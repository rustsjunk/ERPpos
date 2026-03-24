# ERPpos Data Flow & Storage Guide

This document explains every queue, database, and file store involved in getting a sale or layaway
from the till into ERPNext/ERPDash, and whether each one is active in your current setup.

---

## Your Current Environment

| Env var | Value | Effect |
|---|---|---|
| `USE_MOCK` | `0` | Live ERP connections enabled |
| `POS_QUEUE_ONLY` | `1` | SQLite sales outbox suppressed (see below) |
| `ERPDASH_URL` | `http://frontend:5000` | ERPDash server for sales and layaways |
| `ERPNEXT_URL` | `http://frontend:8080` | Frappe/ERPNext API server |

---

## 1. JSON Files — `invoices/`

**What:** When the POS completes a sale it writes a JSON receipt file to the `invoices/` folder.

**Who reads it:** The `till_agent` process watches this folder and POSTs each file to ERPDash at
`TILL_POST_URL` (`http://frontend:5000/api/pos/sales`). It also POSTs to the local POS server
(`http://127.0.0.1:1010/api/pos/sales`) for local recording.

**Necessary?** Yes — this is the primary path for sales reaching ERPDash.

---

## 2. JSON Status Files — `invoices/queue/`

**What:** Mirror copies of each sale JSON, organised into subfolders by status:

```
invoices/queue/
  pending/       ← received but not yet recorded in the local DB
  queued/        ← recorded in erp.db, waiting for ERP confirmation
  confirmed/     ← ERP confirmed receipt
  erp_failed/    ← ERP rejected the sale
  record_error/  ← failed to record locally
```

**Who reads it:** No code reads these for processing. They exist purely for human inspection and
debugging — you can open the folder and immediately see which sales are stuck and why.

**Necessary?** No, but very useful for debugging. Controlled by `POS_QUEUE_DIR` env var.

---

## 3. `pos_sales_queue.sqlite3`

**What:** A dedicated SQLite database (separate from `erp.db`) that tracks every sale the local
POS server receives at `/api/pos/sales`.

**Columns:** `invoice_name`, `sale_id`, `payload_json`, `status`, `error`, `erp_docname`, `attempts`

**Status flow:**
```
received → queued → erp_posting → confirmed
                              ↘ erp_failed
         ↘ record_error
```

**Who writes it:** `_enqueue_pos_sale()` on every POST to `/api/pos/sales`.

**Who processes it:** The idle maintenance loop calls `_process_pos_sales_queue()` every
`POS_IDLE_TASK_INTERVAL` seconds (60s in your setup). This records the sale into `erp.db`
and syncs the ERP confirmation status back.

**Necessary?** Yes — this is what makes `/api/sales/status` work and ensures duplicate
receipts are handled correctly (UPSERT on `invoice_name`).

---

## 4. `erp.db` — Main Local Database

**Path:** Set by `POS_DB_PATH` env var (your value: `erp.db`)

This is the central store for everything the POS knows about locally. The relevant tables:

### `sales`
Every completed sale, with `queue_status` tracking ERP sync state.

### `outbox` (kind = `sale` or `voucher_event`)
A queue of sales and voucher events to be forwarded to ERPNext via the **Frappe REST API**
(using `ERPNEXT_API_KEY` + `ERPNEXT_API_SECRET`). Processed by `push_outbox()` in
`pos_service.py`.

**In your setup this is INACTIVE.** `POS_QUEUE_ONLY=1` suppresses `push_outbox()`.
Your 18 queued sale entries and 2 voucher entries have `attempts=0` and will never be sent.
This is intentional — your sales reach ERPDash via the till_agent directly (path 1 above),
not via this Frappe API path.

**Can you clean these up?** Yes. If you never intend to use the Frappe API sync path,
these rows can be deleted:
```sql
DELETE FROM outbox WHERE kind IN ('sale', 'voucher_event');
```

### `outbox` (kind = `layaway_*`)
Same table, different rows. Used exclusively for layaway sync to ERPDash via `X-POS-KEY`.
Processed by `push_layaway_outbox()` which is **NOT** gated by `POS_QUEUE_ONLY`.

**This IS active in your setup** and is what sends layaways to ERPDash.

Layaway outbox kinds:
| kind | triggers |
|---|---|
| `layaway_create` | New layaway created → creates Sales Order in ERPNext |
| `layaway_payment` | Deposit recorded → creates Payment Entry in ERPNext |
| `layaway_complete` | Layaway collected → creates Sales Invoice in ERPNext |
| `layaway_cancel` | Layaway cancelled → cancels SO in ERPNext |
| `layaway_amend` | Items removed → amends SO in ERPNext |

### `layaways`
The layaway records themselves (ref, customer, items, total, paid, status, expiry).

### `layaway_payments`
Individual payment/deposit history for each layaway.

### `layaway_audit`
Audit trail of every action taken on a layaway (created, payment, extended, cancelled etc.).

---

## Summary: What Is Actually Used In Your Setup

| Storage | Used? | Purpose |
|---|---|---|
| `invoices/` JSON files | **Yes** | Till agent reads and posts to ERPDash |
| `invoices/queue/` status files | Optional | Human debugging only |
| `pos_sales_queue.sqlite3` | **Yes** | Local sale recording and status tracking |
| `erp.db` → `sales` | **Yes** | Local sale history, browse cache, returns |
| `erp.db` → `outbox` (sale/voucher) | **No** | Dead — suppressed by `POS_QUEUE_ONLY=1` |
| `erp.db` → `outbox` (layaway_*) | **Yes** | Syncs layaways to ERPDash |
| `erp.db` → `layaways` | **Yes** | Layaway records |
| `erp.db` → `layaway_payments` | **Yes** | Layaway payment history |
| `erp.db` → `layaway_audit` | **Yes** | Layaway audit trail |

---

## Why `POS_QUEUE_ONLY=1` Exists

Setting `POS_QUEUE_ONLY=1` tells the POS: "store everything locally but do not attempt to push
to ERPNext via the Frappe API." This is useful when:

- ERPDash handles the ERP posting itself (your case — till_agent posts directly to ERPDash)
- You want the POS to work offline without needing ERP credentials on the till machine
- You're running in a setup where the Frappe API is not directly accessible from the till

The layaway sync bypasses this flag because it uses a different auth mechanism (X-POS-KEY to
ERPDash) and was designed to work alongside your existing setup.

---

## Diagnostic Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/layaways/debug` | GET | Shows ERPDASH_URL, key status, all pending outbox entries |
| `/api/layaways/sync` | POST | Manually flushes the layaway outbox immediately |
| `/api/sales/status` | GET | Shows sales queue state |
