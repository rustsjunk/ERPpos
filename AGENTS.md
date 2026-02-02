# AGENTS.md

## Project focus
- Backend APIs live in `pos_server.py`.
- ERP sync + local DB helpers live in `pos_service.py`.
- Frontend behavior is in `static/js/script.js` and `templates/pos.html`.

## Local data
- Primary SQLite database: `erp.db` (configurable via `POS_DB_PATH`).
- Catalog tables: `items`, `barcodes`, `stock`, `item_prices`.
- Sales tables: `sales`, `sale_lines`, `payments`.

## Run/test hints
- Start the server with `python pos_server.py` (reads `.env`).
- If catalog data is missing, use `/api/db/sync-items` or `/api/db/full-sync-items`.

## Guardrails
- Prefer additive changes; avoid destructive DB actions.
- Keep responses fast: limit heavy payloads and use cache where available.
