# Currency Conversion — Architecture & Flow Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (POS UI)                      │
├─────────────────────────────────────────────────────────────┤
│  - Cart / Checkout Interface                                │
│  - EUR Conversion Panel                                      │
│  - Real-time Conversion Display                              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ JSON/REST API
                     │
┌────────────────────▼────────────────────────────────────────┐
│                  Flask Server (pos_server.py)                │
├─────────────────────────────────────────────────────────────┤
│  GET  /api/currency/rates       ─────┐                       │
│  POST /api/currency/convert      ────┤→ Currency Functions  │
│  POST /api/currency/rates/update ────┘                       │
│  POST /api/create-sale (modified)                            │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼─────────────┐
        │            │             │
        ▼            ▼             ▼
   ┌─────────┐  ┌──────────┐  ┌──────────────┐
   │ pos_    │  │ External │  │ SQLite DB    │
   │service  │  │ Currency │  │              │
   │ functions│  │   API    │  │ - rates      │
   │         │  │(Fixer.io)│  │ - sales      │
   │         │  │          │  │ - payments   │
   └─────────┘  └──────────┘  └──────────────┘
        │
        └─→ Background Thread (Daily Rate Updates)
```

---

## Checkout Flow (Detailed)

```
┌─────────────────┐
│ Customer Item   │
│ Selection       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Cart Populated  │ ← Multiple items with quantities & rates
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ Cashier Selects Tender              │
│ Options: Cash | Card | Voucher      │
└────────┬────────────────────────────┘
         │
         ├─→ [Cash Selected]
         │        ▼
         │    ┌───────────────────────────┐
         │    │ Cash Section Appears      │
         │    │ + EUR Conversion Panel    │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ Cashier Enters Amount     │
         │    │ (Keyboard or Numpad)      │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ JavaScript Event:         │
         │    │ 'input' on cashInputField │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ updateEurConversion()     │
         │    │ Calls /api/currency/      │
         │    │ convert                   │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ EUR Conversion Panel      │
         │    │ Updates with:             │
         │    │ - Actual amount           │
         │    │ - Rounded amount          │
         │    │ - Rounded down amount     │
         │    │ - Savings display         │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ Cashier Chooses Option:   │
         │    │ [Use Rounded] or          │
         │    │ [Use Down]                │
         │    └───────┬───────────────────┘
         │            │
         │            ▼
         │    ┌──────────────────────────────────┐
         │    │ applyEurConversion(mode)         │
         │    │ Adds payment:                    │
         │    │ {                                │
         │    │   mode_of_payment: 'Cash (EUR)', │
         │    │   amount: <EUR_amount>,          │
         │    │   currency: 'EUR',               │
         │    │   currency_rate: 1.1847          │
         │    │ }                                │
         │    └───────┬────────────────────────┘
         │            │
         │            ▼
         │    ┌───────────────────────────┐
         │    │ Payment Applied           │
         │    │ Rendered in Payments List │
         │    │ eurConversionActive=true  │
         │    └───────┬───────────────────┘
         │            │
         └────────────┼──────────────────────┐
                      │                      │
                      ▼                      ▼
         ┌──────────────────┐  ┌──────────────────┐
         │ [Complete Sale]  │  │ [More Payments]  │
         │ Button           │  │ or [Modify]      │
         └────────┬─────────┘  └──────────────────┘
                  │
                  ▼
         ┌────────────────────────────────┐
         │ completeSaleFromOverlay()      │
         │                                │
         │ Builds payload with:           │
         │ - currency_used: 'EUR'         │
         │ - currency_rate_used: 1.1847   │
         │ - All payments (including      │
         │   EUR payment metadata)        │
         └────────┬─────────────────────┘
                  │
                  ▼
         ┌────────────────────────────────┐
         │ POST /api/create-sale          │
         │ (with currency metadata)       │
         └────────┬─────────────────────┘
                  │
                  ▼
         ┌────────────────────────────────┐
         │ Sale Created & Recorded        │
         │ - In invoices/ folder (JSON)   │
         │ - In SQLite DB (sales table)   │
         │ - Currency fields populated    │
         └────────┬─────────────────────┘
                  │
                  ▼
         ┌────────────────────────────────┐
         │ Receipt Printed                │
         │ Shows:                         │
         │ - Items                        │
         │ - Currency used (EUR)          │
         │ - Amount in EUR                │
         │ - Exchange rate (if relevant)  │
         └────────────────────────────────┘
```

---

## Data Flow: Currency Conversion

```
User Enters Amount
       │
       ▼
JavaScript Event (input)
       │
       ├──→ updateEurConversion(cashAmount)
       │         │
       │         ▼
       │    Fetch from Backend:
       │    POST /api/currency/convert
       │         {
       │           amount: 12.34,
       │           base: 'GBP',
       │           target: 'EUR',
       │           round_mode: 'nearest'
       │         }
       │         │
       │         ▼
       │    ┌──────────────────────┐
       │    │ pos_server.py        │
       │    │ api_convert_currency │
       │    └──────┬───────────────┘
       │           │
       │           ▼
       │    ┌──────────────────────┐
       │    │ pos_service.py       │
       │    │ get_currency_rate()  │
       │    └──────┬───────────────┘
       │           │
       │           ▼
       │    ┌──────────────────────┐
       │    │ SQLite Database      │
       │    │ SELECT rate_to_base  │
       │    │ FROM rates           │
       │    │ WHERE base='GBP'     │
       │    │   AND target='EUR'   │
       │    └──────┬───────────────┘
       │           │ Returns: 1.1847
       │           ▼
       │    ┌──────────────────────┐
       │    │ convert_currency()   │
       │    │                      │
       │    │ Calculations:        │
       │    │ actual = 12.34×1.1847│
       │    │        = 14.5708     │
       │    │ rounded = 14.55      │
       │    │ rounded_down = 14.55 │
       │    │ savings = 0.00       │
       │    └──────┬───────────────┘
       │           │
       │           ▼ Return JSON
       │    {
       │      actual: 14.57,
       │      rounded: 14.55,
       │      rounded_down: 14.55,
       │      rate: 1.1847,
       │      savings: 0.00
       │    }
       │
       └──→ updateEurConversionDisplay()
                  │
                  ▼
            Update DOM:
            - eurRate.textContent = '1.1847'
            - eurActual.textContent = '€ 14.57'
            - eurRounded.textContent = '€ 14.55'
            - eurRoundedDown.textContent = '€ 14.55'
            - eurConversionSection.style.display = 'block'
            - Button texts update with amounts
```

---

## Database Schema Relationships

```
┌──────────────────────────┐
│         rates            │
├──────────────────────────┤
│ base_currency (PK) ──────┤
│ target_currency (PK) ────┤
│ rate_to_base             │
│ last_updated             │
└──────────────────────────┘
          │
          └──→ Used by sales when currency_used='EUR'
               (to record which rate was applied)
               
┌──────────────────────────────────────────┐
│              sales                       │
├──────────────────────────────────────────┤
│ sale_id (PK)                             │
│ created_utc                              │
│ customer_id                              │
│ total                                    │
│ currency_used        ← NEW: 'GBP'/'EUR'  │
│ rate_used            ← NEW: 1.1847       │
│ pay_status           │
│ queue_status         │
│ erp_docname          │
│ payload_json         │
└──────────────────────────────────────────┘
          │ (1:N)
          ▼
┌──────────────────────────────────────────┐
│            payments                      │
├──────────────────────────────────────────┤
│ sale_id (FK) ────────────────────────────┤
│ seq (PK)                                 │
│ method                                   │
│ amount                                   │
│ ref                                      │
│ [currency] (optional)                    │
│ [currency_rate] (optional)               │
└──────────────────────────────────────────┘
```

---

## API Call Sequence

```
┌─────────────────────────────────────────────────────────────┐
│ Browser                                                      │
└─────────────┬───────────────────────────────────────────────┘
              │
              │ 1. POST /api/currency/convert
              │    {amount: 12.34, ...}
              ▼
┌─────────────────────────────────────────────────────────────┐
│ Flask Server (pos_server.py)                                │
│ api_convert_currency()                                      │
└─────────────┬───────────────────────────────────────────────┘
              │
              │ 2. Call ps.get_currency_rate()
              ▼
┌─────────────────────────────────────────────────────────────┐
│ pos_service.py                                              │
│ get_currency_rate(conn, 'GBP', 'EUR')                       │
└─────────────┬───────────────────────────────────────────────┘
              │
              │ 3. SQL Query
              │    SELECT rate_to_base FROM rates
              │    WHERE base_currency='GBP' AND
              │          target_currency='EUR'
              ▼
┌─────────────────────────────────────────────────────────────┐
│ SQLite Database                                             │
│ rates table                                                 │
└─────────────┬───────────────────────────────────────────────┘
              │
              │ 4. Return: 1.1847
              ▼
┌─────────────────────────────────────────────────────────────┐
│ ps.convert_currency(12.34, 1.1847, 'nearest')              │
│ → Returns: {actual: 14.57, rounded: 14.55, ...}            │
└─────────────┬───────────────────────────────────────────────┘
              │
              │ 5. JSON Response
              │    {status: 'success', conversion: {...}}
              ▼
┌─────────────────────────────────────────────────────────────┐
│ Browser: updateEurConversionDisplay()                       │
│ → Updates DOM with conversion data                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Background Rate Update Process

```
Server Startup
      │
      ▼
app.run(...)
      │
      ▼
_ensure_currency_updater()
      │
      ├─→ ps.schedule_currency_rate_update(
      │       base='GBP',
      │       target='EUR',
      │       interval_seconds=86400
      │   )
      │      │
      │      ▼
      │   Spawn Thread (daemon=True)
      │      │
      │      └─→ While True:
      │             │
      │             ├─ Sleep 86400s
      │             │
      │             ├─ Connect to DB
      │             │
      │             ├─ Call ps.update_currency_rate()
      │             │       │
      │             │       ▼
      │             │   ps.fetch_currency_rate()
      │             │       │
      │             │       ├─ HTTP GET to API
      │             │       │  (e.g., Fixer.io)
      │             │       │
      │             │       ├─ Parse JSON
      │             │       │
      │             │       └─ Return rate or None
      │             │
      │             ├─ If rate received:
      │             │   INSERT/UPDATE rates table
      │             │   WITH rate, timestamp
      │             │
      │             └─ Log success or error
      │
      └─→ Main server continues normally
             (Background thread doesn't block)
```

---

## Error Handling Flow

```
User Interaction or API Call
      │
      ▼
   ┌──────────────┐
   │ Try to fetch │
   │ conversion   │
   └──────┬───────┘
          │
    ┌─────┴─────┐
    │           │
    ▼ Success   ▼ Failure
 [Display]   [Check Error]
    │           │
    │           ├─→ API Key Missing
    │           │   └─→ Log warning
    │           │   └─→ Hide EUR panel
    │           │
    │           ├─→ Rate Not in DB
    │           │   └─→ Return 404
    │           │   └─→ UI shows error
    │           │
    │           ├─→ Network Error
    │           │   └─→ Use cached rate
    │           │   └─→ or return cached
    │           │
    │           └─→ Invalid Input
    │               └─→ Return 400
    │               └─→ UI validation
    │
    ▼
Continue POS Operation
(Currency features optional)
```

---

## Rounding Logic Flowchart

```
Amount in GBP (e.g., 12.34)
      │
      ▼
Multiply by Rate
(12.34 × 1.1847 = 14.5708)
      │
      ▼
actual ← 14.5708
      │
      ├──────────┬──────────┬──────────┐
      │          │          │          │
      ▼          ▼          ▼          ▼
   round_mode='nearest' | 'down' | 'none'
      │          │          │          │
      ├──→ rounded ← ┘      │          │
      │             round_to_nearest_5│
      │             (14.5708 → 14.55) │
      │                      │         │
      │                      ▼         │
      │                rounded ← 14.55 │
      │                      │         │
      ├──→ rounded_down ← ──┤         │
      │         round_down_to_nearest_5│
      │         (14.5708 → 14.55)     │
      │                      │         │
      │                      ▼         │
      │              rounded_down ← 14.55
      │                      │
      ├──→ savings ← │────────┘
      │        = rounded - rounded_down
      │        = 14.55 - 14.55
      │        = 0.00
      │
      ▼
Return {
  actual: 14.57,
  rounded: 14.55,
  rounded_down: 14.55,
  rate: 1.1847,
  savings: 0.00
}
```

---

## Deployment Topology (Production)

```
┌───────────────────────────────────────────────────────────┐
│                    Internet                               │
│  (Currency API - Fixer.io, etc.)                          │
└───────────────────────────┬───────────────────────────────┘
                            │
                            │ HTTPS
                            │
        ┌───────────────────▼───────────────────┐
        │   Flask Server (pos_server.py)        │
        │   + pos_service.py functions          │
        │   + Background updater thread         │
        └───────────────┬───────────────────────┘
                        │
        ┌───────────────┴───────────────────┐
        │                                   │
        ▼                                   ▼
    ┌────────────┐              ┌──────────────────┐
    │  SQLite DB │              │ Local File Cache │
    │  (rates,   │              │ (invoices/, etc) │
    │  sales)    │              └──────────────────┘
    └────────────┘
        │
        │ (Sync Worker)
        ▼
    ┌────────────────┐
    │  ERPNext Server│
    │  (optional)    │
    └────────────────┘
```

---

## Summary

The currency conversion system follows a clean, modular design:

1. **Backend:** pos_service.py handles all currency logic
2. **API Layer:** pos_server.py exposes REST endpoints
3. **Database:** SQLite stores rates and currency metadata
4. **Frontend:** JavaScript provides real-time UI updates
5. **Background:** Daemon thread keeps rates fresh
6. **Integration:** Currency data flows through to sales records

All components are loosely coupled and can be extended or replaced independently.
