Minimal SQLite schema (ready to paste)
-- Core catalog (templates + variants in one table)
CREATE TABLE items (
  item_id        TEXT PRIMARY KEY,             -- ERPNext name/item_code
  parent_id      TEXT REFERENCES items(item_id), -- NULL for templates
  name           TEXT NOT NULL,                -- display name
  brand          TEXT,
  attributes     TEXT,                         -- JSON: {"Size":"8","Color":"Black"}
  price          NUMERIC,                      -- variant price; NULL = inherit
  image_url      TEXT,                         -- variant image; NULL = inherit
  is_template    INTEGER NOT NULL DEFAULT 0,   -- 1 template / 0 variant
  active         INTEGER NOT NULL DEFAULT 1,
  modified_utc   TEXT                          -- for sync checkpoints
);

-- Many barcodes per item (EAN/UPC, internal, Shopify, supplier, etc.)
CREATE TABLE barcodes (
  barcode   TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(item_id)
);

-- Local stock cache (per warehouse if you need it)
CREATE TABLE stock (
  item_id    TEXT NOT NULL REFERENCES items(item_id),
  warehouse  TEXT NOT NULL DEFAULT 'Shop',
  qty        NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, warehouse)
);

-- Handy indexes
CREATE INDEX idx_items_parent ON items(parent_id);
CREATE INDEX idx_items_active_templates ON items(is_template, active);
CREATE INDEX idx_stock_qty ON stock(warehouse, item_id);

Inheritance you’ll want (no duplication)

Two tiny views give you “variant→fallback to template” without piling logic into your POS code.

-- Effective image: variant.image_url else template.image_url
CREATE VIEW v_item_images AS
SELECT
  v.item_id,
  COALESCE(v.image_url, t.image_url) AS image_url_effective
FROM items v
LEFT JOIN items t ON t.item_id = v.parent_id;

-- Effective price: variant.price else template.price
CREATE VIEW v_item_prices AS
SELECT
  v.item_id,
  COALESCE(v.price, t.price) AS price_effective
FROM items v
LEFT JOIN items t ON t.item_id = v.parent_id;

POS queries you’ll use all day

Scan a barcode → get the sellable variant

SELECT i.item_id, i.name, i.brand, i.attributes,
       p.price_effective AS price,
       img.image_url_effective AS image_url
FROM barcodes b
JOIN items i        ON i.item_id = b.item_id AND i.active=1 AND i.is_template=0
LEFT JOIN v_item_prices p ON p.item_id = i.item_id
LEFT JOIN v_item_images img ON img.item_id = i.item_id
LEFT JOIN stock s    ON s.item_id = i.item_id AND s.warehouse = ?
WHERE b.barcode = ?;


Browse tiles → only templates

SELECT item_id, name, brand,
       (SELECT COUNT(*) FROM items v WHERE v.parent_id = items.item_id AND v.active=1) AS variant_count
FROM items
WHERE is_template=1 AND active=1
ORDER BY brand, name;


Variant chips for a template (e.g., sizes that have stock)

SELECT i.item_id, i.attributes, COALESCE(s.qty,0) AS qty
FROM items i
LEFT JOIN stock s ON s.item_id = i.item_id AND s.warehouse = ?
WHERE i.parent_id = ? AND i.active=1
ORDER BY i.attributes;  -- your UI can parse Size/Color from JSON

Why this nails your requirements

Exactly your fields: id, parent id, attributes, stock, name, brand, price, barcodes, warehouse, image link.

Fast scans: barcodes as a primary key → O(1) lookups.

Clean UI: list templates as tiles; when tapped, show child variants with stock badges. If you ever need a variant-only UI, it still works.

No duplication: price/image live once; variants only override when needed.

ERPNext parity: item_id = ERPNext name keeps syncing simple; parent_id mirrors variant relation.

Sync sketch (pull-only + offline sales later)

Pull items changed since modified_utc >= last_checkpoint from ERPNext.

Upsert into items, barcodes, and stock (ERPNext Bin) for your chosen warehouse(s).

If a record disappears in ERPNext, set active=0 locally (don’t hard-delete; you still need history).

Price lists: if you later need “Online vs In-store,” add a tiny prices(item_id, price_list, rate) table and switch the v_item_prices join to your active price list.

Tiny extra niceties

Add search_text column to items (name + brand + attributes flattened) and index it for snappy type-ahead.

If some barcodes point to templates (rare), handle it by prompting for a variant: WHERE i.is_template=1 → show children.




1) Use one local SQLite DB (not separate DBs)

Single file keeps sync/backup simple and fast. Turn on WAL mode so reads never block scans during checkout.

PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;   -- good balance for POS
PRAGMA foreign_keys=ON;

2) Catalog (from earlier)

items, barcodes, stock, plus the inheritance views (v_item_prices, v_item_images). That stands.

3) Sales stored as JSON and queryable rows

Save the full receipt as JSON for lossless ERPNext handoff, but also normalize key parts so the POS can search/filter quickly.

-- One row per receipt, append-only
CREATE TABLE sales (
  sale_id        TEXT PRIMARY KEY,        -- UUID v4
  created_utc    TEXT NOT NULL,           -- ISO8601
  cashier        TEXT,
  customer_id    TEXT,                    -- optional
  subtotal       NUMERIC NOT NULL,
  tax            NUMERIC NOT NULL,
  discount       NUMERIC NOT NULL DEFAULT 0,
  total          NUMERIC NOT NULL,
  pay_status     TEXT NOT NULL,           -- 'paid'|'partially_paid'|'refunded'
  queue_status   TEXT NOT NULL,           -- 'queued'|'posting'|'posted'|'failed'
  erp_docname    TEXT,                    -- filled when ERPNext confirms
  payload_json   TEXT NOT NULL            -- the full, signed receipt for sync
);

-- Lines you can filter quickly (brand reports, item lookups, refunds)
CREATE TABLE sale_lines (
  sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,
  item_id        TEXT NOT NULL,
  item_name      TEXT NOT NULL,
  brand          TEXT,
  attributes     TEXT,                    -- JSON (Size, Colour)
  qty            NUMERIC NOT NULL,
  rate           NUMERIC NOT NULL,
  line_total     NUMERIC NOT NULL,
  barcode_used   TEXT,
  PRIMARY KEY (sale_id, line_no)
);

-- Payments (multiple tenders, split payments)
CREATE TABLE payments (
  sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  method         TEXT NOT NULL,           -- 'Cash'|'Card'|'Voucher'|'GiftCard'|'StoreCredit'
  amount         NUMERIC NOT NULL,
  ref            TEXT,                     -- terminal txn id, last4, etc.
  PRIMARY KEY (sale_id, seq)
);

CREATE INDEX idx_sales_created ON sales(created_utc);
CREATE INDEX idx_sales_erpstatus ON sales(queue_status, created_utc);
CREATE INDEX idx_lines_item ON sale_lines(item_id);
CREATE INDEX idx_payments_method ON payments(method);

Notes

payload_json is your canonical “what happened” (all numbers as strings to avoid float drift; include price list, warehouse, and taxes used).

Idempotency: the sale_id stays the same from queue to ERP. When ERPNext posts, store erp_docname and flip queue_status → posted.

4) Gift vouchers (stored-value) with ledger

You need a current balance and an immutable audit trail.

-- Voucher heads
CREATE TABLE vouchers (
  voucher_code   TEXT PRIMARY KEY,    -- printed code / EAN
  issued_utc     TEXT NOT NULL,
  initial_value  NUMERIC NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  meta_json      TEXT                 -- purchaser, message, etc.
);

-- Movements (issue, redeem, adjust, expire)
CREATE TABLE voucher_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_code   TEXT NOT NULL REFERENCES vouchers(voucher_code),
  entry_utc      TEXT NOT NULL,
  type           TEXT NOT NULL,       -- 'issue'|'redeem'|'adjust'|'expire'|'refund'
  amount         NUMERIC NOT NULL,    -- redeem is negative
  sale_id        TEXT,                -- link redemption to a sale if applicable
  note           TEXT
);

-- Fast balance view (or materialize as a table if you prefer)
CREATE VIEW v_voucher_balance AS
SELECT v.voucher_code,
       v.active,
       v.issued_utc,
       v.initial_value + COALESCE(SUM(l.amount),0) AS balance
FROM vouchers v
LEFT JOIN voucher_ledger l ON l.voucher_code = v.voucher_code
GROUP BY v.voucher_code;

POS flow

Scan voucher → lookup v_voucher_balance.balance. If >= amount, allow. Insert a redeem ledger row atomically with the sale.

Refunds add a positive refund ledger row.

5) Offline queue and JSON backups

You already have sales.queue_status. Keep a tiny outbox, too:

CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,         -- 'sale'|'voucher' etc.
  ref_id        TEXT NOT NULL,         -- e.g., sale_id
  created_utc   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX idx_outbox_ready ON outbox(kind, attempts, created_utc);


Backups as JSON
At the end of day (or hourly), dump newline-delimited JSON for recent sales + voucher changes. Keep 30 days locally, rsync to your server.

Example file names:

pos_backup/sales_2025-11-06.ndjson

pos_backup/voucher_ledger_2025-11-06.ndjson

6) Read patterns for a buttery-smooth UI

Homescreen tiles (templates, featured, or bestsellers):

Precompute a small materialized table during sync or every N minutes.

Don’t constantly re-scan the big tables. Cache 50–200 rows in memory.

CREATE TABLE home_tiles (
  item_id      TEXT PRIMARY KEY,     -- template id
  name         TEXT,
  brand        TEXT,
  image_url    TEXT,
  sort_weight  INTEGER               -- higher shows first
);


Update home_tiles when:

you finish a catalog sync,

a manual pin/unpin happens,

or nightly: recompute from recent sale_lines to bubble up bestsellers.

Barcode scans & searches: always query SQLite live (it’s fast). Use prepared statements and indexes:

scan → barcodes PK lookup → items → views for price/image.

search → simple LIKE on a denormalized search_text column in items (name + brand + attributes flattened), indexed.

Stock badges: query stock live for just the displayed variants/template. No need to keep a big in-memory mirror.

Change notifications: on writes (new sale, stock decrement), update only the minimal UI state; don’t reload the whole catalog.

7) Concurrency & durability

Wrap an entire checkout in one transaction:

insert sales, sale_lines, payments,

reserve/decrement local stock,

voucher redemption ledger rows,

insert into outbox.

Commit once. If anything fails, roll back—customer doesn’t get charged twice.

With WAL mode, reads never block that write.

8) Syncing with ERPNext (push & pull)

Pull (catalog/stock/prices): by modified > last_cursor → upsert.

Push (sales/voucher ledger): pop outbox FIFO, POST to ERPNext; on success mark sale posted, remove outbox row.

Idempotent POSTs: include sale_id in a custom field on ERPNext Sales Invoice so retries don’t duplicate.

9) Indices you’ll care about

barcodes(barcode) PK

items(parent_id), items(is_template,active), items(search_text)

stock(warehouse,item_id)

sales(created_utc), sales(queue_status)

sale_lines(item_id)

vouchers(voucher_code) PK, voucher_ledger(voucher_code, entry_utc)

outbox(kind, attempts, created_utc)

10) Practical tuning

Keep receipts compact: numbers as strings, avoid giant base64 images; store only image URLs.

Periodically VACUUM (e.g., weekly) and ANALYZE.

If you run multiple tills, each till keeps its own SQLite; a tiny sync service aggregates to ERPNext to avoid db locks across machines.
