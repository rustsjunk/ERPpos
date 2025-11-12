# Variant Stock & Price Display Fix — Summary

## Problem
Users were seeing parent items on the POS with **stock=0** even though variants had stock in ERPNext. Additionally, the variant matrix view didn't display individual variant stock quantities.

## Root Causes
1. **Hardcoded warehouse name**: The server queries had `s.warehouse='Shop'` hardcoded, but your warehouse is `'Stores - ROO'`. This caused the aggregated stock subqueries to return 0.
2. **Missing schema tables**: The `item_prices` and `stock_snapshot` tables were created dynamically during sync, not in the main schema. This caused SQL errors when the server tried to query them.
3. **Cross-thread SQLite issue**: The background sync worker was trying to use a SQLite connection created on a different thread, causing "objects created in a thread" errors.

## Changes Made

### 1. Schema Updates (`schema.sql`)
- Added `item_prices` table (stores price_list rates per item)
- Added `stock_snapshot` table (historical stock records per Bin)
- Both tables now created on `init_db()` instead of dynamically during sync

### 2. Server Payload Updates (`pos_server.py`)

#### `_db_items_payload()` function
- **Before**: Hardcoded `s.warehouse='Shop'` in subquery
- **After**: Uses f-string interpolation with `POS_WAREHOUSE` env var
- Subquery now correctly aggregates stock from the configured warehouse
- Result: `variant_stock` field now returns aggregated variant quantities instead of 0

#### `/api/item_matrix` endpoint  
- **Before**: Hardcoded `s.warehouse='Shop'` in variant query
- **After**: Uses `POS_WAREHOUSE` env var
- Result: Variant matrix now displays correct stock qty per variant

### 3. Sync Worker Fix (`pos_server.py`)
- **Issue**: Background sync thread was trying to use a connection created on the main thread
- **Fix**: Moved `_db_connect()` call **inside** the background thread function
- Each sync worker now creates its own SQLite connection (thread-safe)

## Verification

### Test Results
**Before fix:**
```
Template: Adesso-Dila
  variant_stock: 0.0 (warehouse hardcoded as 'Shop' but data is in 'Stores - ROO')
```

**After fix:**
```
Template: Adesso-Dila
  variant_stock: 61 (correctly aggregated from 14 variants in 'Stores - ROO' warehouse)
  
Template: Adesso-Meris
  variant_stock: 33
  
Template: Adesso-Raine
  variant_stock: 68
```

**Variant matrix (per variant):**
```
Adesso-Dila-A8136-Pumpkin Patch-36 EU    qty=4
Adesso-Dila-A8136-Pumpkin Patch-37 EU    qty=1
Adesso-Dila-A8136-Pumpkin Patch-38 EU    qty=9
```

## Frontend Display

The UI (`static/js/script.js`) already had code to display:
- **Tile level**: `variant_stock` aggregated quantity
- **Price display**: Price range (`price_min` - `price_max`) or single price if uniform
- **Matrix view**: Individual variant stock in the Size/Color/Width matrix cells

## Configuration

Ensure these env vars are set:
- `POS_WAREHOUSE`: Name of the warehouse for stock queries (default: 'Shop')
- `POS_PRICE_LIST`: Price list to pull from ERPNext (optional, e.g., 'Standard Selling')
- `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`: ERPNext connection details

For your setup:
```
POS_WAREHOUSE=Stores - ROO
POS_PRICE_LIST=Standard Selling
```

## API Endpoints

### `/api/items` (GET)
Returns template items with aggregated variant data:
```json
{
  "status": "success",
  "items": [
    {
      "name": "Adesso-Dila",
      "item_name": "Dila",
      "standard_rate": 79.0,
      "variant_stock": 61,      // ← aggregated from variants in Stores - ROO
      "price_min": 79.0,
      "price_max": 79.0,
      "stock_uom": "Each"
    }
  ]
}
```

### `/api/item_matrix?item=Adesso-Dila` (GET)
Returns variant matrix with per-variant stock:
```json
{
  "status": "success",
  "data": {
    "variants": {
      "Pumpkin Patch|Standard|36 EU": {
        "item_id": "Adesso-Dila-A8136-Pumpkin Patch-36 EU",
        "qty": 4,
        "rate": 79.0
      }
    },
    "stock": {
      "Pumpkin Patch|Standard|36 EU": 4
    }
  }
}
```

## Testing Sync from ERPNext

To pull stock from live ERPNext (Bin table):

**Via endpoint:**
```powershell
Invoke-RestMethod -Uri http://localhost:5000/api/db/sync-items -Method Post
```

**Via CLI:**
```bash
python pos_service.py --sync --warehouse "Stores - ROO" --price-list "Standard Selling"
```

Watch logs for:
- `"Pulled: Items=..., Bins=X"` — X should be > 0 if stock exists in ERP
- `"ERPNext incremental sync completed"` — sync finished successfully

## Known Issues & Recommendations

1. **Item Barcode permission**: If you see "Item Barcode pull forbidden (HTTP 403)", ask your ERPNext admin to grant read access to the Item Barcode doctype. This is non-critical; the POS falls back to using `item_code` as a barcode.

2. **Price updates**: Currently, if prices are in a `Item Price` doctype in ERPNext, they are pulled into `item_prices` table and the `items.price` field is updated once per sync. Template items without an explicit price inherit the min-variant price for display.

3. **Durable sync queue**: For production, consider implementing a durable outbox queue (SQLite-backed) so failed syncs can be retried without losing data. Currently, syncs are in-process and background threads are daemon threads.

4. **Reconciliation**: The Z-read report should account for variant stock movements. Future enhancement: add a reconciliation helper to compare counted stock against Bin snapshots.

## Files Changed

1. **`schema.sql`**
   - Added `item_prices` table + index
   - Added `stock_snapshot` table + index

2. **`pos_server.py`**
   - Modified `_db_items_payload()`: use `POS_WAREHOUSE` in subquery
   - Modified `/api/item_matrix`: use `POS_WAREHOUSE` in variant query
   - Fixed `/api/db/sync-items` background worker: create DB connection inside thread

3. **`pos_service.py`**
   - Added `_BIN_PULL_FORBIDDEN` flag (same pattern as barcode handling)
   - Added HTTP 403 handler in `pull_bins_incremental()` for graceful permission denials

## Next Steps

1. **Run Flask server:**
   ```bash
   py main.py
   ```
   
2. **Trigger sync (if using live ERPNext):**
   - Click "Resync from ERPNext" admin button, or
   - POST to `/api/db/sync-items`

3. **Verify tiles show stock:**
   - Open POS in browser
   - Parent items should display `Stock: N` where N = sum of variant stock
   - Price should display range or single price depending on variants

4. **Test variant matrix:**
   - Click a parent item
   - Size/Color grid should show quantities per cell
   - Each cell represents a variant with its own stock

---

**Status**: ✅ Complete. Variant stock and prices now correctly aggregated and displayed per warehouse.
