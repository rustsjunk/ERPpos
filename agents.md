## ERPpos — Agents and runbook

This document describes the background/operational agents used (or planned) for ERPpos, their responsibilities, inputs/outputs, failure modes and a short runbook for common recovery steps.

> Note: ERPpos is intentionally small and mostly single-process. "Agents" here means logical responsibilities that can run in-process (background thread) or as separate services/processes depending on deployment.

### Agent overview

- Sync Agent
  - Responsibility: deliver queued sales/receipt JSONs and stock adjustments to ERPNEXT.
  - Inputs: invoice JSONs (local `invoices/` or queue), local sync queue entries.
  - Outputs: HTTP calls to ERPNEXT API, local status marks (synced/failed).
  - Trigger: immediate on network available + periodic retry (exponential backoff).
  - Failure modes: network outages, invalid credentials, server errors. Mitigation: durable queue, retries, operator alert.

- Backup Agent
  - Responsibility: ensure local copies of receipts and minimal DB/backups are maintained for recovery.
  - Inputs: local invoice files, local DB state.
  - Outputs: archived backups (optional path), rotated retention.
  - Trigger: on write (opportunistic) and scheduled snapshots.

- Notification Agent
  - Responsibility: surface important events to the UI or operator (failed syncs, low stock warnings, website sales alert).
  - Inputs: sync failures, low-stock thresholds, external webhook events.
  - Outputs: UI notification bell events, optional email/log.

- Voucher Agent
  - Responsibility: validate, apply and record gift voucher redemptions.
  - Inputs: voucher code scans, voucher DB/service.
  - Outputs: adjusted tender amounts, voucher usage records.

- Reconciliation Agent (Z-read)
  - Responsibility: produce Z-read (end-of-day) report, calculate expected till totals and detect variance.
  - Inputs: local invoices (today), opening float, payouts.
  - Outputs: Z-read report, discrepancy alerts.

### Data contracts (brief)

- Local invoice/receipt JSON (stored in `invoices/`):
  - Fields to expect: invoice_name, created_at, mode (mock|erpnext), customer, items[], payments[], tender, cash_given, change, total, vouchers[]
  - Keep a stable mapping for the Sync Agent to post to ERPNEXT. Version the contract if it changes.

### Operational workflows & runbook

1. Sync failure (common)
   - Symptoms: UI shows sale recorded locally, but ERPNEXT not updated; console shows HTTP error or timeout.
   - Quick checks:
     - Verify network connectivity on the host.
     - If running in ERPNEXT mode, check `.env` variables: `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`.
     - Check console logs for HTTP status codes or error messages.
   - Remediation:
     - If transient network, wait; Sync Agent will retry automatically.
     - For credential errors (401/403), rotate API key/secret and restart the app.
     - If invoices remain unsynced, you can replay them manually by POSTing the JSON to `/api/create-sale` (careful: dedup if necessary).

2. Lost local files or accidental deletion
   - If `invoices/` was deleted, restore from Backup Agent snapshots if available. If no backups, consult ERPNEXT for missing sales and re-run from available transaction logs.

3. Z-read discrepancy
   - Check the day's invoices in `invoices/` and compare totals with the Z-read. Look for refunds, voided transactions, or duplicate entries.
   - Use the admin UI (or add a small script) to recompute expected totals from invoices and reconcile with counted cash.

### Running agents in this codebase

- Currently ERPpos runs as a single Flask process (`pos_server.py`). Background responsibilities are implicit in endpoints and client behaviors (mock mode writes JSON invoices into `invoices/`).
- For a production deployment consider these options:
  - In-process background thread that scans a durable queue and runs Sync Agent logic.
  - Separate worker process (e.g., a Python script run under a process manager) that reads `invoices/` or a persistent queue (SQLite / Redis) and posts receipts to ERPNEXT.

### Example: simple manual sync replay (operator)

If a sale saved locally did not reach ERPNEXT and you want to replay it manually (mock mode writes JSON files):

1. Inspect the invoice file, e.g. `invoices/MOCK-20251104-31F2FC0D.json`.
2. Confirm the JSON structure matches `/api/create-sale` body expectations (customer, items, payments).
3. From the host, POST the JSON to the running server's `/api/create-sale` endpoint (or directly to ERPNEXT if you have validated contract and credentials).

Example PowerShell payload send (against a local running server):

```powershell
$json = Get-Content .\invoices\MOCK-20251104-31F2FC0D.json -Raw
Invoke-RestMethod -Uri http://localhost:5000/api/create-sale -Method Post -Body $json -ContentType 'application/json'
```

Only replay when you are sure it will not create duplicates in ERPNEXT.

### Monitoring & logs

- Console logs are the first place to look. Consider piping output to a file or using a supervisor that can capture logs.
- Add structured logging (JSON) and an external log sink for production.

### Next steps (recommended)

- Implement a durable sync queue backed by SQLite or Redis for atomic enqueue/dequeue and visibility.
- Add a small worker script `sync_worker.py` to run outside the web process; it should:
  - read queued invoices, post to ERPNEXT, mark success/failure, and emit metrics/logs.
- Add health checks and an admin UI to view unsynced invoices and manually retry.

---

For operational help, tell me how you'd like to run agents (in-process or separate workers) and I can scaffold a `sync_worker.py` and a simple replay/admin view.
