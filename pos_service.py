
#!/usr/bin/env python3
# POS scaffold: SQLite + JSON queue + ERPNext sync + NDJSON backups
import os, sys, json, uuid, sqlite3, time, argparse, datetime as dt
from pathlib import Path
from typing import List, Dict, Any, Optional
import urllib.request

DB_PATH = os.environ.get("POS_DB_PATH", "pos.db")
BACKUP_DIR = os.environ.get("POS_BACKUP_DIR", "pos_backup")

# ERPNext REST
ERP_BASE = os.environ.get("ERP_BASE")            # e.g., https://erp.yourdomain.com
ERP_API_KEY = os.environ.get("ERP_API_KEY")
ERP_API_SECRET = os.environ.get("ERP_API_SECRET")

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
    return _erp_request("/api/method/pos_ingest", payload)

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
    # Minimal catalog: one template with 2 variants + barcodes + stock
    now = iso_now()
    upsert_item(conn, {"item_id":"TEMPLATE-BOOT-1","parent_id":None,"name":"Chelsea Boot","brand":"Russells","attributes":None,"price":79.99,"image_url":"https://example/boot.jpg","is_template":1,"active":1,"modified_utc":now})
    upsert_item(conn, {"item_id":"BOOT-1-BLK-7","parent_id":"TEMPLATE-BOOT-1","name":"Chelsea Boot Black 7","brand":"Russells","attributes":json.dumps({"Size":"7","Color":"Black"}),"price":None,"image_url":None,"is_template":0,"active":1,"modified_utc":now})
    upsert_item(conn, {"item_id":"BOOT-1-BLK-8","parent_id":"TEMPLATE-BOOT-1","name":"Chelsea Boot Black 8","brand":"Russells","attributes":json.dumps({"Size":"8","Color":"Black"}),"price":None,"image_url":None,"is_template":0,"active":1,"modified_utc":now})
    upsert_barcode(conn, "505000000007", "BOOT-1-BLK-7")
    upsert_barcode(conn, "505000000008", "BOOT-1-BLK-8")
    upsert_stock(conn, "BOOT-1-BLK-7", 3, "Shop")
    upsert_stock(conn, "BOOT-1-BLK-8", 2, "Shop")

    # Voucher
    conn.execute("INSERT OR REPLACE INTO vouchers (voucher_code, issued_utc, initial_value, active, meta_json) VALUES (?,?,?,?,?)",
                 ("GV-ABC123", now, 100.0, 1, json.dumps({"note":"demo"})))
    conn.execute("INSERT INTO voucher_ledger (voucher_code, entry_utc, type, amount, sale_id, note) VALUES (?,?,?,?,?,?)",
                 ("GV-ABC123", now, "issue", 100.0, None, "Issued"))
    conn.commit()
    print("Demo seed inserted.")

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
    url = ERP_BASE.rstrip("/") + url_path + "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/json",
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}" if ERP_API_KEY and ERP_API_SECRET else ""
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

def pull_items_incremental(conn: sqlite3.Connection, limit: int = 200):
    """Pull Item (templates + variants) changed since cursor. Upsert into items; barcodes handled separately."""
    last_mod, last_name = _cursor_get(conn, "Item")
    filters = []
    if last_mod:
        filters = [["modified",">=",last_mod]]
    fields = ["name","item_name","brand","has_variants","variant_of","disabled","image","modified"]
    params = {"fields": json.dumps(fields), "filters": json.dumps(filters), "limit_page_length": limit, "order_by": "modified asc, name asc"}
    data = _erp_get("/api/resource/Item", params).get("data", [])
    if not data:
        return 0
    for d in data:
        parent = d.get("variant_of")
        itm = {
            "item_id": d["name"],
            "parent_id": parent,
            "name": d.get("item_name") or d["name"],
            "brand": d.get("brand"),
            "attributes": None,
            "price": None,
            "image_url": d.get("image"),
            "is_template": 1 if (d.get("has_variants") and not parent) else 0,
            "active": 0 if d.get("disabled") else 1,
            "modified_utc": d.get("modified")
        }
        upsert_item(conn, itm)
    _cursor_set(conn, "Item", data[-1]["modified"], data[-1]["name"])
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
    data = _erp_get("/api/resource/Bin", params).get("data", [])
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
    conn.commit()
    return len(data)

def pull_item_barcodes_incremental(conn: sqlite3.Connection, limit: int = 500):
    """Fetch barcodes from Item Barcode child table (v15)."""
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
    data = _erp_get("/api/resource/Item Barcode", params).get("data", [])
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
        n2 = pull_item_barcodes_incremental(conn)
        n3 = pull_bins_incremental(conn, warehouse=warehouse)
        n4 = 0
        if price_list:
            n4 = pull_item_prices_incremental(conn, price_list=price_list)
        print(f"Pulled: Items={n1}, Barcodes={n2}, Bins={n3}, Prices={n4}")
        if (n1 + n2 + n3 + n4) == 0:
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
