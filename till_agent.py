#!/usr/bin/env python3
"""
Till posting agent: pushes invoice JSON files to the central POS queue.

Environment:
  INVOICES_DIR          Base folder containing *.json sale files (default: invoices)
  TILL_POST_URL         Endpoint to receive receipts (default: http://frontend:5000/api/pos/sales)
  POS_RECEIPT_KEY       Shared secret for X-POS-KEY header (default: SUPERSECRET123)
  TILL_AGENT_INTERVAL   Seconds to sleep between scans (default: 5)
"""
import json
import logging
import os
import time
from pathlib import Path
from typing import Iterable, Tuple

import requests

logging.basicConfig(level=logging.INFO, format='[till-agent] %(asctime)s %(levelname)s %(message)s')

INVOICES_DIR = Path(os.environ.get('INVOICES_DIR', 'invoices'))
FAILED_DIR = INVOICES_DIR / 'post_failed'
SENT_DIR = INVOICES_DIR / 'posted_remote'
POST_URL = os.environ.get('TILL_POST_URL', 'http://frontend:5000/api/pos/sales')
POS_KEY = os.environ.get('POS_RECEIPT_KEY', 'SUPERSECRET123')
TRY_INTERVAL = float(os.environ.get('TILL_AGENT_INTERVAL', '5'))
REQUEST_TIMEOUT = float(os.environ.get('TILL_AGENT_TIMEOUT', '15'))


def ensure_dirs() -> None:
    for path in (INVOICES_DIR, FAILED_DIR, SENT_DIR):
        path.mkdir(parents=True, exist_ok=True)


def iter_invoice_files() -> Iterable[Tuple[Path, str]]:
    """Yield pending invoice files from base directory and failed queue."""
    sources = (
        (INVOICES_DIR, 'pending'),
        (FAILED_DIR, 'retry'),
    )
    for base, label in sources:
        if not base.exists():
            continue
        files = sorted(base.glob('*.json'))
        for path in files:
            if path.parent == SENT_DIR:
                continue
            yield path, label


def move_file(path: Path, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    dest = target_dir / path.name
    if dest.exists():
        dest = target_dir / f"{path.stem}_{int(time.time())}.json"
    try:
        path.replace(dest)
    except Exception as exc:
        logging.warning("Failed to move %s to %s: %s", path, target_dir, exc)


def post_invoice(path: Path) -> bool:
    try:
        raw = path.read_text(encoding='utf-8')
    except Exception as exc:
        logging.error("Failed to read %s: %s", path, exc)
        return False
    headers = {
        'Content-Type': 'application/json',
        'X-POS-KEY': POS_KEY or '',
    }
    try:
        resp = requests.post(POST_URL, data=raw.encode('utf-8'), headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        logging.warning("HTTP error posting %s: %s", path.name, exc)
        return False
    if resp.status_code != 200:
        logging.warning("Server rejected %s: status=%s body=%s", path.name, resp.status_code, resp.text[:200])
        return False
    try:
        body = resp.json()
    except json.JSONDecodeError:
        logging.warning("Bad JSON response for %s: %s", path.name, resp.text[:200])
        return False
    if body.get('status') != 'received':
        logging.warning("Unexpected response for %s: %s", path.name, body)
        return False
    logging.info("Posted %s (queue_id=%s)", path.name, body.get('queue_id'))
    return True


def main() -> None:
    ensure_dirs()
    logging.info("Posting agent watching %s -> %s", INVOICES_DIR, POST_URL)
    if not POS_KEY:
        logging.warning("POS_RECEIPT_KEY is empty; server will reject requests.")
    while True:
        processed_any = False
        for path, label in iter_invoice_files():
            processed_any = True
            success = post_invoice(path)
            if success:
                move_file(path, SENT_DIR)
            else:
                move_file(path, FAILED_DIR)
        if not processed_any:
            time.sleep(TRY_INTERVAL)


if __name__ == '__main__':
    main()
