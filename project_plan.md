## ERPpos — Point of Sale (POS) Project Plan

Last updated: 2025-11-04

### Overview

ERPpos is a lightweight, web-based Point of Sale system designed to integrate with ERPNEXT. The goal is to provide a fast, reliable, and offline-capable POS that synchronizes sales and inventory with ERPNEXT while continuing to operate during intermittent network outages.

### Goals

- Provide a stable in-store POS with offline-first behavior and a local backup database.
- Seamlessly synchronize sales, receipts, and inventory updates to ERPNEXT via a queue when connectivity is available.
- Offer cashier workflows (user codes, tills, Z-read/end-of-day), payment flexibility (partial & split payments), and promotional features (discounts, gift vouchers).
- Expose a JSON receipt format and API-friendly outputs for downstream consumption.

### Scope (what this project will include)

- Local (client) web UI for checkout, product search, and reporting.
- Local persistence (embedded DB or browser storage) for offline operation and recovery.
- Sync queue that reliably posts sales/stock changes to ERPNEXT when network is available.
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
	- Generate JSON receipts formatted for ERPNEXT consumption (configurable mapping).
	- Store local copies of receipts for audit and offline recovery.

- Sync & resilience
	- Local backup DB or robust queue to hold sales until ERPNEXT sync succeeds.
	- Automatic retry and exponential backoff for sync failures.

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
	- Keep the mapping documented and versioned so ERPNEXT consumers can adapt.

### Acceptance criteria (MVP)

1. A cashier can log in with a user code and complete a sale with at least one payment method.
2. A sale saved locally creates a JSON receipt and is persisted in the local queue.
3. When the network is available, queued receipts are successfully posted to ERPNEXT (or a mock endpoint) and marked synced.
4. The Z-read report shows the day's transactions and calculates expected till totals (opening float + sales - payouts).
5. Partial and split payments are recorded correctly on the receipt.

### Milestones & rough timeline

Note: estimates assume a single developer working part-time. Adjust as needed.

- Week 1 — Foundations (2 days)
	- Project scaffolding, local DB choice (IndexedDB / SQLite), basic front-end layout.
- Week 2 — Catalog & search (3 days)
	- Product templates, attribute matrix, search UI.
- Week 3 — Checkout & payments (4 days)
	- Cart flows, discounts, partial/split payments, gift vouchers basic flows.
- Week 4 — Sync & receipts (3 days)
	- JSON receipt format, sync queue, retry logic, and mock ERPNEXT endpoint for testing.
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
- Integration tests using a mock ERPNEXT endpoint to validate the sync flow.
- Manual QA for offline-to-online transition and Z-read reconciliation.

### Developer notes / next steps

- Decide on local storage technology (IndexedDB for browser-based POS, or SQLite for packaged desktop use).
- Draft the JSON receipt contract and add a sample in `invoices/` for reference (existing `MOCK-*.json` files can be used as templates).
- Add a `docs/` folder with the API mapping and runbook for recovery in case of sync issues.

---

If you'd like, I can:
- implement a polished README and developer runbook next,
- wire up a mock ERPNEXT endpoint for local testing,
- or open a branch and implement the first milestone (local DB + basic checkout UI).

Please tell me which of those you'd prefer next.
