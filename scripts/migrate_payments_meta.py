#!/usr/bin/env python3
"""
Migration: update payments table to new schema.
Renames 'amount' → 'amount_gbp', adds 'currency', 'amount_eur', 'eur_rate' columns.

Run: py scripts\migrate_payments_meta.py --db erp.db
"""
import argparse
import sqlite3

ap = argparse.ArgumentParser()
ap.add_argument("--db", default="erp.db")
args = ap.parse_args()

conn = sqlite3.connect(args.db)
cur = conn.cursor()

# Check columns
cur.execute("PRAGMA table_info(payments)")
cols = {r[1]: r for r in cur.fetchall()}

# If old schema (only 'amount'), migrate to new schema
if 'amount' in cols and 'amount_gbp' not in cols:
    print("Migrating payments table to new FX schema...")
    
    # Rename old table
    cur.execute("ALTER TABLE payments RENAME TO payments_old")
    
    # Create new table
    cur.execute("""
    CREATE TABLE payments (
      sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
      seq            INTEGER NOT NULL,
      method         TEXT NOT NULL,
      currency       TEXT DEFAULT 'GBP',
      amount_gbp     NUMERIC NOT NULL,
      amount_eur     NUMERIC,
      eur_rate       NUMERIC,
      ref            TEXT,
      meta_json      TEXT,
      PRIMARY KEY (sale_id, seq)
    )
    """)
    
    # Copy data from old table (assume old 'amount' was always GBP)
    cur.execute("""
    INSERT INTO payments (sale_id, seq, method, currency, amount_gbp, ref, meta_json)
    SELECT sale_id, seq, method, 'GBP', amount, ref, meta_json
    FROM payments_old
    """)
    
    # Drop old table
    cur.execute("DROP TABLE payments_old")
    
    # Recreate index
    cur.execute("CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method)")
    
    conn.commit()
    print("✓ Payments table migrated successfully")
else:
    print("Payments table already up-to-date or migration already applied")

conn.close()

