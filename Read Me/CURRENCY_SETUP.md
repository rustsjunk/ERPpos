# Currency Conversion Setup Guide

## Quick Start

### 1. Database Schema Update

The currency feature requires a new `rates` table. This is already defined in `schema.sql`. If you have an existing database, run:

```bash
# Backup your current database first!
cp pos.db pos.db.backup

# Add the rates table to your existing database:
sqlite3 pos.db < schema.sql
```

Or use the Python helper:

```python
import pos_service as ps
conn = ps.connect('pos.db')
ps.init_db(conn, 'schema.sql')
```

### 2. Get an API Key (Optional but Recommended)

To enable automatic exchange rate fetching, sign up for a free currency API:

**Option A: Fixer.io (recommended for EUR)**
1. Go to https://fixer.io
2. Sign up for a free account (100 requests/month)
3. Copy your API key

**Option B: Open Exchange Rates**
1. Go to https://openexchangerates.org
2. Sign up for a free account
3. Copy your API key
4. Update the `CURRENCY_API_URL` environment variable accordingly

**Option C: Alternative Services**
- OANDA (https://developer.oanda.com/)
- Exchangerate-api (https://www.exchangerate-api.com/)
- Currencyapi (https://currencyapi.com/)

### 3. Configure Environment Variables

Create or update your `.env` file:

```bash
# Currency API Configuration
CURRENCY_API_KEY=your_api_key_here
CURRENCY_API_URL=https://api.fixer.io/latest  # Optional; defaults to Fixer.io

# Currency Pair to Monitor
CURRENCY_BASE=GBP
CURRENCY_TARGET=EUR

# Update Interval (seconds; default: 86400 = once daily)
CURRENCY_UPDATE_INTERVAL=86400

# Optional: Admin Token for Manual Rate Updates
POS_ADMIN_TOKEN=your_secret_admin_token
```

### 4. Start the Server

```bash
# The currency updater thread starts automatically on first run
python pos_server.py
```

### 5. Test It Out

1. Open the POS in your browser (http://localhost:5000)
2. Add items to the cart
3. Select **Cash** as tender
4. Enter an amount (e.g., 12.34)
5. The **EUR Conversion** panel should appear
6. Click the **Toggle** button if it doesn't show automatically
7. You should see:
   - Current exchange rate
   - Actual EUR amount
   - Rounded options
8. Click **"Use Rounded"** or **"Use Down"** to apply EUR conversion
9. Complete the sale; currency info is stored in the sale record

## Troubleshooting

### EUR Conversion panel doesn't appear

**Symptoms:** No EUR conversion UI when cash tender is selected

**Fixes:**
1. Check browser console (F12) for JavaScript errors
2. Verify that the currency API endpoint is accessible
3. Manually update rate via API:
   ```bash
   curl -X POST http://localhost:5000/api/currency/rates/update \
     -H "Content-Type: application/json" \
     -d '{"base":"GBP","target":"EUR"}'
   ```
4. Check server logs for errors

### "No rate found for GBP->EUR"

**Cause:** Exchange rate not in database yet

**Fix:**
1. Set `CURRENCY_API_KEY` environment variable
2. Trigger manual update:
   ```bash
   curl -X POST http://localhost:5000/api/currency/rates/update
   ```
3. Or restart the server (background updater will fetch on startup)
4. Wait 10 seconds and refresh the browser

### API returns 403 or 401 error

**Cause:** Invalid or missing API key

**Fix:**
1. Verify your API key in `.env`
2. Check that the API service is still active (sometimes free accounts expire)
3. Try logging into the API service web portal directly
4. Consider using a different currency API service

### Exchange rate seems wrong

**Cause:** Stale cached rate; API may have better rates

**Fix:**
1. Manually trigger an update:
   ```bash
   curl -X POST http://localhost:5000/api/currency/rates/update
   ```
2. Increase update frequency (change `CURRENCY_UPDATE_INTERVAL` to 3600 for hourly)
3. Check the `last_updated` timestamp in the response to verify freshness

## Manual Rate Updates

If you prefer to update rates manually (e.g., at opening of business):

```bash
# Get current rate from API
curl http://localhost:5000/api/currency/rates

# Set a custom rate (handy for "today's approved rate")
curl -X POST http://localhost:5000/api/currency/rates/update \
  -H "Content-Type: application/json" \
  -d '{"base":"GBP","target":"EUR","rate":1.1850}'
```

## Adding More Currency Pairs

To support additional currencies (e.g., USD):

1. Update `.env`:
   ```bash
   # Add another schedule call in your startup script, or modify the environment
   ```

2. In Python, add in `pos_server.py` or a startup script:
   ```python
   import pos_service as ps
   conn = ps.connect('pos.db')
   ps.update_currency_rate(conn, 'GBP', 'USD')
   ps.schedule_currency_rate_update('GBP', 'USD')
   ```

3. In frontend, modify the checkout UI to include additional currency buttons

## Verification

### Check Database

```bash
# View all stored rates
sqlite3 pos.db "SELECT * FROM rates;"

# Check sales with EUR
sqlite3 pos.db "SELECT sale_id, currency_used, rate_used FROM sales WHERE currency_used='EUR';"
```

### Check API Status

```bash
curl http://localhost:5000/api/currency/rates?base=GBP&target=EUR | jq
```

### Test Conversion

```bash
curl -X POST http://localhost:5000/api/currency/convert \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"base":"GBP","target":"EUR","round_mode":"nearest"}' | jq
```

## Integration with Sync Worker

If you're syncing sales to ERPNext:

1. Currency data is automatically included in the sale payload
2. When `sync_worker.py` posts to ERPNext, it will include:
   - `currency_used`: 'EUR' or 'GBP'
   - `rate_used`: The exchange rate applied

3. Ensure your ERPNext `Sales Invoice` doctype has currency fields, or update the sync mapping

## Security Note

- The `CURRENCY_API_KEY` is only used server-side; never exposed to the browser
- If using `POS_ADMIN_TOKEN`, transmit only over HTTPS in production
- Store `.env` securely and never commit to version control
- Rotate API keys periodically

## Performance Impact

- **Automatic updates:** Negligible (background thread, once daily)
- **Conversion UI:** Fetches rate on-demand only when checkout is active
- **Database:** One additional table with minimal storage (~100 bytes per rate)
- **API calls:** ~86,400 per year with default daily interval; well within free tier limits

## Next Steps

1. **Test with mock data:** Use `round_down` to verify discount calculations
2. **Train staff:** Show cashiers the EUR toggle and rounding options
3. **Monitor rates:** Check that daily updates are working
4. **Reconcile:** At end of day, verify EUR sales match the recorded rates
5. **Report:** Use the `currency_used` and `rate_used` fields for audits
