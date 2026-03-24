# Layaway Feature — Planning Document

---

## Confirmed decisions

### Customer handling
- Normal sales: customer stays as default walk-in — no change to current flow
- Layaway sales: cashier is **prompted for a customer name** when they choose to put on layaway
- A real ERPNext customer is **always created or matched** by name — used for back-office reconciliation only
- The customer name/ID is **never shown on the till UI, to the cashier, or on the customer-facing receipt**
- No personal data (address, phone, email) required or stored — name only

### Payments
- A layaway can be created **with zero payment** (pure reservation) — expiry window: **1 week**
- A layaway with any payment taken — expiry window: **3 months** (default, configurable)
- Each installment is recorded locally immediately and synced to ERPNext when online
- **Two receipts printed** at every transaction point (creation and each payment):
  - **Customer copy** — items, agreed total, amount paid today, total paid, remaining balance, expiry date. Has `LAY-XXXXXX` barcode for scanning
  - **Store tally copy** — same info plus customer name tag (for the physical layaway shelf label)
- A layaway can be **re-opened by scanning the `LAY-XXXXXX` barcode** on the customer receipt

### Stock
- Stock is **reserved at the point of layaway creation** (Sales Order in ERPNext)
- Stock is not decremented from the system until the layaway is fully paid and completed (Sales Invoice)
- If offline at creation, SO creation is queued — acceptable given ERPNext access is rarely unavailable

### Expiry
- **Notify only** — when threshold is passed, cashier receives a notification
- Notification shows as a **badge/count on the Layaway button** on the till — visible to all logged-in cashiers
- The detailed alert ("this is your layaway") is directed to the creating cashier and admin users
- Cashier decides: extend the layaway (pick new date / snooze) or cancel
- If any monetary value has been paid, the system **requires a refund to be processed** before cancellation can complete

### Cancellation / refund
- All refunds go through the till system — never manual
- Cashier chooses the refund method: cash, card, or store credit/voucher
- Cancellation generates a cancellation receipt and reverses the ERPNext Payment Entries / SO

### Access and audit
- Any cashier can view the layaway store and accept a payment
- Any change (payment, item removal, extension, cancellation) is **logged with cashier name and timestamp**
- Expiry notifications directed to: the cashier who created the layaway + any admin users
- Badge count on layaway button is visible to everyone regardless of who is logged in
- Final sale completion is attributed to the cashier who processes it

### Price locking
- All prices are **locked at the moment the layaway is created** — the agreed price on the receipt is what the customer pays regardless of any price changes in the shop afterwards
- The SQLite record stores `rate` (agreed price) and `original_rate` per item — these never change after creation
- When an item is **removed** from a layaway the total drops by its **original agreed price**, not the current shop price
  - Example: Item A agreed at £29, Item B agreed at £19, total £48. Customer drops Item A → new total is £19

### Items — multiple and partial
- A single layaway holds a **full cart** (multiple items)
- Items can be **dropped from a layaway** after creation — the total is reduced and balance recalculated
- **Partial collection supported** — a customer can collect an individual item once their cumulative payments reach or exceed that item's price. The item is released, its price deducted from total paid, and the remainder of payments stay on the layaway toward the remaining items
- Items cannot be moved between two separate layaway entries — only cancel/refund to restructure

### Receipt barcode
- Layaway receipts use a distinct `LAY-XXXXXX` format (separate from normal invoice barcodes)
- When the till scans a `LAY-` barcode it immediately routes to the layaway view rather than the return flow

### Offline / sync
- Everything works offline — local SQLite is the source of truth
- On reconnect the till agent queue handles: SO creation, Payment Entry posting, SO amendment (items removed), SO cancellation
- Sequence matters: SO must exist before Payment Entries can be posted; queue processor must respect order

---

## Workflow

```
1. Sale built as normal on the till
2. Cashier reaches checkout screen
3. Cashier taps "Put on Layaway" (alongside Discount, Return, etc.)
4. Prompted for customer name → matched or created in ERPNext (back-office only, not shown anywhere on till)
5. Optional: take a payment now (cash/card/voucher) or proceed with zero payment
6. Two receipts print:
     - Customer copy  (no customer name, has LAY-XXXXXX barcode, items, total, paid, balance, expiry)
     - Store tally    (has customer name, same financial info, for the shelf label)
7. Items go onto the physical layaway shelf
── Later visits ──
8. Customer returns — cashier opens Layaway Store view OR scans LAY-XXXXXX barcode from customer receipt
9. Layaway loads showing items, total, paid so far, remaining balance
10. Cashier takes payment → receipts reprint with updated totals
11. If customer wants one item only: cashier checks if payments >= that item's price
      → yes: item is released, price deducted, balance recalculates, receipts reprint
      → no: cashier informs customer how much more is needed for that item
12. If customer wants to remove an item entirely (no longer wants it): item is dropped, total recalculates
13. When remaining balance = £0.00: layaway completes → Sales Invoice raised → normal completion flow
── Expiry ──
14. When expiry date passes: badge count appears on Layaway button for all cashiers
15. Creating cashier / admin sees directed notification when they log in
16. Cashier opens layaway from layaway store, decides to extend (new date) or cancel
17. Cancel with payments taken: refund flow opens (choose method) → cancellation receipt → ERPNext reversed
18. Cancel with zero paid: cancel immediately, SO cancelled in ERPNext, stock released
```

---

## ERPNext data model

| Stage | ERPNext document | Notes |
|---|---|---|
| Layaway created | `Sales Order` submitted | Reserves stock |
| Each payment | `Payment Entry` linked to SO | Posted via till agent queue |
| Item removed from layaway | SO amended (item removed / qty reduced) | Requires cancel+amend in ERPNext |
| Layaway completed | `Sales Invoice` from SO + payments reconciled | Normal POS sale completion |
| Layaway cancelled | SO cancelled, Payment Entries reversed | Triggers refund flow if paid > 0 |

---

## Local SQLite schema

```sql
CREATE TABLE layaways (
    layaway_id       TEXT PRIMARY KEY,   -- LAY-XXXXXX
    customer_tag     TEXT NOT NULL,      -- display name (back-office only, not on customer receipt)
    erp_customer     TEXT,               -- ERPNext customer name
    erp_so_name      TEXT,               -- ERPNext SO name once synced
    items            TEXT NOT NULL,      -- JSON: [{item_code, name, qty, rate, original_rate}]
    total            REAL NOT NULL,      -- agreed total (recalculates when items removed)
    paid             REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',  -- active|completed|cancelled|expired
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    created_by       TEXT,               -- cashier code
    notes            TEXT,
    sync_status      TEXT DEFAULT 'pending'  -- pending|synced|failed
);

CREATE TABLE layaway_payments (
    payment_id       TEXT PRIMARY KEY,
    layaway_id       TEXT NOT NULL REFERENCES layaways(layaway_id),
    paid_at          TEXT NOT NULL,
    amount           REAL NOT NULL,
    method           TEXT NOT NULL,      -- Cash|Card|Voucher
    cashier_code     TEXT NOT NULL,
    erp_pe_name      TEXT,               -- ERPNext Payment Entry name once synced
    sync_status      TEXT DEFAULT 'pending'
);

CREATE TABLE layaway_audit (
    audit_id         TEXT PRIMARY KEY,
    layaway_id       TEXT NOT NULL,
    action           TEXT NOT NULL,      -- created|payment|item_removed|item_collected|extended|cancelled|completed
    detail           TEXT,               -- JSON snapshot of what changed
    cashier_code     TEXT,
    actioned_at      TEXT NOT NULL
);
```

---

## Partial collection logic

When a customer wants to collect one item from a multi-item layaway:

```
Item A price = £50
Item B price = £80
Total paid so far = £60

Customer wants to take Item A (£50):
  £60 >= £50 → yes, they can take it
  New layaway total = £80   (Item A removed)
  Credit carried forward = £60 - £50 = £10
  Remaining balance = £80 - £10 = £70

Customer wants to take Item B (£80) instead:
  £60 < £80 → not enough yet
  Still needs £20 more before Item B can be released
```

Payments are **not pre-allocated to items** — the customer can collect whichever item(s) their cumulative payments cover first. Cashier sees a per-item "can collect?" indicator in the layaway view.

---

## Expiry rules

| Condition | Default expiry | Configurable? |
|---|---|---|
| Zero payment (pure reservation) | 1 week | Per layaway (extend/snooze) |
| Any payment taken | 3 months | Per layaway (extend/snooze) |

Config: default windows set via env vars or settings panel (`LAYAWAY_ZERO_PAYMENT_DAYS`, `LAYAWAY_PAID_DAYS`).

---

## ✅ All questions resolved — spec ready for Phase 1 build

---

## ERPNext server — ✅ IMPLEMENTED (2026-03-16)

The ERPNext/ERPDash side is complete. Two files were added:

### `structure_creation.py`
Run bootstrap to apply two custom fields on `Sales Order`:
- `custom_layaway_ref` — the POS's `LAY-XXXXXX` handle, unique and indexed for lookups
- `custom_layaway_deposit_pct` — records the agreed deposit percentage

### `server.py` — 7 endpoints (all authenticated with `X-POS-KEY`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/layaway` | List all open layaways |
| `GET` | `/api/layaway/<ref>` | Get one layaway by POS ref |
| `POST` | `/api/layaway/create` | Create layaway (creates customer if new) |
| `POST` | `/api/layaway/<ref>/deposit` | Record a deposit/installment payment |
| `POST` | `/api/layaway/<ref>/complete` | Convert SO → Invoice + auto-reconcile advances |
| `POST` | `/api/layaway/<ref>/cancel` | Cancel payments then cancel SO |
| `POST` | `/api/layaway/<ref>/amend` | Replace item list (cancel → amend → resubmit SO) |

### Response contracts (what `pos_server.py` will receive)

```
POST /create      → { so_name, layaway_ref, customer, status, grand_total }
POST /deposit     → { payment_entry, so_name, layaway_ref, paid_amount, outstanding_amount }
GET  /<ref>       → { so_name, layaway_ref, customer, grand_total, paid_amount,
                      outstanding_amount, deposit_pct, items[], payments[] }
POST /complete    → { so_name, si_name, layaway_ref, grand_total, outstanding_amount, status }
POST /cancel      → { so_name, layaway_ref, cancelled_payments[], status: "cancelled" }
POST /amend       → { original_so, new_so_name, layaway_ref, grand_total }
```

### Required env vars on the ERPDash server

```
LAYAWAY_ADVANCE_ACCOUNT=Advance from Customers - <CompanySuffix>
LAYAWAY_PAYMENT_ACCOUNT=Cash - <CompanySuffix>   # or bank account name
```

If `LAYAWAY_ADVANCE_ACCOUNT` is blank, ERPNext will attempt to auto-resolve from the company's default chart of accounts — verify this works in your instance before relying on it.

---

## Implementation phases

### ✅ Phase 0 — ERPNext server (COMPLETE)
All ERPNext-side endpoints live and ready.

### Phase 1 — POS local layer + UI  ← NEXT
- SQLite tables: `layaways`, `layaway_payments`, `layaway_audit`
- `pos_server.py` routes that sit between the till and ERPNext:
  - Proxy/orchestrate the 7 ERPNext endpoints
  - Handle offline: queue calls when ERPNext unreachable, replay when back
  - Enforce sequencing (SO before Payment Entry, etc.)
- "Put on Layaway" button in checkout overlay
- Customer name prompt
- Two-receipt printing: customer copy (LAY barcode, no name) + store tally (with name)
- `LAY-XXXXXX` barcode ID generation
- Scan `LAY-XXXXXX` barcode → opens layaway directly (not return flow)

### Phase 2 — Layaway store view + payment flow
- Layaway store view: list all active, per-item status, balances, expiry dates
- Badge count on layaway button visible to all cashiers
- Take installment payment from layaway store view (any method)
- Directed expiry notification on cashier login (creating cashier + admins)
- Extend / snooze expiry date

### Phase 3 — Item management + completion
- Item removal from active layaway (balance recalculates, receipts reprint)
- Partial collection: per-item "can collect?" indicator, release on payment threshold
- Layaway completion flow (balance = £0 → invoice → normal receipt)
- Cancellation with mandatory refund flow if paid > 0
- Full audit log visible in layaway store view

### Phase 4 — Reconciliation
- Reconciliation report: layaways created / completed / cancelled / outstanding value
- Sync status indicators (pending / synced / failed) per layaway in store view

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-03-16 | Customer always creates ERPNext record but is back-office only — not shown on till or receipts |
| 2026-03-16 | Zero-payment layaway allowed, 1-week window; paid layaway 3-month window, both configurable per layaway |
| 2026-03-16 | Expiry = notify only; badge count visible to all; directed alert to creating cashier + admins |
| 2026-03-16 | Refunds always through the system (cash/card/voucher), cashier chooses method |
| 2026-03-16 | Any cashier can view/pay; all changes audit-logged |
| 2026-03-16 | Multiple items per layaway; items can be removed; partial collection supported |
| 2026-03-16 | Partial collection rule: payments not pre-allocated — customer can collect any item once cumulative payments cover its price |
| 2026-03-16 | Two receipts per transaction: customer copy (no name, LAY barcode) + store tally (with name) |
| 2026-03-16 | LAY-XXXXXX barcode format; scan routes directly to layaway view, not return flow |
| 2026-03-16 | Offline SO creation is acceptable — queue it, ERPNext access is rarely unavailable |
| 2026-03-16 | Prices locked at layaway creation — customer always pays the agreed price regardless of subsequent shop price changes |
| 2026-03-16 | Item removal reduces total by original agreed price, not current price |
| 2026-03-16 | ERPNext server-side complete — 7 endpoints live, custom fields bootstrapped, response contracts defined |
