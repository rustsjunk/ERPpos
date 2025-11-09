#!/usr/bin/env python3
"""
ERPpos Sync Worker

Modes:
  - push: post queued outbox sales to ERPNext using pos_service.push_outbox
  - pull-ack: do not post; only scan invoices/ for .json.ok sidecars and mark posted

Env vars:
  POS_DB_PATH      SQLite DB path (default: pos.db)
  SYNC_MODE        'push' | 'pull-ack' (default: 'pull-ack' when ERP is not configured)
  SYNC_INTERVAL    seconds between loops (default: 10)
  INVOICES_DIR     path to invoices directory (default: invoices)

Run:
  python sync_worker.py
"""
import os
import time
import sqlite3
from pathlib import Path

try:
    import pos_service as ps
except Exception:
    ps = None

POS_DB_PATH = os.environ.get('POS_DB_PATH', 'pos.db')
SYNC_MODE = os.environ.get('SYNC_MODE') or 'pull-ack'
SYNC_INTERVAL = float(os.environ.get('SYNC_INTERVAL', '10'))
INVOICES_DIR = os.environ.get('INVOICES_DIR', 'invoices')


def connect_db() -> sqlite3.Connection:
    if ps:
        return ps.connect(POS_DB_PATH)
    conn = sqlite3.connect(POS_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def scan_sidecar_acks(conn: sqlite3.Connection, inv_dir: str) -> int:
    updated = 0
    p = Path(inv_dir)
    if not p.exists() or not p.is_dir():
        return 0
    to_delete = []
    for ok in p.glob('*.json.ok'):
        base = ok.name[:-3]  # remove .ok
        sale_id = base[:-5] if base.endswith('.json') else base
        try:
            row = conn.execute('SELECT queue_status FROM sales WHERE sale_id=?', (sale_id,)).fetchone()
            if row and row['queue_status'] != 'posted':
                conn.execute("UPDATE sales SET queue_status='posted', erp_docname=COALESCE(erp_docname,'ACK') WHERE sale_id=?", (sale_id,))
                updated += 1
                to_delete.append(ok)
        except Exception:
            continue
    try:
        conn.commit()
    except Exception:
        pass
    # Delete sidecar .ok files only for acknowledged rows
    for ok in to_delete:
        try:
            ok.unlink(missing_ok=True) if hasattr(ok, 'unlink') else ok.unlink()
        except Exception:
            pass
    return updated


def loop_push(conn: sqlite3.Connection):
    if not ps:
        print('[sync] pos_service not available; cannot push outbox')
        return
    try:
        ps.push_outbox(conn)
    except Exception as e:
        print(f'[sync] push_outbox failed: {e}')


def loop_pull_ack(conn: sqlite3.Connection):
    n = scan_sidecar_acks(conn, INVOICES_DIR)
    if n:
        print(f'[sync] acknowledged {n} sales via sidecars')


def main():
    mode = (SYNC_MODE or '').strip().lower() or 'pull-ack'
    print(f'[sync] starting worker in mode={mode}, interval={SYNC_INTERVAL}s, db={POS_DB_PATH}')
    conn = connect_db()
    try:
        while True:
            if mode == 'push':
                loop_push(conn)
            else:
                loop_pull_ack(conn)
            time.sleep(SYNC_INTERVAL)
    except KeyboardInterrupt:
        print('[sync] exiting on Ctrl+C')


if __name__ == '__main__':
    main()
