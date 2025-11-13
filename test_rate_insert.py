#!/usr/bin/env python3
import sqlite3
import sys

conn = sqlite3.connect('pos.db')
conn.execute('PRAGMA foreign_keys=ON')

# Check the schema
print("Current rates table schema:")
schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='rates'").fetchone()
if schema:
    print(schema[0])
else:
    print("Table does not exist!")
    sys.exit(1)

# Try to insert
print("\nAttempting to insert rate...")
try:
    conn.execute('''INSERT INTO rates (base_currency, target_currency, rate_to_base, last_updated)
                     VALUES (?,?,?,?)
                     ON CONFLICT(base_currency, target_currency) DO UPDATE SET
                         rate_to_base=excluded.rate_to_base,
                         last_updated=excluded.last_updated''', 
                  ('GBP', 'EUR', 1.1847, '2025-11-13T10:00:00Z'))
    conn.commit()
    print("✓ SUCCESS: Rate inserted/updated")
    
    row = conn.execute('SELECT * FROM rates WHERE base_currency=? AND target_currency=?', ('GBP', 'EUR')).fetchone()
    if row:
        print(f"✓ Verified in DB: base={row[0]}, target={row[1]}, rate={row[2]}, updated={row[3]}")
    else:
        print("✗ ERROR: Rate not found after insert!")
except Exception as e:
    print(f"✗ ERROR: {e}")
    import traceback
    traceback.print_exc()
finally:
    conn.close()
