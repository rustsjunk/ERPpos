
#!/usr/bin/env python3
# POS scaffold: SQLite + JSON queue + ERPNext sync + NDJSON backups
import os, sys, json, uuid, sqlite3, time, argparse, datetime as dt, ssl, threading
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple
import urllib.request
import urllib.error

DB_PATH = os.environ.get("POS_DB_PATH", "pos.db")
BACKUP_DIR = os.environ.get("POS_BACKUP_DIR", "pos_backup")
try:
    ITEM_PULL_PAGE_LIMIT = int(os.environ.get("POS_ITEM_PULL_LIMIT", "500"))
except ValueError:
    ITEM_PULL_PAGE_LIMIT = 500
_BARCODE_PULL_FORBIDDEN = False
_BIN_PULL_FORBIDDEN = False

# ERPNext REST
ERP_BASE = os.environ.get("ERP_BASE")            # e.g., https://erp.yourdomain.com
ERP_API_KEY = os.environ.get("ERP_API_KEY")
ERP_API_SECRET = os.environ.get("ERP_API_SECRET")
# Fully-qualified method path for ingest (your_app.pos_sync.pos_ingest)
ERP_INGEST_METHOD = os.environ.get("ERP_INGEST_METHOD", "your_app.pos_sync.pos_ingest")
ERP_VOUCHER_DOCTYPE = os.environ.get("ERP_VOUCHER_DOCTYPE", "Gift Voucher")
ERP_VOUCHER_REDEEM_CHILD = os.environ.get(
    "ERP_VOUCHER_REDEEM_CHILD",
    f"{ERP_VOUCHER_DOCTYPE} Redeem Line"
)
ERP_VOUCHER_EVENT_ENDPOINT = os.environ.get("ERP_VOUCHER_EVENT_ENDPOINT", "/api/pos/voucher_event")

# Track docs we repeatedly fail to fetch so we can fall back without noisy retries
UNFETCHABLE_ITEM_DOCS: Set[str] = set()
_FULL_SYNC_FAST = False
UNFETCHABLE_ATTRIBUTE_DOCS: Set[str] = set()

def iso_now() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def connect(db_path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        _ensure_item_extras(conn)
    except Exception:
        pass
    try:
        _ensure_customer_table(conn)
    except Exception:
        pass
    try:
        _ensure_voucher_event_table(conn)
    except Exception:
        pass
    try:
        _ensure_voucher_balance_view(conn)
    except Exception:
        pass
    return conn

def init_db(conn: sqlite3.Connection, schema_path: str):
    with open(schema_path, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.commit()

def _ensure_item_extras(conn: sqlite3.Connection):
    """Add new optional columns on items table if they are missing."""
    try:
        rows = conn.execute("PRAGMA table_info(items)").fetchall()
    except Exception:
        return
    existing = {row["name"] for row in rows}
    alters = []
    if "item_group" not in existing:
        alters.append("ALTER TABLE items ADD COLUMN item_group TEXT")
    if "custom_style_code" not in existing:
        alters.append("ALTER TABLE items ADD COLUMN custom_style_code TEXT")
    if "custom_simple_colour" not in existing:
        alters.append("ALTER TABLE items ADD COLUMN custom_simple_colour TEXT")
    if "vat_rate" not in existing:
        alters.append("ALTER TABLE items ADD COLUMN vat_rate NUMERIC")
    for sql in alters:
        conn.execute(sql)
    if alters:
        conn.commit()


def _ensure_customer_table(conn: sqlite3.Connection):
    """Make sure the optional customers cache table exists."""
    conn.execute("""
    CREATE TABLE IF NOT EXISTS customers (
      name TEXT PRIMARY KEY,
      customer_name TEXT,
      email TEXT,
      phone TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      modified_utc TEXT
    )
    """)

def _ensure_voucher_event_table(conn: sqlite3.Connection):
    """Ensure voucher_events exists for issue/redeem event tracking."""
    conn.execute("""
    CREATE TABLE IF NOT EXISTS voucher_events (
      event_id      TEXT PRIMARY KEY,
      voucher_code  TEXT NOT NULL REFERENCES vouchers(voucher_code),
      created_utc   TEXT NOT NULL,
      kind          TEXT NOT NULL,
      amount        NUMERIC NOT NULL,
      balance_after NUMERIC,
      currency      TEXT DEFAULT 'GBP',
      sale_id       TEXT,
      payload_json  TEXT NOT NULL,
      queue_status  TEXT NOT NULL DEFAULT 'queued',
      erp_docname   TEXT
    )
    """)
    conn.execute("""
    CREATE INDEX IF NOT EXISTS idx_voucher_events_status ON voucher_events(queue_status, created_utc)
    """)

def _ensure_voucher_balance_view(conn: sqlite3.Connection):
    """Ensure balance view ignores issue ledger rows to avoid double-counting."""
    conn.execute("DROP VIEW IF EXISTS v_voucher_balance")
    conn.execute(
        """
        CREATE VIEW v_voucher_balance AS
        SELECT
            v.voucher_code,
            v.active,
            v.issued_utc,
            v.initial_value
            + COALESCE(
                SUM(
                    CASE
                        WHEN l.type = 'issue' THEN 0
                        ELSE l.amount
                    END
                ),
                0
            ) AS balance
        FROM vouchers v
        LEFT JOIN voucher_ledger l ON l.voucher_code = v.voucher_code
        GROUP BY v.voucher_code
        """
    )

# ---------- UPSERT HELPERS ----------
def upsert_item(conn: sqlite3.Connection, item: Dict[str, Any]):
    sql = """
    INSERT INTO items (item_id, parent_id, name, brand, item_group, custom_style_code, custom_simple_colour, vat_rate, attributes, price, image_url, is_template, active, modified_utc)
    VALUES (:item_id, :parent_id, :name, :brand, :item_group, :custom_style_code, :custom_simple_colour, :vat_rate, :attributes, :price, :image_url, :is_template, :active, :modified_utc)
    ON CONFLICT(item_id) DO UPDATE SET
      parent_id=excluded.parent_id,
      name=excluded.name,
      brand=excluded.brand,
      item_group=excluded.item_group,
      custom_style_code=excluded.custom_style_code,
      custom_simple_colour=excluded.custom_simple_colour,
      vat_rate=COALESCE(excluded.vat_rate, items.vat_rate),
      attributes=excluded.attributes,
      price=excluded.price,
      image_url=excluded.image_url,
      is_template=excluded.is_template,
      active=excluded.active,
      modified_utc=excluded.modified_utc;
    """
    conn.execute(sql, item)

def _serialize_item_attributes(attributes: Any) -> Optional[str]:
    if not attributes:
        return None
    if isinstance(attributes, dict):
        try:
            return json.dumps(attributes, separators=(",",":"))
        except TypeError:
            return json.dumps({str(k): str(v) for k, v in attributes.items()}, separators=(",",":"))
    if isinstance(attributes, str):
        attr = attributes.strip()
        return attr or None
    return str(attributes)


def _normalize_customer_disabled(value: Any) -> int:
    if value in (1, "1", True, "true", "True", "yes", "Yes"):
        return 1
    return 0


def upsert_customers(conn: sqlite3.Connection, customers: List[Dict[str, Any]]) -> int:
    """Cache or refresh ERPNext Customer entries in the local DB."""
    if not customers:
        return 0
    now = iso_now()
    stored = 0
    for row in customers:
        name = (row.get("name") or row.get("customer_id") or "").strip()
        if not name:
            continue
        customer_name = (row.get("customer_name") or row.get("customer") or name).strip()
        email = (row.get("email_id") or row.get("email") or "").strip()
        phone = (row.get("mobile_no") or row.get("phone") or row.get("mobile") or "").strip()
        disabled = _normalize_customer_disabled(row.get("disabled"))
        modified = row.get("modified") or row.get("modified_utc") or now
        conn.execute("""
            INSERT INTO customers (name, customer_name, email, phone, disabled, modified_utc)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET
                customer_name=COALESCE(NULLIF(excluded.customer_name,''), customers.customer_name),
                email=COALESCE(NULLIF(excluded.email,''), customers.email),
                phone=COALESCE(NULLIF(excluded.phone,''), customers.phone),
                disabled=excluded.disabled,
                modified_utc=excluded.modified_utc
        """, (name, customer_name or name, email or None, phone or None, disabled, modified))
        stored += 1
    if stored:
        conn.commit()
    return stored


def fetch_customers(conn: sqlite3.Connection, include_disabled: bool = False) -> List[Dict[str, str]]:
    """Return cached customers for dropdowns."""
    clause = "" if include_disabled else "WHERE disabled=0"
    rows = conn.execute(f"SELECT name, customer_name FROM customers {clause} ORDER BY customer_name COLLATE NOCASE").fetchall()
    result: List[Dict[str, str]] = []
    for row in rows:
        display = row["customer_name"] or row["name"]
        result.append({"name": row["name"], "customer_name": display})
    return result


def ensure_item_for_sale_line(conn: sqlite3.Connection, line: Dict[str, Any]):
    item_id = (line.get("item_id") or "").strip()
    if not item_id:
        return
    name = (line.get("item_name") or "").strip() or item_id
    brand = line.get("brand")
    attributes = _serialize_item_attributes(line.get("attributes"))
    now = iso_now()
    conn.execute("""
        INSERT INTO items (item_id, parent_id, name, brand, item_group, custom_style_code, custom_simple_colour, vat_rate, attributes, price, image_url, is_template, active, modified_utc)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET
            name=COALESCE(NULLIF(excluded.name,''), items.name),
            brand=COALESCE(excluded.brand, items.brand),
            item_group=COALESCE(excluded.item_group, items.item_group),
            custom_style_code=COALESCE(excluded.custom_style_code, items.custom_style_code),
            custom_simple_colour=COALESCE(excluded.custom_simple_colour, items.custom_simple_colour),
            vat_rate=COALESCE(excluded.vat_rate, items.vat_rate),
            attributes=COALESCE(NULLIF(excluded.attributes,''), items.attributes),
            modified_utc=excluded.modified_utc,
            active=1
    """, (item_id, None, name, brand, None, None, None, None, attributes, None, None, 0, 1, now))

def upsert_barcode(conn: sqlite3.Connection, barcode: str, item_id: str):
    sql = """
    INSERT INTO barcodes (barcode, item_id) VALUES (?,?)
    ON CONFLICT(barcode) DO UPDATE SET item_id=excluded.item_id;
    """
    conn.execute(sql, (barcode, item_id))

def _ingest_child_barcodes(conn: sqlite3.Connection, child_rows: Any, item_id: str):
    if not conn or not item_id or not child_rows:
        return
    rows = child_rows if isinstance(child_rows, list) else [child_rows]
    for entry in rows:
        if not entry:
            continue
        if isinstance(entry, dict):
            bc = entry.get("barcode")
        else:
            bc = entry
        if not bc:
            continue
        try:
            bc_txt = str(bc).strip()
        except Exception:
            bc_txt = None
        if not bc_txt:
            continue
        upsert_barcode(conn, bc_txt, item_id)

def ensure_barcode_placeholder(conn: sqlite3.Connection, barcode: Optional[str], item_id: str):
    """Insert a fallback barcode (item_code) if none exists, without overwriting real barcodes."""
    if not barcode or not item_id:
        return
    conn.execute("""
        INSERT OR IGNORE INTO barcodes (barcode, item_id) VALUES (?,?)
    """, (barcode, item_id))

def ensure_item_stub(conn: sqlite3.Connection, item_id: Optional[str]):
    """Guarantee that a minimal items row exists so FK inserts (stock, barcodes) never fail."""
    if not item_id:
        return
    conn.execute("""
        INSERT OR IGNORE INTO items (item_id, parent_id, name, is_template, active, modified_utc)
        VALUES (?, NULL, ?, 0, 0, ?)
    """, (item_id, item_id, iso_now()))

def ensure_attribute_definition(conn: sqlite3.Connection, attr_name: str, label: Optional[str] = None):
    """Ensure the attribute definition row exists so FK constraints pass."""
    if not attr_name:
        return
    lbl = label or attr_name
    conn.execute("""
        INSERT OR IGNORE INTO attributes (attr_name, label) VALUES (?,?)
    """, (attr_name, lbl))

def ensure_template_attribute(conn: sqlite3.Connection, template_id: str, attr_name: str, required: bool = True, sort_order: Optional[int] = None):
    if not template_id or not attr_name:
        return
    req = 1 if required else 0
    sort = sort_order if sort_order is not None else 0
    conn.execute("""
        INSERT INTO template_attributes (template_id, attr_name, required, sort_order)
        VALUES (?,?,?,?)
        ON CONFLICT(template_id, attr_name) DO UPDATE SET
            required=excluded.required,
            sort_order=COALESCE(NULLIF(excluded.sort_order,0), template_attributes.sort_order)
    """, (template_id, attr_name, req, sort))

def _hydrate_attribute_options(conn: sqlite3.Connection, docnames: List[str]):
    """Fetch Item Attribute docs to populate attribute definitions + options."""
    if not docnames:
        return
    seen = set()
    for name in docnames:
        if not name or name in seen:
            continue
        seen.add(name)
        if name in UNFETCHABLE_ATTRIBUTE_DOCS:
            ensure_attribute_definition(conn, name, name)
            continue
        try:
            doc = _erp_get_doc("Item Attribute", name)
        except urllib.error.HTTPError as exc:
            status = getattr(exc, "code", None)
            if status in (403, 404):
                UNFETCHABLE_ATTRIBUTE_DOCS.add(name)
                ensure_attribute_definition(conn, name, name)
                continue
            print(f"Failed to fetch attribute {name}: {exc}", file=sys.stderr)
            continue
        except Exception as exc:
            print(f"Failed to fetch attribute {name}: {exc}", file=sys.stderr)
            continue
        attr_name = doc.get("attribute_name") or doc.get("name")
        ensure_attribute_definition(conn, attr_name, doc.get("attribute_name") or doc.get("name"))
        values = doc.get("item_attribute_values") or doc.get("values") or []
        conn.execute("DELETE FROM attribute_options WHERE attr_name=?", (attr_name,))
        for idx, val in enumerate(values):
            option = val.get("attribute_value") or val.get("abbr") or val.get("value")
            if option in (None, ""):
                continue
            sort = val.get("idx") or val.get("sort_order") or idx
            conn.execute("""
                INSERT OR REPLACE INTO attribute_options (attr_name, option, sort_order)
                VALUES (?,?,?)
            """, (attr_name, str(option), int(sort)))

def upsert_stock(conn: sqlite3.Connection, item_id: str, qty: float, warehouse: str = "Shop"):
    ensure_item_stub(conn, item_id)
    sql = """
    INSERT INTO stock (item_id, warehouse, qty) VALUES (?,?,?)
    ON CONFLICT(item_id, warehouse) DO UPDATE SET qty=excluded.qty;
    """
    conn.execute(sql, (item_id, warehouse, qty))

# ---------- VOUCHERS ----------
def voucher_balance(conn: sqlite3.Connection, code: str) -> Optional[float]:
    row = conn.execute("SELECT balance, active FROM v_voucher_balance WHERE voucher_code = ?", (code,)).fetchone()
    if not row: return None
    if row["active"] != 1: return 0.0
    return float(row["balance"])

def voucher_ledger_add(conn: sqlite3.Connection, code: str, amount: float, typ: str, sale_id: Optional[str]=None, note: str=""):
    conn.execute(
        "INSERT INTO voucher_ledger (voucher_code, entry_utc, type, amount, sale_id, note) VALUES (?,?,?,?,?,?)",
        (code, iso_now(), typ, amount, sale_id, note)
    )

def _queue_voucher_event(
    conn: sqlite3.Connection,
    voucher_code: str,
    kind: str,
    amount: float,
    extra_payload: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    event_id = str(uuid.uuid4())
    created = iso_now()
    payload: Dict[str, Any] = {
        "event_id": event_id,
        "created_utc": created,
        "event_type": kind,
        "voucher_code": voucher_code,
        "amount": float(amount)
    }
    if extra_payload:
        payload.update(extra_payload)
    balance_after = payload.get("balance_after")
    currency = (payload.get("currency") or "GBP") if payload.get("currency") else "GBP"
    sale_id = payload.get("sale_id")
    conn.execute("""
        INSERT INTO voucher_events (event_id, voucher_code, created_utc, kind, amount, balance_after, currency, sale_id, payload_json, queue_status)
        VALUES (?,?,?,?,?,?,?,?,?,?)
    """, (
        event_id,
        voucher_code,
        created,
        kind,
        float(amount),
        float(balance_after) if balance_after is not None else None,
        str(currency),
        sale_id,
        json.dumps(payload, separators=(",",":")),
        "queued"
    ))
    conn.execute("""
        INSERT INTO outbox (kind, ref_id, created_utc, payload_json) VALUES ('voucher_event', ?, ?, ?)
    """, (event_id, created, json.dumps(payload, separators=(",",":"))))
    return payload

def _normalize_issue_utc(raw: Optional[str]) -> str:
    if raw is None:
        return iso_now()
    text = str(raw).strip()
    if not text:
        return iso_now()
    if "T" in text:
        return text if text.upper().endswith("Z") else text + "Z"
    return f"{text}T00:00:00Z"

def upsert_voucher_head(
    conn: sqlite3.Connection,
    code: str,
    issue_utc: Optional[str],
    initial_value: float,
    active: int = 1,
    meta: Optional[Dict[str, Any]] = None
) -> None:
    meta_json = None
    if meta is not None:
        try:
            meta_json = json.dumps(meta, separators=(",",":"))
        except Exception:
            meta_json = json.dumps({})
    conn.execute(
        """
        INSERT INTO vouchers (voucher_code, issued_utc, initial_value, active, meta_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(voucher_code) DO UPDATE SET
            issued_utc = excluded.issued_utc,
            initial_value = excluded.initial_value,
            active = excluded.active,
            meta_json = COALESCE(excluded.meta_json, vouchers.meta_json)
        """,
        (code, _normalize_issue_utc(issue_utc), float(initial_value), int(active or 0), meta_json)
    )

def voucher_details(conn: sqlite3.Connection, code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    head = conn.execute(
        "SELECT voucher_code, issued_utc, initial_value, active, meta_json FROM vouchers WHERE voucher_code=?",
        (code,)
    ).fetchone()
    if not head:
        return None
    meta = {}
    if head["meta_json"]:
        try:
            meta = json.loads(head["meta_json"])
        except Exception:
            meta = {}
    bal_row = conn.execute(
        "SELECT balance, active FROM v_voucher_balance WHERE voucher_code=?",
        (code,)
    ).fetchone()
    balance = float(bal_row["balance"]) if bal_row and bal_row["balance"] is not None else 0.0
    active = int(bal_row["active"]) if bal_row and "active" in bal_row.keys() else int(head["active"])
    return {
        "voucher_code": head["voucher_code"],
        "issued_utc": head["issued_utc"],
        "initial_value": float(head["initial_value"]),
        "balance": balance,
        "active": active,
        "meta": meta
    }


def voucher_adjust_balance(conn: sqlite3.Connection, code: str, target_balance: float, note: str = "ERP sync") -> float:
    row = conn.execute(
        "SELECT balance FROM v_voucher_balance WHERE voucher_code=?",
        (code,)
    ).fetchone()
    current = float(row["balance"]) if row and row["balance"] is not None else 0.0
    delta = float(target_balance) - current
    if abs(delta) > 0.005:
        voucher_ledger_add(conn, code, delta, "adjust", sale_id=None, note=note)
        return delta
    return 0.0


def _erp_lookup_voucher_doc(code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    try:
        import urllib.parse
        path = "/api/resource/" + urllib.parse.quote(ERP_VOUCHER_DOCTYPE, safe="")
        response = _erp_get(
            path,
            {
                "filters": json.dumps([["voucher_code", "=", code]]),
                "fields": json.dumps([
                    "name",
                    "voucher_code",
                    "status",
                    "original_amount",
                    # "balance_amount",  # optional now
                ]),
            },
        )
    except Exception:
        return None

    rows = response.get("data") or response.get("message") or []
    if not rows:
        return None

    name = rows[0].get("name")
    if not name:
        return None

    try:
        # Full doc, including child redemption lines
        return _erp_get_doc(ERP_VOUCHER_DOCTYPE, name)
    except Exception:
        return None


def sync_voucher_from_erp(conn: sqlite3.Connection, code: str) -> Optional[Dict[str, Any]]:
    doc = _erp_lookup_voucher_doc(code)
    if not doc:
        return None

    # 1) Base voucher amounts from ERP
    original_amount = float(
        doc.get("original_amount")
        or doc.get("original_amount_gbp")
        or 0
    )

    status = (doc.get("status") or "").strip()
    issue_date = doc.get("issue_date") or doc.get("issue_datetime") or doc.get("issued_on")
    expiry_date = doc.get("expiry_date")

    # 2) Compute redeemed total from child table
    #    Adjust the fieldname "redeem_lines" if your child table field is named differently.
    #    The individual child rows should have an "amount" field.
    redeem_children = (
        doc.get("redeem_lines")
        or doc.get("redemption_lines")
        or doc.get("redeem_log")
        or []
    )

    redeemed_total = 0.0
    for row in redeem_children:
        try:
            redeemed_total += float(row.get("amount") or 0)
        except (TypeError, ValueError):
            # ignore bad rows rather than blowing up
            continue

    # 3) Calculate balance locally
    balance = max(0.0, original_amount - redeemed_total)

    meta = {
        "erp_name": doc.get("name"),
        "customer": doc.get("customer"),
        "mode_of_payment": doc.get("mode_of_payment"),
        "expiry_date": expiry_date,
        "status": status,
        "remarks": doc.get("remarks"),
        "last_sync_utc": iso_now(),
        # Optional but handy for debugging / reporting
        "redeemed_total": redeemed_total,
        "original_amount": original_amount,
    }

    active = 0 if status in ("Expired", "Cancelled") else 1

    # 4) Upsert voucher head – store original amount as the initial value
    upsert_voucher_head(
        conn,
        code,
        issue_date,
        original_amount or balance,
        active,
        meta,
    )

    # 5) Adjust the *event* ledger to match the ERP-derived balance
    #    For a brand-new voucher with no events, this will create a single "adjust"
    #    event with amount = balance. For partially used ones, it will nudge the
    #    local balance to whatever ERP says is correct.
    voucher_adjust_balance(conn, code, balance, note="ERP sync (orig - redemptions)")
    conn.commit()

    details = voucher_details(conn, code)
    if details:
        details["meta"].update({
            "status": status,
            "erp_name": doc.get("name"),
        })
    return details


def queue_voucher_issue(conn: sqlite3.Connection, payload: Dict[str, Any]) -> Dict[str, Any]:
    code = (payload.get("voucher_code") or "").strip()
    if not code:
        raise ValueError("voucher_code is required")
    existing = conn.execute("SELECT 1 FROM vouchers WHERE voucher_code=?", (code,)).fetchone()
    if existing:
        raise ValueError(f"Voucher {code} already exists")
    amount = float(payload.get("amount") or payload.get("original_amount") or 0)
    if amount <= 0:
        raise ValueError("Voucher amount must be greater than zero")
    issue_date = payload.get("issue_date") or dt.date.today().isoformat()
    expiry = payload.get("expiry_date")
    sale_id = payload.get("sale_id")
    remarks = payload.get("remarks") or payload.get("note") or ""
    meta = {
        "customer": payload.get("customer"),
        "expiry_date": expiry,
        "remarks": remarks,
        "till_number": payload.get("till_number"),
        "pos_profile": payload.get("pos_profile")
    }
    upsert_voucher_head(conn, code, issue_date, amount, 1, meta)
    voucher_ledger_add(conn, code, amount, "issue", sale_id=sale_id, note=remarks or "POS issue")
    balance_after = voucher_balance(conn, code)
    event_payload = {
        "balance_after": balance_after if balance_after is not None else amount,
        "currency": (payload.get("currency") or "GBP").upper(),
        "issued_utc": issue_date,
        "expiry_date": expiry,
        "customer": payload.get("customer"),
        "cashier": payload.get("cashier"),
        "till_number": payload.get("till_number"),
        "pos_profile": payload.get("pos_profile"),
        "note": remarks,
        "sale_id": sale_id,
        "mode_of_payment": payload.get("mode_of_payment"),
        "status": payload.get("status") or "Active"
    }
    _queue_voucher_event(conn, code, "issue", amount, event_payload)
    conn.commit()
    return {"voucher_code": code, "amount": amount, "issue_date": issue_date, "expiry_date": expiry}

# ---------- SALES (transactional) ----------
def begin_sale_txn(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")

def commit_sale_txn(conn: sqlite3.Connection):
    conn.commit()

def rollback_sale_txn(conn: sqlite3.Connection):
    conn.rollback()

def record_sale(conn: sqlite3.Connection, sale: Dict[str, Any]) -> str:
    """
    sale = {
      'cashier': 'alice',
      'customer_id': None,
      'lines': [ { 'item_id': 'SKU1', 'item_name': 'Name', 'brand':'Brand', 'attributes': {'Size':'8'}, 'qty': 1, 'rate': 59.99, 'barcode_used': '...'} ],
      'payments': [ {'method':'Card', 'amount': 59.99, 'ref':'T123'} ],
      'warehouse': 'Shop',
      'voucher_redeem': [ {'code':'G123', 'amount': 10.0} ]   # optional
    }
    """
    sale_id = sale.get("sale_id") or str(uuid.uuid4())
    created = iso_now()
    lines = sale["lines"]
    payments = sale["payments"]
    warehouse = sale.get("warehouse", "Shop")

    subtotal = sum(float(l["qty"]) * float(l["rate"]) for l in lines)
    discount = float(sale.get("discount", 0))
    tax = float(sale.get("tax", 0))
    total = subtotal - discount + tax
    pay_total = sum(float(p["amount"]) for p in payments) + sum(float(v["amount"]) for v in sale.get("voucher_redeem", []))

    def _as_float(value: Any) -> float:
        if value in (None, "", False):
            return 0.0
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    raw_change = _as_float(sale.get("change"))
    net_collected = pay_total - raw_change if total >= 0 else pay_total
    pay_status = "paid" if abs(net_collected - total) < 0.005 else ("partially_paid" if abs(net_collected) > 0 else "unpaid")
    till_number = sale.get("till") or sale.get("till_number")
    if isinstance(till_number, str):
        till_number = till_number.strip()
    if not till_number:
        till_number = None

    payload = {
        "sale_id": sale_id,
        "created_utc": created,
        "cashier": sale.get("cashier"),
        "customer_id": sale.get("customer_id"),
        "warehouse": warehouse,
        "lines": lines,
        "payments": payments,
        "discount": discount,
        "tax": tax,
        "totals": {"subtotal": subtotal, "total": total},
        "disable_rounded_total": 1,
        "voucher_redeem": sale.get("voucher_redeem", []),
        "voucher_issue": sale.get("voucher_issue", []),
        "voucher_balance_prints": sale.get("voucher_balance_prints", []),
        "pos_voucher_code": ",".join(
            v["code"] for v in sale.get("voucher_redeem", []) if v.get("code")
        ) or None,
        "tender": sale.get("tender"),
        "cash_given": sale.get("cash_given"),
        "change": sale.get("change"),
        "till": till_number,
        "till_number": till_number,
    }

    try:
        begin_sale_txn(conn)

        # Insert sale header
        conn.execute("""
            INSERT INTO sales (sale_id, created_utc, cashier, customer_id, subtotal, tax, discount, total, pay_status, queue_status, erp_docname, payload_json)
            VALUES (?,?,?,?,?,?,?,?,?,'queued',NULL,?)
        """, (
            sale_id, created, sale.get("cashier"), sale.get("customer_id"),
            subtotal, tax, discount, total, pay_status, json.dumps(payload, separators=(",",":"))
        ))

        # Lines
        for idx, l in enumerate(lines, start=1):
            ensure_item_for_sale_line(conn, l)
            conn.execute("""
                INSERT INTO sale_lines (sale_id, line_no, item_id, item_name, brand, attributes, qty, rate, line_total, barcode_used)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """, (sale_id, idx, l["item_id"], l.get("item_name",""), l.get("brand"), json.dumps(l.get("attributes") or {}),
                  float(l["qty"]), float(l["rate"]), float(l["qty"])*float(l["rate"]), l.get("barcode_used")))

            # Decrement local stock
            conn.execute("""
                INSERT INTO stock (item_id, warehouse, qty) VALUES (?,?,?)
                ON CONFLICT(item_id, warehouse) DO UPDATE SET qty = MAX(0, stock.qty - ?)
            """, (l["item_id"], warehouse, 0, float(l["qty"])))

        # Payments (store optional meta_json for extra metadata like EUR conversion details)
        for idx, p in enumerate(payments, start=1):
            meta_json = None
            try:
                meta = p.get('meta') if isinstance(p, dict) else None
                if meta is not None:
                    meta_json = json.dumps(meta, separators=(",",":"))
            except Exception:
                meta_json = None
            
            # Support both old format (amount) and new format (amount_gbp / amount_eur)
            amount_gbp = p.get('amount_gbp') or p.get('amount', 0)
            amount_eur = p.get('amount_eur')
            currency = (p.get('currency') or 'GBP').upper()
            eur_rate = p.get('eur_rate')
            
            conn.execute("""
                INSERT INTO payments (sale_id, seq, method, currency, amount_gbp, amount_eur, eur_rate, ref, meta_json)
                VALUES (?,?,?,?,?,?,?,?,?)
            """, (sale_id, idx, p["method"], currency, float(amount_gbp), 
                  float(amount_eur) if amount_eur else None, 
                  float(eur_rate) if eur_rate else None,
                  p.get("ref"), meta_json))

        # Voucher redemption
        for v in sale.get("voucher_redeem", []):
            code = v["code"]; amt = float(v["amount"])
            bal = voucher_balance(conn, code)
            if bal is None or bal < amt - 1e-6:
                raise ValueError(f"Voucher {code} insufficient balance or not found")
            voucher_ledger_add(conn, code, -amt, "redeem", sale_id=sale_id, note="POS redemption")
            remaining_after = voucher_balance(conn, code)
            event_payload = {
                "balance_after": remaining_after if remaining_after is not None else max(0.0, (bal or 0.0) - amt),
                "currency": (sale.get("currency_used") or "GBP").upper(),
                "sale_id": sale_id,
                "cashier": sale.get("cashier"),
                "till_number": till_number,
                "note": "POS redemption"
            }
            _queue_voucher_event(conn, code, "redeem", amt, event_payload)

        # Outbox enqueue (idempotent ref_id = sale_id)
        conn.execute("""
            INSERT INTO outbox (kind, ref_id, created_utc, payload_json) VALUES ('sale', ?, ?, ?)
        """, (sale_id, created, json.dumps(payload, separators=(",",":"))))

        commit_sale_txn(conn)
        return sale_id
    except Exception as e:
        rollback_sale_txn(conn)
        raise

# ---------- OUTBOX PUSH (ERPNext) ----------
def _erp_request(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not ERP_BASE:
        # Dry-run: pretend success
        return {"ok": True, "dry_run": True}
    url = ERP_BASE.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}" if ERP_API_KEY and ERP_API_SECRET else "",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} from ERPNext: {body[:500]}") from e

def _erp_resource_request(path: str, payload: Optional[Dict[str, Any]], method: str = "POST") -> Dict[str, Any]:
    if not ERP_BASE:
        return {"ok": True, "dry_run": True, "data": payload or {}}
    url = ERP_BASE.rstrip("/") + path
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Expect": "",
    }
    if ERP_API_KEY and ERP_API_SECRET:
        headers["Authorization"] = f"token {ERP_API_KEY}:{ERP_API_SECRET}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body)

def _erp_post_resource(doctype: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    import urllib.parse
    path = "/api/resource/" + urllib.parse.quote(doctype, safe="")
    return _erp_resource_request(path, payload, method="POST")

def _erp_put_resource(doctype: str, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    import urllib.parse
    path = "/api/resource/{}/{}".format(
        urllib.parse.quote(doctype, safe=""),
        urllib.parse.quote(name, safe="")
    )
    return _erp_resource_request(path, payload, method="PUT")

def _post_voucher_issue_to_erp(voucher: Dict[str, Any]) -> Dict[str, Any]:
    if not voucher.get("voucher_code"):
        raise ValueError("voucher_code missing for ERP issue")
    payload = {
        "doctype": ERP_VOUCHER_DOCTYPE,
        "voucher_code": voucher.get("voucher_code"),
        "mode_of_payment": voucher.get("mode_of_payment"),
        "issue_date": voucher.get("issue_date") or dt.date.today().isoformat(),
        "expiry_date": voucher.get("expiry_date"),
        "customer": voucher.get("customer"),
        "original_amount": float(voucher.get("original_amount") or voucher.get("balance_amount") or 0),
        "balance_amount": float(voucher.get("balance_amount") or voucher.get("original_amount") or 0),
        "status": voucher.get("status") or "Active",
        "is_clearance": 1 if voucher.get("is_clearance") else 0,
        "remarks": voucher.get("remarks"),
        "pos_profile": voucher.get("pos_profile"),
        "till_number": voucher.get("till_number")
    }
    res = _erp_post_resource(ERP_VOUCHER_DOCTYPE, payload)
    data = res.get("data") or res
    name = data.get("name") or data.get("voucher_code")
    if name:
        _erp_request("/api/method/frappe.client.submit", {"doc": {"doctype": ERP_VOUCHER_DOCTYPE, "name": name}})
    return data

def _post_voucher_event(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not ERP_BASE:
        return {"ok": True, "dry_run": True}
    endpoint = ERP_VOUCHER_EVENT_ENDPOINT or "/api/pos/voucher_event"
    path = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    return _erp_request(path, payload)

def _apply_voucher_redemptions_to_erp(
    vouchers: List[Dict[str, Any]],
    sale_docname: Optional[str],
    sale_payload: Dict[str, Any]
) -> None:
    if not vouchers or not ERP_BASE:
        return
    posting_date = sale_payload.get("posting_date") or dt.date.today().isoformat()
    pos_profile = sale_payload.get("till") or sale_payload.get("till_number") or sale_payload.get("warehouse")
    till_number = sale_payload.get("till_number")
    for entry in vouchers:
        code = (entry.get("code") or "").strip()
        amount = float(entry.get("amount") or 0)
        if not code or amount <= 0:
            continue
        doc = _erp_lookup_voucher_doc(code)
        if not doc:
            raise ValueError(f"Voucher {code} not found in ERP")
        balance = float(doc.get("balance_amount") or 0)
        if balance + 1e-6 < amount:
            raise ValueError(f"Voucher {code} balance too low in ERP")
        redeem_lines = []
        for ln in doc.get("redeem_lines") or []:
            redeem_lines.append({
                "name": ln.get("name"),
                "doctype": ln.get("doctype") or ERP_VOUCHER_REDEEM_CHILD,
                "reference_doctype": ln.get("reference_doctype"),
                "reference_name": ln.get("reference_name"),
                "posting_date": ln.get("posting_date"),
                "amount": ln.get("amount"),
                "pos_profile": ln.get("pos_profile"),
                "till_number": ln.get("till_number")
            })
        redeem_lines.append({
            "doctype": ERP_VOUCHER_REDEEM_CHILD,
            "reference_doctype": "Sales Invoice",
            "reference_name": sale_docname,
            "posting_date": posting_date,
            "amount": amount,
            "pos_profile": pos_profile,
            "till_number": till_number
        })
        new_balance = max(0.0, balance - amount)
        update_payload = {
            "redeem_lines": redeem_lines,
            "balance_amount": new_balance,
            "status": "Redeemed" if new_balance <= 0.005 else "Partially Redeemed"
        }
        _erp_put_resource(ERP_VOUCHER_DOCTYPE, doc.get("name"), update_payload)

def post_sale_to_erpnext(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Example: post to a whitelisted method you expose, e.g. /api/method/your_app.pos_ingest
    or build a Sales Invoice document directly via /api/resource/Sales Invoice.
    This function is a stub calling /api/method/pos_ingest by default.
    """
    # Prefer fully-qualified method if provided; fallback to legacy 'pos_ingest'
    path = "/api/method/" + (ERP_INGEST_METHOD or "pos_ingest")
    return _erp_request(path, payload)

def push_outbox(conn: sqlite3.Connection, limit: int = 20):
    rows = conn.execute("""
        SELECT id, kind, ref_id, payload_json FROM outbox
        ORDER BY id ASC LIMIT ?
    """, (limit,)).fetchall()
    for r in rows:
        oid = r["id"]
        kind = r["kind"]
        ref = r["ref_id"]
        payload = json.loads(r["payload_json"])
        if kind == "sale":
            try:
                conn.execute("UPDATE sales SET queue_status='posting' WHERE sale_id=?", (ref,))
                conn.commit()
                resp = post_sale_to_erpnext(payload)
                sale_docname = resp.get("name") or resp.get("docname") or resp.get("sales_invoice")
                try:
                    _apply_voucher_redemptions_to_erp(payload.get("voucher_redeem", []), sale_docname, payload)
                except Exception as voucher_exc:
                    raise RuntimeError(f"Voucher sync failed: {voucher_exc}") from voucher_exc
                conn.execute(
                    "UPDATE sales SET queue_status='posted', erp_docname=COALESCE(?, erp_docname,'OK') WHERE sale_id=?",
                    (sale_docname, ref)
                )
                conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
                conn.commit()
                print(f"Posted sale {ref}: {resp}")
            except Exception as e:
                conn.execute("UPDATE sales SET queue_status='failed' WHERE sale_id=?", (ref,))
                conn.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (str(e), oid))
                conn.commit()
                print(f"Failed posting sale {ref}: {e}", file=sys.stderr)
        elif kind == "voucher_event":
            try:
                conn.execute("UPDATE voucher_events SET queue_status='posting' WHERE event_id=?", (ref,))
                conn.commit()
                resp = _post_voucher_event(payload)
                docname = resp.get("name") or resp.get("docname") or resp.get("reference")
                conn.execute(
                    "UPDATE voucher_events SET queue_status='posted', erp_docname=COALESCE(?, erp_docname,'OK') WHERE event_id=?",
                    (docname, ref)
                )
                conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
                conn.commit()
                print(f"Posted voucher event {ref}: {docname or 'OK'}")
            except Exception as e:
                conn.execute("UPDATE voucher_events SET queue_status='failed' WHERE event_id=?", (ref,))
                conn.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (str(e), oid))
                conn.commit()
                print(f"Failed posting voucher event {ref}: {e}", file=sys.stderr)
        elif kind == "voucher":
            try:
                result = _post_voucher_issue_to_erp(payload.get("voucher") or {})
                erp_name = result.get("name")
                head = voucher_details(conn, ref)
                meta = head["meta"] if head else {}
                if meta is None:
                    meta = {}
                if erp_name:
                    meta["erp_name"] = erp_name
                if payload.get("voucher", {}).get("status"):
                    meta["status"] = payload["voucher"]["status"]
                conn.execute(
                    "UPDATE vouchers SET meta_json=? WHERE voucher_code=?",
                    (json.dumps(meta, separators=(",",":")), ref)
                )
                conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
                conn.commit()
                print(f"Posted voucher {ref}: {erp_name or 'OK'}")
            except Exception as e:
                conn.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (str(e), oid))
                conn.commit()
                print(f"Failed posting voucher {ref}: {e}", file=sys.stderr)

# ---------- BACKUPS ----------
def ensure_dir(p: str):
    Path(p).mkdir(parents=True, exist_ok=True)

def backup_ndjson(conn: sqlite3.Connection, day: Optional[str] = None):
    """
    day: 'YYYY-MM-DD' in UTC. Defaults to today.
    Produces NDJSON files for sales and voucher_ledger for that day.
    """
    if day is None:
        day = dt.datetime.utcnow().date().isoformat()
    ensure_dir(BACKUP_DIR)
    start = day + "T00:00:00Z"
    end_dt = (dt.datetime.fromisoformat(day) + dt.timedelta(days=1)).date().isoformat() + "T00:00:00Z"

    sales_path = Path(BACKUP_DIR) / f"sales_{day}.ndjson"
    ledger_path = Path(BACKUP_DIR) / f"voucher_ledger_{day}.ndjson"

    with open(sales_path, "w", encoding="utf-8") as f:
        for row in conn.execute("SELECT payload_json FROM sales WHERE created_utc >= ? AND created_utc < ? ORDER BY created_utc", (start, end_dt)):
            f.write(row["payload_json"] + "\n")

    with open(ledger_path, "w", encoding="utf-8") as f:
        q = """
        SELECT voucher_code, entry_utc, type, amount, sale_id, note
        FROM voucher_ledger WHERE entry_utc >= ? AND entry_utc < ? ORDER BY entry_utc
        """
        for r in conn.execute(q, (start, end_dt)):
            f.write(json.dumps(dict(r), separators=(",",":")) + "\n")

    events_path = Path(BACKUP_DIR) / f"voucher_events_{day}.ndjson"
    with open(events_path, "w", encoding="utf-8") as f:
        for row in conn.execute(
            "SELECT payload_json FROM voucher_events WHERE created_utc >= ? AND created_utc < ? ORDER BY created_utc",
            (start, end_dt)
        ):
            f.write(row["payload_json"] + "\n")

    print(f"Backed up to {sales_path}, {ledger_path}, and {events_path}")

# ---------- DEMO & CLI ----------
def demo_seed(conn: sqlite3.Connection):
    """Seed a richer demo catalog matching mock examples + one boot template.
    Items seeded include:
      - Stride (Athletic/Trail): SHOE-ATH-001/002
      - ComfortStep (Casual): SHOE-CAS-001/002
      - Elegance (Dress): SHOE-DRS-001/002
      - LittleFeet (Kids): SHOE-KID-001/002
      - Boot template with 2 variants
    """
    now = iso_now()
    def add_template(tpl_id, name, brand=None, price=None, image=None):
        upsert_item(conn, {"item_id":tpl_id,"parent_id":None,"name":name,"brand":brand,"attributes":None,
                           "price":price,"image_url":image,"is_template":1,"active":1,"modified_utc":now})
    def add_variant(item_id, tpl_id, name, brand, price, barcode, stock_qty, attributes=None, image=None):
        # Name variants the same as their template; all specifics live in attributes
        try:
            row = conn.execute("SELECT name FROM items WHERE item_id=?", (tpl_id,)).fetchone()
            tpl_name = row["name"] if row else None
        except Exception:
            tpl_name = None
        v_name = tpl_name or name
        upsert_item(conn, {"item_id":item_id,"parent_id":tpl_id,"name":v_name,"brand":brand,
                            "attributes":json.dumps(attributes) if isinstance(attributes, dict) else (attributes if attributes else None),
                            "price":price,"image_url":image,"is_template":0,"active":1,"modified_utc":now})
        if barcode:
            upsert_barcode(conn, barcode, item_id)
        if stock_qty is not None:
            upsert_stock(conn, item_id, stock_qty, "Shop")

    # Define attributes (Size, Color, Width) and options
    conn.execute("INSERT OR IGNORE INTO attributes (attr_name, label) VALUES (?,?)", ("Size","Size"))
    conn.execute("INSERT OR IGNORE INTO attributes (attr_name, label) VALUES (?,?)", ("Color","Color"))
    conn.execute("INSERT OR IGNORE INTO attributes (attr_name, label) VALUES (?,?)", ("Width","Width"))
    # Common size options (adult)
    for s, order in [("6",0),("7",1),("8",2),("9",3),("10",4)]:
        conn.execute("INSERT OR IGNORE INTO attribute_options (attr_name, option, sort_order) VALUES (?,?,?)", ("Size", s, order))
    # Kids sizes
    for s, order in [("1",0),("2",1),("3",2),("4",3),("5",4)]:
        conn.execute("INSERT OR IGNORE INTO attribute_options (attr_name, option, sort_order) VALUES (?,?,?)", ("Size", s, 50+order))
    # Colors
    for c, order in [("Black",0),("Brown",1),("Blue",2)]:
        conn.execute("INSERT OR IGNORE INTO attribute_options (attr_name, option, sort_order) VALUES (?,?,?)", ("Color", c, order))
    # Widths
    for w, order in [("Standard",0),("Wide",1)]:
        conn.execute("INSERT OR IGNORE INTO attribute_options (attr_name, option, sort_order) VALUES (?,?,?)", ("Width", w, order))

    # Athletic (Stride)
    add_template("TPL-ATH-STRIDE", "Stride Athletic", brand="Stride")
    # template required attributes
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,0)", ("TPL-ATH-STRIDE","Size"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,1)", ("TPL-ATH-STRIDE","Color"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,0,2)", ("TPL-ATH-STRIDE","Width"))
    add_variant("SHOE-ATH-001", "TPL-ATH-STRIDE", "Runner Pro", "Stride", 59.99, "100001", 10, {"Style":"Runner Pro"})
    add_variant("SHOE-ATH-002", "TPL-ATH-STRIDE", "Trail Master", "Stride", 69.99, "100002", 8, {"Style":"Trail Master"})
    # Add attributes to variants
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-ATH-001","Size","8"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-ATH-001","Color","Blue"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-ATH-002","Size","9"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-ATH-002","Color","Black"))

    # Casual (ComfortStep)
    add_template("TPL-CAS-COMFORT", "ComfortStep Casual", brand="ComfortStep")
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,0)", ("TPL-CAS-COMFORT","Size"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,1)", ("TPL-CAS-COMFORT","Color"))
    add_variant("SHOE-CAS-001", "TPL-CAS-COMFORT", "Everyday Comfort", "ComfortStep", 49.99, "100003", 12, {"Style":"Everyday Comfort"})
    add_variant("SHOE-CAS-002", "TPL-CAS-COMFORT", "Urban Walk", "ComfortStep", 54.99, "100004", 9, {"Style":"Urban Walk"})
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-CAS-001","Size","7"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-CAS-001","Color","Brown"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-CAS-002","Size","8"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-CAS-002","Color","Black"))

    # Dress (Elegance)
    add_template("TPL-DRS-ELEG", "Elegance Dress", brand="Elegance")
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,0)", ("TPL-DRS-ELEG","Size"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,1)", ("TPL-DRS-ELEG","Color"))
    add_variant("SHOE-DRS-001", "TPL-DRS-ELEG", "Oxford Classic", "Elegance", 79.99, "100005", 6, {"Style":"Oxford Classic"})
    add_variant("SHOE-DRS-002", "TPL-DRS-ELEG", "Derby Prime", "Elegance", 84.99, "100006", 5, {"Style":"Derby Prime"})
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-DRS-001","Size","9"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-DRS-001","Color","Black"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-DRS-002","Size","10"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-DRS-002","Color","Brown"))

    # Kids (LittleFeet)
    add_template("TPL-KID-LFEET", "LittleFeet Kids", brand="LittleFeet")
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,0)", ("TPL-KID-LFEET","Size"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,1)", ("TPL-KID-LFEET","Color"))
    add_variant("SHOE-KID-001", "TPL-KID-LFEET", "Playtime Sneaker", "LittleFeet", 39.99, "100007", 7, {"Style":"Playtime Sneaker"})
    add_variant("SHOE-KID-002", "TPL-KID-LFEET", "School Buddy", "LittleFeet", 34.99, "100008", 11, {"Style":"School Buddy"})
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-KID-001","Size","3"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-KID-001","Color","Blue"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-KID-002","Size","4"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("SHOE-KID-002","Color","Black"))

    # Existing boot example (template + 2 size variants)
    add_template("TEMPLATE-BOOT-1", "Chelsea Boot", brand="Russells", price=79.99, image="https://example/boot.jpg")
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,0)", ("TEMPLATE-BOOT-1","Size"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,1,1)", ("TEMPLATE-BOOT-1","Color"))
    conn.execute("INSERT OR IGNORE INTO template_attributes (template_id, attr_name, required, sort_order) VALUES (?,?,0,2)", ("TEMPLATE-BOOT-1","Width"))
    add_variant("BOOT-1-BLK-7", "TEMPLATE-BOOT-1", "Chelsea Boot Black 7", "Russells", None, "505000000007", 3, {"Size":"7","Color":"Black"})
    add_variant("BOOT-1-BLK-8", "TEMPLATE-BOOT-1", "Chelsea Boot Black 8", "Russells", None, "505000000008", 2, {"Size":"8","Color":"Black"})
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-7","Size","7"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-7","Color","Black"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-7","Width","Standard"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-8","Size","8"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-8","Color","Black"))
    conn.execute("INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value) VALUES (?,?,?)", ("BOOT-1-BLK-8","Width","Wide"))

    # Demo voucher
    conn.execute("INSERT OR REPLACE INTO vouchers (voucher_code, issued_utc, initial_value, active, meta_json) VALUES (?,?,?,?,?)",
                 ("GV-ABC123", now, 100.0, 1, json.dumps({"note":"demo"})))
    conn.execute("INSERT INTO voucher_ledger (voucher_code, entry_utc, type, amount, sale_id, note) VALUES (?,?,?,?,?,?)",
                 ("GV-ABC123", now, "issue", 100.0, None, "Issued"))
    # Demo cashier(s)
    conn.execute("INSERT OR REPLACE INTO cashiers (code, name, active, meta) VALUES (?,?,1,?)", ("19", "Josh", json.dumps({"note":"demo user"})))
    conn.commit()
    print("Demo seed inserted: athletic, casual, dress, kids, and boot variants.")

def demo_sale(conn: sqlite3.Connection):
    sale = {
        "cashier": "alice",
        "lines": [
            {"item_id":"BOOT-1-BLK-7","item_name":"Chelsea Boot Black 7","brand":"Russells","attributes":{"Size":"7","Color":"Black"},"qty":1,"rate":79.99,"barcode_used":"505000000007"}
        ],
        "payments": [{"method":"Card","amount":69.99,"ref":"T123-XYZ"}],
        "voucher_redeem": [{"code":"GV-ABC123","amount":10.0}],
        "discount": 0.0,
        "tax": 0.0,
        "warehouse": "Shop"
    }
    sale_id = record_sale(conn, sale)
    print("Recorded sale:", sale_id)


# ---------- INCREMENTAL SYNC CURSORS & PULL ----------
def _cursor_get(conn: sqlite3.Connection, doctype: str):
    row = conn.execute("SELECT last_modified, last_name FROM sync_cursors WHERE doctype=?", (doctype,)).fetchone()
    return (row["last_modified"], row["last_name"]) if row else (None, None)

def _cursor_set(conn: sqlite3.Connection, doctype: str, last_modified: str, last_name: str):
    conn.execute("""
        INSERT INTO sync_cursors (doctype, last_modified, last_name) VALUES (?,?,?)
        ON CONFLICT(doctype) DO UPDATE SET last_modified=excluded.last_modified, last_name=excluded.last_name
    """, (doctype, last_modified, last_name))
    conn.commit()

def _erp_get(url_path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Basic GET helper with token auth. Returns dict; on dry-run returns empty list."""
    if not ERP_BASE:
        return {"data": []}
    import urllib.parse, urllib.request, json
    base = ERP_BASE.rstrip("/")
    path = url_path or ""
    # Encode spaces/control chars but keep path separators
    path_encoded = urllib.parse.quote(path, safe="/:")
    url = base + path_encoded + "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/json",
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}" if ERP_API_KEY and ERP_API_SECRET else ""
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _describe_http_error(exc: urllib.error.HTTPError) -> str:
    """Return a short description/body snippet for logging HTTP errors."""
    detail = ""
    try:
        body = exc.read()
        if body:
            detail = body.decode("utf-8", errors="ignore")
    except Exception:
        detail = ""
    if not detail:
        detail = str(getattr(exc, "reason", "")) or ""
    detail = detail.strip()
    if detail and len(detail) > 400:
        detail = detail[:400] + "…"
    return detail

def _erp_get_doc(doctype: str, name: str) -> Dict[str, Any]:
    """Fetch a single document (e.g., Item/SKU)"""
    if not ERP_BASE:
        return {}
    import urllib.parse, urllib.request, json
    base = ERP_BASE.rstrip("/")
    path = "/api/resource/{}/{}".format(
        urllib.parse.quote(doctype, safe=""),
        urllib.parse.quote(name, safe="")
    )
    url = base + path
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/json",
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}" if ERP_API_KEY and ERP_API_SECRET else ""
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("data") or data

def pull_items_incremental(conn: sqlite3.Connection, limit: int = ITEM_PULL_PAGE_LIMIT):
    """Pull Item (templates + variants) changed since cursor. Upsert into items; barcodes handled separately."""
    last_mod, last_name = _cursor_get(conn, "Item")
    filters = []
    if last_mod:
        filters = [["modified",">=",last_mod]]
    fields = [
        "name","item_code","item_name","brand","item_group","custom_style_code","custom_simple_colour",
        "has_variants","variant_of","disabled","image","standard_rate","stock_uom","modified","barcodes"
    ]
    params = {"fields": json.dumps(fields), "filters": json.dumps(filters), "limit_page_length": limit, "order_by": "modified asc, name asc"}
    data = _erp_get("/api/resource/Item", params).get("data", [])
    if not data:
        return 0
    variants_to_hydrate: List[tuple[str, Optional[str]]] = []
    item_rows: List[Dict[str, Any]] = []
    prefetched_item_docs: Dict[str, Optional[Dict[str, Any]]] = {}

    def _fetch_item_doc_cached(item_id: str) -> Optional[Dict[str, Any]]:
        if not item_id:
            return None
        if item_id in prefetched_item_docs:
            return prefetched_item_docs[item_id]
        doc = None
        try:
            doc = _erp_get_doc("Item", item_id)
        except Exception as exc:
            print(f"Failed to refetch Item {item_id} for metadata fallback: {exc}", file=sys.stderr)
        prefetched_item_docs[item_id] = doc
        return doc

    for d in data:
        parent = d.get("variant_of")
        if "variant_of" not in d and not _FULL_SYNC_FAST:
            doc = _fetch_item_doc_cached(d.get("name"))
            if doc:
                parent = doc.get("variant_of") or parent
                if "barcodes" not in d and doc.get("barcodes"):
                    d["barcodes"] = doc.get("barcodes")
                if d.get("image") in (None, "") and doc.get("image"):
                    d["image"] = doc.get("image")
        price = d.get("standard_rate")
        try:
            price = float(price) if price is not None else None
        except Exception:
            price = None
        itm = {
          "item_id": d["name"],
          "parent_id": parent,
          "name": d.get("item_name") or d["name"],
          "brand": d.get("brand"),
          "item_group": d.get("item_group"),
          "custom_style_code": d.get("custom_style_code"),
          "custom_simple_colour": d.get("custom_simple_colour"),
          "vat_rate": None,
            "attributes": None,
            "price": price,
            "image_url": d.get("image"),
            "is_template": 1 if (d.get("has_variants") and not parent) else 0,
            "active": 0 if d.get("disabled") else 1,
            "modified_utc": d.get("modified")
        }
        upsert_item(conn, itm)
        item_rows.append({"item_id": d["name"], "parent_id": parent})
        ensure_barcode_placeholder(conn, d.get("item_code") or d.get("name"), d["name"])
        if parent:
            variants_to_hydrate.append((d["name"], parent))
        _ingest_child_barcodes(conn, d.get("barcodes"), d["name"])
    if variants_to_hydrate and not _FULL_SYNC_FAST:
        _hydrate_variant_attributes(conn, variants_to_hydrate, prefetched_docs=prefetched_item_docs)
    if item_rows and not _FULL_SYNC_FAST:
        _hydrate_item_tax_rates(conn, item_rows)
    _cursor_set(conn, "Item", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

def _infer_variant_attributes_from_name(item_id: str) -> Optional[List[Dict[str, Any]]]:
    """Best-effort parse variant naming convention Brand-Style-...-Color-Size to recover attributes."""
    if not item_id:
        return None
    parts = [p.strip() for p in item_id.split("-") if p and p.strip()]
    if len(parts) < 2:
        return None

    def _numeric_token(token: str) -> bool:
        text = token.strip()
        return text.isdigit()

    parts_work: List[str] = parts[:]
    rows: List[Dict[str, Any]] = []
    size = None
    if parts_work:
        size_chunks = [parts_work.pop()]
        # Join trailing numeric segments so "36-40" stays intact instead of splitting color/size.
        while parts_work and _numeric_token(size_chunks[-1]) and _numeric_token(parts_work[-1]):
            size_chunks.append(parts_work.pop())
        size = "-".join(reversed(size_chunks)).strip()
    color = parts_work.pop() if parts_work else None
    if color:
        rows.append({"attribute": "Colour", "attribute_value": color})
        rows.append({"attribute": "Color", "attribute_value": color})
    if size:
        rows.append({"attribute": "EU half Sizes", "attribute_value": size})
        rows.append({"attribute": "Size", "attribute_value": size})
    return rows or None

def _hydrate_variant_attributes(
    conn: sqlite3.Connection,
    variant_rows: List[Tuple[str, Optional[str]]],
    prefetched_docs: Optional[Dict[str, Optional[Dict[str, Any]]]] = None
):
    """Fetch attributes for variants by hitting each Item doc (no child table permission required)."""
    if not variant_rows:
        return
    def _fallback_variant_attr_rows(item_id: str) -> Optional[List[Dict[str, Any]]]:
        params = {
            "fields": json.dumps(["attribute", "attribute_name", "attribute_value", "abbr", "idx", "parent"]),
            "filters": json.dumps([["parent","=",item_id]]),
            "limit_page_length": 200
        }
        try:
            data = _erp_get("/api/resource/Item Variant Attribute", params).get("data", [])
            return data
        except urllib.error.HTTPError as exc:
            detail = _describe_http_error(exc)
            msg = f"Failed to fetch variant attribute child rows for {item_id}: {exc}"
            if detail:
                msg += f" | body: {detail}"
            print(msg, file=sys.stderr)
        except Exception as exc:
            print(f"Failed to fetch variant attribute child rows for {item_id}: {exc}", file=sys.stderr)
        return None
    seen: Set[str] = set()
    touched_templates: Set[str] = set()
    for item_id, parent_id in variant_rows:
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        attr_rows: Optional[List[Dict[str, Any]]] = None
        doc_from_cache = prefetched_docs.get(item_id) if prefetched_docs else None
        doc: Optional[Dict[str, Any]] = doc_from_cache
        if doc is None and item_id in UNFETCHABLE_ITEM_DOCS:
            attr_rows = _infer_variant_attributes_from_name(item_id)
        elif doc is None:
            try:
                doc = _erp_get_doc("Item", item_id)
                if prefetched_docs is not None:
                    prefetched_docs[item_id] = doc
            except Exception as exc:
                http_status = getattr(exc, "code", None) if isinstance(exc, urllib.error.HTTPError) else None
                if isinstance(exc, urllib.error.HTTPError):
                    detail = _describe_http_error(exc)
                    msg = f"Failed to fetch Item doc for {item_id}: {exc}"
                    if detail:
                        msg += f" | body: {detail}"
                    print(msg, file=sys.stderr)
                    if http_status in (403, 404):
                        UNFETCHABLE_ITEM_DOCS.add(item_id)
                attr_rows = None
                if http_status not in (403, 404):
                    attr_rows = _fallback_variant_attr_rows(item_id)
                if attr_rows is None:
                    inferred = _infer_variant_attributes_from_name(item_id)
                    if inferred:
                        attr_rows = inferred
                    else:
                        if not isinstance(exc, urllib.error.HTTPError) or http_status not in (403, 404):
                            print(f"Failed to fetch attributes for {item_id}: {exc}", file=sys.stderr)
                        continue
        if doc:
            # Persist any barcode field present on the Item doc (single field or child table).
            if doc.get("barcode"):
                try:
                    primary = str(doc.get("barcode")).strip()
                except Exception:
                    primary = None
                if primary:
                    upsert_barcode(conn, primary, item_id)
            _ingest_child_barcodes(conn, doc.get("barcodes"), item_id)
            if attr_rows is None:
                attr_rows = doc.get("attributes") or doc.get("variant_attributes") or doc.get("attributes_json") or []
        if attr_rows is None:
            attr_rows = []
        conn.execute("DELETE FROM variant_attributes WHERE item_id=?", (item_id,))
        attr_map: Dict[str, str] = {}
        for row in attr_rows:
            attr_name = row.get("attribute") or row.get("attribute_name") or row.get("attribute_id")
            value = row.get("attribute_value") or row.get("value")
            if not attr_name or value in (None, ""):
                continue
            ensure_attribute_definition(conn, attr_name, row.get("attribute") or row.get("attribute_name"))
            conn.execute("""
                INSERT OR REPLACE INTO variant_attributes (item_id, attr_name, value)
                VALUES (?,?,?)
            """, (item_id, attr_name, str(value)))
            attr_map[attr_name] = str(value)
            if parent_id:
                ensure_template_attribute(
                    conn,
                    parent_id,
                    attr_name,
                    bool(row.get("reqd", 1)),
                    row.get("idx") or row.get("sort_order")
                )
        if attr_map:
            conn.execute(
                "UPDATE items SET attributes=? WHERE item_id=?",
                (json.dumps(attr_map, separators=(',', ':')), item_id)
            )
        if parent_id:
            touched_templates.add(parent_id)
    if touched_templates:
        _refresh_template_attribute_cache(conn, touched_templates)
    conn.commit()

def _extract_item_vat_rate(doc: Dict[str, Any]) -> Optional[float]:
    if not doc:
        return None
    # Try explicit field names first
    for key in ("vat_rate", "tax_rate"):
        if doc.get(key) is not None:
            try:
                return float(doc.get(key))
            except (TypeError, ValueError):
                pass
    taxes = doc.get("taxes") or []
    for row in taxes:
        rate = row.get("tax_rate")
        if rate is None:
            rate = row.get("rate")
        if rate is None and isinstance(row.get("tax_rate"), str):
            rate = row.get("tax_rate")
        if rate is None:
            continue
        try:
            return float(rate)
        except (TypeError, ValueError):
            continue
    taxes_json = doc.get("taxes_json")
    if taxes_json:
        try:
            parsed = json.loads(taxes_json)
            if isinstance(parsed, dict):
                for val in parsed.values():
                    try:
                        return float(val)
                    except (TypeError, ValueError):
                        continue
        except Exception:
            pass
    return None

def _hydrate_item_tax_rates(conn: sqlite3.Connection, item_rows: List[Dict[str, Any]]):
    """Fetch VAT/tax rates for items and store on items.vat_rate."""
    if not item_rows:
        return
    seen: Set[str] = set()
    for row in item_rows:
        item_id = row.get("item_id") or row.get("name")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        parent_id = row.get("parent_id")
        vat_rate = None
        if item_id in UNFETCHABLE_ITEM_DOCS:
            vat_rate = None
        else:
            try:
                doc = _erp_get_doc("Item", item_id)
                vat_rate = _extract_item_vat_rate(doc)
            except urllib.error.HTTPError as exc:
                status = getattr(exc, "code", None)
                if status in (403, 404):
                    UNFETCHABLE_ITEM_DOCS.add(item_id)
                else:
                    print(f"Failed to fetch tax info for {item_id}: {exc}", file=sys.stderr)
                vat_rate = None
            except Exception as exc:
                print(f"Failed to fetch tax info for {item_id}: {exc}", file=sys.stderr)
                vat_rate = None
        try:
            if vat_rate is not None:
                conn.execute("UPDATE items SET vat_rate=? WHERE item_id=?", (vat_rate, item_id))
            elif parent_id:
                conn.execute("""
                    UPDATE items
                    SET vat_rate = COALESCE(vat_rate, (SELECT vat_rate FROM items WHERE item_id=?))
                    WHERE item_id=? AND vat_rate IS NULL
                """, (parent_id, item_id))
        except Exception:
            continue
    conn.commit()

def _refresh_template_attribute_cache(conn: sqlite3.Connection, template_ids: Set[str]):
    """Store aggregated attribute values on template rows for quick inspection/UI."""
    if not template_ids:
        return
    for template_id in template_ids:
        rows = conn.execute("""
            SELECT va.attr_name, va.value
            FROM variant_attributes va
            JOIN items v ON v.item_id = va.item_id
            WHERE v.parent_id=? AND v.is_template=0
        """, (template_id,)).fetchall()
        if not rows:
            continue
        agg: Dict[str, Set[str]] = {}
        for attr_name, value in rows:
            agg.setdefault(attr_name, set()).add(value)
        payload = {k: sorted(v) for k, v in agg.items()}
        conn.execute(
            "UPDATE items SET attributes=? WHERE item_id=?",
            (json.dumps(payload, separators=(',', ':')), template_id)
        )

def pull_item_attributes(conn: sqlite3.Connection, limit: int = 200):
    """Pull Item Attribute definitions + options."""
    last_mod, last_name = _cursor_get(conn, "Item Attribute")
    filters = []
    if last_mod:
        filters = [["modified",">=",last_mod]]
    params = {
        "fields": json.dumps(["name","attribute_name","modified"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "modified asc, name asc"
    }
    data = _erp_get("/api/resource/Item Attribute", params).get("data", [])
    if not data:
        return 0
    docnames: List[str] = []
    for row in data:
        attr_name = row.get("attribute_name") or row.get("name")
        ensure_attribute_definition(conn, attr_name, row.get("attribute_name") or row.get("name"))
        docnames.append(row.get("name") or attr_name)
    _hydrate_attribute_options(conn, docnames)
    _cursor_set(conn, "Item Attribute", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

def pull_bins_incremental(conn: sqlite3.Connection, warehouse: str, limit: int = 500):
    """Pull Bin (stock snapshot) changed since cursor for a specific warehouse; write to stock_snapshot."""
    conn.execute("""
    CREATE TABLE IF NOT EXISTS stock_snapshot (
      item_id     TEXT NOT NULL,
      warehouse   TEXT NOT NULL DEFAULT 'Shop',
      qty_base    NUMERIC NOT NULL,
      asof_utc    TEXT NOT NULL,
      PRIMARY KEY (item_id, warehouse)
    )""")
    last_mod, last_name = _cursor_get(conn, f"Bin:{warehouse}")
    filters = [["warehouse","=",warehouse]]
    if last_mod:
        filters.append(["modified",">=",last_mod])
    params = {
        "fields": json.dumps(["name","item_code","warehouse","actual_qty","reserved_qty","projected_qty","modified"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "modified asc, name asc"
    }
    global _BIN_PULL_FORBIDDEN
    try:
        data = _erp_get("/api/resource/Bin", params).get("data", [])
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            if not _BIN_PULL_FORBIDDEN:
                print("Bin pull forbidden (HTTP 403); skipping Bin sync", file=sys.stderr)
            _BIN_PULL_FORBIDDEN = True
            return 0
        raise
    if not data:
        return 0
    asof = iso_now()
    for b in data:
        item_code = b.get("item_code")
        if not item_code:
            continue
        ensure_item_stub(conn, item_code)
        sellable = float(b.get("projected_qty") if b.get("projected_qty") is not None else (b.get("actual_qty",0) - b.get("reserved_qty",0)))
        conn.execute("""
        INSERT INTO stock_snapshot (item_id, warehouse, qty_base, asof_utc)
        VALUES (?,?,?,?)
        ON CONFLICT(item_id, warehouse) DO UPDATE SET qty_base=excluded.qty_base, asof_utc=excluded.asof_utc
        """, (item_code, warehouse, sellable, asof))
        conn.execute("""
        INSERT INTO stock (item_id, warehouse, qty)
        VALUES (?,?,?)
        ON CONFLICT(item_id, warehouse) DO UPDATE SET qty=excluded.qty
        """, (item_code, warehouse, sellable))
    _cursor_set(conn, f"Bin:{warehouse}", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

def pull_item_prices_incremental(conn: sqlite3.Connection, price_list: str, limit: int = 500):
    """Optional: maintain a prices table per list; not required if you store price on items."""
    conn.execute("""
    CREATE TABLE IF NOT EXISTS item_prices (
      item_id     TEXT NOT NULL,
      price_list  TEXT NOT NULL,
      rate        NUMERIC NOT NULL,
      valid_from  TEXT,
      valid_to    TEXT,
      modified_utc TEXT,
      PRIMARY KEY (item_id, price_list)
    )""")
    last_mod, last_name = _cursor_get(conn, f"Item Price:{price_list}")
    filters = [["price_list","=",price_list],["selling","=",1]]
    if last_mod:
        filters.append(["modified",">=",last_mod])
    params = {
        "fields": json.dumps(["name","item_code","price_list","price_list_rate","valid_from","valid_upto","modified"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "modified asc, name asc"
    }
    data = _erp_get("/api/resource/Item Price", params).get("data", [])
    if not data:
        return 0
    for p in data:
        conn.execute("""
        INSERT INTO item_prices (item_id, price_list, rate, valid_from, valid_to, modified_utc)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(item_id, price_list) DO UPDATE SET rate=excluded.rate, valid_from=excluded.valid_from, valid_to=excluded.valid_to, modified_utc=excluded.modified_utc
        """, (p["item_code"], p["price_list"], float(p["price_list_rate"]), p.get("valid_from"), p.get("valid_upto"), p.get("modified")))
    _cursor_set(conn, f"Item Price:{price_list}", data[-1]["modified"], data[-1]["name"])
    _apply_price_list_rates(conn, price_list)
    conn.commit()
    return len(data)

def _apply_price_list_rates(conn: sqlite3.Connection, price_list: str):
    """Override the catalog price with the configured price list rate when available."""
    if not price_list:
        return
    conn.execute("""
    UPDATE items
    SET price = (
      SELECT rate FROM item_prices ip WHERE ip.item_id = items.item_id AND ip.price_list = ?
    )
    WHERE EXISTS (
      SELECT 1 FROM item_prices ip WHERE ip.item_id = items.item_id AND ip.price_list = ?
    )
    """, (price_list, price_list))

def _pull_item_barcodes_via_item_docs(conn: sqlite3.Connection, limit: int = 200) -> int:
    """Fallback barcode fetcher that rehydrates barcodes via Item list queries when child table access is blocked."""
    cursor_key = "Item Barcode (Item Doc)"
    last_mod, last_name = _cursor_get(conn, cursor_key)
    filters = []
    if last_mod:
        filters.append(["modified", ">=", last_mod])
    params = {
        "fields": json.dumps(["name", "modified"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "modified asc, name asc",
    }
    data = _erp_get("/api/resource/Item", params).get("data", [])
    if not data:
        return 0
    for row in data:
        item_id = row.get("name")
        if not item_id:
            continue
        try:
            doc = _erp_get_doc("Item", item_id)
        except urllib.error.HTTPError as exc:
            detail = _describe_http_error(exc)
            msg = f"Failed to fetch Item doc for {item_id}: {exc}"
            if detail:
                msg += f" | body: {detail}"
            print(msg, file=sys.stderr)
            if exc.code in (403, 404):
                UNFETCHABLE_ITEM_DOCS.add(item_id)
            continue
        except Exception as exc:
            print(f"Failed to fetch Item doc for {item_id}: {exc}", file=sys.stderr)
            continue
        primary = doc.get("barcode")
        if primary is not None:
            try:
                primary_txt = str(primary).strip()
            except Exception:
                primary_txt = None
            if primary_txt:
                upsert_barcode(conn, primary_txt, item_id)
        _ingest_child_barcodes(conn, doc.get("barcodes"), item_id)
    last = data[-1]
    _cursor_set(conn, cursor_key, last.get("modified") or iso_now(), last.get("name") or "")
    conn.commit()
    return len(data)


def pull_item_barcodes_incremental(conn: sqlite3.Connection, limit: int = 500):
    """Fetch barcodes from Item Barcode child table (v15). Falls back to Item docs if direct access is forbidden."""
    global _BARCODE_PULL_FORBIDDEN
    if _BARCODE_PULL_FORBIDDEN:
        return _pull_item_barcodes_via_item_docs(conn, limit=limit)
    last_mod, last_name = _cursor_get(conn, "Item Barcode")
    filters = []
    if last_mod:
        filters.append(["modified",">=",last_mod])
    params = {
        "fields": json.dumps(["name","parent","barcode","modified"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "modified asc, name asc"
    }
    try:
        data = _erp_get("/api/resource/Item Barcode", params).get("data", [])
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 417):
            if not _BARCODE_PULL_FORBIDDEN:
                code = exc.code
                print(f"Item Barcode pull forbidden (HTTP {code}); falling back to Item doc barcode sync", file=sys.stderr)
            _BARCODE_PULL_FORBIDDEN = True
            return _pull_item_barcodes_via_item_docs(conn, limit=limit)
        raise
    if not data:
        return 0
    for r in data:
        if r.get("barcode") and r.get("parent"):
            upsert_barcode(conn, r["barcode"], r["parent"])
    _cursor_set(conn, "Item Barcode", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

def pull_deleted_items(conn: sqlite3.Connection, limit: int = 500) -> int:
    """Incremental: fetch Deleted Document records for Item and mark local rows inactive.

    Uses a cursor on the Deleted Document doctype's creation timestamp so only
    newly-deleted items are checked on each sync cycle. Fast — one API call per
    batch of deletions, returns nothing when no items have been deleted since
    last run.

    Returns count of local items deactivated.
    """
    last_mod, last_name = _cursor_get(conn, "DeletedDocument:Item")
    filters: List[Any] = [["deleted_doctype", "=", "Item"]]
    if last_mod:
        filters.append(["creation", ">=", last_mod])
    params = {
        "fields": json.dumps(["name", "deleted_name", "creation"]),
        "filters": json.dumps(filters),
        "limit_page_length": limit,
        "order_by": "creation asc, name asc",
    }
    try:
        data = _erp_get("/api/resource/Deleted Document", params).get("data", [])
    except Exception as exc:
        print(f"[sync] pull_deleted_items skipped (Deleted Document unavailable): {exc}", file=sys.stderr)
        return 0
    if not data:
        return 0
    marked = 0
    for row in data:
        deleted_name = (row.get("deleted_name") or "").strip()
        if not deleted_name:
            continue
        deletion_ts = row.get("creation") or ""
        # Guard: if the local item's modified_utc is newer than the deletion
        # timestamp, the same item_id was re-created in ERPNext after being
        # deleted (e.g. re-import with the same code). Skip — the local row
        # already represents the new item.
        local = conn.execute(
            "SELECT modified_utc FROM items WHERE item_id=?", (deleted_name,)
        ).fetchone()
        if local and local["modified_utc"] and local["modified_utc"] >= deletion_ts:
            continue
        result = conn.execute(
            "UPDATE items SET active=0 WHERE item_id=? AND active=1",
            (deleted_name,)
        )
        if result.rowcount:
            marked += 1
    conn.commit()
    _cursor_set(conn, "DeletedDocument:Item", data[-1]["creation"], data[-1]["name"])
    if marked:
        print(f"[sync] pull_deleted_items: deactivated {marked} item(s)")
    return marked


def reconcile_items_against_erp(conn: sqlite3.Connection, page_size: int = 1000) -> int:
    """Name-only reconciliation: fetch every Item name from ERPNext and deactivate
    any local active items that no longer exist there.

    Much lighter than a full sync — only the 'name' field is fetched per page
    (~10 API calls for 10 000 items vs. 50+ for a full sync). Intended to run
    once at the end of full_sync_from_erp as a safety net for items that were
    hard-deleted without leaving a Deleted Document record.

    Returns count of items deactivated. Aborts entirely if ERPNext returns an
    empty set to prevent mass-deactivation on a network failure.
    """
    erp_names: Set[str] = set()
    offset = 0
    while True:
        params = {
            "fields": json.dumps(["name"]),
            "limit_page_length": page_size,
            "limit_start": offset,
        }
        try:
            data = _erp_get("/api/resource/Item", params).get("data", [])
        except Exception as exc:
            print(f"[sync] reconcile_items_against_erp aborted at offset {offset}: {exc}", file=sys.stderr)
            return 0  # partial reconciliation would wrongly deactivate items
        for row in data:
            n = (row.get("name") or "").strip()
            if n:
                erp_names.add(n)
        if len(data) < page_size:
            break
        offset += page_size

    if not erp_names:
        print("[sync] reconcile_items_against_erp: ERP returned 0 items — aborting to avoid mass deactivation", file=sys.stderr)
        return 0

    local_rows = conn.execute("SELECT item_id FROM items WHERE active=1").fetchall()
    to_deactivate = [r["item_id"] for r in local_rows if r["item_id"] not in erp_names]
    if not to_deactivate:
        return 0

    for item_id in to_deactivate:
        conn.execute("UPDATE items SET active=0 WHERE item_id=?", (item_id,))
    conn.commit()
    print(f"[sync] reconcile_items_against_erp: deactivated {len(to_deactivate)} item(s) not found in ERPNext")
    return len(to_deactivate)


def sync_cycle(conn: sqlite3.Connection, warehouse: str = "Shop", price_list: Optional[str] = None, loops: int = 1):
    """Run a bounded number of incremental pulls (useful from a cron/loop)."""
    for _ in range(loops):
        n1 = pull_items_incremental(conn)
        n_attr_defs = pull_item_attributes(conn)
        n2 = pull_item_barcodes_incremental(conn)
        n3 = pull_bins_incremental(conn, warehouse=warehouse)
        n4 = 0
        if price_list:
            n4 = pull_item_prices_incremental(conn, price_list=price_list)
        n_deleted = pull_deleted_items(conn)
        print(f"Pulled: Items={n1}, AttrDefs={n_attr_defs}, Barcodes={n2}, Bins={n3}, Prices={n4}, Deleted={n_deleted}")
        if (n1 + n_attr_defs + n2 + n3 + n4) == 0:
            break

def _clear_sync_cursors(conn: sqlite3.Connection, keys: List[str]) -> None:
    if not keys:
        return
    placeholders = ",".join("?" for _ in keys)
    conn.execute(f"DELETE FROM sync_cursors WHERE doctype IN ({placeholders})", keys)
    conn.commit()

def full_sync_from_erp(
    conn: sqlite3.Connection,
    warehouse: str = "Shop",
    price_list: Optional[str] = None,
    item_limit: int = ITEM_PULL_PAGE_LIMIT,
    attr_limit: int = 200,
    barcode_limit: int = 500,
    bin_limit: int = 500,
    price_limit: int = 500,
    max_loops: int = 10000,
    progress_cb: Optional[Any] = None,
) -> Dict[str, int]:
    """Reset cursors and perform a full pull until no more ERPNext rows remain."""
    global _BARCODE_PULL_FORBIDDEN, _BIN_PULL_FORBIDDEN, _FULL_SYNC_FAST
    fast_mode = os.getenv("POS_FULL_SYNC_FAST", "0") == "1"
    _BARCODE_PULL_FORBIDDEN = False
    _BIN_PULL_FORBIDDEN = False
    _FULL_SYNC_FAST = fast_mode
    UNFETCHABLE_ITEM_DOCS.clear()
    cursor_keys = ["Item", "Item Attribute", "Item Barcode", "Item Barcode (Item Doc)"]
    if warehouse:
        cursor_keys.append(f"Bin:{warehouse}")
    if price_list:
        cursor_keys.append(f"Item Price:{price_list}")
    _clear_sync_cursors(conn, cursor_keys)

    totals = {"items": 0, "attr_defs": 0, "barcodes": 0, "bins": 0, "prices": 0}
    def _progress(stage: str, pulled: int, total: int) -> None:
        if progress_cb:
            progress_cb(stage, pulled, total)
        print(f"Full sync {stage}: pulled {pulled}, total {total}")
    try:
        loops = 0
        while True:
            loops += 1
            if loops > max_loops:
                break
            pulled = pull_items_incremental(conn, limit=item_limit)
            totals["items"] += pulled
            _progress("items", pulled, totals["items"])
            if pulled < item_limit:
                break

        loops = 0
        while True:
            loops += 1
            if loops > max_loops:
                break
            pulled = pull_item_attributes(conn, limit=attr_limit)
            totals["attr_defs"] += pulled
            _progress("attributes", pulled, totals["attr_defs"])
            if pulled < attr_limit:
                break

        loops = 0
        while True:
            loops += 1
            if loops > max_loops:
                break
            pulled = pull_item_barcodes_incremental(conn, limit=barcode_limit)
            totals["barcodes"] += pulled
            _progress("barcodes", pulled, totals["barcodes"])
            if pulled < barcode_limit:
                break

        loops = 0
        while True:
            loops += 1
            if loops > max_loops:
                break
            pulled = pull_bins_incremental(conn, warehouse=warehouse, limit=bin_limit)
            totals["bins"] += pulled
            _progress("bins", pulled, totals["bins"])
            if pulled < bin_limit:
                break

        if price_list:
            loops = 0
            while True:
                loops += 1
                if loops > max_loops:
                    break
                pulled = pull_item_prices_incremental(conn, price_list=price_list, limit=price_limit)
                totals["prices"] += pulled
                _progress("prices", pulled, totals["prices"])
                if pulled < price_limit:
                    break

        # After all upserts: reconcile local items against the full ERPNext item list
        # to deactivate anything that was hard-deleted since the last full sync.
        n_reconciled = reconcile_items_against_erp(conn)
        totals["reconciled"] = n_reconciled
        _progress("reconcile", n_reconciled, n_reconciled)
        return totals
    finally:
        _FULL_SYNC_FAST = False


def main():
    ap = argparse.ArgumentParser(description="POS scaffold service")
    ap.add_argument("--init", action="store_true", help="Initialize database schema")
    ap.add_argument("--schema", default="schema.sql", help="Path to schema.sql")
    ap.add_argument("--seed", action="store_true", help="Insert demo catalog and voucher")
    ap.add_argument("--demo-sale", action="store_true", help="Create a demo sale")
    ap.add_argument("--push", action="store_true", help="Push outbox to ERPNext")
    ap.add_argument("--sync", action="store_true", help="Run an incremental pull once")
    ap.add_argument("--warehouse", default="Shop", help="Warehouse for Bin snapshots")
    ap.add_argument("--price-list", default=None, help="Price List to pull (optional)")
    ap.add_argument("--backup", action="store_true", help="Write NDJSON backups for today")
    ap.add_argument("--db", default=DB_PATH, help="Path to SQLite DB")
    args = ap.parse_args()

    conn = connect(args.db)

    if args.init:
        init_db(conn, args.schema)
        print("Initialized schema from", args.schema)

    if args.seed:
        demo_seed(conn)

    if args.demo_sale:
        demo_sale(conn)

    if args.push:
        push_outbox(conn)

    if args.sync:
        sync_cycle(conn, warehouse=args.warehouse, price_list=args.price_list, loops=3)

    if args.backup:
        backup_ndjson(conn)

if __name__ == "__main__":
    main()


# ========== CURRENCY CONVERSION ==========

def round_to_nearest_multiple(value: float, multiple: float) -> float:
    """Round value to nearest `multiple` units. If multiple is small (0.05) this is cents.

    Examples:
      round_to_nearest_multiple(12.34, 0.05) -> 12.35
      round_to_nearest_multiple(249.35, 5.0) -> 250.0
    """
    if multiple == 0:
        return value
    return round(value / multiple) * multiple


def round_down_to_nearest_multiple(value: float, multiple: float) -> float:
    """Round DOWN (floor) to nearest `multiple` units."""
    import math
    if multiple == 0:
        return value
    return math.floor(value / multiple) * multiple


def round_to_nearest_5(value: float) -> float:
    """Backward-compatible helper: nearest 5 cents (0.05)."""
    return round_to_nearest_multiple(value, 0.05)


def round_down_to_nearest_5(value: float) -> float:
    """Backward-compatible helper: round down to 5 cents (0.05)."""
    return round_down_to_nearest_multiple(value, 0.05)

def fetch_currency_rate(base: str = "GBP", target: str = "EUR") -> Optional[float]:
    """
    Fetch the exchange rate using a free public service.

    Strategy:
      1. Try exchangerate.host JSON API (requires API key - deprecated, now falls through).
      2. Fall back to ECB daily XML (eurofxref) and compute pair via EUR relative rates.

    Returns the rate as a float meaning: 1 <base> = X <target>
    Returns None on failure.
    """
    # Trivial case
    if base == target:
        return 1.0

    # Create SSL context that handles certificate verification issues
    # (useful for corporate proxies, custom CAs, etc.)
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    # 1) Try exchangerate.host (free API - now requires API key, so we skip this)
    # Keeping code for reference but it will fail and fall through to ECB
    try:
        url = f"https://api.exchangerate.host/latest?base={urllib.parse.quote(base)}&symbols={urllib.parse.quote(target)}"
        with urllib.request.urlopen(url, timeout=8, context=ssl_context) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        # Expected shape: { 'motd':..., 'success': True, 'base': 'GBP', 'rates': {'EUR': 1.18}, ... }
        rates = data.get("rates") or {}
        rate = rates.get(target)
        if rate:
            return float(rate)
    except Exception as e:
        print(f"exchangerate.host fetch failed for {base}->{target}: {e}", file=sys.stderr)

    # 2) Fallback: ECB daily XML (base EUR)
    try:
        ecb_url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
        with urllib.request.urlopen(ecb_url, timeout=8, context=ssl_context) as resp:
            xml = resp.read()
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml)
        # Find Cube elements like: <Cube currency='USD' rate='1.1234' />
        ns = { 'gesmes': 'http://www.gesmes.org/xml/2002-08-01', '': 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref' }
        # Simple approach: search for all Cube with currency attribute
        rates_per_eur: Dict[str, float] = { 'EUR': 1.0 }
        for cube in root.findall('.//{http://www.ecb.int/vocabulary/2002-08-01/eurofxref}Cube'):
            cur = cube.get('currency')
            r = cube.get('rate')
            if cur and r:
                try:
                    rates_per_eur[cur] = float(r)
                except Exception:
                    continue

        # If base or target not present, we cannot compute
        if base == 'EUR' and target in rates_per_eur:
            return float(rates_per_eur[target])
        if target == 'EUR' and base in rates_per_eur:
            # rates_per_eur[base] = base per EUR => 1 base = 1 / (base per EUR) EUR
            return float(1.0 / rates_per_eur[base])
        if base in rates_per_eur and target in rates_per_eur:
            # 1 base = (target_per_eur / base_per_eur) target
            return float(rates_per_eur[target] / rates_per_eur[base])
        print(f"ECB rates missing currencies for {base}->{target}", file=sys.stderr)
    except Exception as e:
        print(f"ECB fallback failed for {base}->{target}: {e}", file=sys.stderr)

    return None

def update_currency_rate(conn: sqlite3.Connection, base: str = "GBP", target: str = "EUR", rate: Optional[float] = None) -> bool:
    """
    Update or insert the exchange rate in the rates table.
    If rate is None, fetches it from the API.
    
    Returns True if successful, False otherwise.
    """
    if rate is None:
        rate = fetch_currency_rate(base, target)
        if rate is None:
            return False
    
    try:
        now_utc = iso_now()
        conn.execute("""
            INSERT INTO rates (base_currency, target_currency, rate_to_base, last_updated)
            VALUES (?,?,?,?)
            ON CONFLICT(base_currency, target_currency) DO UPDATE SET
                rate_to_base=excluded.rate_to_base,
                last_updated=excluded.last_updated
        """, (base, target, float(rate), now_utc))
        conn.commit()
        return True
    except Exception as e:
        print(f"Failed to update currency rate: {e}", file=sys.stderr)
        return False

def get_currency_rate(conn: sqlite3.Connection, base: str = "GBP", target: str = "EUR") -> Optional[float]:
    """
    Retrieve the current exchange rate from the database.
    Returns the rate (e.g., 1.18 means 1 GBP = 1.18 EUR), or None if not found.
    """
    try:
        row = conn.execute(
            "SELECT rate_to_base FROM rates WHERE base_currency=? AND target_currency=? ORDER BY last_updated DESC LIMIT 1",
            (base, target)
        ).fetchone()
        if row and row[0]:
            return float(row[0])
    except Exception:
        pass
    return None

def convert_currency(amount: float, rate: float, round_mode: str = "nearest", target_currency: str = "EUR") -> dict:
    """
    Convert an amount using the given exchange rate.
    
    Args:
        amount: The amount in the base currency (e.g., GBP)
        rate: The exchange rate (e.g., 1.18 for GBP->EUR)
        round_mode: 'nearest' (default), 'down', or 'none' (no rounding)
    
    Returns a dict:
      {
        'actual': converted amount without rounding,
        'rounded': rounded amount (to nearest 5),
        'rounded_down': rounded down amount,
        'rate': the exchange rate used,
        'savings': difference between actual and rounded down (potential discount)
      }
    """
    actual = amount * rate
    # Use euro-specific rounding when converting to EUR: nearest 5 EUR (unit steps)
    if (target_currency or '').upper() == 'EUR':
        multiple = 5.0
    else:
        # default to nearest 5 cents for other currencies
        multiple = 0.05

    rounded = round_to_nearest_multiple(actual, multiple)
    rounded_down = round_down_to_nearest_multiple(actual, multiple)
    savings = rounded - rounded_down  # Always positive; discount if rounding down
    
    result = {
        'actual': round(actual, 2),
        'rounded': round(rounded, 2),
        'rounded_down': round(rounded_down, 2),
        'rate': float(rate),
        'savings': round(savings, 2),  # Potential discount value
        'mode': round_mode
    }
    return result

def ensure_currency_rate_populated(conn: sqlite3.Connection, base: str = "GBP", target: str = "EUR") -> bool:
    """
    Ensure that a currency rate exists in the database.
    
    Logic:
      1. Check if rate exists for base->target pair
      2. If it exists, check if today's date matches the last_updated date
      3. If missing OR date has changed, fetch and update the rate
    
    Returns True if successful or rate already exists and is fresh, False otherwise.
    """
    try:
        today = dt.datetime.utcnow().date().isoformat()
        
        # Check if rate exists
        row = conn.execute(
            "SELECT rate_to_base, last_updated FROM rates WHERE base_currency=? AND target_currency=? ORDER BY last_updated DESC LIMIT 1",
            (base, target)
        ).fetchone()
        
        if row and row['rate_to_base']:
            # Rate exists, check if it's from today
            last_updated = row['last_updated']
            last_updated_date = last_updated.split('T')[0] if last_updated else None
            
            if last_updated_date == today:
                # Rate is fresh, no need to update
                return True
            else:
                # Date has changed, need to refresh
                print(f"Currency rate is stale (last updated {last_updated_date}, today is {today}). Refreshing...", file=sys.stderr)
        else:
            # Rate doesn't exist, need to fetch
            print(f"No currency rate found for {base}->{target}. Fetching...", file=sys.stderr)
        
        # Fetch and update the rate
        success = update_currency_rate(conn, base, target)
        if success:
            print(f"Currency rate {base}->{target} populated/refreshed successfully", file=sys.stderr)
            return True
        else:
            print(f"Failed to fetch currency rate {base}->{target}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"Error ensuring currency rate: {e}", file=sys.stderr)
        return False

def schedule_currency_rate_update(base: str = "GBP", target: str = "EUR", interval_seconds: int = 86400):
    """
    Suggested scheduling function (integrate with your task scheduler).
    This would typically be called by a cron job or background thread.
    
    Example usage in a separate worker:
      while True:
          update_currency_rate(conn, 'GBP', 'EUR')
          time.sleep(86400)  # Daily
    """
    import time
    import threading
    
    def worker():
        while True:
            try:
                conn = connect()
                update_currency_rate(conn, base, target)
                conn.close()
            except Exception as e:
                print(f"Currency update worker failed: {e}", file=sys.stderr)
            time.sleep(interval_seconds)
    
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


# ========== FX ROUNDING & EFFECTIVE RATE ==========

def compute_eur_suggestions(gbp_total: float, store_rate: float) -> Dict[str, Any]:
    """
    Given a GBP total and store rate, compute EUR suggestions (nearest 5 EUR up/down).
    
    Returns:
      {
        'eur_exact': exact EUR (gbp_total * store_rate),
        'eur_round_up': nearest 5 EUR ceiling,
        'eur_round_down': nearest 5 EUR floor,
        'store_rate': the input store_rate,
        'gbp_total': the input gbp_total
      }
    """
    eur_exact = gbp_total * store_rate
    eur_round_up = round_to_nearest_multiple(eur_exact, 5.0)
    eur_round_down = round_down_to_nearest_multiple(eur_exact, 5.0)
    
    return {
        'eur_exact': round(eur_exact, 2),
        'eur_round_up': round(eur_round_up, 2),
        'eur_round_down': round(eur_round_down, 2),
        'store_rate': float(store_rate),
        'gbp_total': float(gbp_total)
    }


def compute_effective_rate(gbp_total: float, eur_target: float) -> float:
    """
    Derive the effective exchange rate from a chosen EUR target.
    
    effective_rate = eur_target / gbp_total
    
    This is the rate that will be used for ALL conversions and change calculations
    within this sale.
    """
    if gbp_total <= 0:
        return 1.0
    return round(eur_target / gbp_total, 4)


def convert_eur_payment_to_gbp(eur_amount: float, effective_rate: float) -> float:
    """
    Convert a EUR payment to GBP equivalent using the sale's effective_rate.
    
    gbp_equiv = eur_amount / effective_rate
    """
    if effective_rate <= 0:
        return 0.0
    return round(eur_amount / effective_rate, 2)


def record_sale_with_fx(conn: sqlite3.Connection, sale: Dict[str, Any], fx_metadata: Optional[Dict[str, Any]] = None) -> str:
    """
    Enhanced record_sale that also persists FX metadata if provided.
    
    fx_metadata (optional):
      {
        'store_rate': 1.30,
        'effective_rate': 1.243,
        'eur_target': 55.0,
        'gbp_total': 44.23,
        'eur_exact': 57.50
      }
    """
    sale_id = record_sale(conn, sale)
    
    # If FX metadata provided, record it in sales_fx table
    if fx_metadata:
        try:
            conn.execute("""
                INSERT INTO sales_fx (sale_id, store_rate, effective_rate, eur_target, gbp_total, eur_exact, created_utc)
                VALUES (?,?,?,?,?,?,?)
            """, (
                sale_id,
                fx_metadata.get('store_rate'),
                fx_metadata.get('effective_rate'),
                fx_metadata.get('eur_target'),
                fx_metadata.get('gbp_total'),
                fx_metadata.get('eur_exact'),
                iso_now()
            ))
            conn.commit()
        except Exception as e:
            print(f"Failed to record FX metadata for sale {sale_id}: {e}", file=sys.stderr)

    return sale_id


# ── Layaway ERPNext helpers ────────────────────────────────────────────────────

# ERPDash is a separate Flask server from Frappe/ERPNext.
# Set LAYAWAY_ERP_URL to your ERPDash base URL (e.g., https://erpdash.example.com).
# Falls back to ERP_BASE if not set (works when ERPDash and ERPNext share a domain).
# Set LAYAWAY_ERP_KEY in env to override; defaults to POS_RECEIPT_KEY.
LAYAWAY_ERP_URL = os.environ.get("LAYAWAY_ERP_URL", "")
LAYAWAY_ERP_KEY = os.environ.get("LAYAWAY_ERP_KEY") or os.environ.get("POS_RECEIPT_KEY", "")


def _lay_base() -> str:
    """Return the base URL for ERPDash layaway requests."""
    return (LAYAWAY_ERP_URL or ERP_BASE or "").rstrip("/")


def _lay_headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if LAYAWAY_ERP_KEY:
        h["X-POS-KEY"] = LAYAWAY_ERP_KEY
    return h


def _lay_request(path: str, payload: Optional[Dict[str, Any]] = None, method: str = "POST") -> Dict[str, Any]:
    base = _lay_base()
    if not base:
        return {"ok": True, "dry_run": True}
    url = base + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=_lay_headers())
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=90, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"ERPDash layaway HTTP {exc.code}: {body[:400]}") from exc


def erp_layaway_create(layaway_id: str, customer_tag: str, items: List[Dict[str, Any]], total: float) -> Dict[str, Any]:
    return _lay_request("/api/layaway/create", {
        "layaway_ref": layaway_id,
        "customer_name": customer_tag,   # ERPDash expects customer_name
        "items": items,
        "grand_total": total,
    })


def erp_layaway_deposit(layaway_id: str, amount: float, method: str, reference_no: Optional[str] = None) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "amount": amount,
        "mode_of_payment": method,       # ERPDash expects mode_of_payment
    }
    if reference_no:
        body["reference_no"] = reference_no
    return _lay_request(f"/api/layaway/{layaway_id}/deposit", body)


def erp_layaway_complete(layaway_id: str, payload: Dict[str, Any] = None) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if payload and payload.get('pos_receipt_id'):
        body['pos_receipt_id'] = payload['pos_receipt_id']
    return _lay_request(f"/api/layaway/{layaway_id}/complete", body)


def erp_layaway_cancel(layaway_id: str) -> Dict[str, Any]:
    return _lay_request(f"/api/layaway/{layaway_id}/cancel", {})


def erp_layaway_amend(layaway_id: str, items: List[Dict[str, Any]], grand_total: float) -> Dict[str, Any]:
    return _lay_request(f"/api/layaway/{layaway_id}/amend", {
        "items": items,
        "grand_total": grand_total,
    })


def erp_layaway_collect(layaway_id: str, item_code: str, qty: float) -> Dict[str, Any]:
    return _lay_request(f"/api/layaway/{layaway_id}/collect", {
        "items": [{"item_code": item_code, "qty": qty}],
    })


def erp_layaway_snapshot() -> Dict[str, Any]:
    """Pull full layaway snapshot from ERPDash (GET /api/layaway/snapshot).
    Returns dict with 'layaways' list or raises RuntimeError."""
    return _lay_request("/api/layaway/snapshot", method="GET")


_LAYAWAY_MAX_ATTEMPTS = 5
_layaway_push_lock = threading.Lock()
# Set to True when _schedule_layaway_sync() is called while a sync is already running.
# The running sync will do a follow-up pass after it finishes so nothing is lost.
_layaway_rerun_needed = False


def _classify_layaway_error(kind: str, error_msg: str):
    """
    Classify an ERPDash error as terminal or retryable.

    Returns a tuple: (is_terminal: bool, action: str)
    action is one of: 'drop', 'mark_completed', 'mark_cancelled', 'cancel_all_ref'
    'drop'           — delete outbox entry, no local status change
    'mark_completed' — delete outbox entry, set layaway status='completed'
    'mark_cancelled' — delete outbox entry, set layaway status='cancelled', drop ALL entries for ref
    """
    msg = error_msg.lower()

    if kind == "layaway_create":
        # 409 "already exists" — previous attempt succeeded, SO is in ERP
        if "already exists" in msg or "409" in msg:
            return True, "drop"

    if kind == "layaway_payment":
        # 409 "Fully Billed" — SO has a full invoice, layaway is complete on ERP side
        if "fully billed" in msg:
            return True, "mark_completed"
        # 409 "already fully paid via advances" — the PE was actually submitted in ERPNext
        # but the HTTP response was lost (e.g. 504 gateway timeout on the submit call).
        # The money is already recorded; drop this retry to avoid a duplicate PE.
        if "fully paid via advances" in msg:
            return True, "drop"
        # 400 "exceeds outstanding balance" — amount was already capped on POS side so this
        # means ERPNext's record genuinely has less outstanding (e.g. a prior PE that the POS
        # didn't know about). Drop to avoid infinite retries on a mis-matched amount.
        if "exceeds outstanding balance" in msg:
            return True, "drop"
        # 409 "not submitted" / "not in submitted state" — SO was cancelled
        if "not submitted" in msg or "not in submitted state" in msg:
            return True, "mark_cancelled"

    if kind == "layaway_complete":
        # 409 "no items" or "Fully Billed" — already billed, treat as complete
        if "no items" in msg or "fully billed" in msg or "409" in msg:
            return True, "mark_completed"
        # 409 "not submitted" — SO cancelled before we could complete it
        if "not submitted" in msg or "not in submitted state" in msg:
            return True, "mark_cancelled"

    if kind == "layaway_cancel":
        # 409 "not in submitted state" / "already cancelled" — SO already gone
        if "not submitted" in msg or "not in submitted state" in msg or "already cancel" in msg:
            return True, "mark_cancelled"

    if kind == "layaway_amend":
        # 409 "not submitted" — SO cancelled, nothing to amend
        if "not submitted" in msg or "not in submitted state" in msg:
            return True, "mark_cancelled"

    if kind == "layaway_collect":
        # SI already exists for this item — idempotent, drop
        if "already_exists" in msg or "fully billed" in msg:
            return True, "drop"
        # Layaway SO gone — nothing to invoice
        if "not found" in msg:
            return True, "drop"

    return False, "retry"


def push_layaway_outbox(conn: sqlite3.Connection, limit: int = 20) -> None:
    """
    Process queued layaway operations with strict per-ref sequencing.

    Rules enforced:
    - Only one concurrent push at a time (module-level lock).
    - Per ref: create → deposits (one at a time) → complete.
      A later step is deferred if an earlier step for the same ref is still pending.
    - 503 responses are retried immediately up to 3 times with a 2-second pause.
    - When any entry for a ref fails, all later entries for that ref are skipped this pass.
    - If _schedule_layaway_sync() was called while this sync was running (concurrent skip),
      _layaway_rerun_needed is set and we do a follow-up pass after the current one finishes
      so no queued entries are stranded waiting for the idle loop.
    """
    global _layaway_rerun_needed
    base = _lay_base()
    print(f"[layaway-sync] push_layaway_outbox called. Target base URL: {base!r}", flush=True)
    if not base:
        print("[layaway-sync] No target URL configured — skipping", flush=True)
        return

    if not _layaway_push_lock.acquire(blocking=False):
        print("[layaway-sync] Concurrent sync detected — will rerun after current sync finishes", flush=True)
        _layaway_rerun_needed = True
        return
    try:
        _do_push_layaway_outbox(conn, limit)
        # If new entries were queued while we were running, process them now
        # rather than waiting for the idle loop (which only runs between cashier sessions).
        while _layaway_rerun_needed:
            _layaway_rerun_needed = False
            print("[layaway-sync] Rerun triggered — processing entries queued during previous pass", flush=True)
            _do_push_layaway_outbox(conn, limit)
    finally:
        _layaway_push_lock.release()


def _do_push_layaway_outbox(conn: sqlite3.Connection, limit: int) -> None:
    rows = conn.execute("""
        SELECT id, kind, ref_id, payload_json, attempts FROM outbox
        WHERE kind LIKE 'layaway_%'
        ORDER BY id ASC LIMIT ?
    """, (limit,)).fetchall()

    print(f"[layaway-sync] {len(rows)} pending outbox entries", flush=True)
    if not rows:
        return

    # Track which refs are blocked this pass (a failed entry blocks all later entries for that ref)
    blocked_refs: set = set()

    # Build pending index: ref -> sorted list of (id, kind) still in the fetched set
    # Used to enforce sequencing: don't fire complete if deposits are still pending, etc.
    pending: Dict[str, List[tuple]] = {}
    for r in rows:
        pending.setdefault(r["ref_id"], []).append((r["id"], r["kind"]))

    # Ordering weight: lower = must come first
    _order = {"layaway_create": 0, "layaway_payment": 1, "layaway_collect": 1,
              "layaway_complete": 2, "layaway_cancel": 2, "layaway_amend": 1}

    for r in rows:
        oid, kind, ref, payload_raw, attempts = r["id"], r["kind"], r["ref_id"], r["payload_json"], r["attempts"]
        payload = json.loads(payload_raw)

        # Skip if an earlier entry for this ref already failed this pass
        if ref in blocked_refs:
            print(f"[layaway-sync] DEFER (blocked): {kind} {ref} id={oid}", flush=True)
            continue

        # Sequential constraint: don't fire this entry if a lower-order entry for the same ref
        # is still pending (not yet processed in this pass)
        my_order = _order.get(kind, 99)
        earlier_pending = [
            (pid, pkind) for pid, pkind in pending.get(ref, [])
            if pid < oid and _order.get(pkind, 99) < my_order
        ]
        if earlier_pending:
            print(f"[layaway-sync] DEFER (sequencing): {kind} {ref} id={oid} — waiting for {[p[1] for p in earlier_pending]}", flush=True)
            continue

        print(f"[layaway-sync] Processing outbox id={oid} kind={kind} ref={ref} attempts={attempts}", flush=True)

        # Drop entries past the retry cap
        if attempts >= _LAYAWAY_MAX_ATTEMPTS:
            print(f"[layaway-sync] SKIP: {kind} {ref} — exceeded {_LAYAWAY_MAX_ATTEMPTS} attempts", file=sys.stderr, flush=True)
            conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
            conn.commit()
            pending[ref] = [(pid, pk) for pid, pk in pending.get(ref, []) if pid != oid]
            continue

        # --- Execute with 503 immediate-retry logic ---
        last_exc: Optional[Exception] = None
        success = False

        for attempt_n in range(3):
            try:
                if kind == "layaway_create":
                    resp = erp_layaway_create(
                        payload["layaway_id"],
                        payload["customer_tag"],
                        payload["items"],
                        payload["total"],
                    )
                    so_name = resp.get("so_name") or resp.get("data", {}).get("so_name")
                    erp_customer = resp.get("customer") or resp.get("data", {}).get("customer")
                    conn.execute(
                        "UPDATE layaways SET erp_so_name=COALESCE(?,erp_so_name), erp_customer=COALESCE(?,erp_customer), sync_status='synced' WHERE layaway_id=?",
                        (so_name, erp_customer, ref)
                    )
                elif kind == "layaway_payment":
                    ref_no = payload.get("reference_no") or payload.get("payment_id")
                    resp = erp_layaway_deposit(ref, payload["amount"], payload["method"], reference_no=ref_no)
                    pe_name = resp.get("payment_entry") or resp.get("data", {}).get("payment_entry")
                    conn.execute(
                        "UPDATE layaway_payments SET erp_pe_name=COALESCE(?,erp_pe_name), sync_status='synced' WHERE payment_id=?",
                        (pe_name, payload["payment_id"])
                    )
                    # If a layaway_complete is pending for this ref in the current batch,
                    # pause briefly so ERPNext has time to update advance_paid on the SO
                    # before the Sales Invoice is created. Without this, allocate_advances_automatically
                    # may miss the just-submitted PE, leaving the invoice with non-zero outstanding.
                    has_pending_complete = any(
                        pk == "layaway_complete"
                        for pid, pk in pending.get(ref, [])
                        if pid != oid
                    )
                    if has_pending_complete:
                        _complete_delay = int(os.environ.get("LAYAWAY_COMPLETE_DELAY", "4"))
                        print(f"[layaway-sync] Waiting {_complete_delay}s before layaway_complete for {ref} "
                              "to allow ERPNext to update advance_paid ...", flush=True)
                        time.sleep(_complete_delay)
                elif kind == "layaway_complete":
                    erp_layaway_complete(ref, payload)
                    conn.execute("UPDATE layaways SET sync_status='synced' WHERE layaway_id=?", (ref,))
                elif kind == "layaway_cancel":
                    erp_layaway_cancel(ref)
                    conn.execute("UPDATE layaways SET sync_status='synced' WHERE layaway_id=?", (ref,))
                elif kind == "layaway_amend":
                    erp_layaway_amend(ref, payload["items"], payload["total"])
                    conn.execute("UPDATE layaways SET sync_status='synced' WHERE layaway_id=?", (ref,))
                elif kind == "layaway_collect":
                    erp_layaway_collect(
                        payload["layaway_ref"],
                        payload["item_code"],
                        float(payload["qty"]),
                    )
                else:
                    print(f"[layaway-sync] Unknown kind {kind!r} id={oid} — dropping", flush=True)
                    conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
                    conn.commit()
                    pending[ref] = [(pid, pk) for pid, pk in pending.get(ref, []) if pid != oid]
                    success = True
                    break

                conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
                conn.commit()
                print(f"[layaway-sync] OK: {kind} {ref}", flush=True)
                pending[ref] = [(pid, pk) for pid, pk in pending.get(ref, []) if pid != oid]
                success = True
                break

            except Exception as exc:
                err_str = str(exc)
                is_503 = "503" in err_str
                if is_503 and attempt_n < 2:
                    print(f"[layaway-sync] 503 on {kind} {ref}, retry {attempt_n + 1}/3 in 2s ...", flush=True)
                    time.sleep(2)
                    last_exc = exc
                    continue
                last_exc = exc
                break

        if success:
            continue

        # Handle failure
        err_str = str(last_exc)
        is_terminal, action = _classify_layaway_error(kind, err_str)

        if is_terminal:
            print(f"[layaway-sync] TERMINAL: {kind} {ref} — {err_str} → action={action}", file=sys.stderr, flush=True)
            conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
            if action == "mark_completed":
                conn.execute(
                    "UPDATE layaways SET status='completed', sync_status='synced' WHERE layaway_id=? AND status NOT IN ('completed','cancelled')",
                    (ref,)
                )
            elif action == "mark_cancelled":
                conn.execute("DELETE FROM outbox WHERE kind LIKE 'layaway_%' AND ref_id=?", (ref,))
                conn.execute(
                    "UPDATE layaways SET status='cancelled', sync_status='synced' WHERE layaway_id=? AND status != 'cancelled'",
                    (ref,)
                )
                pending[ref] = []  # All entries for this ref are gone
                blocked_refs.add(ref)
            conn.commit()
            pending[ref] = [(pid, pk) for pid, pk in pending.get(ref, []) if pid != oid]
        else:
            conn.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (err_str, oid))
            conn.commit()
            print(f"[layaway-sync] FAILED: {kind} {ref} — {err_str}", file=sys.stderr, flush=True)
            # Block all subsequent entries for this ref this pass
            blocked_refs.add(ref)
