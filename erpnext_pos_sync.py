"""
ERPNext-side POS ingestion helpers (drop into your custom ERPNext app).

Usage inside ERPNext:
- Place this file in your app, e.g., your_app/pos_sync.py (adjust module path).
- Expose API endpoint: /api/method/your_app.pos_sync.pos_ingest
- Optional: schedule pull_from_folder to ingest JSON receipts from a shared directory.

Notes:
- Create a custom unique field on Sales Invoice: pos_receipt_id (Data, Unique)
- The idempotency key is the receipt_id (invoice_name/sale_id)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import os
import json

import frappe
from frappe import _
from frappe.utils import nowdate


@frappe.whitelist()
def pos_ingest(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Idempotently create and submit Sales Invoice(s) from a POS payload.

    Handles three cases:
    - Pure sale: single Sales Invoice with all positive qty items.
    - Pure return: single Sales Invoice with is_return=1 and positive qty items
      (quantities are stored positive; ERPNext flips sign for returns).
    - Mixed exchange (some returned, some purchased): splits into two invoices —
      a return invoice (suffixed -RTN) and a sale invoice (suffixed -SALE).
      Payments go on the sale invoice; the return is a standalone credit note.
    """
    if payload is None:
        payload = frappe.request.get_json(silent=True) or {}

    norm = _normalize_payload(payload)
    receipt_id = norm["receipt_id"]
    customer = norm["customer"] or "Walk-in Customer"
    items = norm["items"]
    payments = norm["payments"]

    if not items:
        frappe.throw(_("No items to post"))

    sale_items = [i for i in items if i["qty"] > 0]
    return_items = [
        {"item_code": i["item_code"], "qty": abs(i["qty"]), "rate": i["rate"]}
        for i in items if i["qty"] < 0
    ]
    is_mixed = bool(sale_items and return_items)
    is_pure_return = bool(return_items and not sale_items)

    results = []

    # --- Sale invoice (or sole invoice for pure-sale transactions) ---
    if not is_pure_return:
        sale_rid = f"{receipt_id}-SALE" if is_mixed else receipt_id
        existing = frappe.db.get_value("Sales Invoice", {"pos_receipt_id": sale_rid}, "name")
        if existing:
            results.append({"type": "sale", "name": existing, "idempotent": True})
        else:
            si = _build_invoice(
                customer=customer,
                items=sale_items if is_mixed else items,
                payments=payments,
                receipt_id=sale_rid,
                payload=payload,
                is_return=False,
            )
            si.insert(ignore_permissions=True)
            si.submit()
            results.append({"type": "sale", "name": si.name})

    # --- Return invoice (pure return or exchange return leg) ---
    if return_items or is_pure_return:
        rtn_rid = f"{receipt_id}-RTN" if is_mixed else receipt_id
        existing = frappe.db.get_value("Sales Invoice", {"pos_receipt_id": rtn_rid}, "name")
        if existing:
            results.append({"type": "return", "name": existing, "idempotent": True})
        else:
            rtn_items = return_items if return_items else [
                {"item_code": i["item_code"], "qty": abs(i["qty"]), "rate": i["rate"]}
                for i in items
            ]
            # Payments on the return leg only for pure returns; exchange payments sit on sale
            rtn_payments = payments if is_pure_return else []
            si = _build_invoice(
                customer=customer,
                items=rtn_items,
                payments=rtn_payments,
                receipt_id=rtn_rid,
                payload=payload,
                is_return=True,
            )
            si.insert(ignore_permissions=True)
            si.submit()
            results.append({"type": "return", "name": si.name})

    # Backward-compatible response shape for pure-sale (single invoice)
    if len(results) == 1:
        r = results[0]
        return {"ok": True, "name": r["name"], "idempotent": r.get("idempotent", False)}
    return {"ok": True, "results": results}


def _build_invoice(
    customer: str,
    items: List[Dict],
    payments: List[Dict],
    receipt_id: str,
    payload: Dict[str, Any],
    is_return: bool,
) -> Any:
    """Construct (but do not insert/submit) a Sales Invoice frappe doc."""
    si = frappe.new_doc("Sales Invoice")
    si.update({
        "customer": customer,
        "is_pos": 1,
        "is_return": 1 if is_return else 0,
        "posting_date": nowdate(),
        "pos_receipt_id": receipt_id,
        "pos_voucher_code": (
            payload.get("pos_voucher_code")
            or _voucher_code_concat(payload.get("voucher_redeem"))
        ),
    })
    for it in items:
        si.append("items", {
            "item_code": it["item_code"],
            "qty": it["qty"],
            "rate": it["rate"],
        })
    for p in payments:
        si.append("payments", {
            "mode_of_payment": p["mode_of_payment"],
            "amount": p["amount"],
        })
    return si


@frappe.whitelist()
def pull_from_folder(base_path: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    """Ingest JSON receipts from a folder and write sidecar .json.ok acks.

    Args:
      base_path: absolute path to the shared invoices/ folder
      limit: max files to process in one call
    """
    base = base_path or frappe.db.get_single_value("System Settings", "pos_import_dir") or ""
    if not base:
        frappe.throw(_("Missing base_path and System Settings.pos_import_dir"))
    base = os.path.abspath(base)
    if not os.path.isdir(base):
        frappe.throw(_("Import directory does not exist: {0}").format(base))

    processed = 0
    errors: List[Dict[str, str]] = []
    for name in sorted(os.listdir(base)):
        if processed >= limit:
            break
        if not name.endswith(".json"):
            continue
        json_path = os.path.join(base, name)
        ok_path = json_path + ".ok"
        if os.path.exists(ok_path):
            continue
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            res = pos_ingest(payload)
            if not res or not res.get("ok"):
                raise Exception("ingest returned error")
            with open(ok_path, "w", encoding="utf-8") as f:
                f.write("OK")
            processed += 1
        except Exception as e:
            errors.append({"file": name, "error": str(e)})
    return {"ok": True, "processed": processed, "errors": errors}


def _normalize_payload(src: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize till payload shapes into a common structure.

    Accepts either file-based shape (invoice_name, items[], payments[])
    or outbox payload shape (sale_id, lines[]).
    """
    receipt_id = (src.get("invoice_name")
                  or src.get("sale_id")
                  or src.get("receipt_id"))
    if not receipt_id:
        frappe.throw(_("Missing idempotency key: invoice_name/sale_id"))

    items_raw = src.get("items") or src.get("lines") or []
    items = []
    for it in items_raw:
        item_code = (it.get("item_code")
                     or it.get("item_id")
                     or it.get("code")
                     or it.get("name"))
        if not item_code:
            continue
        qty = float(it.get("qty") or 0)
        rate = float(it.get("rate") or it.get("price") or 0)
        items.append({"item_code": item_code, "qty": qty, "rate": rate})

    pays_raw = src.get("payments") or []
    payments = []
    for p in pays_raw:
        mop = (p.get("mode_of_payment") or p.get("method") or "Cash")
        amt = float(p.get("amount") or 0)
        if amt != 0:
            payments.append({"mode_of_payment": mop, "amount": amt})

    return {
        "receipt_id": str(receipt_id),
        "customer": src.get("customer") or src.get("customer_id") or "Walk-in Customer",
        "items": items,
        "payments": payments,
    }


def _voucher_code_concat(rows: Optional[Any]) -> Optional[str]:
    codes: List[str] = []
    if isinstance(rows, dict):
        rows_iter = [rows]
    else:
        rows_iter = rows or []
    for entry in rows_iter:
        if not isinstance(entry, dict):
            continue
        code = entry.get("code") or entry.get("voucher_code")
        if not code:
            continue
        text = str(code).strip()
        if not text:
            continue
        if text not in codes:
            codes.append(text)
    if not codes:
        return None
    return ", ".join(codes)
