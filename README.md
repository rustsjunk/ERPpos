# ERPpos

Simple Flask-based POS UI that talks to ERPNext via REST API.

Quickstart
- Install dependencies: `pip install -r requirements.txt`
- Run in MOCK mode (default, no ERPNext required): `python main.py`
  - Optional env: `FLASK_DEBUG=1`, `HOST=0.0.0.0`, `PORT=5000`, `USE_MOCK=1`
- To connect to ERPNext later (optional):
  - Create a `.env` file with:
    - `ERPNEXT_URL=https://your-erpnext-instance.com`
    - `ERPNEXT_API_KEY=your-api-key`
    - `ERPNEXT_API_SECRET=your-api-secret`
    - `USE_MOCK=0`
  - Then run `python main.py`

Notes
- Main app is in `pos_server.py`; `main.py` loads and runs it.
- Default behavior uses mock items/customers and records mock sales IDs.
- Currency display is client-side formatted; set currency in `static/js/script.js` (CURRENCY).
