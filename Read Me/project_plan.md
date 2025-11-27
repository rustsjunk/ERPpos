## ERPpos — Point of Sale (POS) Project Plan

Last updated: 2025-11-09

### Overview

ERPpos is a lightweight, web-based Point of Sale system designed to integrate with ERPNext. The goal is to provide a fast, reliable, and offline-capable POS that synchronizes sales and inventory with ERPNext while continuing to operate during intermittent network outages.

### Goals

- Provide a stable in-store POS with offline-first behavior and a local backup database.
- Seamlessly synchronize sales, receipts, and inventory updates to ERPNext via a queue when connectivity is available.
- Offer cashier workflows (user codes, tills, Z-read/end-of-day), payment flexibility (partial & split payments), and promotional features (discounts, gift vouchers).
- Expose a JSON receipt format and API-friendly outputs for downstream consumption.

### Scope (what this project will include)

- Local (client) web UI for checkout, product search, and reporting.
- Local persistence (embedded DB or browser storage) for offline operation and recovery.
- Sync queue that reliably posts sales/stock changes to ERPNext when network is available.
- Core features: product templates with images and attribute matrices, search, cashier login via user codes, payment processing, gift vouchers, discounts, and daily reconciliation (Z-read).
- Administrative pages for configuring tills, setting opening float, and managing exchange rates.

### Out of scope (for the initial MVP)

- Direct payment gateway integrations (beyond simulated/placeholder split payments) — can be added later as connectors.
- Multi-store complex transfer workflows (unless required later).

### Features (detailed)

- Authentication & roles
  - Cashier sign-in using short user codes (fast login at the till).
  - Admin role for settings, exchange rates, voucher management, and reconciliation.

- Product catalog & search
  - Products displayed using configurable templates (image, name, attributes matrix, price, available stock).
  - Attributes matrix support (size, color, style) with per-attribute stock quantities.
  - Search by brand, style, code, name, or attribute value.

- Cart & checkout
  - Add/remove items, apply discounts (item-level and cart-level).
  - Split and partial payments (e.g., cash + card), with clear payment records.
  - Gift voucher creation and redemption workflows.

- Receipts & API
  - Generate JSON receipts formatted for ERPNext consumption (configurable mapping).
  - Store local copies of receipts for audit and offline recovery.

- Sync & resilience
  - Local backup DB or robust queue to hold sales until ERPNext sync succeeds.
  - Automatic retry and exponential backoff for sync failures.
  - Durable local index + receipts folder that supports either ERP pull (sidecar acknowledgements) or API push.
  - Lightweight worker (`sync_worker.py`) to reconcile state and update statuses.

- Till management & reporting
  - Opening float setup on shift start.
  - Z-read (end-of-day) with till reconciliation, cash counted, expected vs actual.
  - Notification bell/alerts for e-commerce/website sales or critical sync errors.

- Currency & pricing
  - Support multi-currency display (EUR/GBP) with regularly updated conversion rates from trusted sources.

### Non-functional requirements

- Reliability: no data loss on connectivity loss. Local storage must persist until successful sync.
- Performance: checkout flow must complete in <2s for standard operations on local network/hardware.
- Security: local data must be protected (reasonable access control); API secrets never committed to repo.
- Observability: logging for sync attempts, errors, and reconciliation events.

### Data contracts

- JSON Sales Receipt (example shape)
  - sale_id, timestamp, cashier_code, items[{sku, qty, price, attributes}], payments[{method, amount}], totals{subtotal, tax, total}, till_id
  - Keep the mapping documented and versioned so ERPNext consumers can adapt.

### Implementation notes (current status)

- Frontend
  - Global “scan-like” keyburst catcher implemented in `static/js/script.js`, routing scans to cart/return/voucher contexts while keeping the on-screen search field for manual input.
  - Product search overlay, checkout overlay, voucher and return overlays wired.
- Backend
  - Flask app in `pos_server.py`; lightweight entry in `main.py` for certain hosts.
  - SQLite schema (`schema.sql`) with basic outbox and voucher helpers in `pos_service.py`.
  - Return lookup endpoints and `/api/sales/status` for UI indicators.
- Sync
  - `sync_worker.py` present with `pull-ack` and `push` modes.
  - ERP-side helper `erpnext_pos_sync.py` provided for ingestion and folder pulls.
- Repo hygiene
  - Removed temporary files (`tmp_*.txt`, `tmp_app_final_copy.py`) and runtime logs from the repo.

### Milestones & rough timeline

- Week 1 — Foundations (2 days)
  - Project scaffolding, local DB choice (IndexedDB / SQLite), basic front-end layout.
- Week 2 — Catalog & search (3 days)
  - Product templates, attribute matrix, search UI.
- Week 3 — Checkout & payments (4 days)
  - Cart flows, discounts, partial/split payments, gift vouchers basic flows.
- Week 4 — Sync & receipts (3 days)
  - JSON receipt format, sync queue, retry logic, and mock ERPNext endpoint for testing.
- Week 5 — Till management & reporting (3 days)
  - Opening float, Z-read, reconciliation UI, notifications.
- Week 6 — Testing & polish (4 days)
  - Unit tests for core logic, end-to-end sanity checks, documentation.

### Risks & mitigations

- Risk: Data loss during sync failures.
  - Mitigation: durable local queue, acknowledgements from server, and manual re-try interface.
- Risk: Complexity in attribute matrix stock tracking.
  - Mitigation: start with clear product model and small test dataset; add migration scripts to normalize product variants.
- Risk: Currency rate inaccuracies.
  - Mitigation: fetch from reliable providers and cache last-known rate with admin override.

### Testing strategy

- Unit tests for: receipt generation, sync queue behavior, payment splitting logic.
- Integration tests using a mock ERPNext endpoint to validate the sync flow.
- Manual QA for offline-to-online transition and Z-read reconciliation.

### Developer notes / next steps

- Decide on local storage technology (IndexedDB for browser-based POS, or SQLite for packaged desktop use).
- Draft the JSON receipt contract and add a sample in `invoices/` for reference (existing `MOCK-*.json` files can be used as templates).
- Add a `docs/` folder with the API mapping and runbook for recovery in case of sync issues.
- Implement and run the sync worker:
  - See `sync.md` for pull-ack vs push modes, env vars, and ops guidance.
  - Expose `/api/sales/status` for UI indicators of queued/failed receipts.

### New: Local + ERP Pull Sync Design

- Idempotent sales: POS assigns a stable `sale_id` (also used as the `invoice_name` for files in `invoices/`).
- Local index in SQLite: table `sales` tracks `queue_status` in `queued|posting|posted|failed`.
- ERP pull acknowledgement: ERPNext writes `invoices/<sale_id>.json.ok` after ingesting; the worker marks the sale `posted`.
- Optional push mode: switch `SYNC_MODE=push` to post via REST using the existing `outbox` table.
- UI: the bell icon shows pending/failed counts based on `/api/sales/status`.

---

If you'd like, I can:
- implement a polished README and developer runbook next,
- wire up a mock ERPNext endpoint for local testing,
- or open a branch and implement the first milestone (local DB + basic checkout UI).

Please tell me which of those you'd prefer next.

