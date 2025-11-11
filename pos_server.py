from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import requests
import os
import sqlite3
from pathlib import Path
import json as _json
from datetime import datetime
from uuid import uuid4
import threading
import re

# Load environment variables
load_dotenv()

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # disable static caching during development

# Behavior flags
USE_MOCK = os.getenv('USE_MOCK', '1') == '1'  # default to mock POS with no ERP dependency
POS_DB_PATH = os.getenv('POS_DB_PATH', 'pos.db')
SCHEMA_PATH = os.getenv('POS_SCHEMA_PATH', 'schema.sql')
PAUSED_DIR = os.getenv('POS_PAUSED_DIR', 'paused')

# ERPNext API configuration (used only if USE_MOCK is False)
ERPNEXT_URL = os.getenv('ERPNEXT_URL')
API_KEY = os.getenv('ERPNEXT_API_KEY')
API_SECRET = os.getenv('ERPNEXT_API_SECRET')

# Keep pos_service ERP env vars aligned with Flask env names
if ERPNEXT_URL and not os.getenv('ERP_BASE'):
    os.environ['ERP_BASE'] = ERPNEXT_URL
if API_KEY and not os.getenv('ERP_API_KEY'):
    os.environ['ERP_API_KEY'] = API_KEY
if API_SECRET and not os.getenv('ERP_API_SECRET'):
    os.environ['ERP_API_SECRET'] = API_SECRET

# Optional bootstrap tuning + cashier source configuration
POS_WAREHOUSE = os.getenv('POS_WAREHOUSE', 'Shop')
try:
    BOOTSTRAP_ITEM_BATCHES = int(os.getenv('POS_BOOTSTRAP_ITEM_BATCHES', '6'))
except ValueError:
    BOOTSTRAP_ITEM_BATCHES = 6
SKIP_BARCODE_SYNC = os.getenv('POS_SKIP_BARCODE_SYNC', '0') == '1'
CASHIER_DOCTYPE = os.getenv('POS_CASHIER_DOCTYPE', 'Cashier')
CASHIER_CODE_FIELD = os.getenv('POS_CASHIER_CODE_FIELD', 'code')
CASHIER_NAME_FIELD = os.getenv('POS_CASHIER_NAME_FIELD', 'cashier_name')
CASHIER_ACTIVE_FIELD = os.getenv('POS_CASHIER_ACTIVE_FIELD', 'active')
CASHIER_EXTRA_FIELDS = [
    field.strip() for field in (os.getenv('POS_CASHIER_EXTRA_FIELDS', '') or '').split(',')
    if field.strip()
]
CASHIER_FILTERS_RAW = (os.getenv('POS_CASHIER_FILTERS', '') or '').strip()

# Optional QZ Tray certificate + signing key (PEM strings)
QZ_CERTIFICATE = os.getenv('QZ_CERTIFICATE', '').strip() or None
QZ_PRIVATE_KEY = os.getenv('QZ_PRIVATE_KEY', '').strip() or None

# Optional SQLite service helpers
try:
    import pos_service as ps
    if ERPNEXT_URL:
        setattr(ps, 'ERP_BASE', ERPNEXT_URL)
    if API_KEY:
        setattr(ps, 'ERP_API_KEY', API_KEY)
    if API_SECRET:
        setattr(ps, 'ERP_API_SECRET', API_SECRET)
except Exception:
    ps = None

_BOOTSTRAP_LOCK = threading.Lock()
_BOOTSTRAP_DONE = False

class CashierQueryFieldError(Exception):
    """Raised when ERPNext rejects list queries due to field permissions."""
    def __init__(self, field: str, detail: str = ""):
        super().__init__(detail or field)
        self.field = field

def _db_connect():
    try:
        if not ps:
            return None
        if not USE_MOCK:
            _ensure_db_bootstrap()
        return ps.connect(POS_DB_PATH)
    except Exception:
        return None

def _db_has_items(conn: sqlite3.Connection) -> bool:
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM items WHERE active=1 AND is_template=0").fetchone()
        return (row and row['c'] and row['c'] > 0) or False
    except Exception:
        return False

def _db_items_payload(conn: sqlite3.Connection):
    """Return template items as tiles, with aggregated variant attribute values for search/display."""
    q_tpl = """
    SELECT i.item_id AS name,
           i.item_id AS item_code,
           i.name AS item_name,
           i.brand AS brand,
           (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS standard_rate,
           'Each' AS stock_uom,
           (SELECT image_url_effective FROM v_item_images img WHERE img.item_id=i.item_id) AS image
    FROM items i
    WHERE i.active=1 AND i.is_template=1
    ORDER BY COALESCE(i.brand,''), i.name
    """
    # Preload aggregated attribute values per template from its variants
    agg = {}
    q_attr = """
      SELECT t.item_id AS template_id, va.attr_name, va.value
      FROM items v
      JOIN items t ON t.item_id = v.parent_id
      JOIN variant_attributes va ON va.item_id = v.item_id
      WHERE v.active=1 AND v.is_template=0
    """
    for row in conn.execute(q_attr):
        tpl = row["template_id"]
        d = agg.setdefault(tpl, {})
        vals = d.setdefault(row["attr_name"], set())
        vals.add(row["value"])

    out = []
    for r in conn.execute(q_tpl):
        attrs = {}
        if r["name"] in agg:
            for aname, values in agg[r["name"]].items():
                attrs[aname] = " ".join(sorted(values))
        out.append({
            "name": r["name"],
            "item_code": r["item_code"],
            "item_name": r["item_name"],
            "brand": r["brand"],
            "barcode": None,
            "standard_rate": float(r["standard_rate"]) if r["standard_rate"] is not None else None,
            "stock_uom": r["stock_uom"],
            "image": _absolute_image_url(r["image"]),
            "attributes": attrs,
        })
    return out

def _db_has_cashiers(conn: sqlite3.Connection) -> bool:
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM cashiers WHERE active=1").fetchone()
        return (row and row['c'] and row['c'] > 0) or False
    except Exception:
        return False

def _ensure_schema(conn: sqlite3.Connection):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='items'"
    ).fetchone()
    if not row:
        ps.init_db(conn, SCHEMA_PATH)

def _ensure_db_bootstrap():
    """Create schema + seed catalog/cashiers from ERPNext on first real deployment run."""
    global _BOOTSTRAP_DONE
    if _BOOTSTRAP_DONE or USE_MOCK or not ps:
        return
    with _BOOTSTRAP_LOCK:
        if _BOOTSTRAP_DONE or USE_MOCK or not ps:
            return
        conn = None
        completed = False
        try:
            conn = ps.connect(POS_DB_PATH)
            _ensure_schema(conn)
            need_items = not _db_has_items(conn)
            need_cashiers = not _db_has_cashiers(conn)
            if need_items or need_cashiers:
                _bootstrap_sync_from_erp(conn, need_items=need_items, need_cashiers=need_cashiers)
            completed = True
        except Exception as exc:
            app.logger.warning("Initial ERP bootstrap failed: %s", exc)
        finally:
            if conn:
                conn.close()
        _BOOTSTRAP_DONE = completed

def _bootstrap_sync_from_erp(conn: sqlite3.Connection, need_items: bool, need_cashiers: bool):
    if need_items:
        _initial_sync_items(conn)
    if need_cashiers:
        _initial_sync_cashiers(conn)

def _initial_sync_items(conn: sqlite3.Connection):
    if not ERPNEXT_URL:
        app.logger.warning("Skipping ERP item bootstrap (ERPNEXT_URL not set)")
        return
    if not hasattr(ps, 'pull_items_incremental'):
        app.logger.warning("pos_service missing pull_items_incremental; cannot seed items")
        return
    total = 0
    batches = max(1, BOOTSTRAP_ITEM_BATCHES)
    for _ in range(batches):
        fetched = ps.pull_items_incremental(conn, limit=500)
        total += fetched
        if fetched < 500:
            break
    if hasattr(ps, 'pull_variant_attributes_incremental'):
        try:
            ps.pull_variant_attributes_incremental(conn, limit=500)
        except Exception as exc:
            # Try to detect an HTTP 403 (permission) error and log a clearer message
            err_code = getattr(exc, 'code', None)
            if not err_code:
                resp = getattr(exc, 'response', None)
                if resp is not None:
                    err_code = getattr(resp, 'status_code', None)
            if err_code == 403:
                app.logger.warning("Variant attribute bootstrap skipped (HTTP 403). Grant read access on 'Variant Attribute' in ERPNext.")
            else:
                app.logger.warning("Variant attribute bootstrap failed: %s", exc)
    if SKIP_BARCODE_SYNC:
        app.logger.info("Skipping barcode bootstrap (POS_SKIP_BARCODE_SYNC=1)")
    elif hasattr(ps, 'pull_item_barcodes_incremental'):
        try:
            ps.pull_item_barcodes_incremental(conn, limit=500)
        except Exception as exc:
            err_code = getattr(exc, 'code', None)
            if err_code == 403:
                app.logger.warning("Barcode bootstrap skipped (HTTP 403). Grant read access on 'Item Barcode' or set POS_SKIP_BARCODE_SYNC=1.")
            else:
                app.logger.warning("Barcode bootstrap failed: %s", exc)
    if hasattr(ps, 'pull_bins_incremental'):
        try:
            ps.pull_bins_incremental(conn, warehouse=POS_WAREHOUSE, limit=500)
        except Exception as exc:
            app.logger.warning("Stock bootstrap failed: %s", exc)
    app.logger.info("Seeded %d ERPNext items locally", total)

def _initial_sync_cashiers(conn: sqlite3.Connection):
    try:
        rows = _fetch_cashiers_from_erp()
    except Exception as exc:
        app.logger.warning("Cashier bootstrap failed: %s", exc)
        return
    if not rows:
        app.logger.info("ERPNext returned no active cashiers")
        return
    for entry in rows:
        meta = entry.get('meta') or {}
        conn.execute(
            "INSERT OR REPLACE INTO cashiers (code, name, active, meta) VALUES (?,?,?,?)",
            (entry['code'], entry['name'], 1 if entry.get('active', 1) else 0, _json.dumps(meta))
        )
    conn.commit()
    app.logger.info("Seeded %d ERPNext cashiers", len(rows))

def _fetch_cashiers_from_erp():
    if not ERPNEXT_URL:
        raise RuntimeError("ERPNEXT_URL not configured")
    if not CASHIER_DOCTYPE:
        raise RuntimeError("POS_CASHIER_DOCTYPE not configured")
    active_field = CASHIER_ACTIVE_FIELD or None
    filters = _build_cashier_filters(active_field)
    fields = _build_cashier_fields()
    order_field = _preferred_cashier_order_field(fields)
    need_detail_fetch = False
    while True:
        try:
            rows = _cashier_get_list(fields, filters, order_field)
            break
        except CashierQueryFieldError as err:
            fld = (err.field or '').strip()
            if fld and active_field and fld == active_field:
                app.logger.info("Cashier filter '%s' not permitted; retrying without it", active_field)
                filters = [f for f in filters if f[0] != active_field]
                active_field = None
                continue
            if fld and fld in fields:
                app.logger.info("Cashier field '%s' not permitted in list results; retrying without it", fld)
                fields = [f for f in fields if f != fld]
                if not fields:
                    fields = ['name']
                order_field = _preferred_cashier_order_field(fields)
                need_detail_fetch = True
                continue
            raise RuntimeError(f"Cashier pull failed: {err}") from err
    out = []
    if not rows:
        return out
    if any(req and req not in fields for req in (CASHIER_CODE_FIELD, CASHIER_NAME_FIELD)):
        need_detail_fetch = True
    for item in rows:
        doc = item
        if need_detail_fetch:
            doc = _cashier_fetch_doc(item.get('name'))
            if not doc:
                continue
        normalized = _normalize_cashier_doc(doc or {})
        if normalized:
            out.append(normalized)
    return out

def _build_cashier_fields():
    fields = ['name']
    for fname in (CASHIER_CODE_FIELD, CASHIER_NAME_FIELD, CASHIER_ACTIVE_FIELD):
        if fname and fname not in fields:
            fields.append(fname)
    for extra in CASHIER_EXTRA_FIELDS:
        if extra and extra not in fields:
            fields.append(extra)
    return fields

def _build_cashier_filters(active_field):
    filters = []
    if active_field:
        filters.append([active_field, '=', 1])
    if CASHIER_FILTERS_RAW:
        try:
            extra_filters = _json.loads(CASHIER_FILTERS_RAW)
            if isinstance(extra_filters, list):
                filters.extend(extra_filters)
        except Exception:
            app.logger.warning("Invalid POS_CASHIER_FILTERS JSON; ignoring")
    return filters

def _preferred_cashier_order_field(fields):
    for cand in [CASHIER_NAME_FIELD, CASHIER_CODE_FIELD, 'name1', 'full_name', 'name']:
        if cand and cand in fields:
            return cand
    return 'name'

def _cashier_get_list(fields, filters, order_field):
    payload = {
        'doctype': CASHIER_DOCTYPE,
        'fields': fields,
        'limit_page_length': 500,
    }
    if order_field:
        payload['order_by'] = f"{order_field} asc"
    if filters:
        payload['filters'] = filters
    resp = requests.post(
        f"{ERPNEXT_URL}/api/method/frappe.client.get_list",
        headers=_erp_headers(),
        json=payload,
        timeout=20
    )
    if resp.status_code >= 400:
        detail = ''
        try:
            detail = resp.text.strip()
        except Exception:
            detail = ''
        field_name = None
        if detail:
            m = re.search(r'Field not permitted in query:\s*([A-Za-z0-9_\.]+)', detail)
            if m:
                field_name = m.group(1)
        if field_name:
            raise CashierQueryFieldError(field_name, detail)
        resp.raise_for_status()
    try:
        body = resp.json()
    except ValueError:
        app.logger.warning("Cashier list response JSON decode failed")
        return []
    return body.get('message') or body.get('data') or []

def _cashier_fetch_doc(docname):
    if not docname:
        return None
    resp = requests.post(
        f"{ERPNEXT_URL}/api/method/frappe.client.get",
        headers=_erp_headers(),
        json={'doctype': CASHIER_DOCTYPE, 'name': docname},
        timeout=20
    )
    if resp.status_code >= 400:
        app.logger.warning("Failed fetching cashier doc %s: %s", docname, resp.text.strip() if resp.text else resp.status_code)
        return None
    try:
        body = resp.json()
    except ValueError:
        app.logger.warning("Cashier doc response JSON decode failed for %s", docname)
        return None
    return body.get('message') or body.get('data') or {}

def _normalize_cashier_doc(doc):
    if not doc:
        return None
    code = _first_value(doc, [CASHIER_CODE_FIELD, 'code', 'id', 'employee', 'user_id', 'name'])
    name = _first_value(doc, [CASHIER_NAME_FIELD, 'cashier_name', 'name1', 'full_name', 'employee_name', 'name'])
    if not code or not name:
        return None
    active_value = doc.get(CASHIER_ACTIVE_FIELD) if CASHIER_ACTIVE_FIELD else doc.get('active', 1)
    meta = {}
    for key in CASHIER_EXTRA_FIELDS:
        if key in doc:
            meta[key] = doc[key]
    return {
        'code': str(code).strip(),
        'name': str(name).strip(),
        'active': _as_bool(active_value),
        'meta': meta
    }

def _first_value(doc, keys):
    for key in keys:
        if not key:
            continue
        if key in doc and doc[key]:
            return doc[key]
    return None

def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ('0', 'false', 'no', 'inactive', 'disabled'):
        return False
    if text in ('', 'none'):
        return False
    return True


def _erp_headers():
    if not ERPNEXT_URL or not API_KEY or not API_SECRET:
        raise RuntimeError("Missing ERPNEXT_URL/ERPNEXT_API_KEY/ERPNEXT_API_SECRET in environment")
    return {
        'Authorization': f'token {API_KEY}:{API_SECRET}',
        'Content-Type': 'application/json'
    }

def _absolute_image_url(path):
    if not path:
        return None
    if isinstance(path, bytes):
        path = path.decode('utf-8', errors='ignore')
    text = str(path).strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered.startswith(('http://', 'https://', 'data:')):
        return text
    if text.startswith('//'):
        scheme = 'https:' if ERPNEXT_URL and ERPNEXT_URL.lower().startswith('https') else 'http:'
        return scheme + text
    normalized = text
    if not normalized.startswith('/'):
        if normalized.startswith('files/'):
            normalized = '/' + normalized
        else:
            normalized = '/' + normalized
    if ERPNEXT_URL:
        return ERPNEXT_URL.rstrip('/') + normalized
    return normalized


def _error_message_from_response(resp: requests.Response) -> str:
    try:
        j = resp.json()
        return j.get('message') or j.get('exception') or resp.text
    except Exception:
        return resp.text


# Disable caching for all responses during development to avoid stale assets
@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    # Prefer Cache-Control over Expires; remove Expires if present
    if 'Expires' in response.headers:
        del response.headers['Expires']
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.route('/')
def index():
    """Render the main POS interface"""
    return render_template(
        'pos.html',
        qz_certificate=QZ_CERTIFICATE,
        qz_private_key=QZ_PRIVATE_KEY
    )


@app.route('/api/items')
def get_items():
    """Get all items"""
    # Prefer local SQLite items if available
    try:
        conn = _db_connect()
        if conn and _db_has_items(conn):
            items = _db_items_payload(conn)
            return jsonify({'status': 'success', 'items': items})
    except Exception:
        pass
    # No hard-coded mock items. If ERPNext configured and not in mock mode, fetch from ERP.
    if not USE_MOCK and ERPNEXT_URL:
        try:
            response = requests.get(
                f"{ERPNEXT_URL}/api/resource/Item",
                headers=_erp_headers(),
                params={
                    'fields': '["name", "item_code", "item_name", "brand", "item_group", "image", "standard_rate", "stock_uom", "barcode"]',
                    'filters': '[["is_sales_item","=",1],["disabled","=",0]]'
                },
                timeout=15
            )
            response.raise_for_status()
            items = response.json().get('data', [])
            for item in items:
                item_code = item.get('item_code') or item.get('name')
                item['item_code'] = item_code
                barcode = item.get('barcode')
                if not barcode and isinstance(item.get('barcodes'), list):
                    for entry in item['barcodes']:
                        candidate = entry.get('barcode') if isinstance(entry, dict) else entry
                        if candidate:
                            barcode = candidate
                            break
                    # If ERPNext does not have barcodes configured, allow using the item_code as a scanable barcode
                    item['barcode'] = barcode or item_code or None
                item['image'] = _absolute_image_url(item.get('image'))
            return jsonify({'status': 'success', 'items': items})
        except requests.HTTPError as e:
            return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
        except Exception as e:
            return jsonify({'status': 'error', 'message': str(e)}), 500
    # Otherwise return empty list (prompt user to seed DB from Admin)
    return jsonify({'status': 'success', 'items': []})


@app.route('/api/cashier/login', methods=['POST'])
def api_cashier_login():
    """Login a cashier by code. Leading zeros are ignored."""
    try:
        code = (request.json or {}).get('code', '')
    except Exception:
        code = ''
    if code is None:
        code = ''
    code = str(code).strip()
    if not code:
        return jsonify({'status': 'error', 'message': 'Missing code'}), 400
    conn = _db_connect()
    if not conn:
        # fallback: allow Josh 19 even if DB not ready
        if code.lstrip('0') == '19':
            return jsonify({'status': 'success', 'cashier': {'code': '19', 'name': 'Josh'}})
        return jsonify({'status': 'error', 'message': 'Database not available'}), 500
    row = conn.execute(
        "SELECT code, name FROM cashiers WHERE active=1 AND (code = ? OR code = ltrim(?, '0'))",
        (code, code)
    ).fetchone()
    if not row and code.lstrip('0'):
        # Optional: try stripped form
        stripped = code.lstrip('0')
        row = conn.execute("SELECT code, name FROM cashiers WHERE active=1 AND code = ?", (stripped,)).fetchone()
    if not row:
        return jsonify({'status': 'error', 'message': 'Invalid code'}), 401
    return jsonify({'status': 'success', 'cashier': {'code': row['code'], 'name': row['name']}})


@app.route('/api/create-sale', methods=['POST'])
def create_sale():
    """Create a sales invoice"""
    if USE_MOCK:
        data = request.json or {}
        if not data.get('customer'):
            return jsonify({'status': 'error', 'message': 'Customer is required'}), 400
        if not data.get('items'):
            return jsonify({'status': 'error', 'message': 'Items are required'}), 400
        invoice_name = f"MOCK-{datetime.now().strftime('%Y%m%d')}-{uuid4().hex[:8].upper()}"
        # Persist a simple invoice file (placeholder JSON format)
        try:
            os.makedirs('invoices', exist_ok=True)
            record = {
                'invoice_name': invoice_name,
                'created_at': datetime.now().isoformat(),
                'mode': 'mock',
                'customer': data.get('customer'),
                'items': data.get('items', []),
                'payments': data.get('payments', []),
                'tender': data.get('tender'),
                'cash_given': data.get('cash_given'),
                'change': data.get('change'),
                'total': data.get('total'),
                'vouchers': data.get('vouchers', []),
                'cashier': data.get('cashier')
            }
            with open(os.path.join('invoices', f"{invoice_name}.json"), 'w', encoding='utf-8') as f:
                import json
                json.dump(record, f, ensure_ascii=False, indent=2)
        except Exception:
            # Don't fail the sale if writing the file has issues
            pass
        # Also index the sale into SQLite outbox for durable tracking (idempotency via invoice_name)
        try:
            if ps:
                conn = _db_connect() or ps.connect(POS_DB_PATH)
                sale_payload = {
                    'sale_id': invoice_name,  # idempotency key matches file name
                    'cashier': (data.get('cashier') or {}).get('code') or (data.get('cashier') or {}).get('name'),
                    'customer_id': data.get('customer'),
                    'lines': [
                        {
                            'item_id': it.get('item_code') or it.get('code') or it.get('name'),
                            'item_name': it.get('item_name') or it.get('name') or (it.get('item_code') or ''),
                            'brand': it.get('brand'),
                            'attributes': it.get('attributes') or {},
                            'qty': float(it.get('qty') or 0),
                            'rate': float(it.get('rate') or 0),
                            'barcode_used': None,
                        }
                        for it in (data.get('items') or [])
                    ],
                    'payments': [
                        {
                            'method': (p.get('mode_of_payment') or p.get('method') or 'Other'),
                            'amount': float(p.get('amount') or 0),
                            'ref': p.get('ref')
                        }
                        for p in (data.get('payments') or [])
                    ],
                    'warehouse': 'Shop',
                    'voucher_redeem': [
                        {
                            'code': v.get('code'),
                            'amount': float(v.get('amount') or 0)
                        }
                        for v in (data.get('vouchers') or []) if v.get('code')
                    ],
                }
                try:
                    ps.record_sale(conn, sale_payload)
                except Exception:
                    # Do not block POS on DB/indexing issues
                    pass
        except Exception:
            pass
        return jsonify({'status': 'success', 'message': 'Sale recorded (mock)', 'invoice_name': invoice_name})
    try:
        data = request.json
        invoice_data = {
            'doctype': 'Sales Invoice',
            'customer': data['customer'],
            'posting_date': datetime.now().strftime('%Y-%m-%d'),
            'items': data['items'],
            'is_pos': 1,
            'payments': data['payments']
        }
        # Create invoice
        response = requests.post(
            f"{ERPNEXT_URL}/api/resource/Sales Invoice",
            headers=_erp_headers(),
            json=invoice_data,
            timeout=20
        )
        response.raise_for_status()
        invoice = response.json().get('data', {})

        # Submit invoice
        submit_response = requests.post(
            f"{ERPNEXT_URL}/api/method/frappe.client.submit",
            headers=_erp_headers(),
            json={'doctype': 'Sales Invoice', 'name': invoice['name']},
            timeout=20
        )
        submit_response.raise_for_status()

        # Persist invoice file (placeholder JSON format)
        try:
            data = data or {}
            os.makedirs('invoices', exist_ok=True)
            record = {
                'invoice_name': invoice['name'],
                'created_at': datetime.now().isoformat(),
                'mode': 'erpnext',
                'customer': data.get('customer'),
                'items': data.get('items', []),
                'payments': data.get('payments', []),
                'tender': data.get('tender'),
                'cash_given': data.get('cash_given'),
                'change': data.get('change'),
                'total': data.get('total'),
                'vouchers': data.get('vouchers', []),
                'cashier': data.get('cashier')
            }
            with open(os.path.join('invoices', f"{invoice['name']}.json"), 'w', encoding='utf-8') as f:
                import json
                json.dump(record, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return jsonify({'status': 'success', 'message': 'Sale completed successfully', 'invoice_name': invoice['name']})
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/customers')
def get_customers():
    """Get all customers"""
    if USE_MOCK:
        customers = [
            {"name": "CUST-WALKIN", "customer_name": "Walk-in Customer"},
            {"name": "CUST-ALPHA", "customer_name": "Alpha Ltd"},
            {"name": "CUST-BETA", "customer_name": "Beta Inc"},
            {"name": "CUST-JDOE", "customer_name": "John Doe"}
        ]
        return jsonify({'status': 'success', 'customers': customers})
    try:
        response = requests.get(
            f"{ERPNEXT_URL}/api/resource/Customer",
            headers=_erp_headers(),
            params={
                'fields': '["name", "customer_name"]',
                'filters': '[["disabled","=",0]]'
            },
            timeout=15
        )
        response.raise_for_status()
        customers = response.json().get('data', [])
        return jsonify({'status': 'success', 'customers': customers})
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/sales/status')
def api_sales_status():
    """Return counts of local sales by queue_status and a quick scan of invoice acks.
    Response: { status, counts: {queued, posting, posted, failed}, invoices_pending }
    """
    counts = {'queued': 0, 'posting': 0, 'posted': 0, 'failed': 0}
    try:
        conn = _db_connect()
        if conn:
            for st in counts.keys():
                row = conn.execute('SELECT COUNT(*) AS c FROM sales WHERE queue_status=?', (st,)).fetchone()
                counts[st] = int(row['c']) if row and 'c' in row.keys() else 0
    except Exception:
        pass
    # Invoice folder pending (no .ok sidecar)
    pending = 0
    try:
        inv_dir = 'invoices'
        if os.path.isdir(inv_dir):
            for name in os.listdir(inv_dir):
                if not name.endswith('.json'):
                    continue
                base = name[:-5]
                ok_path = os.path.join(inv_dir, base + '.json.ok')
                if not os.path.exists(ok_path):
                    pending += 1
    except Exception:
        pass
    return jsonify({'status': 'success', 'counts': counts, 'invoices_pending': pending})


@app.route('/api/admin/sync/scan-acks', methods=['POST'])
def api_scan_acks():
    """Scan invoices/ for .ok sidecar files and mark corresponding sales as posted.
    This supports ERP pull flows that acknowledge by writing <name>.json.ok sidecars.
    """
    updated = 0
    try:
        conn = _db_connect()
        inv_dir = 'invoices'
        if not conn or not os.path.isdir(inv_dir):
            return jsonify({'status': 'success', 'updated': 0})
        to_delete = []
        for name in os.listdir(inv_dir):
            if not name.endswith('.json.ok'):
                continue
            base = name[:-3]  # strip '.ok'
            sale_id = base[:-5] if base.endswith('.json') else base
            try:
                row = conn.execute('SELECT queue_status FROM sales WHERE sale_id=?', (sale_id,)).fetchone()
                if row and row['queue_status'] != 'posted':
                    conn.execute("UPDATE sales SET queue_status='posted', erp_docname=COALESCE(erp_docname, 'ACK') WHERE sale_id=?", (sale_id,))
                    updated += 1
                    to_delete.append(os.path.join(inv_dir, name))
            except Exception:
                continue
        try:
            conn.commit()
        except Exception:
            pass
        # Delete .json.ok sidecars only for acknowledged rows
        for path in to_delete:
            try:
                os.remove(path)
            except Exception:
                pass
    except Exception:
        pass
    return jsonify({'status': 'success', 'updated': updated})


@app.route('/api/db/init', methods=['POST'])
def api_db_init():
    if not ps:
        return jsonify({'status':'error','message':'pos_service not available'}), 500
    try:
        conn = _db_connect()
        if not conn:
            conn = ps.connect(POS_DB_PATH)
        ps.init_db(conn, SCHEMA_PATH)
        Path(POS_DB_PATH).touch(exist_ok=True)
        return jsonify({'status':'success','message':'Database initialized','path': POS_DB_PATH})
    except Exception as e:
        return jsonify({'status':'error','message': str(e)}), 500


@app.route('/api/db/seed-demo', methods=['POST'])
def api_db_seed_demo():
    if not ps:
        return jsonify({'status':'error','message':'pos_service not available'}), 500
    try:
        conn = _db_connect() or ps.connect(POS_DB_PATH)
        # ensure schema
        try:
            conn.execute('SELECT 1 FROM items LIMIT 1')
        except Exception:
            ps.init_db(conn, SCHEMA_PATH)
        ps.demo_seed(conn)
        return jsonify({'status':'success','message':'Demo data seeded'})
    except Exception as e:
        return jsonify({'status':'error','message': str(e)}), 500


@app.route('/api/db/ensure-demo', methods=['POST'])
def api_db_ensure_demo():
    if not ps:
        return jsonify({'status':'error','message':'pos_service not available'}), 500
    try:
        conn = _db_connect() or ps.connect(POS_DB_PATH)
        # If no tables, init
        try:
            conn.execute('SELECT 1 FROM items LIMIT 1')
        except Exception:
            ps.init_db(conn, SCHEMA_PATH)
        if not _db_has_items(conn):
            ps.demo_seed(conn)
            return jsonify({'status':'success','message':'Initialized and seeded demo data'})
        return jsonify({'status':'success','message':'DB already has items'})
    except Exception as e:
        return jsonify({'status':'error','message': str(e)}), 500


@app.route('/api/db/status')
def api_db_status():
    if not ps:
        return jsonify({'status':'error','message':'pos_service not available'}), 500
    try:
        conn = _db_connect()
        if not conn:
            return jsonify({'status':'success','message':'No DB connection','present': False})
        counts = {}
        for name, sql in {
            'items_total': 'SELECT COUNT(*) AS c FROM items',
            'items_variants': 'SELECT COUNT(*) AS c FROM items WHERE is_template=0 AND active=1',
            'items_templates': 'SELECT COUNT(*) AS c FROM items WHERE is_template=1 AND active=1',
            'barcodes': 'SELECT COUNT(*) AS c FROM barcodes',
            'stock_rows': 'SELECT COUNT(*) AS c FROM stock',
            'vouchers': 'SELECT COUNT(*) AS c FROM vouchers',
            'sales': 'SELECT COUNT(*) AS c FROM sales',
        }.items():
            row = conn.execute(sql).fetchone()
            counts[name] = int(row['c']) if row and 'c' in row.keys() else 0
        return jsonify({'status':'success','present': True, 'counts': counts, 'db_path': POS_DB_PATH})
    except Exception as e:
        return jsonify({'status':'error','message': str(e)}), 500


@app.route('/api/db/sync-items', methods=['POST'])
def api_db_sync_items():
    # Placeholder: wiring for future ERPNext incremental pulls
    if not ERPNEXT_URL:
        return jsonify({'status':'error','message':'ERPNext not configured'}), 400
    return jsonify({'status':'error','message':'Sync not implemented yet in this build'}), 501

@app.route('/api/item_matrix')
def item_matrix():
    """Return a variant matrix for a template item from SQLite (sizes as columns; colors/widths as rows)."""
    template_id = request.args.get('item')
    if not template_id:
        return jsonify({'status': 'error', 'message': 'Missing item parameter'}), 400
    conn = _db_connect()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database not available'}), 500
    tpl = conn.execute("SELECT item_id, name, brand FROM items WHERE item_id=? AND is_template=1", (template_id,)).fetchone()
    if not tpl:
        return jsonify({'status': 'error', 'message': 'Template not found'}), 404
    qv = """
      SELECT v.item_id,
             v.name,
             (SELECT price_effective FROM v_item_prices p WHERE p.item_id=v.item_id) AS rate,
             COALESCE((SELECT qty FROM stock s WHERE s.item_id=v.item_id AND s.warehouse='Shop'), 0) AS qty
      FROM items v
      WHERE v.parent_id=? AND v.active=1 AND v.is_template=0
    """
    variants = {}
    colors=set(); widths=set(); sizes=set()
    rows = conn.execute(qv, (template_id,)).fetchall()
    attr_map = {}
    if rows:
        ids = tuple(r["item_id"] for r in rows)
        if ids:
            placeholders = ",".join(["?"]*len(ids))
            for ar in conn.execute(f"SELECT item_id, attr_name, value FROM variant_attributes WHERE item_id IN ({placeholders})", ids):
                d = attr_map.setdefault(ar["item_id"], {})
                d[ar["attr_name"]] = ar["value"]
    for r in rows:
        attrs = attr_map.get(r["item_id"], {})
        color = attrs.get('Color', '-')
        width = attrs.get('Width', 'Standard')
        size = attrs.get('Size', '-')
        colors.add(color); widths.add(width); sizes.add(size)
        key = f"{color}|{width}|{size}"
        variants[key] = { 'item_id': r['item_id'], 'item_name': r['name'], 'rate': float(r['rate']) if r['rate'] is not None else None, 'qty': float(r['qty']) }
    data = {
        'item': template_id,
        'sizes': sorted(sizes, key=lambda x: (len(x), x)),
        'colors': sorted(colors),
        'widths': sorted(widths),
        'stock': { k:v['qty'] for k,v in variants.items() },
        'variants': variants,
        'price': None,
        'image': None,
    }
    return jsonify({'status': 'success', 'data': data})


@app.route('/api/lookup-barcode')
def api_lookup_barcode():
    """Lookup a variant by barcode and return minimal details for POS add-to-cart.
    Response: { status, variant: { item_id, name, rate, qty, attributes: {..} } }
    """
    code = request.args.get('code') or ''
    code = str(code).strip()
    if not code:
        return jsonify({'status': 'error', 'message': 'Missing code'}), 400
    conn = _db_connect()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database not available'}), 500
    row = conn.execute(
        """
        SELECT i.item_id,
               i.name,
               (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS rate,
               COALESCE((SELECT qty FROM stock s WHERE s.item_id=i.item_id AND s.warehouse='Shop'), 0) AS qty
        FROM barcodes b
        JOIN items i ON i.item_id = b.item_id
        WHERE b.barcode = ? AND i.active=1
        """,
        (code,)
    ).fetchone()
    # If no barcode row found, fall back to matching the code against item_id/item_code/name
    if not row:
        try:
            row = conn.execute(
                """
                SELECT i.item_id,
                       i.name,
                       (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS rate,
                       COALESCE((SELECT qty FROM stock s WHERE s.item_id=i.item_id AND s.warehouse='Shop'), 0) AS qty
                FROM items i
                WHERE (i.item_id = ? OR i.item_code = ? OR i.name = ?) AND i.active=1
                """,
                (code, code, code)
            ).fetchone()
        except Exception:
            row = None
    if not row:
        return jsonify({'status': 'error', 'message': 'Not found'}), 404
    attrs = {}
    for ar in conn.execute("SELECT attr_name, value FROM variant_attributes WHERE item_id=?", (row['item_id'],)):
        attrs[ar['attr_name']] = ar['value']
    out = {
        'item_id': row['item_id'],
        'name': row['name'],
        'rate': float(row['rate']) if row['rate'] is not None else 0.0,
        'qty': float(row['qty']) if row['qty'] is not None else 0.0,
        'attributes': attrs,
    }
    return jsonify({'status': 'success', 'variant': out})


@app.route('/api/variant-info')
def api_variant_info():
    """Return basic variant info for a list of item_ids: name and attributes.
    Query param: ids=ID1,ID2,...
    Response: { status, variants: { <id>: { item_id, name, brand, attributes } } }
    """
    ids_raw = request.args.get('ids') or ''
    ids = [s for s in (ids_raw.split(',') if ids_raw else []) if s]
    if not ids:
        return jsonify({'status': 'error', 'message': 'Missing ids'}), 400
    conn = _db_connect()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database not available'}), 500
    placeholders = ",".join(["?"]*len(ids))
    out = {}
    # Fetch base item names and brand
    for r in conn.execute(f"SELECT item_id, name, brand FROM items WHERE item_id IN ({placeholders})", tuple(ids)):
        out[r['item_id']] = {
            'item_id': r['item_id'],
            'name': r['name'],
            'brand': r['brand'],
            'attributes': {}
        }
    # Attach attributes
    for ar in conn.execute(f"SELECT item_id, attr_name, value FROM variant_attributes WHERE item_id IN ({placeholders})", tuple(ids)):
        if ar['item_id'] not in out:
            out[ar['item_id']] = {'item_id': ar['item_id'], 'name': '', 'brand': None, 'attributes': {}}
        out[ar['item_id']]['attributes'][ar['attr_name']] = ar['value']
    return jsonify({'status': 'success', 'variants': out})


# --- Receipt/Sale lookup (for returns) ---
@app.route('/api/sale/<sale_id>')
def api_get_sale(sale_id: str):
    """Lookup a recorded sale/receipt by its id. Tries local invoices/ then SQLite sales table."""
    sid = (sale_id or '').strip()
    if not sid:
        return jsonify({'status': 'error', 'message': 'Missing sale id'}), 400
    # 1) invoices/<id>.json
    try:
        inv_path = os.path.join('invoices', f'{sid}.json')
        if os.path.exists(inv_path):
            with open(inv_path, 'r', encoding='utf-8') as f:
                rec = _json.load(f)
            items = []
            for it in rec.get('items') or []:
                items.append({
                    'item_code': it.get('item_code') or it.get('code') or it.get('name'),
                    'item_name': it.get('item_name') or it.get('name') or (it.get('item_code') or ''),
                    'qty': it.get('qty') or 1,
                    'rate': it.get('rate') or it.get('price') or 0
                })
            out = {
                'id': rec.get('invoice_name') or sid,
                'customer': rec.get('customer') or '',
                'items': items,
                'total': rec.get('total')
            }
            return jsonify({'status': 'success', 'sale': out})
        # Fallback: scan invoices/ for a record whose invoice_name matches sid (e.g., when filename differs)
        inv_dir = 'invoices'
        if os.path.isdir(inv_dir):
            for name in os.listdir(inv_dir):
                if not name.endswith('.json'):
                    continue
                try:
                    with open(os.path.join(inv_dir, name), 'r', encoding='utf-8') as f:
                        rec = _json.load(f)
                    inv_name = (rec.get('invoice_name') or '').strip()
                    if inv_name and inv_name == sid:
                        items = []
                        for it in rec.get('items') or []:
                            items.append({
                                'item_code': it.get('item_code') or it.get('code') or it.get('name'),
                                'item_name': it.get('item_name') or it.get('name') or (it.get('item_code') or ''),
                                'qty': it.get('qty') or 1,
                                'rate': it.get('rate') or it.get('price') or 0
                            })
                        out = {
                            'id': inv_name,
                            'customer': rec.get('customer') or '',
                            'items': items,
                            'total': rec.get('total')
                        }
                        return jsonify({'status': 'success', 'sale': out})
                except Exception:
                    # ignore unreadable entries
                    continue
    except Exception:
        pass
    # 2) SQLite sales table via pos_service, if available
    try:
        conn = _db_connect()
        if conn:
            row = conn.execute("SELECT payload_json FROM sales WHERE sale_id=? OR erp_docname=?", (sid, sid)).fetchone()
            if row and row[0]:
                try:
                    payload = _json.loads(row[0])
                except Exception:
                    payload = {}
                lines = []
                for ln in payload.get('lines') or payload.get('items') or []:
                    lines.append({
                        'item_code': ln.get('item_id') or ln.get('item_code') or ln.get('name'),
                        'item_name': ln.get('item_name') or ln.get('name') or (ln.get('item_id') or ''),
                        'qty': ln.get('qty') or 1,
                        'rate': ln.get('rate') or ln.get('price') or 0
                    })
                out = {
                    'id': sid,
                    'customer': payload.get('customer_id') or payload.get('customer') or '',
                    'items': lines,
                    'total': payload.get('total')
                }
                return jsonify({'status': 'success', 'sale': out})
    except Exception:
        pass
    return jsonify({'status': 'error', 'message': 'Sale not found'}), 404

# ---- Paused/Hold transactions API ----

def _paused_path_for_id(pid: str) -> str:
    # Only allow simple IDs like PAUSE-YYYYMMDD-XXXXXXXX
    safe = ''.join([c for c in pid if c.isalnum() or c in ('-', '_')])
    if not safe or not safe.startswith('PAUSE-'):
        raise ValueError('Invalid paused id')
    return os.path.join(PAUSED_DIR, f"{safe}.json")


@app.route('/api/hold-sale', methods=['POST'])
def api_hold_sale():
    """Persist the current cart as a paused/held transaction on disk.
    Expected payload: { customer, cart: [ {item_code, item_name, qty, rate, refund?} ], vouchers: [], cashier: {code,name}, till_number }
    """
    try:
        payload = request.json or {}
    except Exception:
        payload = {}
    cart_rows = payload.get('cart') or []
    if not isinstance(cart_rows, list) or len(cart_rows) == 0:
        return jsonify({'status': 'error', 'message': 'Cart is empty'}), 400
    cashier = payload.get('cashier') or {}
    if not cashier or not cashier.get('code'):
        return jsonify({'status': 'error', 'message': 'Missing cashier'}), 400
    try:
        os.makedirs(PAUSED_DIR, exist_ok=True)
    except Exception:
        pass
    pid = f"PAUSE-{datetime.now().strftime('%Y%m%d')}-{uuid4().hex[:8].upper()}"
    created_at = datetime.now().isoformat()
    total = 0.0
    items_count = 0
    for r in cart_rows:
        qty = float(r.get('qty') or 0)
        rate = float(r.get('rate') or 0)
        is_refund = bool(r.get('refund'))
        sign = -1.0 if is_refund else 1.0
        total += sign * qty * rate
        items_count += 1
    record = {
        'id': pid,
        'created_at': created_at,
        'customer': payload.get('customer') or '',
        'cart': cart_rows,
        'vouchers': payload.get('vouchers') or [],
        'cashier': {'code': cashier.get('code'), 'name': cashier.get('name')},
        'till_number': payload.get('till_number') or None,
        'items_count': items_count,
        'total': total,
    }
    try:
        with open(os.path.join(PAUSED_DIR, f"{pid}.json"), 'w', encoding='utf-8') as f:
            _json.dump(record, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'Failed to write paused sale: {e}'}), 500
    return jsonify({'status': 'success', 'id': pid, 'created_at': created_at})


@app.route('/api/paused-sales')
def api_list_paused_sales():
    os.makedirs(PAUSED_DIR, exist_ok=True)
    out = []
    try:
        for name in sorted(os.listdir(PAUSED_DIR)):
            if not name.endswith('.json'):
                continue
            try:
                with open(os.path.join(PAUSED_DIR, name), 'r', encoding='utf-8') as f:
                    rec = _json.load(f)
                out.append({
                    'id': rec.get('id') or name[:-5],
                    'created_at': rec.get('created_at'),
                    'cashier': rec.get('cashier'),
                    'customer': rec.get('customer'),
                    'items_count': rec.get('items_count'),
                    'total': rec.get('total'),
                })
            except Exception:
                # Skip unreadable entries
                continue
    except FileNotFoundError:
        pass
    return jsonify({'status': 'success', 'paused': out})


@app.route('/api/paused-sales/<pid>')
def api_get_paused_sale(pid: str):
    try:
        path = _paused_path_for_id(pid)
        if not os.path.exists(path):
            return jsonify({'status': 'error', 'message': 'Not found'}), 404
        with open(path, 'r', encoding='utf-8') as f:
            rec = _json.load(f)
        consume = (request.args.get('consume') or '').lower() in ('1', 'true', 'yes')
        if consume:
            try:
                os.remove(path)
            except Exception:
                # If removal fails, still return the record
                pass
        return jsonify({'status': 'success', 'paused': rec})
    except ValueError:
        return jsonify({'status': 'error', 'message': 'Invalid id'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/paused-sales/<pid>', methods=['DELETE'])
def api_delete_paused_sale(pid: str):
    try:
        path = _paused_path_for_id(pid)
        if not os.path.exists(path):
            return jsonify({'status': 'error', 'message': 'Not found'}), 404
        os.remove(path)
        return jsonify({'status': 'success'})
    except ValueError:
        return jsonify({'status': 'error', 'message': 'Invalid id'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    port = int(os.getenv('PORT', '5000'))
    host = os.getenv('HOST', '0.0.0.0')
    app.run(host=host, port=port, debug=debug)


@app.route('/api/invoices')
def api_invoices_by_date():
    """Return sales/invoices for a given day, combining SQLite sales and local invoices/*.json.
    Query param: date=YYYY-MM-DD (defaults to today, local time)
    Response: { status, date, rows: [ {id, created_at, customer, total, source, status, erp_docname} ] }
    """
    try:
        qdate = (request.args.get('date') or '').strip()
    except Exception:
        qdate = ''
    if not qdate:
        qdate = datetime.now().strftime('%Y-%m-%d')
    out = []
    seen_ids = set()

    # From SQLite sales table
    try:
        conn = _db_connect()
        if conn:
            for row in conn.execute("SELECT sale_id, created_utc, customer_id, cashier, total, queue_status, erp_docname FROM sales WHERE substr(created_utc,1,10)=? ORDER BY created_utc ASC", (qdate,)):
                rec = {
                    'id': row['sale_id'],
                    'created_at': row['created_utc'],
                    'customer': row['customer_id'] or '',
                    'total': float(row['total'] or 0),
                    'source': 'db',
                    'status': row['queue_status'] or 'queued',
                    'erp_docname': row['erp_docname'] or None,
                    'cashier': row['cashier'] or None,
                }
                out.append(rec)
                seen_ids.add(rec['id'])
    except Exception:
        pass

    # From local invoices/*.json
    try:
        inv_dir = 'invoices'
        if os.path.isdir(inv_dir):
            for name in os.listdir(inv_dir):
                if not name.endswith('.json'):
                    continue
                fpath = os.path.join(inv_dir, name)
                try:
                    with open(fpath, 'r', encoding='utf-8') as f:
                        rec = _json.load(f)
                except Exception:
                    continue
                created = (rec.get('created_at') or '').strip()
                if not created:
                    continue
                # Compare date portion only
                if not created.startswith(qdate):
                    # Accept ISO without T (local) or with time; fallback parse
                    try:
                        dt = datetime.fromisoformat(created.replace('Z',''))
                        if dt.strftime('%Y-%m-%d') != qdate:
                            continue
                    except Exception:
                        continue
                inv_id = (rec.get('invoice_name') or '').strip() or name[:-5]
                if inv_id in seen_ids:
                    continue
                ok_sidecar = fpath + '.ok'
                status = 'posted' if os.path.exists(ok_sidecar) else ('posted' if (rec.get('mode') == 'erpnext') else 'queued')
                out.append({
                    'id': inv_id,
                    'created_at': created,
                    'customer': rec.get('customer') or '',
                    'cashier': (((rec.get('cashier') or {}).get('code','') + ' ' + (rec.get('cashier') or {}).get('name','')).strip()),
                    'total': float(rec.get('total') or 0),
                    'source': 'file',
                    'status': status,
                    'erp_docname': inv_id if rec.get('mode') == 'erpnext' else None,
                })
    except Exception:
        pass

    # Sort by created_at ascending
    try:
        out.sort(key=lambda r: (r.get('created_at') or ''))
    except Exception:
        pass
    return jsonify({'status': 'success', 'date': qdate, 'rows': out})



@app.route('/api/invoices/<inv_id>')
def api_invoice_detail(inv_id: str):
    """Detailed invoice view with items, images and payments.
    Tries SQLite sales payload first, then invoices/<id>.json (or match by invoice_name).
    Response: { status, invoice: { id, created_at, customer, cashier, total, items[], payments[] } }
    """
    sid = (inv_id or '').strip()
    if not sid:
        return jsonify({'status':'error','message':'Missing invoice id'}), 400
    # 1) Try SQLite sales
    try:
        conn = _db_connect()
        if conn:
            row = conn.execute("SELECT sale_id, created_utc, customer_id, cashier, total, erp_docname, payload_json FROM sales WHERE sale_id=? OR erp_docname=?", (sid, sid)).fetchone()
            if row:
                try:
                    payload = _json.loads(row['payload_json'] or '{}')
                except Exception:
                    payload = {}
                items = []
                ids = []
                for ln in (payload.get('lines') or []):
                    code = ln.get('item_id') or ln.get('item_code') or ln.get('name')
                    items.append({
                        'item_code': code,
                        'item_name': ln.get('item_name') or ln.get('name') or code,
                        'qty': ln.get('qty') or 1,
                        'rate': ln.get('rate') or ln.get('price') or 0,
                        'image': None,
                    })
                    if code: ids.append(code)
                # images
                try:
                    if ids:
                        qs = ','.join(['?']*len(ids))
                        for ir in conn.execute(f"SELECT item_id, image_url_effective FROM v_item_images WHERE item_id IN ({qs})", tuple(ids)):
                            for it in items:
                                if it['item_code'] == ir['item_id']:
                                    it['image'] = _absolute_image_url(ir['image_url_effective'])
                except Exception:
                    pass
                pays = []
                for p in (payload.get('payments') or []):
                    pays.append({'method': p.get('method') or p.get('mode_of_payment') or 'Payment', 'amount': float(p.get('amount') or 0), 'ref': p.get('ref')})
                inv = {
                    'id': row['erp_docname'] or row['sale_id'] or sid,
                    'created_at': row['created_utc'],
                    'customer': row['customer_id'] or '',
                    'cashier': row['cashier'] or '',
                    'total': float(row['total'] or 0),
                    'items': items,
                    'payments': pays,
                    'source': 'db'
                }
                return jsonify({'status':'success','invoice': inv})
    except Exception:
        pass
    # 2) Try invoices/<id>.json
    try:
        inv_dir = 'invoices'
        path = os.path.join(inv_dir, f'{sid}.json')
        rec = None
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                rec = _json.load(f)
        else:
            # scan for invoice_name match
            if os.path.isdir(inv_dir):
                for name in os.listdir(inv_dir):
                    if not name.endswith('.json'): continue
                    try:
                        with open(os.path.join(inv_dir, name), 'r', encoding='utf-8') as f:
                            r = _json.load(f)
                        if (r.get('invoice_name') or '') == sid:
                            rec = r
                            break
                    except Exception:
                        continue
        if rec:
            data_items = []
            ids = []
            for it in (rec.get('items') or []):
                code = it.get('item_code') or it.get('code') or it.get('name')
                data_items.append({
                    'item_code': code,
                    'item_name': it.get('item_name') or it.get('name') or code,
                    'qty': it.get('qty') or 1,
                    'rate': it.get('rate') or it.get('price') or 0,
                    'image': None,
                })
                if code: ids.append(code)
            # try images via DB
            try:
                conn = _db_connect()
                if conn and ids:
                    qs = ','.join(['?']*len(ids))
                    for ir in conn.execute(f"SELECT item_id, image_url_effective FROM v_item_images WHERE item_id IN ({qs})", tuple(ids)):
                        for it in data_items:
                            if it['item_code'] == ir['item_id']:
                                it['image'] = _absolute_image_url(ir['image_url_effective'])
            except Exception:
                pass
            pays = []
            for p in (rec.get('payments') or []):
                pays.append({'method': p.get('mode_of_payment') or p.get('method') or 'Payment', 'amount': float(p.get('amount') or 0), 'ref': p.get('ref')})
            inv = {
                'id': rec.get('invoice_name') or sid,
                'created_at': rec.get('created_at') or '',
                'customer': rec.get('customer') or '',
                    'cashier': (((rec.get('cashier') or {}).get('code','') + ' ' + (rec.get('cashier') or {}).get('name','')).strip()),
                'cashier': '',
                'total': float(rec.get('total') or 0),
                'items': data_items,
                'payments': pays,
                'source': 'file'
            }
            return jsonify({'status':'success','invoice': inv})
    except Exception:
        pass
    return jsonify({'status':'error','message':'Invoice not found'}), 404




