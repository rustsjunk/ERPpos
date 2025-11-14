# ERPpos

ERPpos is a lightweight Flask-based Point-of-Sale (POS) web UI that can operate in a mock/offline mode or integrate with an ERPNEXT instance via REST API. It prioritizes simple, resilient in-store workflows (fast cashier login, variant matrix, barcode scanning, split payments, receipts) and reliable sync to ERPNEXT.

## Quickstart (PowerShell)

1. Create and activate a virtual environment (recommended):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Run the app in mock mode (no ERPNEXT required):

```powershell
# optional: enable Flask debug
$env:FLASK_DEBUG = "1"; $env:USE_MOCK = "1"; python main.py
```

4. To connect to ERPNEXT, create a `.env` file in the project root with these keys (replace values):

```
ERPNEXT_URL=https://your-erpnext-instance.com
ERPNEXT_API_KEY=your-api-key
ERPNEXT_API_SECRET=your-api-secret
USE_MOCK=0
```

Then run:

```powershell
python main.py
```

With `USE_MOCK=0`, ERPpos now auto-initializes `POS_DB_PATH` using `schema.sql` the first time it runs and immediately pulls the ERPNext catalog plus active cashiers. Optional environment knobs:

- `POS_WAREHOUSE` (default `Shop`) — warehouse to probe when seeding stock snapshots during the first sync.
- `POS_BOOTSTRAP_ITEM_BATCHES` — number of 500-row item batches to pull on bootstrap (default `6`).
- `POS_CASHIER_DOCTYPE`, `POS_CASHIER_CODE_FIELD`, `POS_CASHIER_NAME_FIELD`, `POS_CASHIER_ACTIVE_FIELD`, `POS_CASHIER_EXTRA_FIELDS`, `POS_CASHIER_FILTERS` — map your ERPNext cashier source (defaults assume a `Cashier` doctype with `code`, `cashier_name`, `enabled` fields). Extra fields land in the local `cashiers.meta` JSON blob.
- `POS_SKIP_BARCODE_SYNC` — set to `1` if the ERP API user does not have permission to read the `Item Barcode` doctype; items will still load but barcode lookups rely on ERPNext.
- `POS_PRICE_LIST` — optional price list name to pull into the POS catalog. When supplied (and `/api/db/` syncs are run via `python pos_service.py --sync --price-list "$POS_PRICE_LIST"`), the local `items.price` values override the standard rate and the configured warehouse stock is updated too.

## Project layout (important files)

- `main.py` — launcher that starts the Flask app.
- `pos_server.py` — the Flask application and API endpoints (items, customers, create-sale, item_matrix).
- `templates/pos.html` — client UI markup.
- `static/js/script.js` — client-side application logic (cart, checkout, barcode, UI flows).
- `static/css/style.css` — styles.
- `invoices/` — saved invoice JSON files (mock and persisted receipts).
- `project_plan.md` — high-level product plan and milestones.
- `agents.md` — (new) documentation of server-side agents and runbook.

## Modes & behavior

- Mock mode (default) – fast local testing using built-in mock items and customers. Use `USE_MOCK=1`.
- ERPNEXT mode – real integration using `ERPNEXT_URL`, `ERPNEXT_API_KEY`, and `ERPNEXT_API_SECRET`.
- The app writes invoice JSON files into `invoices/` for audit and offline recovery. In mock mode invoices are prefixed `MOCK-YYYYMMDD-<id>.json`.
- Set `POS_QUEUE_ONLY=1` when you want checkout to stop at the local invoice/outbox (just write a JSON receipt) even though ERP credentials are configured; the receipts can be replayed later via `sync_worker` or manual posting.

## Development notes

- The client is vanilla JS with simple DOM rendering in `static/js/script.js`. Currency formatting is configured by the `CURRENCY` constant inside that file.
- For quick iteration, static caching is disabled in `pos_server.py` during development.
- Use local `invoices/` JSON files as fixtures for integration tests.

## Testing & QA

- Unit tests: not included yet; add tests around receipt generation and sync logic.
- Manual QA: validate offline->online sync, Z-read reconciliation, partial/split payment scenarios.

## Operational notes

- Logs and errors appear on the Flask console. Persist logs externally when running in production.
- To refresh catalog stock and price-list rates from ERPNext, run `python pos_service.py --sync --warehouse Shop --price-list Retail` (or substitute `Shop`/`Retail` with `POS_WAREHOUSE`/`POS_PRICE_LIST`). That sync writes the selected warehouse Bin levels into `stock` and applies the price list to `items.price`.
- The app is intentionally simple to be run behind a process manager (systemd, NSSM on Windows) or inside a container.

## Where to go next

- `project_plan.md` — high-level roadmap and acceptance criteria.
- `agents.md` — descriptions of the sync/backup/notification agents and an operator runbook.

If you'd like, I can also:
- add a sample `invoices/sample-receipt.json` (based on the current mock invoice format),
- scaffold the first unit tests for receipt generation and the sync queue,
- or create a `develop` branch and implement the local DB + minimal checkout UI (Week 1 milestone from `project_plan.md`).
