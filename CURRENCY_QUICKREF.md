# Currency Conversion — Quick Reference & Examples

## Setup (5 minutes)

### 1. Update Environment
```bash
# .env file
CURRENCY_API_KEY=your_fixer_key_here
CURRENCY_BASE=GBP
CURRENCY_TARGET=EUR
CURRENCY_UPDATE_INTERVAL=86400
```

### 2. Restart Server
```bash
python pos_server.py
```
Background updater starts automatically.

### 3. Test in Browser
- Go to http://localhost:5000
- Add items to cart
- Click "Cash" tender
- Enter amount → EUR panel appears
- Click "Toggle" if it doesn't show

## API Examples

### Fetch Current Rate
```bash
curl http://localhost:5000/api/currency/rates
```
**Response:**
```json
{
  "status": "success",
  "base": "GBP",
  "target": "EUR",
  "rate": 1.1847,
  "last_updated": "2025-11-12T10:00:00Z"
}
```

### Convert an Amount
```bash
curl -X POST http://localhost:5000/api/currency/convert \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100.00,
    "base": "GBP",
    "target": "EUR",
    "round_mode": "nearest"
  }'
```
**Response:**
```json
{
  "status": "success",
  "base": "GBP",
  "target": "EUR",
  "amount_base": 100.00,
  "conversion": {
    "actual": 118.47,
    "rounded": 118.50,
    "rounded_down": 118.45,
    "rate": 1.1847,
    "savings": 0.05,
    "mode": "nearest"
  }
}
```

### Manually Update Rate
```bash
# Auto-fetch from API
curl -X POST http://localhost:5000/api/currency/rates/update

# Set custom rate
curl -X POST http://localhost:5000/api/currency/rates/update \
  -H "Content-Type: application/json" \
  -d '{"base":"GBP","target":"EUR","rate":1.1850}'
```

## Python Examples

### Fetch Rate from Database
```python
import pos_service as ps

conn = ps.connect('pos.db')
rate = ps.get_currency_rate(conn, 'GBP', 'EUR')
print(f"1 GBP = {rate} EUR")  # Output: 1 GBP = 1.1847 EUR
```

### Convert Amount
```python
import pos_service as ps

# Get rate from database
conn = ps.connect('pos.db')
rate = ps.get_currency_rate(conn, 'GBP', 'EUR')

# Convert £100.50
result = ps.convert_currency(100.50, rate, round_mode='nearest')
print(f"Actual: €{result['actual']}")          # €118.64
print(f"Rounded: €{result['rounded']}")        # €118.65
print(f"Rounded Down: €{result['rounded_down']}")  # €118.60
print(f"Savings: €{result['savings']}")        # €0.05
```

### Update Rate from API
```python
import pos_service as ps

conn = ps.connect('pos.db')
success = ps.update_currency_rate(conn, 'GBP', 'EUR')

if success:
    rate = ps.get_currency_rate(conn, 'GBP', 'EUR')
    print(f"Updated rate: {rate}")
else:
    print("Failed to fetch rate from API")
```

### Rounding Functions
```python
import pos_service as ps

amount = 14.572

# Round to nearest 0.05
rounded = ps.round_to_nearest_5(amount)
print(f"{amount} → {rounded}")  # 14.572 → 14.55

# Round down
rounded_down = ps.round_down_to_nearest_5(amount)
print(f"{amount} → {rounded_down}")  # 14.572 → 14.55

# Multiple examples
print(ps.round_to_nearest_5(12.322))        # 12.30
print(ps.round_to_nearest_5(12.342))        # 12.35
print(ps.round_down_to_nearest_5(12.349))   # 12.30
```

## Checkout Flow (End-to-End)

### Scenario: Customer pays in EUR

1. **Item total: £47.99**

2. **Cashier clicks "Cash" tender**
   - EUR Conversion panel appears

3. **Cashier enters: 47.99**
   - System calls `/api/currency/convert`
   - Panel updates with options

4. **Panel shows:**
   ```
   Rate (GBP→EUR): 1.1847
   Actual: € 56.76
   Rounded (nearest 5¢): € 56.75
   Rounded Down: € 56.75 (save €0.00)
   
   [Use Rounded] [Use Down]
   ```

5. **Cashier clicks "Use Rounded"**
   - Payment added: `{mode_of_payment: 'Cash (EUR)', amount: 56.75, currency: 'EUR', currency_rate: 1.1847}`

6. **Cashier clicks "Complete Sale"**
   - Sale payload includes:
     ```json
     {
       "currency_used": "EUR",
       "currency_rate_used": 1.1847,
       "payments": [{
         "mode_of_payment": "Cash (EUR)",
         "amount": 56.75,
         "currency": "EUR",
         "currency_rate": 1.1847
       }]
     }
   ```

7. **Database records:**
   ```sql
   -- In sales table
   currency_used = 'EUR'
   rate_used = 1.1847
   
   -- In payments table
   method = 'Cash (EUR)'
   amount = 56.75
   ref = NULL  -- or use for additional notes
   ```

## Rounding Strategies Explained

### Nearest 0.05 (Standard)
Best for: Fair pricing, international standards
```
£12.34 × 1.1847 = €14.5708
→ Rounds to €14.55 (nearest 0.05)
```

### Round Down (Discount)
Best for: Customer satisfaction, rounding generously
```
£12.34 × 1.1847 = €14.5708
→ Rounds down to €14.55
```

### Full Transparency
Customer sees both options:
- "We could charge €14.60 (rounding up)"
- "Or €14.55 (rounding down) — your choice"

## Reconciliation Example

### End of Day Report

**EUR Sales Summary:**
```
Date: 2025-11-12
Total EUR Sales: 5 transactions
```

| Transaction | GBP Total | EUR Rate | EUR Applied | Strategy | Savings |
|---|---|---|---|---|---|
| INV-001 | 47.99 | 1.1847 | 56.75 | Rounded | €0.00 |
| INV-002 | 32.50 | 1.1847 | 38.45 | Rounded Down | €0.05 |
| INV-003 | 89.00 | 1.1847 | 105.40 | Rounded | €0.00 |
| INV-004 | 15.75 | 1.1847 | 18.65 | Rounded | €0.05 |
| INV-005 | 63.25 | 1.1847 | 74.95 | Rounded Down | €0.00 |

**Total Recorded:** €294.20
**Total Actual:** €294.25
**Variance:** €0.05 (due to rounding strategy choices)

### SQL Queries for Reports

```sql
-- All EUR sales
SELECT sale_id, total, currency_used, rate_used 
FROM sales 
WHERE currency_used = 'EUR'
ORDER BY created_utc DESC;

-- EUR sales on specific date
SELECT COUNT(*), SUM(total) 
FROM sales 
WHERE currency_used = 'EUR' 
  AND DATE(created_utc) = '2025-11-12';

-- Compare GBP vs EUR rates
SELECT DISTINCT rate_used 
FROM sales 
WHERE currency_used = 'EUR'
ORDER BY created_utc DESC
LIMIT 1;

-- Find transactions with rounding discounts
SELECT sale_id, total, rate_used,
       (total / rate_used) AS gbp_equivalent
FROM sales
WHERE currency_used = 'EUR';
```

## Troubleshooting

### "No rate found for GBP->EUR"

**Solution 1: Manual API Update**
```bash
curl -X POST http://localhost:5000/api/currency/rates/update \
  -d '{"rate": 1.1847}' \
  -H "Content-Type: application/json"
```

**Solution 2: Direct Database Insert**
```bash
sqlite3 pos.db "
INSERT OR REPLACE INTO rates 
  (base_currency, target_currency, rate_to_base, last_updated)
VALUES ('GBP', 'EUR', 1.1847, datetime('now'))
"
```

**Solution 3: Python**
```python
import pos_service as ps
conn = ps.connect('pos.db')
ps.update_currency_rate(conn, 'GBP', 'EUR', 1.1847)
```

### EUR panel doesn't appear

**Check 1:** Verify JavaScript console (F12)
```javascript
eurConversionData  // Should not be null
eurConversionActive  // Should be false or true
```

**Check 2:** Test API manually
```bash
curl http://localhost:5000/api/currency/rates
```

**Check 3:** Verify database has rate
```bash
sqlite3 pos.db "SELECT * FROM rates WHERE base_currency='GBP' AND target_currency='EUR';"
```

### Conversion amount seems off

**Verify rate:**
```bash
# Check what rate system is using
curl http://localhost:5000/api/currency/rates

# Test calculation
curl -X POST http://localhost:5000/api/currency/convert \
  -d '{"amount":100,"base":"GBP","target":"EUR"}' \
  -H "Content-Type: application/json"
```

**Manual calculation:**
```
£100 × rate = €amount
£100 × 1.1847 = €118.47 ✓
```

## Advanced: Custom Currency Pair

To support GBP→USD or other pairs:

### Python
```python
import pos_service as ps

conn = ps.connect('pos.db')

# Update USD rate
ps.update_currency_rate(conn, 'GBP', 'USD', 1.2750)

# Start auto-updater for USD
ps.schedule_currency_rate_update('GBP', 'USD', interval_seconds=86400)
```

### API
```bash
# Fetch USD rate
curl http://localhost:5000/api/currency/rates?base=GBP&target=USD

# Convert to USD
curl -X POST http://localhost:5000/api/currency/convert \
  -d '{"amount":100,"base":"GBP","target":"USD"}' \
  -H "Content-Type: application/json"
```

### Frontend
Would need to extend the UI with additional currency buttons, but the backend API supports any base/target pair already.

## Performance Tips

1. **Cache rates in-memory** (optional; current database lookup is fast)
2. **Batch updates** if supporting multiple currency pairs
3. **Use SQLite indexes** on rates table (already done on primary key)
4. **Schedule updates** during off-peak hours

## Security Reminders

✅ Do:
- Store API key in environment variable
- Use HTTPS in production
- Validate all user input
- Log all currency transactions

❌ Don't:
- Commit API key to Git
- Expose rate update endpoint without auth
- Trust browser with rate data
- Use old rates without checking timestamp

## Integration with ERPNext

When syncing to ERPNext:

```json
{
  "doctype": "Sales Invoice",
  "customer": "Customer Name",
  "company": "Your Company",
  "currency": "EUR",
  "conversion_rate": 1.1847,
  "items": [...],
  "payments": [...]
}
```

The sync worker will automatically include currency fields from the POS sale record.
