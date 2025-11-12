
#!/usr/bin/env python3
# POS scaffold: SQLite + JSON queue + ERPNext sync + NDJSON backups
import os, sys, json, uuid, sqlite3, time, argparse, datetime as dt
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple
import urllib.request
import urllib.error

DB_PATH = os.environ.get("POS_DB_PATH", "pos.db")
BACKUP_DIR = os.environ.get("POS_BACKUP_DIR", "pos_backup")
_BARCODE_PULL_FORBIDDEN = False
_BIN_PULL_FORBIDDEN = False

# ERPNext REST
ERP_BASE = os.environ.get("ERP_BASE")            # e.g., https://erp.yourdomain.com
ERP_API_KEY = os.environ.get("ERP_API_KEY")
ERP_API_SECRET = os.environ.get("ERP_API_SECRET")
# Fully-qualified method path for ingest (your_app.pos_sync.pos_ingest)
ERP_INGEST_METHOD = os.environ.get("ERP_INGEST_METHOD", "your_app.pos_sync.pos_ingest")

def iso_now() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def connect(db_path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

def init_db(conn: sqlite3.Connection, schema_path: str):
    with open(schema_path, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.commit()

# ---------- UPSERT HELPERS ----------
def upsert_item(conn: sqlite3.Connection, item: Dict[str, Any]):
    sql = """
    INSERT INTO items (item_id, parent_id, name, brand, attributes, price, image_url, is_template, active, modified_utc)
    VALUES (:item_id, :parent_id, :name, :brand, :attributes, :price, :image_url, :is_template, :active, :modified_utc)
    ON CONFLICT(item_id) DO UPDATE SET
      parent_id=excluded.parent_id,
      name=excluded.name,
      brand=excluded.brand,
      attributes=excluded.attributes,
      price=excluded.price,
      image_url=excluded.image_url,
      is_template=excluded.is_template,
      active=excluded.active,
      modified_utc=excluded.modified_utc;
    """
    conn.execute(sql, item)

def upsert_barcode(conn: sqlite3.Connection, barcode: str, item_id: str):
    sql = """
    INSERT INTO barcodes (barcode, item_id) VALUES (?,?)
    ON CONFLICT(barcode) DO UPDATE SET item_id=excluded.item_id;
    """
    conn.execute(sql, (barcode, item_id))

def ensure_barcode_placeholder(conn: sqlite3.Connection, barcode: Optional[str], item_id: str):
    """Insert a fallback barcode (item_code) if none exists, without overwriting real barcodes."""
    if not barcode or not item_id:
        return
    conn.execute("""
        INSERT OR IGNORE INTO barcodes (barcode, item_id) VALUES (?,?)
    """, (barcode, item_id))

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
        try:
            doc = _erp_get_doc("Item Attribute", name)
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
    pay_status = "paid" if abs(pay_total - total) < 0.005 else ("partially_paid" if pay_total > 0 else "unpaid")

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
        "voucher_redeem": sale.get("voucher_redeem", [])
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

        # Payments
        for idx, p in enumerate(payments, start=1):
            conn.execute("""
                INSERT INTO payments (sale_id, seq, method, amount, ref)
                VALUES (?,?,?,?,?)
            """, (sale_id, idx, p["method"], float(p["amount"]), p.get("ref")))

        # Voucher redemption
        for v in sale.get("voucher_redeem", []):
            code = v["code"]; amt = float(v["amount"])
            bal = voucher_balance(conn, code)
            if bal is None or bal < amt - 1e-6:
                raise ValueError(f"Voucher {code} insufficient balance or not found")
            voucher_ledger_add(conn, code, -amt, "redeem", sale_id=sale_id, note="POS redemption")

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
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}" if ERP_API_KEY and ERP_API_SECRET else ""
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

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
        SELECT id, ref_id, payload_json FROM outbox
        WHERE kind='sale' ORDER BY id ASC LIMIT ?
    """, (limit,)).fetchall()
    for r in rows:
        oid = r["id"]
        ref = r["ref_id"]
        payload = json.loads(r["payload_json"])
        try:
            conn.execute("UPDATE sales SET queue_status='posting' WHERE sale_id=?", (ref,))
            conn.commit()
            resp = post_sale_to_erpnext(payload)
            # Mark posted
            conn.execute("UPDATE sales SET queue_status='posted', erp_docname=COALESCE(erp_docname,'OK') WHERE sale_id=?", (ref,))
            conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
            conn.commit()
            print(f"Posted sale {ref}: {resp}")
        except Exception as e:
            conn.execute("UPDATE sales SET queue_status='failed' WHERE sale_id=?", (ref,))
            conn.execute("UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?", (str(e), oid))
            conn.commit()
            print(f"Failed posting sale {ref}: {e}", file=sys.stderr)

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

    print(f"Backed up to {sales_path} and {ledger_path}")

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

def _erp_get_doc(doctype: str, name: str) -> Dict[str, Any]:
    """Fetch a single document (e.g., Item/SKU)"""
    if not ERP_BASE:
        return {}
    import urllib.parse, urllib.request, json
    base = ERP_BASE.rstrip("/")
    path = "/api/resource/{}/{}/".format(
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

def pull_items_incremental(conn: sqlite3.Connection, limit: int = 200):
    """Pull Item (templates + variants) changed since cursor. Upsert into items; barcodes handled separately."""
    last_mod, last_name = _cursor_get(conn, "Item")
    filters = []
    if last_mod:
        filters = [["modified",">=",last_mod]]
    fields = ["name","item_code","item_name","brand","has_variants","variant_of","disabled","image","standard_rate","stock_uom","modified"]
    params = {"fields": json.dumps(fields), "filters": json.dumps(filters), "limit_page_length": limit, "order_by": "modified asc, name asc"}
    data = _erp_get("/api/resource/Item", params).get("data", [])
    if not data:
        return 0
    variants_to_hydrate: List[tuple[str, Optional[str]]] = []
    for d in data:
        parent = d.get("variant_of")
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
            "attributes": None,
            "price": price,
            "image_url": d.get("image"),
            "is_template": 1 if (d.get("has_variants") and not parent) else 0,
            "active": 0 if d.get("disabled") else 1,
            "modified_utc": d.get("modified")
        }
        upsert_item(conn, itm)
        ensure_barcode_placeholder(conn, d.get("item_code") or d.get("name"), d["name"])
        if parent:
            variants_to_hydrate.append((d["name"], parent))
    if variants_to_hydrate:
        _hydrate_variant_attributes(conn, variants_to_hydrate)
    _cursor_set(conn, "Item", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

def _hydrate_variant_attributes(conn: sqlite3.Connection, variant_rows: List[Tuple[str, Optional[str]]]):
    """Fetch attributes for variants by hitting each Item doc (no child table permission required)."""
    if not variant_rows:
        return
    seen: Set[str] = set()
    touched_templates: Set[str] = set()
    for item_id, parent_id in variant_rows:
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        try:
            doc = _erp_get_doc("Item", item_id)
        except Exception as exc:
            print(f"Failed to fetch attributes for {item_id}: {exc}", file=sys.stderr)
            continue
        attrs = doc.get("attributes") or doc.get("variant_attributes") or []
        conn.execute("DELETE FROM variant_attributes WHERE item_id=?", (item_id,))
        attr_map: Dict[str, str] = {}
        for row in attrs:
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
        sellable = float(b.get("projected_qty") if b.get("projected_qty") is not None else (b.get("actual_qty",0) - b.get("reserved_qty",0)))
        conn.execute("""
        INSERT INTO stock_snapshot (item_id, warehouse, qty_base, asof_utc)
        VALUES (?,?,?,?)
        ON CONFLICT(item_id, warehouse) DO UPDATE SET qty_base=excluded.qty_base, asof_utc=excluded.asof_utc
        """, (b["item_code"], warehouse, sellable, asof))
        conn.execute("""
        INSERT INTO stock (item_id, warehouse, qty)
        VALUES (?,?,?)
        ON CONFLICT(item_id, warehouse) DO UPDATE SET qty=excluded.qty
        """, (b["item_code"], warehouse, sellable))
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

def pull_item_barcodes_incremental(conn: sqlite3.Connection, limit: int = 500):
    """Fetch barcodes from Item Barcode child table (v15)."""
    global _BARCODE_PULL_FORBIDDEN
    if _BARCODE_PULL_FORBIDDEN:
        return 0
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
        if exc.code == 403:
            if not _BARCODE_PULL_FORBIDDEN:
                print("Item Barcode pull forbidden (HTTP 403); skipping barcode sync", file=sys.stderr)
            _BARCODE_PULL_FORBIDDEN = True
            return 0
        raise
    if not data:
        return 0
    for r in data:
        if r.get("barcode") and r.get("parent"):
            upsert_barcode(conn, r["barcode"], r["parent"])
    _cursor_set(conn, "Item Barcode", data[-1]["modified"], data[-1]["name"])
    conn.commit()
    return len(data)

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
        print(f"Pulled: Items={n1}, AttrDefs={n_attr_defs}, Barcodes={n2}, Bins={n3}, Prices={n4}")
        if (n1 + n_attr_defs + n2 + n3 + n4) == 0:
            break


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

def round_to_nearest_5(value: float) -> float:
    """Round a numeric value to the nearest 5 cents/lowest unit.
    E.g., 12.34 -> 12.35, 12.32 -> 12.30
    """
    return round(value * 20) / 20

def round_down_to_nearest_5(value: float) -> float:
    """Round DOWN a numeric value to the nearest 5 cents/lowest unit.
    E.g., 12.34 -> 12.30, 12.37 -> 12.35
    """
    import math
    return math.floor(value * 20) / 20

def fetch_currency_rate(base: str = "GBP", target: str = "EUR") -> Optional[float]:
    """
    Fetch the exchange rate using a free public service.

    Strategy:
      1. Try exchangerate.host JSON API (no API key required).
      2. Fall back to ECB daily XML (eurofxref) and compute pair via EUR relative rates.

    Returns the rate as a float meaning: 1 <base> = X <target>
    Returns None on failure.
    """
    # Trivial case
    if base == target:
        return 1.0

    # 1) Try exchangerate.host (free, no key required)
    try:
        url = f"https://api.exchangerate.host/latest?base={urllib.parse.quote(base)}&symbols={urllib.parse.quote(target)}"
        with urllib.request.urlopen(url, timeout=8) as resp:
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
        with urllib.request.urlopen(ecb_url, timeout=8) as resp:
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

def convert_currency(amount: float, rate: float, round_mode: str = "nearest") -> dict:
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
    rounded = round_to_nearest_5(actual)
    rounded_down = round_down_to_nearest_5(actual)
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
