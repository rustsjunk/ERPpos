Sync: Durable Local Queue + ERP Pull Acknowledgement

Overview
- ERPpos records every sale locally (SQLite + JSON receipt in `invoices/`).
- ERPNext can either pull those JSON receipts from `invoices/` or you can push via API.
- A lightweight worker reconciles state and exposes counts to the UI.

ERPNext Integration (drop-in script)
- This repo includes `erpnext_pos_sync.py` with two whitelisted methods you can copy into your ERP app as `your_app/pos_sync.py`:
  - `/api/method/your_app.pos_sync.pos_ingest` (idempotent ingest using `pos_receipt_id`)
  - `/api/method/your_app.pos_sync.pull_from_folder` (optional folder pull that writes `.json.ok`)
- Create a custom field on Sales Invoice: `pos_receipt_id` (Data, Unique) to enforce idempotency.

Key Concepts
- Idempotency key: each sale uses a stable `sale_id` that matches the file name `invoices/<sale_id>.json` (in mock mode the name looks like `MOCK-YYYYMMDD-XXXXXXX`).
- Local index: every sale is stored in SQLite (`sales` table) with `queue_status` in `queued|posting|posted|failed`.
- Acknowledgement (ERP pull): when ERPNext finishes ingesting a file, it writes a sidecar `invoices/<sale_id>.json.ok`. The worker marks that sale as `posted`.
  - After marking posted, the worker deletes the `.json.ok` sidecar to keep the folder tidy.
- Push mode (optional): instead of ERP pull, the worker can post queued sales to ERPNext via REST and mark them `posted` on success.

Files and Tables
- `invoices/` holds JSON receipts produced by `/api/create-sale`.
- `pos.db` contains tables `sales`, `sale_lines`, `payments`, and `outbox` (for push workflows).

API Endpoints
- `GET /api/sales/status` → `{ counts: { queued, posting, posted, failed }, invoices_pending }`
- `POST /api/admin/sync/scan-acks` → scans `invoices/*.json.ok` and marks sales `posted`.
  - Successful acknowledgements also delete the corresponding `.json.ok` files.

Worker
- Script: `sync_worker.py`
- Modes:
  - `pull-ack` (default): only scans `invoices/` for `.json.ok` sidecars and updates `sales.queue_status`.
  - `push`: calls `pos_service.push_outbox` to post queued sales to ERPNext.
- Env vars:
  - `POS_DB_PATH` (default `pos.db`)
  - `SYNC_MODE` = `pull-ack` | `push`
  - `SYNC_INTERVAL` seconds (default `10`)
- `INVOICES_DIR` (default `invoices`)
  - Push mode env: `ERP_BASE`, `ERP_API_KEY`, `ERP_API_SECRET`, `ERP_INGEST_METHOD` (default `your_app.pos_sync.pos_ingest`)

Run
- Windows (PowerShell):
  - `python .\sync_worker.py`
- Linux/Mac:
  - `python3 ./sync_worker.py`

How the flows work
1) Local → ERP (pull)
   - POS writes `invoices/<sale_id>.json` and inserts a `sales` row with `queue_status='queued'`.
   - ERPNext job picks up the JSON and creates the Sales Invoice.
   - ERPNext writes `invoices/<sale_id>.json.ok` (or moves the file to an archive you define).
   - Worker sees `.ok`, marks the sale `posted` and increments the UI counters accordingly.

2) Local → ERP (push)
   - POS inserts sale and enqueues to `outbox`.
   - Worker runs in `push` mode, calls ERPNext API and on success marks sale `posted` and removes from `outbox`.

UI Indicators
- The top bar bell shows pending and failed counts.
- Tooltip shows `Pending sync: N | Failed: M`.

Operational Notes
- Backups: consider running `pos_service.backup_ndjson()` daily to produce NDJSON archives in `pos_backup/`.
- Recovery:
  - If ERP pull pauses, tills continue; `queued` grows. Once pull resumes, sidecars get written and the worker marks `posted`.
  - If a specific sale is missing in ERP, you can replay by sending the JSON body to your ERP ingestion endpoint (ensure idempotency).

Extending
- If you prefer moving files to `invoices/processed/` instead of writing `.ok` files, adjust `sync_worker.py` to detect moves and update `sales` accordingly.
- To show remote-only sales (e.g., e-commerce), add a simple cache table and a fetch routine that populates it from ERPNext at intervals using `sync_cursors`.
