# Currency Conversion Feature (EUR Support)

This document describes the currency conversion feature added to ERPpos, with initial support for EUR (Euro) conversion from GBP (British Pound).

## Overview

The currency conversion system allows cashiers to:
1. **Toggle currency conversion** during checkout to show GBP→EUR conversion
2. **View multiple rounding options**:
   - **Actual conversion**: Pure mathematical conversion (e.g., £12.34 → €14.57)
   - **Rounded (nearest 5¢)**: Rounded to the nearest 0.05 EUR for easier handling
   - **Rounded Down**: Rounded down to the nearest 0.05 EUR, potentially giving the customer a discount
3. **Apply either rounding option** with a single click
4. **Track currency information** in the sale record for auditing and reconciliation

## Database Schema

### New Table: `rates`

Stores current exchange rates, updated daily (or on-demand).

```sql
CREATE TABLE IF NOT EXISTS rates (
  base_currency    TEXT NOT NULL,
  target_currency  TEXT NOT NULL,
  rate_to_base     NUMERIC NOT NULL,
  last_updated     TEXT NOT NULL,
  PRIMARY KEY (base_currency, target_currency)
)
```

**Fields:**
- `base_currency`: Source currency code (e.g., 'GBP')
- `target_currency`: Target currency code (e.g., 'EUR')
- `rate_to_base`: Exchange rate (e.g., 1.18 means 1 GBP = 1.18 EUR)
- `last_updated`: ISO 8601 timestamp of when the rate was last fetched

### Modified Table: `sales`

Two new columns added to track currency used in the sale:

```sql
currency_used       TEXT NOT NULL,           -- 'GBP', 'EUR', etc.
rate_used           NUMERIC NOT NULL DEFAULT 1,  -- Exchange rate applied
```

## Backend Implementation

### `pos_service.py` Functions

#### `fetch_currency_rate(base='GBP', target='EUR') -> Optional[float]`

Fetches the current exchange rate from an external API (Fixer.io by default).

**Environment Variables Required:**
- `CURRENCY_API_KEY`: API key for the currency service
- `CURRENCY_API_URL` (optional): Custom API endpoint; defaults to Fixer.io format

**Returns:** Exchange rate as float (e.g., 1.18), or None if fetch fails

**Example:**
```python
rate = ps.fetch_currency_rate('GBP', 'EUR')
# Returns: 1.1847 (1 GBP = 1.1847 EUR)
```

#### `update_currency_rate(conn, base='GBP', target='EUR', rate=None) -> bool`

Updates the database with a new exchange rate. If `rate` is None, fetches from API.

**Returns:** True if successful, False otherwise

**Example:**
```python
conn = ps.connect('pos.db')
success = ps.update_currency_rate(conn, 'GBP', 'EUR')
# Fetches rate from API and updates database
```

#### `get_currency_rate(conn, base='GBP', target='EUR') -> Optional[float]`

Retrieves the most recent exchange rate from the database.

**Returns:** Exchange rate or None if not found

**Example:**
```python
rate = ps.get_currency_rate(conn, 'GBP', 'EUR')
# Returns: 1.1847
```

#### `round_to_nearest_5(value: float) -> float`

Rounds a value to the nearest 0.05 (5 cents).

**Example:**
```python
ps.round_to_nearest_5(12.342)  # Returns: 12.35
ps.round_to_nearest_5(12.322)  # Returns: 12.30
```

#### `round_down_to_nearest_5(value: float) -> float`

Rounds DOWN a value to the nearest 0.05 (5 cents).

**Example:**
```python
ps.round_down_to_nearest_5(12.342)  # Returns: 12.30
ps.round_down_to_nearest_5(12.377)  # Returns: 12.35
```

#### `convert_currency(amount, rate, round_mode='nearest') -> dict`

Converts an amount using the provided exchange rate and returns multiple rounding options.

**Parameters:**
- `amount`: Amount in base currency (GBP)
- `rate`: Exchange rate (GBP→EUR)
- `round_mode`: Rounding preference ('nearest', 'down', 'none')

**Returns:**
```python
{
  'actual': 14.57,          # Pure conversion: £12.34 × 1.18 = €14.5712
  'rounded': 14.60,         # Rounded to nearest 0.05
  'rounded_down': 14.55,    # Rounded down to nearest 0.05
  'rate': 1.18,             # Exchange rate used
  'savings': 0.05,          # Discount if using rounded_down (€14.60 - €14.55)
  'mode': 'nearest'
}
```

#### `schedule_currency_rate_update(base='GBP', target='EUR', interval_seconds=86400) -> threading.Thread`

Starts a background daemon thread to fetch and update currency rates at regular intervals.

**Parameters:**
- `base`: Base currency code
- `target`: Target currency code
- `interval_seconds`: Update interval in seconds (default: 86400 = 1 day)

**Returns:** Thread object (runs as daemon)

**Example:**
```python
# Start daily EUR rate updates
thread = ps.schedule_currency_rate_update('GBP', 'EUR', interval_seconds=86400)
```

## API Endpoints

### `GET /api/currency/rates`

Retrieves the current exchange rate.

**Query Parameters:**
- `base` (optional): Base currency code (default: 'GBP')
- `target` (optional): Target currency code (default: 'EUR')

**Response:**
```json
{
  "status": "success",
  "base": "GBP",
  "target": "EUR",
  "rate": 1.1847,
  "last_updated": "2025-11-12T10:30:00Z"
}
```

### `POST /api/currency/convert`

Converts an amount and provides multiple rounding options.

**Request Body:**
```json
{
  "amount": 12.34,
  "base": "GBP",
  "target": "EUR",
  "round_mode": "nearest"
}
```

**Response:**
```json
{
  "status": "success",
  "base": "GBP",
  "target": "EUR",
  "amount_base": 12.34,
  "conversion": {
    "actual": 14.57,
    "rounded": 14.60,
    "rounded_down": 14.55,
    "rate": 1.1847,
    "savings": 0.05,
    "mode": "nearest"
  }
}
```

### `POST /api/currency/rates/update`

Admin endpoint to manually update the exchange rate.

**Request Body:**
```json
{
  "base": "GBP",
  "target": "EUR",
  "rate": 1.1850
}
```

If `rate` is omitted, the system will fetch it from the API.

**Response:**
```json
{
  "status": "success",
  "message": "Updated GBP->EUR rate",
  "rate": 1.1850
}
```

**Authentication:**
- Set `POS_ADMIN_TOKEN` environment variable to enable token-based protection
- Include `Authorization: Bearer <token>` header

## Frontend Implementation

### Checkout UI

When a cashier selects **Cash** as the tender:

1. **EUR Conversion Section** appears below the cash controls
2. Shows:
   - Current GBP→EUR exchange rate
   - Actual conversion amount
   - Rounded amount (nearest 0.05)
   - Rounded down amount (with potential savings)

3. **Two buttons** to apply either option:
   - "Use Rounded (€ ...)" — applies the nearest 0.05 rounding
   - "Use Down (€ ...)" — applies the rounded down option (potential discount)

### JavaScript Functions

#### `updateEurConversion(cashAmount)`

Fetches conversion data for the entered cash amount.

```javascript
await updateEurConversion(12.34);
// Updates eurConversionData with conversion details
// Calls updateEurConversionDisplay() to refresh UI
```

#### `updateEurConversionDisplay()`

Refreshes the EUR conversion UI with the latest data.

#### `applyEurConversion(roundMode)`

Applies a EUR conversion to the payment list.

**Parameters:**
- `roundMode`: 'rounded' or 'rounded_down'

**Effect:**
- Adds a payment to `appliedPayments` with:
  - `mode_of_payment`: 'Cash (EUR)'
  - `currency`: 'EUR'
  - `currency_rate`: Exchange rate used
  - `amount`: Converted amount in EUR

```javascript
applyEurConversion('rounded');  // Apply nearest 0.05 rounding
applyEurConversion('rounded_down');  // Apply rounded down (potential discount)
```

### State Variables

```javascript
let eurConversionData = null;      // { actual, rounded, rounded_down, rate, savings }
let eurConversionActive = false;   // Whether EUR is currently being used
```

## Configuration

### Environment Variables

**Currency Conversion Settings:**
```bash
# API for fetching exchange rates
CURRENCY_API_KEY=your_fixer_io_key
CURRENCY_API_URL=https://api.fixer.io/latest  # Optional; defaults to Fixer.io format

# Currency pair to monitor
CURRENCY_BASE=GBP                  # Default: GBP
CURRENCY_TARGET=EUR                # Default: EUR

# Update interval for background rate fetcher (seconds)
CURRENCY_UPDATE_INTERVAL=86400     # Default: 86400 (1 day)

# Optional: Admin token for rate update endpoint
POS_ADMIN_TOKEN=your_secret_token
```

## Usage Example

### Scenario: Accept EUR payment with rounding

1. **Customer's total: £12.34 GBP**
2. **Cashier selects "Cash" tender**
3. **Cashier enters: 12.34**
4. **EUR Conversion panel shows:**
   - Rate: 1.1847
   - Actual: €14.57
   - Rounded: €14.60
   - Rounded Down: €14.55 (saves €0.05)
5. **Cashier clicks "Use Down"** → Payment applied as €14.55 (with noted EUR conversion)
6. **Sale completes** with:
   - `currency_used`: 'EUR'
   - `rate_used`: 1.1847
   - Payment recorded with currency metadata

## Rounding Behavior

The system uses **0.05 EUR** (5 cents) as the rounding unit, which is common for coin-based currencies:

- **Nearest 0.05:** Follows standard mathematical rounding
  - €14.571 → €14.55 (rounds down)
  - €14.576 → €14.60 (rounds up)

- **Round Down:** Always rounds toward zero (potential customer discount)
  - €14.579 → €14.55

- **Savings:** Difference between rounded and rounded down
  - €14.60 - €14.55 = €0.05 (displayed as potential discount)

## Reconciliation & Auditing

All sales include:
- `currency_used`: Which currency the payment was made in
- `rate_used`: The exchange rate applied
- Payment details with `currency` and `currency_rate` metadata

This allows reconciliation teams to:
- Verify EUR payments against the recorded rate
- Detect rate variations over time
- Calculate exact EUR amounts for international bank transfers

## Daily Rate Updates

The system can automatically fetch updated rates daily:

```bash
# Option 1: Enable background updater on server startup
# (Configured via environment variables; runs automatically)

# Option 2: Manual trigger via API
curl -X POST http://localhost:5000/api/currency/rates/update \
  -H "Content-Type: application/json" \
  -d '{"base":"GBP","target":"EUR"}'

# Option 3: Scheduled cron job
0 9 * * * curl -X POST http://localhost:5000/api/currency/rates/update
```

## Error Handling

- **Missing API Key:** Logs warning; prevents fetch but doesn't block POS operations
- **API Failure:** Falls back to cached rate in database
- **No Rate in Database:** Conversion UI hides; normal GBP payment proceeds
- **Invalid Amount:** Conversion section updates only for positive amounts

## Future Enhancements

- Support multiple currency pairs (GBP↔USD, GBP↔JPY, etc.)
- Historical rate tracking for reporting
- Automatic rate refresh on each checkout
- Multi-currency payment splitting (e.g., part EUR, part GBP)
- Dashboard view of currency statistics and rates
