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
import time
import logging
import hmac
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    from serial.tools import list_ports
except ImportError:
    list_ports = None

# Load environment variables
load_dotenv()

def _env_string(name: str, default: Optional[str] = None) -> Optional[str]:
    """Return trimmed string-valued env vars, normalizing empty strings to None."""
    raw = os.getenv(name, default)
    if raw is None:
        return default
    if isinstance(raw, str):
        clean = raw.strip()
        return clean if clean else default
    return raw

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # disable static caching during development

_LOG_LEVEL_NAME = (os.getenv('POS_LOG_LEVEL') or 'INFO').strip().upper()
try:
    app.logger.setLevel(getattr(logging, _LOG_LEVEL_NAME, logging.INFO))
except Exception:
    app.logger.setLevel(logging.INFO)
try:
    logging.getLogger('werkzeug').setLevel(getattr(logging, _LOG_LEVEL_NAME, logging.INFO))
except Exception:
    pass

# Behavior flags
USE_MOCK = (_env_string('USE_MOCK', '1') == '1')  # default to mock POS with no ERP dependency
POS_DB_PATH = _env_string('POS_DB_PATH', 'pos.db')
SCHEMA_PATH = _env_string('POS_SCHEMA_PATH', 'schema.sql')
PAUSED_DIR = _env_string('POS_PAUSED_DIR', 'paused')

# ERPNext API configuration (used only if USE_MOCK is False)
ERPNEXT_URL = _env_string('ERPNEXT_URL')
API_KEY = _env_string('ERPNEXT_API_KEY')
API_SECRET = _env_string('ERPNEXT_API_SECRET')

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
POS_PRICE_LIST = os.getenv('POS_PRICE_LIST') or None
CASHIER_DOCTYPE = os.getenv('POS_CASHIER_DOCTYPE', 'Cashier')
CASHIER_CODE_FIELD = os.getenv('POS_CASHIER_CODE_FIELD', 'code')
CASHIER_NAME_FIELD = os.getenv('POS_CASHIER_NAME_FIELD', 'cashier_name')
CASHIER_ACTIVE_FIELD = os.getenv('POS_CASHIER_ACTIVE_FIELD', 'active')
CASHIER_EXTRA_FIELDS = [
    field.strip() for field in (os.getenv('POS_CASHIER_EXTRA_FIELDS', '') or '').split(',')
    if field.strip()
]
CASHIER_FILTERS_RAW = (os.getenv('POS_CASHIER_FILTERS', '') or '').strip()

# Attribute normalization map (ERP vs POS expectations)
ATTRIBUTE_SYNONYMS = {
    'colour': 'Color',
    'color': 'Color',
    'colors': 'Color',
    'eu half sizes': 'Size',
    'uk half sizes': 'Size',
    'eu half size': 'Size',
    'uk half size': 'Size',
    'eu sizes': 'Size',
    'uk sizes': 'Size',
    'eu size': 'Size',
    'uk size': 'Size',
    'size': 'Size',
    'width': 'Width',
}

# Default COM port for the receipt pipeline (used by the UI)
RECEIPT_DEFAULT_PORT = os.getenv('RECEIPT_SERIAL_PORT', 'COM3')

# Local receipt helper configuration
RECEIPT_AGENT_HOST = os.getenv('RECEIPT_AGENT_HOST')
RECEIPT_AGENT_PORT = os.getenv('RECEIPT_AGENT_PORT')
RECEIPT_AGENT_PATH = os.getenv('RECEIPT_AGENT_PATH', '/print')
RECEIPT_AGENT_USE_HTTPS = os.getenv('RECEIPT_AGENT_USE_HTTPS', '0') == '1'
RECEIPT_AGENT_URL = os.getenv('RECEIPT_AGENT_URL')
if not RECEIPT_AGENT_URL and RECEIPT_AGENT_HOST and RECEIPT_AGENT_PORT:
    scheme = 'https' if RECEIPT_AGENT_USE_HTTPS else 'http'
    path = RECEIPT_AGENT_PATH if RECEIPT_AGENT_PATH.startswith('/') else f'/{RECEIPT_AGENT_PATH}'
    RECEIPT_AGENT_URL = f"{scheme}://{RECEIPT_AGENT_HOST}:{RECEIPT_AGENT_PORT}{path}"

# Force POS to stay in local queue-only mode even when ERP creds exist.
POS_QUEUE_ONLY = os.getenv('POS_QUEUE_ONLY', '0') == '1'

# Till posting queue configuration
POS_RECEIPT_KEY = _env_string('POS_RECEIPT_KEY', 'SUPERSECRET123')
POS_QUEUE_DB_PATH = _env_string('POS_QUEUE_DB', 'pos_sales_queue.sqlite3')
POS_QUEUE_DIR = Path(_env_string('POS_QUEUE_DIR', os.path.join('invoices', 'queue')))
_POS_QUEUE_DIR_STATES = {
    'pending': POS_QUEUE_DIR / 'pending',
    'ready': POS_QUEUE_DIR / 'ready',
    'failed': POS_QUEUE_DIR / 'failed',
    'confirmed': POS_QUEUE_DIR / 'confirmed'
}
_QUEUE_STATUS_DIR = {
    'received': 'pending',
    'record_error': 'failed',
    'queued': 'ready',
    'erp_posting': 'ready',
    'erp_failed': 'failed',
    'confirmed': 'confirmed'
}
_QUEUE_DB_LOCK = threading.Lock()
_QUEUE_DB_INITIALIZED = False
POS_QUEUE_BATCH_LIMIT = 25


def _utcnow_z() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def _ensure_queue_dirs() -> None:
    if not POS_QUEUE_DIR:
        return
    try:
        POS_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
        for path in _POS_QUEUE_DIR_STATES.values():
            path.mkdir(parents=True, exist_ok=True)
    except Exception:
        app.logger.exception('Failed to prepare POS queue directories')


def _queue_db_connect() -> Optional[sqlite3.Connection]:
    if not POS_QUEUE_DB_PATH:
        return None
    conn = sqlite3.connect(POS_QUEUE_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    with _QUEUE_DB_LOCK:
        global _QUEUE_DB_INITIALIZED
        if not _QUEUE_DB_INITIALIZED:
            _init_queue_db(conn)
            _QUEUE_DB_INITIALIZED = True
    return conn


def _init_queue_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pos_sales_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_name TEXT NOT NULL UNIQUE,
            sale_id TEXT,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            erp_docname TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_utc TEXT NOT NULL,
            updated_utc TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pos_sales_queue_status ON pos_sales_queue(status)")
    conn.commit()


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except Exception:
        app.logger.debug('Failed to remove %s', path)


def _queue_state_dir(status: str) -> Optional[Path]:
    if not status:
        return None
    dir_key = _QUEUE_STATUS_DIR.get(status, 'pending')
    return _POS_QUEUE_DIR_STATES.get(dir_key)


def _write_queue_file(invoice_name: str, payload: Any, status: str) -> None:
    if not invoice_name or not POS_QUEUE_DIR:
        return
    try:
        data = payload if isinstance(payload, dict) else _json.loads(payload)
    except Exception:
        data = {}
    try:
        _ensure_queue_dirs()
        target_dir = _queue_state_dir(status) or _POS_QUEUE_DIR_STATES['pending']
        for name, directory in _POS_QUEUE_DIR_STATES.items():
            if directory == target_dir:
                continue
            _safe_unlink(directory / f"{invoice_name}.json")
        target_path = target_dir / f"{invoice_name}.json"
        with open(target_path, 'w', encoding='utf-8') as f:
            _json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        app.logger.warning('Failed to maintain queue file for %s', invoice_name)


def _valid_pos_shared_key(provided: Optional[str]) -> bool:
    expected = (POS_RECEIPT_KEY or '').strip()
    if not expected:
        return True
    if provided is None:
        return False
    try:
        return hmac.compare_digest(expected, provided.strip())
    except Exception:
        return False


def _normalize_receipt_id(payload: Dict[str, Any]) -> Optional[str]:
    for key in ('invoice_name', 'sale_id', 'receipt_id'):
        value = payload.get(key)
        if value in (None, ''):
            continue
        try:
            cleaned = str(value).strip()
        except Exception:
            continue
        if cleaned:
            return cleaned
    return None


def _validate_pos_sale_payload(payload: Dict[str, Any]) -> Optional[str]:
    if not isinstance(payload, dict):
        return 'Invalid JSON payload'
    receipt_id = _normalize_receipt_id(payload)
    if not receipt_id:
        return 'Missing invoice_name or sale_id'
    items = payload.get('items')
    if not isinstance(items, list) or not items:
        return 'Items array is required'
    for idx, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            return f'Item #{idx} is invalid'
        item_code = item.get('item_code') or item.get('item_id') or item.get('code') or item.get('name')
        if not item_code:
            return f'Item #{idx} missing item_code'
        try:
            qty = float(item.get('qty') or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            return f'Item #{idx} must have positive qty'
        try:
            rate = float(item.get('rate') or 0)
        except (TypeError, ValueError):
            rate = -1
        if rate < 0:
            return f'Item #{idx} must have non-negative rate'
    return None


def _enqueue_pos_sale(payload: Dict[str, Any]) -> int:
    conn = _queue_db_connect()
    if not conn:
        raise RuntimeError('POS queue storage unavailable')
    receipt_id = _normalize_receipt_id(payload)
    if not receipt_id:
        raise ValueError('Missing receipt id')
    payload = dict(payload)
    payload['invoice_name'] = receipt_id
    payload.setdefault('sale_id', receipt_id)
    payload_json = _json.dumps(payload, ensure_ascii=False)
    now = _utcnow_z()
    try:
        with conn:
            conn.execute("""
            INSERT INTO pos_sales_queue (invoice_name, sale_id, payload_json, status, error, erp_docname, attempts, created_utc, updated_utc)
            VALUES (?,?,?,?,NULL,NULL,0,?,?)
            ON CONFLICT(invoice_name) DO UPDATE SET
                payload_json=excluded.payload_json,
                sale_id=COALESCE(NULLIF(excluded.sale_id,''), pos_sales_queue.sale_id),
                status='received',
                updated_utc=excluded.updated_utc,
                error=NULL,
                attempts=0
            """, (receipt_id, payload.get('sale_id') or receipt_id, payload_json, 'received', now, now))
            row = conn.execute("SELECT id FROM pos_sales_queue WHERE invoice_name=?", (receipt_id,)).fetchone()
            queue_id = int(row['id']) if row else 0
    finally:
        conn.close()
    _write_queue_file(receipt_id, payload_json, 'received')
    return queue_id


def _record_queue_entry(queue_conn: sqlite3.Connection, main_conn: Optional[sqlite3.Connection], row: sqlite3.Row) -> bool:
    if not ps or not main_conn:
        return False
    payload = _json.loads(row['payload_json'])
    sale_id = payload.get('sale_id') or payload.get('invoice_name') or row['invoice_name']
    sale_id = str(sale_id or row['invoice_name'])
    payload['sale_id'] = sale_id
    payload['invoice_name'] = sale_id
    try:
        exists = main_conn.execute('SELECT queue_status FROM sales WHERE sale_id=?', (sale_id,)).fetchone()
    except Exception:
        exists = None
    if exists:
        queue_conn.execute(
            "UPDATE pos_sales_queue SET sale_id=?, status='queued', updated_utc=?, error=NULL WHERE id=?",
            (sale_id, _utcnow_z(), row['id'])
        )
        _write_queue_file(sale_id, payload, 'queued')
        return True
    try:
        sale_payload = _build_sale_payload(payload, sale_id)
        fx_metadata = payload.get('fx_metadata')
        if fx_metadata:
            ps.record_sale_with_fx(main_conn, sale_payload, fx_metadata)
        else:
            ps.record_sale(main_conn, sale_payload)
        queue_conn.execute(
            "UPDATE pos_sales_queue SET sale_id=?, status='queued', updated_utc=?, error=NULL WHERE id=?",
            (sale_id, _utcnow_z(), row['id'])
        )
        _write_queue_file(sale_id, payload, 'queued')
        return True
    except Exception as exc:
        queue_conn.execute(
            "UPDATE pos_sales_queue SET status='record_error', error=?, attempts=attempts+1, updated_utc=? WHERE id=?",
            (str(exc), _utcnow_z(), row['id'])
        )
        _write_queue_file(sale_id, payload, 'record_error')
        app.logger.warning('Failed to record queued sale %s: %s', sale_id, exc)
        return False


def _sync_queue_status(queue_conn: sqlite3.Connection, main_conn: Optional[sqlite3.Connection]) -> int:
    if not ps or not main_conn:
        return 0
    rows = queue_conn.execute("""
        SELECT id, sale_id, invoice_name, status, payload_json FROM pos_sales_queue
        WHERE sale_id IS NOT NULL AND status IN ('queued','erp_posting','erp_failed')
    """).fetchall()
    updated = 0
    for row in rows:
        sale_id = row['sale_id']
        if not sale_id:
            continue
        try:
            sale_row = main_conn.execute("SELECT queue_status, erp_docname FROM sales WHERE sale_id=?", (sale_id,)).fetchone()
        except Exception:
            sale_row = None
        if not sale_row:
            continue
        queue_status = sale_row['queue_status'] or 'queued'
        new_status = None
        error_msg = None
        if queue_status == 'posted' and row['status'] != 'confirmed':
            new_status = 'confirmed'
        elif queue_status == 'failed' and row['status'] != 'erp_failed':
            new_status = 'erp_failed'
            error_msg = _lookup_outbox_error(main_conn, sale_id)
        elif queue_status == 'posting' and row['status'] != 'erp_posting':
            new_status = 'erp_posting'
        elif queue_status == 'queued' and row['status'] != 'queued':
            new_status = 'queued'
        if not new_status:
            continue
        erp_docname = sale_row['erp_docname'] if 'erp_docname' in sale_row.keys() else None
        queue_conn.execute(
            "UPDATE pos_sales_queue SET status=?, updated_utc=?, error=?, erp_docname=? WHERE id=?",
            (new_status, _utcnow_z(), error_msg, erp_docname, row['id'])
        )
        _write_queue_file(row['invoice_name'], row['payload_json'], new_status)
        updated += 1
    if updated:
        queue_conn.commit()
    return updated


def _lookup_outbox_error(main_conn: sqlite3.Connection, sale_id: str) -> Optional[str]:
    try:
        row = main_conn.execute("SELECT last_error FROM outbox WHERE ref_id=? ORDER BY id DESC LIMIT 1", (sale_id,)).fetchone()
        if row and row['last_error']:
            return row['last_error']
    except Exception:
        return None
    return None


def _process_pos_sales_queue(main_conn: Optional[sqlite3.Connection]) -> Optional[str]:
    if not POS_QUEUE_DB_PATH:
        return None
    queue_conn = _queue_db_connect()
    if not queue_conn:
        return None
    processed = 0
    try:
        rows = queue_conn.execute("""
            SELECT id, invoice_name, payload_json, status FROM pos_sales_queue
            WHERE status IN ('received','record_error')
            ORDER BY id ASC LIMIT ?
        """, (POS_QUEUE_BATCH_LIMIT,)).fetchall()
        dirty = False
        for row in rows:
            dirty = True
            if _record_queue_entry(queue_conn, main_conn, row):
                processed += 1
        if dirty:
            queue_conn.commit()
        synced = _sync_queue_status(queue_conn, main_conn)
        if processed or synced:
            return f"pos queue recorded={processed} synced={synced}"
        return None
    finally:
        queue_conn.close()


# Default customers for offline/mock usage.
_DEFAULT_CUSTOMERS = [
    {"name": "CUST-WALKIN", "customer_name": "Walk-in Customer"},
    {"name": "CUST-ALPHA", "customer_name": "Alpha Ltd"},
    {"name": "CUST-BETA", "customer_name": "Beta Inc"},
    {"name": "CUST-JDOE", "customer_name": "John Doe"}
]

# Idle/background task configuration
IDLE_TASKS_ENABLED = os.getenv('POS_IDLE_TASKS_ENABLED', '1') == '1'
try:
    IDLE_TASK_INTERVAL = int(os.getenv('POS_IDLE_TASK_INTERVAL', '300'))
except ValueError:
    IDLE_TASK_INTERVAL = 300
IDLE_TASK_INTERVAL = max(30, IDLE_TASK_INTERVAL)
try:
    SESSION_PING_INTERVAL = int(os.getenv('POS_SESSION_PING_INTERVAL', '60'))
except ValueError:
    SESSION_PING_INTERVAL = 60
SESSION_PING_INTERVAL = max(15, SESSION_PING_INTERVAL)
try:
    SESSION_TTL_SECONDS = int(os.getenv('POS_SESSION_TTL_SECONDS', '300'))
except ValueError:
    SESSION_TTL_SECONDS = 300
SESSION_TTL_SECONDS = max(SESSION_TTL_SECONDS, SESSION_PING_INTERVAL * 2, 120)

# Track active till sessions to gate background maintenance
_ACTIVE_CASHIER_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSION_LOCK = threading.Lock()
_IDLE_TASK_THREAD: Optional[threading.Thread] = None
_IDLE_TASK_LOCK = threading.Lock()

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
_BACKGROUND_SERVICES_STARTED = False

def _purge_expired_sessions_locked(now_ts: Optional[float] = None) -> None:
    """Drop cashier sessions that have not pinged recently."""
    cutoff = now_ts or time.time()
    expired: List[str] = []
    for sess_id, meta in list(_ACTIVE_CASHIER_SESSIONS.items()):
        last_seen = float(meta.get('last_seen') or 0)
        if cutoff - last_seen > SESSION_TTL_SECONDS:
            expired.append(sess_id)
    for sess_id in expired:
        _ACTIVE_CASHIER_SESSIONS.pop(sess_id, None)
        app.logger.info("Cashier session %s expired after inactivity (active=%d)", sess_id, len(_ACTIVE_CASHIER_SESSIONS))


def _remove_sessions_for_code_locked(code: Optional[str], skip_session: Optional[str] = None) -> None:
    if not code:
        return
    targets = [sid for sid, meta in _ACTIVE_CASHIER_SESSIONS.items()
               if meta.get('code') == code and sid != skip_session]
    for sid in targets:
        _ACTIVE_CASHIER_SESSIONS.pop(sid, None)
        app.logger.info("Removed stale session %s for cashier %s (active=%d)", sid, code, len(_ACTIVE_CASHIER_SESSIONS))


def _register_cashier_session(code: str) -> Optional[str]:
    """Create a lightweight session token for presence tracking."""
    session_id = uuid4().hex
    now_ts = time.time()
    with _SESSION_LOCK:
        _purge_expired_sessions_locked(now_ts)
        _remove_sessions_for_code_locked(code)
        _ACTIVE_CASHIER_SESSIONS[session_id] = {'code': code, 'last_seen': now_ts}
    return session_id


def _touch_cashier_session(session_id: str) -> bool:
    """Refresh presence timestamp; returns False if the session is unknown."""
    if not session_id:
        return False
    with _SESSION_LOCK:
        _purge_expired_sessions_locked()
        if session_id not in _ACTIVE_CASHIER_SESSIONS:
            return False
        _ACTIVE_CASHIER_SESSIONS[session_id]['last_seen'] = time.time()
        return True


def _remove_cashier_session(session_id: str) -> bool:
    """Clear the recorded session so idle tasks can resume."""
    if not session_id:
        return False
    with _SESSION_LOCK:
        removed = _ACTIVE_CASHIER_SESSIONS.pop(session_id, None)
        return removed is not None


def _active_session_count() -> int:
    with _SESSION_LOCK:
        _purge_expired_sessions_locked()
        return len(_ACTIVE_CASHIER_SESSIONS)


def _has_active_cashier_sessions() -> bool:
    return _active_session_count() > 0


def _ensure_idle_worker():
    """Start the idle maintenance worker thread if enabled."""
    global _IDLE_TASK_THREAD
    if not IDLE_TASKS_ENABLED or not ps:
        return
    if _IDLE_TASK_THREAD and _IDLE_TASK_THREAD.is_alive():
        return
    _IDLE_TASK_THREAD = threading.Thread(target=_idle_maintenance_loop, name='idle-maintenance', daemon=True)
    _IDLE_TASK_THREAD.start()
    app.logger.info("Idle maintenance thread started (interval=%ss)", IDLE_TASK_INTERVAL)


def _idle_maintenance_loop():
    """Periodically run maintenance tasks whenever no cashier sessions are active."""
    while True:
        try:
            time.sleep(IDLE_TASK_INTERVAL)
        except Exception:
            continue
        if not IDLE_TASKS_ENABLED:
            continue
        if _has_active_cashier_sessions():
            continue
        try:
            _run_idle_maintenance_tasks()
        except Exception as exc:
            app.logger.exception("Idle maintenance cycle failed: %s", exc)


def _run_idle_maintenance_tasks():
    """Perform background work (ERP sync, queue drain, invoice ingest) when tills are idle."""
    if not ps:
        return
    acquired = _IDLE_TASK_LOCK.acquire(blocking=False)
    if not acquired:
        return
    conn = None
    try:
        conn = _db_connect() or ps.connect(POS_DB_PATH)
        if not conn:
            return
        summary: List[str] = []
        try:
            ingested = _ingest_new_local_invoices(conn)
            if ingested:
                summary.append(f"ingested {ingested} invoice(s)")
        except Exception as exc:
            app.logger.warning("Idle invoice ingest failed: %s", exc)
        if not USE_MOCK and _has_erp_credentials():
            try:
                ps.sync_cycle(conn, warehouse=POS_WAREHOUSE, price_list=POS_PRICE_LIST, loops=1)
                summary.append("synced ERP catalog")
            except Exception as exc:
                app.logger.warning("Idle ERP sync failed: %s", exc)
        if not POS_QUEUE_ONLY and not USE_MOCK and _has_erp_credentials():
            try:
                ps.push_outbox(conn)
                summary.append("pushed outbox")
            except Exception as exc:
                app.logger.warning("Idle outbox push failed: %s", exc)
        if summary:
            app.logger.info("Idle maintenance completed (%s)", ", ".join(summary))
        try:
            queue_note = _process_pos_sales_queue(conn)
            if queue_note:
                app.logger.info("Idle %s", queue_note)
        except Exception as exc:
            app.logger.warning("Idle POS queue processing failed: %s", exc)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        _IDLE_TASK_LOCK.release()

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
    # Use POS_WAREHOUSE config var in the SQL subquery for aggregated variant stock
    q_tpl = f"""
    SELECT i.item_id AS name,
           i.item_id AS item_code,
           i.name AS item_name,
           i.brand AS brand,
           i.custom_style_code AS custom_style_code,
           i.custom_simple_colour AS custom_simple_colour,
           i.vat_rate AS vat_rate,
        (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS standard_rate,
        -- Min/max of configured price list rates for child variants (if present in item_prices)
        (SELECT MIN(ip.rate) FROM item_prices ip JOIN items v2 ON v2.item_id = ip.item_id WHERE v2.parent_id = i.item_id) AS min_variant_price,
        (SELECT MAX(ip.rate) FROM item_prices ip JOIN items v2 ON v2.item_id = ip.item_id WHERE v2.parent_id = i.item_id) AS max_variant_price,
        -- Aggregate sellable stock across variants for this template (using configured warehouse)
        (SELECT COALESCE(SUM(s.qty),0) FROM stock s JOIN items v2 ON v2.item_id = s.item_id WHERE v2.parent_id = i.item_id AND s.warehouse='{POS_WAREHOUSE}') AS variant_stock,
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

    # Aggregate custom fields (style code + simple colour) from variants
    custom_agg: Dict[str, Dict[str, Set[str]]] = {}
    q_custom = """
      SELECT parent_id AS template_id, custom_style_code, custom_simple_colour
      FROM items
      WHERE parent_id IS NOT NULL
        AND (custom_style_code IS NOT NULL OR custom_simple_colour IS NOT NULL)
    """
    for row in conn.execute(q_custom):
        tpl = row["template_id"]
        if not tpl:
            continue
        entry = custom_agg.setdefault(tpl, {"custom_style_code": set(), "custom_simple_colour": set()})
        if row["custom_style_code"]:
            entry["custom_style_code"].add(str(row["custom_style_code"]))
        if row["custom_simple_colour"]:
            entry["custom_simple_colour"].add(str(row["custom_simple_colour"]))

    barcode_map: Dict[str, Set[str]] = {}
    q_barcodes = """
      SELECT v.parent_id AS template_id, b.barcode
      FROM barcodes b
      JOIN items v ON v.item_id = b.item_id
      WHERE v.parent_id IS NOT NULL
        AND b.barcode IS NOT NULL
    """
    for row in conn.execute(q_barcodes):
        tpl = row["template_id"]
        if not tpl:
            continue
        bc = (row["barcode"] or '').strip()
        if not bc:
            continue
        barcode_map.setdefault(tpl, set()).add(bc)

    out = []
    for r in conn.execute(q_tpl):
        attrs = {}
        if r["name"] in agg:
            for aname, values in agg[r["name"]].items():
                disp = " ".join(sorted(values))
                for key in _attribute_payload_keys(aname):
                    attrs[key] = disp

        # Determine displayed rate: prefer template's effective price; otherwise fallback to variant prices
        template_rate = r["standard_rate"] if r["standard_rate"] is not None else None
        min_var = r["min_variant_price"] if r["min_variant_price"] is not None else None
        max_var = r["max_variant_price"] if r["max_variant_price"] is not None else None
        display_rate = template_rate if template_rate is not None else (min_var if min_var is not None else None)

        custom_entry = custom_agg.get(r["name"])
        barcodes = sorted(barcode_map.get(r["name"] , set()))
        payload = {
            "name": r["name"],
            "item_code": r["item_code"],
            "item_name": r["item_name"],
            "brand": r["brand"],
            "custom_style_code": _merge_custom_field_value(
                r["custom_style_code"],
                custom_entry["custom_style_code"] if custom_entry else None
            ),
            "custom_simple_colour": _merge_custom_field_value(
                r["custom_simple_colour"],
                custom_entry["custom_simple_colour"] if custom_entry else None
            ),
            "vat_rate": float(r["vat_rate"]) if r["vat_rate"] is not None else None,
            "barcode": barcodes[0] if barcodes else None,
            "standard_rate": float(display_rate) if display_rate is not None else None,
            "stock_uom": r["stock_uom"],
            "image": _absolute_image_url(r["image"]),
            "attributes": attrs,
            "barcodes": barcodes,
            # expose variant price bounds and aggregated stock for UI use
            "price_min": float(min_var) if min_var is not None else None,
            "price_max": float(max_var) if max_var is not None else None,
            "variant_stock": float(r["variant_stock"]) if r["variant_stock"] is not None else 0.0,
        }
        out.append(payload)
    return out

def _merge_custom_field_value(base_value: Optional[str], variants: Optional[Set[str]]) -> Optional[str]:
    values: List[str] = []
    if base_value:
        values.append(str(base_value))
    if variants:
        values.extend(str(v) for v in variants if v)
    if not values:
        return None
    dedup = []
    seen = set()
    for val in values:
        if val in seen:
            continue
        dedup.append(val)
        seen.add(val)
    if len(dedup) == 1:
        return dedup[0]
    dedup.sort()
    return ", ".join(dedup)

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

def _has_erp_credentials() -> bool:
    return bool(ERPNEXT_URL and API_KEY and API_SECRET)

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
                if _has_erp_credentials():
                    _bootstrap_sync_from_erp(conn, need_items=need_items, need_cashiers=need_cashiers)
                else:
                    app.logger.warning(
                        "Skipping ERP bootstrap: ERPNEXT_URL/API credentials not configured (ERPNEXT_URL=%s, key=%s).",
                        ERPNEXT_URL, bool(API_KEY and API_SECRET)
                    )
            completed = True
        except Exception as exc:
            app.logger.warning(
                "Initial ERP bootstrap failed: %s (verify ERPNEXT_URL + API key/secret)", exc
            )
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
    if hasattr(ps, 'pull_item_attributes'):
        try:
            while True:
                pulled = ps.pull_item_attributes(conn, limit=200)
                if pulled < 200:
                    break
        except Exception as exc:
            err_code = getattr(exc, 'code', None)
            if not err_code:
                resp = getattr(exc, 'response', None)
                if resp is not None:
                    err_code = getattr(resp, 'status_code', None)
            if err_code == 403:
                app.logger.warning("Item attribute bootstrap skipped (HTTP 403). Grant read access on 'Item Attribute'.")
            else:
                app.logger.warning("Item attribute bootstrap failed: %s", exc)
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
    if POS_PRICE_LIST and hasattr(ps, 'pull_item_prices_incremental'):
        try:
            ps.pull_item_prices_incremental(conn, price_list=POS_PRICE_LIST, limit=500)
        except Exception as exc:
            app.logger.warning("Price list bootstrap failed: %s", exc)
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
    headers = {
        'Authorization': f'token {API_KEY}:{API_SECRET}',
        'Accept': 'application/json',
        'Expect': ''
    }
    headers['Content-Type'] = 'application/json'
    return headers


def _erp_session_get(url: str, params: Optional[Dict[str, Any]] = None, timeout: float = 15):
    """Use a prepared request to ensure Expect headers are stripped for ERPNext GETs."""
    headers = _erp_headers()
    session = requests.Session()
    try:
        req = requests.Request("GET", url, headers=headers, params=params)
        prepped = session.prepare_request(req)
        prepped.headers.pop('Expect', None)
        return session.send(prepped, timeout=timeout)
    finally:
        session.close()

def _absolute_image_url(path: Optional[str]) -> Optional[str]:
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

def _canonical_attr_name(name: Optional[str]) -> Optional[str]:
    if name is None:
        return None
    text = str(name).strip()
    if not text:
        return None
    key = text.lower()
    return ATTRIBUTE_SYNONYMS.get(key) or text

def _attribute_payload_keys(name: Optional[str]) -> Tuple[str, ...]:
    canon = _canonical_attr_name(name)
    original = (str(name).strip() if name else '') or None
    keys = []
    if canon:
        keys.append(canon)
    if original and original != canon:
        keys.append(original)
    if not keys and original:
        keys.append(original)
    return tuple(keys)

def _variant_attrs_dict(conn: sqlite3.Connection, item_id: str) -> dict:
    attrs = {}
    if not item_id:
        return attrs
    try:
        for ar in conn.execute("SELECT attr_name, value FROM variant_attributes WHERE item_id=?", (item_id,)):
            for key in _attribute_payload_keys(ar['attr_name']):
                attrs[key] = ar['value']
    except Exception:
        pass
    return attrs

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
        receipt_agent_url=RECEIPT_AGENT_URL or '',
        receipt_default_port=RECEIPT_DEFAULT_PORT
    )


@app.route('/api/serial-ports')
def api_serial_ports():
    """Return available serial/COM ports for the till."""
    if not list_ports:
        return jsonify({'status': 'error', 'message': 'pyserial is not installed'}), 501
    ports = []
    try:
        for port in list_ports.comports():
            ports.append({
                'device': port.device or '',
                'description': port.description or '',
                'hwid': port.hwid or ''
            })
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500
    return jsonify({'status': 'success', 'ports': ports})


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
                    'fields': '["name", "item_code", "item_name", "brand", "custom_style_code", "custom_simple_colour", "item_group", "image", "standard_rate", "stock_uom", "barcode", "barcodes"]',
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
                item['vat_rate'] = item.get('vat_rate')
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
    try:
        ingested = _ingest_new_local_invoices(conn)
        if ingested:
            app.logger.info("Ingested %s local invoice(s) into SQLite during cashier login", ingested)
    except Exception:
        pass
    session_id = _register_cashier_session(row['code'])
    if session_id:
        app.logger.info("Cashier %s session started (active=%d)", row['code'], _active_session_count())
    payload = {
        'status': 'success',
        'cashier': {'code': row['code'], 'name': row['name']},
        'session': session_id,
        'session_ping_interval': SESSION_PING_INTERVAL,
        'session_ttl': SESSION_TTL_SECONDS
    }
    _ensure_idle_worker()
    return jsonify(payload)


@app.route('/api/cashier/ping', methods=['POST'])
def api_cashier_ping():
    """Heartbeat endpoint so the server knows a cashier is still logged in."""
    data = request.get_json(silent=True) or {}
    session_id = str(data.get('session') or '').strip()
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session'}), 400
    if not _touch_cashier_session(session_id):
        return jsonify({'status': 'error', 'message': 'Session not found'}), 404
    return jsonify({'status': 'success'})


@app.route('/api/cashier/logout', methods=['POST'])
def api_cashier_logout():
    """Mark a cashier session as logged out so idle maintenance can resume quickly."""
    data = request.get_json(silent=True) or {}
    session_id = str(data.get('session') or '').strip()
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session'}), 400
    removed = _remove_cashier_session(session_id)
    if removed:
        app.logger.info("Cashier session closed (active=%d)", _active_session_count())
    return jsonify({'status': 'success', 'active_sessions': _active_session_count()})


def _format_till_segment(till_value: Optional[str]) -> str:
    if till_value is None:
        return '000'
    cleaned = ''.join(ch for ch in str(till_value) if ch.isdigit())
    if not cleaned:
        return '000'
    if len(cleaned) >= 3:
        return cleaned[-3:]
    return cleaned.zfill(3)


def _generate_invoice_name(till_number: Optional[str] = None) -> str:
    """Stable invoice names for offline receipts."""
    date_segment = datetime.now().strftime('%Y%m%d')
    till_segment = _format_till_segment(till_number)
    unique_segment = uuid4().hex[:4].upper()
    return f"{date_segment}{till_segment}{unique_segment}"


def _extract_till_number(data: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    for key in ('till_number', 'till', 'till_id'):
        value = data.get(key)
        if value is None or value == '':
            continue
        if isinstance(value, str):
            value = value.strip()
        if value:
            return value
    return None


def _save_invoice_file(invoice_name: str, data: dict, mode_label: str) -> None:
    """Persist the JSON receipt for audit/replay."""
    try:
        os.makedirs('invoices', exist_ok=True)
        items_payload = []
        for it in data.get('items') or []:
            entry = {
                'item_code': it.get('item_code') or it.get('code') or it.get('name'),
                'item_name': it.get('item_name') or it.get('name'),
                'qty': it.get('qty'),
                'rate': it.get('rate'),
                'vat_rate': it.get('vat_rate')
            }
            items_payload.append(entry)
        till_number = _extract_till_number(data)
        record = {
            'invoice_name': invoice_name,
            'sale_id': invoice_name,
            'created_at': datetime.now().isoformat(),
            'mode': mode_label,
            'customer': data.get('customer'),
            'items': items_payload,
            'payments': data.get('payments') or [],
            'tender': data.get('tender'),
            'cash_given': data.get('cash_given'),
            'change': data.get('change'),
            'total': data.get('total'),
            'vouchers': data.get('vouchers') or [],
            'cashier': data.get('cashier'),
            'currency_used': data.get('currency_used', 'GBP'),
            'currency_rate_used': data.get('currency_rate_used', 1.0),
            'fx_metadata': data.get('fx_metadata'),
            'till_number': till_number,
            'till': till_number
        }
        with open(os.path.join('invoices', f"{invoice_name}.json"), 'w', encoding='utf-8') as f:
            _json.dump(record, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _sanitize_barcode_value(value: Optional[str]) -> str:
    if not value:
        return ''
    normalized = re.sub(r'\s+', ' ', str(value).upper()).strip()
    safe = re.sub(r'[^A-Z0-9\-\. \$\/\+\%]', '', normalized)
    return safe[:42]


def _build_barcode_sequence_code39(value: str) -> List[str]:
    clean = str(value).strip()
    if not clean:
        return []
    value_hex = " ".join(f"{ord(c):02x}" for c in clean)
    return [
        "1b 40",
        "1d 68 50",
        "1d 77 02",
        "1d 48 02",
        f"1d 6b 04 {value_hex} 00",
        "0a",
    ]


def _receipt_barcode_context(invoice_name: str) -> dict:
    clean_value = _sanitize_barcode_value(invoice_name)
    if not clean_value:
        return {'invoice_barcode_value': '', 'invoice_barcode_hex': []}
    return {
        'invoice_barcode_value': clean_value,
        'invoice_barcode_hex': _build_barcode_sequence_code39(clean_value)
    }


def _receipt_success_payload(invoice_name: str, message: str) -> dict:
    payload = {
        'status': 'success',
        'message': message,
        'invoice_name': invoice_name
    }
    payload.update(_receipt_barcode_context(invoice_name))
    return payload


def _build_sale_payload(data: dict, sale_id: str) -> dict:
    """Normalize incoming checkout data for the local SQLite queue."""
    items = data.get('items') or []
    payments = data.get('payments') or []
    vouchers = data.get('vouchers') or []
    tender = (data.get('tender') or '').strip() or None

    lines = []
    for it in items:
        item_id = it.get('item_code') or it.get('code') or it.get('name')
        if not item_id:
            continue
        vat_rate = it.get('vat_rate')
        try:
            vat_rate = float(vat_rate) if vat_rate not in (None, '') else None
        except (TypeError, ValueError):
            vat_rate = None
        lines.append({
            'item_id': item_id,
            'item_name': it.get('item_name') or it.get('name') or '',
            'brand': it.get('brand'),
            'attributes': it.get('attributes') or {},
            'qty': float(it.get('qty') or 0),
            'rate': float(it.get('rate') or 0),
            'barcode_used': it.get('barcode_used') or it.get('barcode') or None,
            'vat_rate': vat_rate,
        })

    payments_payload = []
    for p in payments:
        amount = float(p.get('amount') or p.get('amount_gbp') or 0)
        payments_payload.append({
            'method': (p.get('mode_of_payment') or p.get('method') or 'Other'),
            'amount': amount,
            'amount_gbp': float(p.get('amount_gbp') or amount),
            'amount_eur': float(p.get('amount_eur')) if p.get('amount_eur') else None,
            'currency': (p.get('currency') or 'GBP').upper(),
            'eur_rate': float(p.get('eur_rate')) if p.get('eur_rate') else None,
            'ref': p.get('ref'),
            'meta': p.get('meta')
        })

    voucher_payload = [
        {'code': v.get('code'), 'amount': float(v.get('amount') or 0)}
        for v in vouchers if v.get('code')
    ]

    def _safe_float(val):
        if val in (None, ''):
            return None
        try:
            return float(val)
        except (TypeError, ValueError):
            return None

    cash_given = _safe_float(data.get('cash_given'))
    change_due = _safe_float(data.get('change'))

    cashier = (data.get('cashier') or {}).get('code') or (data.get('cashier') or {}).get('name')
    till_number = _extract_till_number(data)

    return {
        'sale_id': sale_id,
        'cashier': cashier,
        'customer_id': data.get('customer'),
        'warehouse': data.get('warehouse') or POS_WAREHOUSE,
        'lines': lines,
        'payments': payments_payload,
        'voucher_redeem': voucher_payload,
        'discount': float(data.get('discount') or 0),
        'tax': float(data.get('tax') or 0),
        'tender': tender,
        'cash_given': cash_given,
        'change': change_due,
        'till': till_number,
        'till_number': till_number,
    }


def _record_local_sale(invoice_name: str, data: dict) -> None:
    if not ps:
        return
    try:
        conn = _db_connect() or ps.connect(POS_DB_PATH)
        if not conn:
            return
        sale_payload = _build_sale_payload(data, invoice_name)
        fx_metadata = data.get('fx_metadata')
        if fx_metadata:
            ps.record_sale_with_fx(conn, sale_payload, fx_metadata)
        else:
            ps.record_sale(conn, sale_payload)
    except Exception:
        pass


def _persist_local_sale(data: dict, mode_label: str) -> str:
    till_number = _extract_till_number(data)
    invoice_name = _generate_invoice_name(till_number)
    _save_invoice_file(invoice_name, data, mode_label)
    _record_local_sale(invoice_name, data)
    return invoice_name


def _ingest_new_local_invoices(conn: Optional[sqlite3.Connection]) -> int:
    """Replay invoices/*.json that have not yet been persisted into SQLite."""
    if not ps or not conn:
        return 0
    inv_dir = Path('invoices')
    if not inv_dir.is_dir():
        return 0
    ingested = 0
    for inv_path in sorted(inv_dir.glob('*.json')):
        try:
            with open(inv_path, 'r', encoding='utf-8') as f:
                record = _json.load(f)
        except Exception:
            continue
        sale_id = record.get('sale_id') or record.get('invoice_name') or inv_path.stem
        if not sale_id:
            continue
        try:
            exists = conn.execute('SELECT 1 FROM sales WHERE sale_id=?', (sale_id,)).fetchone()
        except Exception:
            exists = None
        if exists:
            continue
        try:
            payload = _build_sale_payload(record, sale_id)
            fx_metadata = record.get('fx_metadata')
            app.logger.info('Recording sale ID "%s" into database', sale_id)

            if fx_metadata:
                ps.record_sale_with_fx(conn, payload, fx_metadata)
                app.logger.info('Recorded sale ID "%s" with FX into database', sale_id)
            else:
                ps.record_sale(conn, payload)
                app.logger.info('Recorded sale ID "%s" into database', sale_id)

            ingested += 1

        except Exception:
            app.logger.exception('Failed to record sale "%s" from %s', sale_id, inv_path)
            continue



@app.route('/api/create-sale', methods=['POST'])
def create_sale():
    """Create a sales invoice"""
    data = request.json or {}
    customer = data.get('customer')
    if not customer:
        return jsonify({'status': 'error', 'message': 'Customer is required'}), 400
    items = data.get('items') or []
    if not items:
        return jsonify({'status': 'error', 'message': 'Items are required'}), 400
    payments = data.get('payments') or []

    if POS_QUEUE_ONLY:
        mode_label = 'local'
        invoice_name = _persist_local_sale(data, mode_label)
        return jsonify(_receipt_success_payload(invoice_name, 'Sale recorded (queued locally for sync)'))
    if USE_MOCK:
        mode_label = 'mock'
        invoice_name = _persist_local_sale(data, mode_label)
        return jsonify(_receipt_success_payload(invoice_name, 'Sale recorded (mock)'))

    try:
        invoice_data = {
            'doctype': 'Sales Invoice',
            'customer': customer,
            'posting_date': datetime.now().strftime('%Y-%m-%d'),
            'items': items,
            'is_pos': 1,
            'payments': payments
        }
        response = requests.post(
            f"{ERPNEXT_URL}/api/resource/Sales Invoice",
            headers=_erp_headers(),
            json=invoice_data,
            timeout=20
        )
        response.raise_for_status()
        invoice = response.json().get('data', {})

        submit_response = requests.post(
            f"{ERPNEXT_URL}/api/method/frappe.client.submit",
            headers=_erp_headers(),
            json={
                'doc': {
                    'doctype': 'Sales Invoice',
                    'name': invoice['name'],
                }
            },
            timeout=20
        )
        submit_response.raise_for_status()

        _save_invoice_file(invoice['name'], data, 'erpnext')
        return jsonify(_receipt_success_payload(invoice['name'], 'Sale completed successfully'))
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/pos/sales', methods=['POST'])
def api_pos_sales_ingest():
    """Receive till receipts via shared secret and queue them for ERP posting."""
    if not _valid_pos_shared_key(request.headers.get('X-POS-KEY')):
        return jsonify({'status': 'error', 'message': 'Invalid POS key'}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'status': 'error', 'message': 'Invalid JSON payload'}), 400
    validation_error = _validate_pos_sale_payload(payload)
    if validation_error:
        return jsonify({'status': 'error', 'message': validation_error}), 400
    try:
        queue_id = _enqueue_pos_sale(payload)
        return jsonify({'status': 'received', 'queue_id': queue_id})
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400
    except Exception as exc:
        app.logger.exception('Failed to enqueue POS sale')
        return jsonify({'status': 'error', 'message': 'Unable to queue sale'}), 502


@app.route('/api/customers')
def get_customers():
    """Get all customers"""
    if USE_MOCK:
        return jsonify({'status': 'success', 'customers': _default_customer_list()})
    conn = _db_connect()
    try:
        response = _erp_session_get(
            f"{ERPNEXT_URL}/api/resource/Customer",
            params={
                'fields': '["name", "customer_name"]',
                'filters': '[["disabled","=",0]]'
            },
            timeout=15
        )
        response.raise_for_status()
        customers = response.json().get('data', []) or []
        if customers:
            _cache_customers(conn, customers)
        else:
            customers = _default_customer_list()
        return jsonify({'status': 'success', 'customers': customers})
    except requests.HTTPError as e:
        app.logger.warning('ERPNext customer fetch failed with HTTP error: %s', e)
        return _fallback_customer_response(conn, 'ERPNext customer list unavailable (HTTP error).')
    except Exception:
        app.logger.exception('Failed to fetch customers from ERPNext')
        return _fallback_customer_response(conn, 'ERPNext customer list unavailable.')
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def _default_customer_list():
    return [dict(item) for item in _DEFAULT_CUSTOMERS]


def _cache_customers(conn: Optional[sqlite3.Connection], customers: List[Dict[str, Any]]):
    if not conn or not ps:
        return
    try:
        ps.upsert_customers(conn, customers)
    except Exception:
        app.logger.exception('Failed to cache ERPNext customers')


def _cached_customers(conn: Optional[sqlite3.Connection]) -> List[Dict[str, str]]:
    if not conn or not ps:
        return []
    try:
        return ps.fetch_customers(conn)
    except Exception:
        app.logger.exception('Failed to load cached customers')
        return []


def _fallback_customer_response(conn: Optional[sqlite3.Connection], note: Optional[str] = None):
    customers = _cached_customers(conn) or _default_customer_list()
    payload = {'status': 'success', 'customers': customers}
    if note:
        payload['note'] = note
    return jsonify(payload)

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
    # Trigger an incremental pull from ERPNext into the local SQLite DB.
    # Runs the sync in a background thread and returns immediately.
    if not ERPNEXT_URL:
        return jsonify({'status':'error','message':'ERPNext not configured'}), 400
    if not ps or not hasattr(ps, 'sync_cycle'):
        return jsonify({'status':'error','message':'pos_service not available or missing sync implementation'}), 500
    def _run_sync():
        conn = None
        try:
            # Connect to DB inside the worker thread to avoid cross-thread SQLite use
            try:
                conn = _db_connect() or ps.connect(POS_DB_PATH)
            except Exception as e:
                app.logger.exception('Failed to connect to DB inside sync worker: %s', e)
                return
            # Ensure schema present
            try:
                _ensure_schema(conn)
            except Exception:
                pass
            # Run a few loops to fetch items, attributes, barcodes, bins and prices
            ps.sync_cycle(conn, warehouse=POS_WAREHOUSE, price_list=POS_PRICE_LIST, loops=3)
            app.logger.info('ERPNext incremental sync completed')
        except Exception as exc:
            app.logger.exception('ERP sync failed: %s', exc)
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

    thr = threading.Thread(target=_run_sync, daemon=True)
    thr.start()
    return jsonify({'status': 'success', 'message': 'Sync started'})

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
    qv = f"""
      SELECT v.item_id,
             v.name,
             v.vat_rate,
             v.image_url,
             v.custom_style_code,
             (SELECT price_effective FROM v_item_prices p WHERE p.item_id=v.item_id) AS rate,
             COALESCE((SELECT qty FROM stock s WHERE s.item_id=v.item_id AND s.warehouse='{POS_WAREHOUSE}'), 0) AS qty
      FROM items v
      WHERE v.parent_id=? AND v.active=1 AND v.is_template=0
    """
    variants = {}
    colors=set(); widths=set(); sizes=set()
    style_codes: Dict[str, str] = {}
    price_min = None
    price_max = None
    rows = conn.execute(qv, (template_id,)).fetchall()
    attr_map = {}
    if rows:
        ids = tuple(r["item_id"] for r in rows)
        if ids:
            placeholders = ",".join(["?"]*len(ids))
            for ar in conn.execute(f"SELECT item_id, attr_name, value FROM variant_attributes WHERE item_id IN ({placeholders})", ids):
                d = attr_map.setdefault(ar["item_id"], {})
                for key in _attribute_payload_keys(ar["attr_name"]):
                    d[key] = ar["value"]
    for r in rows:
        attrs = attr_map.get(r["item_id"], {})
        color = attrs.get('Color') or attrs.get('Colour') or attrs.get('color') or '-'
        width = attrs.get('Width') or attrs.get('width') or attrs.get('Fit') or 'Standard'
        size = (attrs.get('Size') or attrs.get('EU half Sizes') or attrs.get('UK half Sizes') or '-')
        colors.add(color); widths.add(width); sizes.add(size)
        key = f"{color}|{width}|{size}"
        # Get variant image (with absolute URL), fallback to parent image
        variant_image = _absolute_image_url(r['image_url']) if r['image_url'] else None
        style_code = (r["custom_style_code"] or '').strip() if r["custom_style_code"] else ''
        if style_code:
            style_codes.setdefault(color, style_code)
        variants[key] = {
            'item_id': r['item_id'],
            'item_name': r['name'],
            'rate': float(r['rate']) if r['rate'] is not None else None,
            'qty': float(r['qty']),
            'vat_rate': float(r['vat_rate']) if r['vat_rate'] is not None else None,
            'image': variant_image
        }
        if style_code:
            variants[key]['style_code'] = style_code
        rate_value = variants[key]['rate']
        if rate_value is not None:
            if price_min is None or rate_value < price_min:
                price_min = rate_value
            if price_max is None or rate_value > price_max:
                price_max = rate_value
    data = {
        'item': template_id,
        'sizes': sorted(sizes, key=lambda x: (len(x), x)),
        'colors': sorted(colors),
        'widths': sorted(widths),
        'stock': { k:v['qty'] for k,v in variants.items() },
        'variants': variants,
        'price': None,
        'image': None,
        'price_min': price_min,
        'price_max': price_max,
        'style_codes': style_codes,
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
               i.brand,
               i.vat_rate,
               i.custom_style_code,
               (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS rate,
               COALESCE((SELECT qty FROM stock s WHERE s.item_id=i.item_id AND s.warehouse='Shop'), 0) AS qty
        FROM barcodes b
        JOIN items i ON i.item_id = b.item_id
        WHERE b.barcode = ? AND i.active=1
        """,
        (code,)
    ).fetchone()
    # If no barcode row found, fall back to matching the code against item_id/name
    if not row:
        try:
            row = conn.execute(
                """
                SELECT i.item_id,
                       i.name,
                       i.brand,
                       i.vat_rate,
                       i.custom_style_code,
                       (SELECT price_effective FROM v_item_prices p WHERE p.item_id = i.item_id) AS rate,
                       COALESCE((SELECT qty FROM stock s WHERE s.item_id=i.item_id AND s.warehouse='Shop'), 0) AS qty
                FROM items i
                WHERE (i.item_id = ? OR i.name = ?) AND i.active=1
                """,
                (code, code)
            ).fetchone()
        except Exception:
            row = None
    if not row:
        return jsonify({'status': 'error', 'message': 'Not found'}), 404
    attrs = _variant_attrs_dict(conn, row['item_id'])
    style_code = (row['custom_style_code'] or '').strip() if row['custom_style_code'] else ''
    brand = row['brand'] if row['brand'] else None
    out = {
      'item_id': row['item_id'],
      'name': row['name'],
      'rate': float(row['rate']) if row['rate'] is not None else 0.0,
      'vat_rate': float(row['vat_rate']) if row['vat_rate'] is not None else None,
      'qty': float(row['qty']) if row['qty'] is not None else 0.0,
      'brand': brand,
      'item_group': brand,
      'attributes': attrs,
      'style_code': style_code
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
    # Attach attributes (normalized key names)
    for vid in ids:
        if vid not in out:
            out[vid] = {'item_id': vid, 'name': '', 'brand': None, 'attributes': {}}
        attrs = _variant_attrs_dict(conn, vid)
        if attrs:
            out[vid]['attributes'].update(attrs)
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
                    'rate': it.get('rate') or it.get('price') or 0,
                    'vat_rate': it.get('vat_rate')
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
                                'rate': it.get('rate') or it.get('price') or 0,
                                'vat_rate': it.get('vat_rate')
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
                        'rate': ln.get('rate') or ln.get('price') or 0,
                        'vat_rate': ln.get('vat_rate')
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


# ---- Currency/Exchange Rate APIs ----

# Global thread for currency rate updates (started on first use)
_CURRENCY_UPDATER_THREAD = None

def _ensure_currency_updater():
    """Start the background currency updater thread if not already running."""
    global _CURRENCY_UPDATER_THREAD
    if _CURRENCY_UPDATER_THREAD is None and ps:
        try:
            base = os.getenv('CURRENCY_BASE', 'GBP')
            target = os.getenv('CURRENCY_TARGET', 'EUR')
            
            # Ensure rate is populated (blocking call - checks if exists/is fresh)
            conn = _db_connect()
            if conn:
                ps.ensure_currency_rate_populated(conn, base, target)
                conn.close()
            
            # Schedule background updates
            _CURRENCY_UPDATER_THREAD = ps.schedule_currency_rate_update(
                base=base,
                target=target,
                interval_seconds=int(os.getenv('CURRENCY_UPDATE_INTERVAL', '86400'))
            )
            app.logger.info("Currency rate updater thread started")
        except Exception as e:
            app.logger.warning(f"Failed to start currency updater: {e}")

@app.route('/api/currency/rates')
def api_get_currency_rates():
    """Get the current exchange rates from the database.
    Query params:
      base: Base currency code (default: GBP)
      target: Target currency code (default: EUR)
    Response: { status, base, target, rate, last_updated }
    """
    try:
        base = (request.args.get('base') or 'GBP').strip().upper()
        target = (request.args.get('target') or 'EUR').strip().upper()
        
        if not ps:
            return jsonify({'status': 'error', 'message': 'pos_service not available'}), 500
        
        conn = _db_connect()
        if not conn:
            return jsonify({'status': 'error', 'message': 'Database not available'}), 500
        
        rate = ps.get_currency_rate(conn, base, target)
        if rate is None:
            return jsonify({'status': 'error', 'message': f'No rate found for {base}->{target}'}), 404
        
        # Get last_updated timestamp
        row = conn.execute(
            "SELECT last_updated FROM rates WHERE base_currency=? AND target_currency=? ORDER BY last_updated DESC LIMIT 1",
            (base, target)
        ).fetchone()
        last_updated = row['last_updated'] if row else None
        
        return jsonify({
            'status': 'success',
            'base': base,
            'target': target,
            'rate': float(rate),
            'last_updated': last_updated
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/currency/convert', methods=['POST'])
def api_convert_currency():
    """Convert an amount using the current exchange rate.
    Body: { amount, base, target, round_mode }
    round_mode: 'nearest' (default), 'down', 'none'
    Response: { status, base, target, amount_base, conversion: { actual, rounded, rounded_down, rate, savings } }
    """
    try:
        data = request.json or {}
        amount = float(data.get('amount') or 0)
        base = (data.get('base') or 'GBP').strip().upper()
        target = (data.get('target') or 'EUR').strip().upper()
        round_mode = (data.get('round_mode') or 'nearest').strip().lower()
        
        if amount < 0:
            return jsonify({'status': 'error', 'message': 'Amount must be non-negative'}), 400
        if round_mode not in ('nearest', 'down', 'none'):
            round_mode = 'nearest'
        
        if not ps:
            return jsonify({'status': 'error', 'message': 'pos_service not available'}), 500
        
        conn = _db_connect()
        if not conn:
            return jsonify({'status': 'error', 'message': 'Database not available'}), 500
        
        rate = ps.get_currency_rate(conn, base, target)
        if rate is None:
            return jsonify({'status': 'error', 'message': f'No rate found for {base}->{target}'}), 404

        result = ps.convert_currency(amount, rate, round_mode, target)

        return jsonify({
            'status': 'success',
            'base': base,
            'target': target,
            'amount_base': round(amount, 2),
            'conversion': result
        })
    except ValueError as e:
        return jsonify({'status': 'error', 'message': f'Invalid input: {e}'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/currency/eur-suggestions', methods=['POST'])
def api_eur_suggestions():
    """Compute EUR rounding suggestions based on GBP total and store rate.
    Body: { gbp_total, store_rate }
    Response: { status, eur_exact, eur_round_up, eur_round_down, store_rate, gbp_total }
    """
    try:
        data = request.json or {}
        gbp_total = float(data.get('gbp_total') or 0)
        store_rate = float(data.get('store_rate') or 1.0)
        
        if gbp_total < 0:
            return jsonify({'status': 'error', 'message': 'GBP total must be non-negative'}), 400
        if store_rate <= 0:
            return jsonify({'status': 'error', 'message': 'Store rate must be positive'}), 400
        
        if not ps:
            return jsonify({'status': 'error', 'message': 'pos_service not available'}), 500
        
        suggestions = ps.compute_eur_suggestions(gbp_total, store_rate)
        
        return jsonify({
            'status': 'success',
            **suggestions
        })
    except ValueError as e:
        return jsonify({'status': 'error', 'message': f'Invalid input: {e}'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/currency/effective-rate', methods=['POST'])
def api_compute_effective_rate():
    """Compute the effective rate for a sale given a chosen EUR target.
    Body: { gbp_total, eur_target }
    Response: { status, gbp_total, eur_target, effective_rate }
    """
    try:
        data = request.json or {}
        gbp_total = float(data.get('gbp_total') or 0)
        eur_target = float(data.get('eur_target') or 0)
        
        if gbp_total <= 0:
            return jsonify({'status': 'error', 'message': 'GBP total must be positive'}), 400
        if eur_target < 0:
            return jsonify({'status': 'error', 'message': 'EUR target must be non-negative'}), 400
        
        if not ps:
            return jsonify({'status': 'error', 'message': 'pos_service not available'}), 500
        
        effective_rate = ps.compute_effective_rate(gbp_total, eur_target)
        
        return jsonify({
            'status': 'success',
            'gbp_total': float(gbp_total),
            'eur_target': float(eur_target),
            'effective_rate': float(effective_rate)
        })
    except ValueError as e:
        return jsonify({'status': 'error', 'message': f'Invalid input: {e}'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/currency/rates/update', methods=['POST'])
def api_update_currency_rates():
    """Admin endpoint to manually trigger a currency rate update.
    Body: { base, target, rate }
    rate is optional; if not provided, will be fetched from API.
    Response: { status, message }
    """
    if not os.getenv('POS_ADMIN_TOKEN'):
        # No admin protection configured; allow any local call
        pass
    else:
        # Check token if configured
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if token != os.getenv('POS_ADMIN_TOKEN'):
            return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    
    try:
        data = request.json or {}
        base = (data.get('base') or 'GBP').strip().upper()
        target = (data.get('target') or 'EUR').strip().upper()
        rate = data.get('rate')
        
        if rate is not None:
            rate = float(rate)
            if rate <= 0:
                return jsonify({'status': 'error', 'message': 'Rate must be positive'}), 400
        
        if not ps:
            return jsonify({'status': 'error', 'message': 'pos_service not available'}), 500
        
        conn = _db_connect()
        if not conn:
            return jsonify({'status': 'error', 'message': 'Database not available'}), 500
        
        success = ps.update_currency_rate(conn, base, target, rate)
        if success:
            new_rate = ps.get_currency_rate(conn, base, target)
            return jsonify({
                'status': 'success',
                'message': f'Updated {base}->{target} rate',
                'rate': float(new_rate) if new_rate else None
            })
        else:
            return jsonify({'status': 'error', 'message': 'Failed to update rate'}), 500
    except ValueError as e:
        return jsonify({'status': 'error', 'message': f'Invalid input: {e}'}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


_CURRENCY_BOOTSTRAP_DONE = False

def start_background_services():
    """Start background helper threads once per process."""
    global _BACKGROUND_SERVICES_STARTED
    if _BACKGROUND_SERVICES_STARTED:
        return
    try:
        _ensure_queue_dirs()
        conn = _queue_db_connect()
        if conn:
            conn.close()
    except Exception:
        app.logger.warning('POS queue storage initialization failed', exc_info=True)
    _ensure_currency_updater()
    _ensure_idle_worker()
    _BACKGROUND_SERVICES_STARTED = True


@app.before_request
def _bootstrap_background_services():
    """Start background helpers (currency updater + idle worker) on first inbound request."""
    start_background_services()
    global _CURRENCY_BOOTSTRAP_DONE
    _CURRENCY_BOOTSTRAP_DONE = True


if __name__ == '__main__':
    start_background_services()
    
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
                        'vat_rate': ln.get('vat_rate'),
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
                    'vat_rate': it.get('vat_rate'),
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




