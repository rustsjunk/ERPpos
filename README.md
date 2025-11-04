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

- Mock mode (default) — fast local testing using built-in mock items and customers. Use `USE_MOCK=1`.
- ERPNEXT mode — real integration using `ERPNEXT_URL`, `ERPNEXT_API_KEY`, and `ERPNEXT_API_SECRET`.
- The app writes invoice JSON files into `invoices/` for audit and offline recovery. In mock mode invoices are prefixed `MOCK-YYYYMMDD-<id>.json`.

## Development notes

- The client is vanilla JS with simple DOM rendering in `static/js/script.js`. Currency formatting is configured by the `CURRENCY` constant inside that file.
- For quick iteration, static caching is disabled in `pos_server.py` during development.
- Use local `invoices/` JSON files as fixtures for integration tests.

## Testing & QA

- Unit tests: not included yet; add tests around receipt generation and sync logic.
- Manual QA: validate offline->online sync, Z-read reconciliation, partial/split payment scenarios.

## Operational notes

- Logs and errors appear on the Flask console. Persist logs externally when running in production.
- The app is intentionally simple to be run behind a process manager (systemd, NSSM on Windows) or inside a container.

## Where to go next

- `project_plan.md` — high-level roadmap and acceptance criteria.
- `agents.md` — descriptions of the sync/backup/notification agents and an operator runbook.

If you'd like, I can also:
- add a sample `invoices/sample-receipt.json` (based on the current mock invoice format),
- scaffold the first unit tests for receipt generation and the sync queue,
- or create a `develop` branch and implement the local DB + minimal checkout UI (Week 1 milestone from `project_plan.md`).
