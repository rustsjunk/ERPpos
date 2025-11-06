
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

-- Core catalog (templates + variants in one table)
CREATE TABLE IF NOT EXISTS items (
  item_id        TEXT PRIMARY KEY,                -- ERPNext name/item_code
  parent_id      TEXT REFERENCES items(item_id),  -- NULL for templates
  name           TEXT NOT NULL,
  brand          TEXT,
  attributes     TEXT,                            -- JSON: {"Size":"8","Color":"Black"}
  price          NUMERIC,                         -- variant price; NULL = inherit
  image_url      TEXT,                            -- variant image; NULL = inherit
  is_template    INTEGER NOT NULL DEFAULT 0,      -- 1 template / 0 variant
  active         INTEGER NOT NULL DEFAULT 1,
  modified_utc   TEXT
);

-- Many barcodes per item (EAN/UPC, internal, Shopify, supplier, etc.)
CREATE TABLE IF NOT EXISTS barcodes (
  barcode   TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(item_id)
);

-- Local stock cache (per warehouse if you need it)
CREATE TABLE IF NOT EXISTS stock (
  item_id    TEXT NOT NULL REFERENCES items(item_id),
  warehouse  TEXT NOT NULL DEFAULT 'Shop',
  qty        NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, warehouse)
);

-- Inheritance views
DROP VIEW IF EXISTS v_item_images;
CREATE VIEW v_item_images AS
SELECT
  v.item_id,
  COALESCE(v.image_url, t.image_url) AS image_url_effective
FROM items v
LEFT JOIN items t ON t.item_id = v.parent_id;

DROP VIEW IF EXISTS v_item_prices;
CREATE VIEW v_item_prices AS
SELECT
  v.item_id,
  COALESCE(v.price, t.price) AS price_effective
FROM items v
LEFT JOIN items t ON t.item_id = v.parent_id;

-- Sales: header, lines, payments
CREATE TABLE IF NOT EXISTS sales (
  sale_id        TEXT PRIMARY KEY,        -- UUID v4
  created_utc    TEXT NOT NULL,           -- ISO8601
  cashier        TEXT,
  customer_id    TEXT,
  subtotal       NUMERIC NOT NULL,
  tax            NUMERIC NOT NULL,
  discount       NUMERIC NOT NULL DEFAULT 0,
  total          NUMERIC NOT NULL,
  pay_status     TEXT NOT NULL,           -- 'paid'|'partially_paid'|'refunded'
  queue_status   TEXT NOT NULL,           -- 'queued'|'posting'|'posted'|'failed'
  erp_docname    TEXT,
  payload_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_lines (
  sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,
  item_id        TEXT NOT NULL,
  item_name      TEXT NOT NULL,
  brand          TEXT,
  attributes     TEXT,
  qty            NUMERIC NOT NULL,
  rate           NUMERIC NOT NULL,
  line_total     NUMERIC NOT NULL,
  barcode_used   TEXT,
  PRIMARY KEY (sale_id, line_no)
);

CREATE TABLE IF NOT EXISTS payments (
  sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  method         TEXT NOT NULL,           -- 'Cash'|'Card'|'Voucher'|'GiftCard'|'StoreCredit'
  amount         NUMERIC NOT NULL,
  ref            TEXT,
  PRIMARY KEY (sale_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_utc);
CREATE INDEX IF NOT EXISTS idx_sales_erpstatus ON sales(queue_status, created_utc);
CREATE INDEX IF NOT EXISTS idx_lines_item ON sale_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);

-- Gift vouchers with ledger
CREATE TABLE IF NOT EXISTS vouchers (
  voucher_code   TEXT PRIMARY KEY,    -- printed code / EAN
  issued_utc     TEXT NOT NULL,
  initial_value  NUMERIC NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  meta_json      TEXT
);

CREATE TABLE IF NOT EXISTS voucher_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_code   TEXT NOT NULL REFERENCES vouchers(voucher_code),
  entry_utc      TEXT NOT NULL,
  type           TEXT NOT NULL,       -- 'issue'|'redeem'|'adjust'|'expire'|'refund'
  amount         NUMERIC NOT NULL,    -- redeem is negative
  sale_id        TEXT,
  note           TEXT
);

DROP VIEW IF EXISTS v_voucher_balance;
CREATE VIEW v_voucher_balance AS
SELECT v.voucher_code,
       v.active,
       v.issued_utc,
       v.initial_value + COALESCE(SUM(l.amount),0) AS balance
FROM vouchers v
LEFT JOIN voucher_ledger l ON l.voucher_code = v.voucher_code
GROUP BY v.voucher_code;

-- Outbox for ERPNext posting and other sync ops
CREATE TABLE IF NOT EXISTS outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,         -- 'sale'|'voucher'
  ref_id        TEXT NOT NULL,         -- e.g., sale_id
  created_utc   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox(kind, attempts, created_utc);

-- Optional: home screen cache for tiles
CREATE TABLE IF NOT EXISTS home_tiles (
  item_id      TEXT PRIMARY KEY,     -- template id
  name         TEXT,
  brand        TEXT,
  image_url    TEXT,
  sort_weight  INTEGER
);


-- Incremental sync cursors (per ERPNext doctype)
CREATE TABLE IF NOT EXISTS sync_cursors (
  doctype      TEXT PRIMARY KEY,   -- e.g., 'Item', 'Item Price', 'Bin', 'Item Barcode'
  last_modified TEXT,              -- server-side ISO timestamp
  last_name     TEXT               -- tiebreaker (docname) to handle equal modified times
);
