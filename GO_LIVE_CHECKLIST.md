# POS Go-Live Test Checklist

Use this as a practical, step-by-step checklist before going live.
Check items off in order and note any issues.

## 1) Environment & Access
- [ ] Server starts cleanly with `python pos_server.py` and no errors.
- [ ] Correct `.env` values set (ERP URL/key/secret, warehouse, price list).
- [ ] System clock correct on server and tills.
- [ ] Network/firewall allows tills to reach the server.

## 2) Data Integrity
- [ ] Catalog loaded: items, variants, barcodes, prices, stock.
- [ ] Brands/groups present and correct.
- [ ] VAT rate(s) correct on items.
- [ ] Spot-check 10 products: name, price, VAT, barcode, stock.

## 3) Search & Browse
- [ ] Search opens quickly and returns results.
- [ ] Multi-term search: brand + item (e.g., `ecco track`).
- [ ] Multi-term search: brand + color (e.g., `ecco black`).
- [ ] Zero-stock toggle behaves as expected.
- [ ] Item opens to matrix and variant stock matches expected.

## 4) Cart & Sale Flow
- [ ] Add item via search (table and tiles).
- [ ] Add item via barcode (valid and invalid barcode).
- [ ] Add multiple variants to cart.
- [ ] Change quantity up/down.
- [ ] Remove item from cart.
- [ ] Refund toggle works.

## 5) Payments & Receipts
- [ ] Cash payment: exact amount.
- [ ] Cash payment: change due.
- [ ] Card/Other payment: full amount.
- [ ] Split tender (if used).
- [ ] Voucher redemption (if used).
- [ ] Receipt prints correctly (header/footer, totals, VAT).
- [ ] Gift receipt (if used).

## 6) Opening/Closing
- [ ] Opening float entry and save.
- [ ] X-read output (view/print).
- [ ] Z-read output and end session.
- [ ] Reconcile cash flow (closing screen).

## 7) ERP Sync & Offline Safety
- [ ] If ERP is online: test `/api/db/sync-items` works.
- [ ] If ERP is down: sales queue correctly (no crash).
- [ ] When ERP returns: queued sales sync.

## 8) Multiple Tills
- [ ] Two devices can use different till numbers.
- [ ] Settings are per-device (localStorage).
- [ ] Sales show correct till/branch metadata.

## 9) Hardware
- [ ] Receipt printer connection stable.
- [ ] Cash drawer opens after sale (if enabled).
- [ ] Barcode scanner input works consistently.

## 10) Recovery & Backup
- [ ] `erp.db` backup strategy in place.
- [ ] `pos_sales_queue.sqlite3` backup strategy in place.
- [ ] Quick restart procedure tested.
- [ ] Known failure steps documented (printer offline, ERP down).

## Notes / Issues
- 
- 
- 

