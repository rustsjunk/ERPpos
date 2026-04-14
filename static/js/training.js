/* =========================================================
   Training Wheels — guided cashier onboarding engine
   Levels:
     0  Off
     1  Pulsing highlight on the next button only
     2  Level 1 + floating hint labels beside key buttons
     3  Level 2 + guide panel with full transaction-type flow:
        — 6-type picker at start (Sale / Return / Layaway /
          Layaway Payment / Gift Voucher / Search)
        — Step-by-step guidance tailored to the chosen type
        — Inline decision questions at each decision point
        — No automatic actions — guide only highlights & advises
   ========================================================= */
'use strict';

(function () {

  // -------------------------------------------------------
  // State
  // -------------------------------------------------------
  let level        = 0;
  let currentStep  = 'idle';
  let txnType      = null;       // 'sale'|'return'|'layaway'|'layaway_payment'|'voucher_sale'|'search'|null
  let returnLoaded = false;      // true once return overlay has been visited
  let returnPath   = null;       // 'receipt'|'manual' — chosen in idle_return picker
  let highlightedEls  = [];
  let activeHints     = [];
  let stepCompleteTimer = null;

  // -------------------------------------------------------
  // Step → highlighted elements  (levels 1, 2, 3)
  // Keyed by step name; for idle the key is 'idle_<txnType>'
  // so applyHighlights() looks up the merged key where needed.
  // -------------------------------------------------------
  const HIGHLIGHTS = {
    // ── idle variants ────────────────────────────────────────
    idle:                  ['#itemSearch', '#barcodeInput'],   // fallback
    idle_sale:             ['#itemSearch', '#barcodeInput'],
    idle_return:           ['#returnFromReceiptBtn', '#itemSearch'],
    idle_layaway:          ['#itemSearch', '#barcodeInput'],
    idle_layaway_payment:  ['#layawayStoreBtn'],
    idle_voucher_sale:     ['#voucherSaleBtn'],
    idle_search:           ['#itemSearch', '#barcodeInput'],
    // ── cart ─────────────────────────────────────────────────
    cart_ready:            ['#checkoutBtn'],
    cart_ready_sale:       ['#mainDiscountBtn', '#mainBagBtn', '#checkoutBtn'],
    cart_ready_layaway:    ['#checkoutBtn'],
    cart_ready_return:     ['#checkoutBtn'],
    // ── checkout / payment ───────────────────────────────────
    checkout_open:         ['.tender-grid', '#checkoutReturnBtn', '.checkout-refund-btn'],
    checkout_open_layaway: ['#putOnLayawayBtn'],
    tender_cash:           ['#cashSection'],
    tender_card:           ['#otherSection'],
    tender_voucher:        ['#voucherOverlay', '#tenderVoucherBtn'],
    tender_discount:       ['#discountItemsList', '#discountValueInput'],
    tender_eur:            ['#eurConverterOverlay'],
    payment_partial:       ['#completeSaleBtn'],
    payment_ready:         ['#completeSaleBtn'],
    complete:              [],
    // ── return sub-steps ─────────────────────────────────────
    return_receipt:        ['#returnFromReceiptBtn'],
    return_open:           ['#returnScanInput', '#returnFindBtn', '#returnLoadBtn'],
    return_manual:         ['#itemSearch', '#barcodeInput'],
    // ── layaway sub-steps ────────────────────────────────────
    layaway_customer:      ['#layawayCustomerInput', '#layawayCustomerNextBtn'],
    layaway_payment_q:     ['#layawayPaymentConfirmBtn'],
    layaway_done:          [],
    // ── layaway payment sub-steps ────────────────────────────
    layaway_pay_list:      ['#layawayStoreList'],
    layaway_pay_amount:    ['#layawayDepositInput', '#layawayMethodBtns'],
    layaway_pay_confirm:   ['#layawayPaymentConfirmBtn'],
    layaway_pay_done:      [],
    // ── voucher sale ─────────────────────────────────────────
    voucher_sale_open:     ['#voucherAmountInput', '#voucherSubmitBtn'],
  };

  // -------------------------------------------------------
  // Level 2 — hint pill definitions per step
  // -------------------------------------------------------
  const HINTS = {
    idle: [
      { sel: '#itemSearch',   text: 'Search for a product here',   place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan / type a barcode',    place: 'right' },
    ],
    idle_sale: [
      { sel: '#itemSearch',   text: 'Search for a product here',   place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan / type a barcode',    place: 'right' },
    ],
    idle_return: [
      { sel: '#returnFromReceiptBtn', text: 'Preferred: return by receipt', place: 'below' },
      { sel: '#itemSearch',           text: 'Or search for the item',       place: 'right' },
    ],
    idle_layaway: [
      { sel: '#itemSearch',   text: 'Search for items to put on layaway', place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan a barcode',                   place: 'right' },
    ],
    idle_layaway_payment: [
      { sel: '#layawayStoreBtn', text: 'Open the Layaway store here', place: 'below' },
    ],
    idle_voucher_sale: [
      { sel: '#voucherSaleBtn', text: 'Issue a gift voucher here', place: 'below' },
    ],
    idle_search: [
      { sel: '#itemSearch',   text: 'Search by name or style code', place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan a barcode',            place: 'right' },
    ],
    cart_ready: [
      { sel: '#checkoutBtn', text: 'Tap to begin payment →', place: 'above' },
    ],
    cart_ready_sale: [
      { sel: '#mainDiscountBtn', text: 'Apply a discount?',    place: 'above' },
      { sel: '#mainBagBtn',      text: 'Add a bag charge?',    place: 'above' },
      { sel: '#checkoutBtn',     text: 'Tap to begin payment', place: 'above' },
    ],
    cart_ready_layaway: [
      { sel: '#checkoutBtn', text: 'Tap to go to layaway →', place: 'above' },
    ],
    checkout_open: [
      { sel: '[data-tender="cash"]',    text: 'Notes & coins',        place: 'below' },
      { sel: '[data-tender="card"]',    text: 'Debit / credit card',  place: 'below' },
      { sel: '[data-tender="voucher"]', text: 'Gift voucher',         place: 'below' },
      { sel: '#openDiscountBtn',        text: 'Any discount?',        place: 'right' },
      { sel: '#convertToEuroBtn',       text: 'Customer paying in €', place: 'above' },
      { sel: '#checkoutReturnBtn',      text: 'Return from receipt',  place: 'above' },
      { sel: '#completeSaleBtn',        text: 'Finish transaction',   place: 'left'  },
    ],
    checkout_open_layaway: [
      { sel: '#putOnLayawayBtn', text: 'Tap to save as layaway', place: 'above' },
    ],
    return_receipt: [
      { sel: '#returnFromReceiptBtn', text: 'Tap to open receipt scanner', place: 'below' },
    ],
    return_open: [
      { sel: '#returnScanInput', text: 'Enter or scan the receipt ID', place: 'right' },
      { sel: '#returnFindBtn',   text: 'Tap to look up the receipt',   place: 'above' },
      { sel: '#returnLoadBtn',   text: 'Select items then load return', place: 'above' },
    ],
    return_manual: [
      { sel: '#itemSearch',   text: 'Search for the item to return', place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan its barcode',            place: 'right' },
    ],
    layaway_customer: [
      { sel: '#layawayCustomerInput',   text: 'Enter customer name here',  place: 'right' },
      { sel: '#layawayCustomerNextBtn', text: 'Tap to proceed',            place: 'above' },
    ],
    layaway_payment_q: [
      { sel: '#layawayPaymentConfirmBtn', text: 'Confirm when ready', place: 'above' },
    ],
    layaway_pay_list: [
      { sel: '#layawayStoreList', text: 'Select the customer layaway', place: 'right' },
    ],
    layaway_pay_amount: [
      { sel: '#layawayDepositInput', text: 'Enter payment amount', place: 'right' },
      { sel: '#layawayMethodBtns',   text: 'Choose payment method', place: 'above' },
    ],
    layaway_pay_confirm: [
      { sel: '#layawayPaymentConfirmBtn', text: 'Tap to take payment', place: 'above' },
    ],
    voucher_sale_open: [
      { sel: '#voucherAmountInput', text: 'Enter voucher value', place: 'right' },
      { sel: '#voucherSubmitBtn',   text: 'Then issue here',      place: 'left'  },
    ],
    tender_cash: [
      { sel: '#cashInputField',  text: 'Enter cash amount given', place: 'right' },
      { sel: '#applyCashBtn',    text: 'Then tap here',           place: 'above' },
    ],
    tender_card: [
      { sel: '#otherAmountInput',   text: 'Enter card amount',    place: 'right' },
      { sel: '#otherFullAmountBtn', text: 'Or fill remaining',    place: 'above' },
      { sel: '#applyOtherBtn',      text: 'Then tap here',        place: 'above' },
    ],
    tender_voucher: [
      { sel: '#voucherCodeInput', text: 'Scan or type voucher code', place: 'right' },
      { sel: '#voucherSubmitBtn', text: 'Then tap here',             place: 'left'  },
    ],
    tender_eur: [
      { sel: '#eurOverlayGbpTotal', text: 'GBP total to collect',      place: 'right' },
      { sel: '#eurOverlayExact',    text: 'Exact EUR equivalent',       place: 'right' },
      { sel: '#eurOverlayRoundUp',  text: 'Rounded up — easier change', place: 'right' },
    ],
    tender_discount: [
      { sel: '#discountItemsList',  text: 'Tap items to discount',   place: 'right' },
      { sel: '#discModePercent',    text: 'Or choose % off',         place: 'right' },
      { sel: '#discountValueInput', text: 'Enter the discount value', place: 'right' },
      { sel: '#discountCloseBtn',   text: 'Done — applies to cart',  place: 'left'  },
    ],
    payment_partial: [
      { sel: '.tender-grid', text: 'Add another payment method for the rest', place: 'above' },
    ],
    payment_ready: [
      { sel: '#completeSaleBtn', text: '✓ All paid — tap to complete!', place: 'left' },
    ],
  };

  // -------------------------------------------------------
  // Helpers
  // -------------------------------------------------------
  function focusEl(sel) {
    try { const el = document.querySelector(sel); if (el) el.focus(); } catch (_) {}
  }

  function highlightOne(sel) {
    clearHighlights();
    try {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (el) { el.classList.add('training-highlight'); highlightedEls.push(el); }
    } catch (_) {}
  }

  function highlightMany(sels) {
    clearHighlights();
    (sels || []).forEach(sel => {
      try {
        const el = document.querySelector(sel);
        if (el) { el.classList.add('training-highlight'); highlightedEls.push(el); }
      } catch (_) {}
    });
  }

  // -------------------------------------------------------
  // Sub-guide helpers — show guidance + swap highlights
  // without changing currentStep (mirror of showTenderGuide)
  // -------------------------------------------------------

  // Called from PRETENDER entries (payment tender buttons)
  const PRETENDER = {
    cash: {
      highlightSels: ['[data-tender="cash"]'],
      title: 'Cash payment',
      body:  'Count the cash the customer hands over. Now click the highlighted <strong>Cash</strong> button on screen to open the cash entry section.',
    },
    card: {
      highlightSels: ['[data-tender="card"]'],
      title: 'Card payment',
      body:  'Process the payment on the card terminal <em>first</em>, then click the highlighted <strong>Card</strong> button on screen to record the amount.',
    },
    voucher: {
      highlightSels: ['[data-tender="voucher"]', '#tenderVoucherBtn'],
      title: 'Gift voucher',
      body:  'Ask the customer for their voucher. Click the highlighted <strong>Voucher</strong> button on screen to open the voucher entry.',
    },
    eur: {
      highlightSels: ['#convertToEuroBtn'],
      title: 'Euro payment',
      body:  'The system converts the total to euros at today\'s rate and offers rounding options. Click the highlighted <strong>€ Euro</strong> button on screen to open the converter.',
    },
  };

  function showTenderGuide(type) {
    const cfg = PRETENDER[type];
    if (!cfg) return;
    highlightMany(cfg.highlightSels);
    _renderPanel(cfg.title, cfg.body, [
      { label: '← Back to payment types', style: 'outline', fn: () => { applyHighlights(currentStep); showGuidePanel(currentStep); } },
    ]);
  }

  // Discount sub-guide (called from cart_ready_sale)
  function showDiscountSubGuide() {
    highlightMany(['#mainDiscountBtn']);
    _renderPanel(
      'Applying a discount',
      '<ol><li>Click the highlighted <strong>Discount</strong> button.</li><li>Tap the items you want to discount (all pre-selected).</li><li>Choose type: <strong>£ Off</strong>, <strong>% Off</strong>, or <strong>Set Price</strong>.</li><li>Enter the value and tap <strong>Apply</strong>.</li><li>Tap <strong>Done</strong> when finished.</li></ol>',
      [
        { label: '← Back to cart', style: 'outline', fn: () => { applyHighlights(currentStep); showGuidePanel(currentStep); } },
      ]
    );
  }

  // Layaway deposit method sub-guide
  function showLayawayDepositGuide(method) {
    const labels = { cash: 'Cash', card: 'Card', voucher: 'Voucher' };
    const sels   = { cash: ['.lay-method-btn[data-method="cash"]', '#layawayDepositInput'],
                     card: ['.lay-method-btn[data-method="card"]', '#layawayDepositInput'],
                     voucher: ['.lay-method-btn[data-method="voucher"]', '#layawayDepositInput'] };
    highlightMany(sels[method] || []);
    _renderPanel(
      `Deposit — ${labels[method] || method}`,
      `Click the highlighted <strong>${labels[method]}</strong> method button, enter the deposit amount, then tap <strong>Confirm Layaway</strong>.`,
      [
        { label: '← Back', style: 'outline', fn: () => { applyHighlights(currentStep); showGuidePanel(currentStep); } },
        { label: 'Confirm Layaway →', style: 'primary', fn: () => highlightMany(['#layawayPaymentConfirmBtn']) },
      ]
    );
  }

  // Layaway payment method sub-guide (for paying off an existing layaway)
  function showLayawayPayMethodGuide(method) {
    const labels = { cash: 'Cash', card: 'Card', voucher: 'Voucher' };
    highlightMany([`.lay-method-btn[data-method="${method}"]`, '#layawayDepositInput']);
    _renderPanel(
      `Payment — ${labels[method] || method}`,
      `Click the highlighted <strong>${labels[method]}</strong> method, enter the amount, then tap <strong>Confirm Layaway</strong>.`,
      [
        { label: '← Back', style: 'outline', fn: () => setStep('layaway_pay_amount') },
        { label: 'Confirm →', style: 'primary', fn: () => setStep('layaway_pay_confirm') },
      ]
    );
  }

  // -------------------------------------------------------
  // Level 3 — Guide panel content
  // -------------------------------------------------------
  const GUIDE = {

    // ── Transaction type picker ───────────────────────────
    idle_null: {
      title: 'What type of transaction?',
      body:  'Choose below to get step-by-step guidance tailored to the transaction.',
      actionsClass: 'tgp-actions-picker',
      actions: [
        { icon: '🛒', label: 'Sale',              style: 'primary', fn: () => chooseTxnType('sale')            },
        { icon: '↩️', label: 'Return / Exchange', style: 'outline', fn: () => chooseTxnType('return')          },
        { icon: '📦', label: 'Layaway',            style: 'outline', fn: () => chooseTxnType('layaway')         },
        { icon: '💳', label: 'Layaway Payment',    style: 'outline', fn: () => chooseTxnType('layaway_payment') },
        { icon: '🎁', label: 'Gift Voucher',        style: 'outline', fn: () => chooseTxnType('voucher_sale')   },
        { icon: '🔍', label: 'Search / Browse',    style: 'outline', fn: () => chooseTxnType('search')         },
      ],
    },

    // ── Sale ─────────────────────────────────────────────
    idle_sale: {
      title: 'Step 1 — Add items to the cart',
      body:  'Scan a barcode or use the <strong>search box</strong> to find a product by name, barcode, or style code. Tap any item to open its size matrix and add a variant to the cart.',
    },

    cart_ready_sale: {
      title: 'Step 2 — Before checkout',
      body:  'Take a moment to check the cart. You can apply a discount, add a bag charge, or go straight to checkout.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💸', label: 'Apply Discount', style: 'outline', fn: () => showDiscountSubGuide() },
        { icon: '🛍️', label: '+ Add Bag',      style: 'outline', fn: () => { highlightMany(['#mainBagBtn']); _renderPanel('Plastic bag charge', 'Click the highlighted <strong>+ Bag</strong> button to add the bag charge to this sale.', [{ label: '← Back', style: 'outline', fn: () => { applyHighlights('cart_ready_sale'); showGuidePanel('cart_ready_sale'); } }]); } },
        { icon: '✅', label: 'Checkout →',     style: 'primary', fn: () => highlightMany(['#checkoutBtn']) },
      ],
    },

    // ── Return ───────────────────────────────────────────
    idle_return: {
      title: 'Step 1 — How would you like to process the return?',
      body:  '<strong>Receipt scan</strong> is the fastest method — it loads all original items automatically. Use <strong>Manual</strong> if no receipt is available.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '↩️', label: '↩ By Receipt',    style: 'primary', fn: () => { returnPath = 'receipt'; setStep('return_receipt'); } },
        { icon: '🔍', label: 'Manual — no receipt', style: 'outline', fn: () => { returnPath = 'manual'; setStep('return_manual'); } },
      ],
    },

    return_receipt: {
      title: 'Step 2 — Scan the original receipt',
      body:  'Click the highlighted <strong>↩ Return by Receipt</strong> button in the top bar. This opens the receipt scanner where you can find the original transaction.',
      actions: [
        { icon: '↩️', label: '↩ Return by Receipt', style: 'primary', fn: () => highlightMany(['#returnFromReceiptBtn']) },
      ],
    },

    return_open: {
      title: 'Step 3 — Find and load the receipt',
      body:  '<ol><li>Scan the receipt barcode <em>or</em> type the receipt ID into the box.</li><li>Tap <strong>Find</strong> to locate the transaction.</li><li>The original items appear as cards — tap any to deselect it.</li><li>Tap <strong>Load As Return</strong> to add the selected items to the cart as refunds.</li></ol>',
      actions: [
        { icon: '🔍', label: 'Find →',           style: 'primary', fn: () => highlightMany(['#returnFindBtn']) },
        { icon: '↩️', label: 'Load As Return →', style: 'outline', fn: () => highlightMany(['#returnLoadBtn']) },
      ],
    },

    return_manual: {
      title: 'Step 2 — Add the item to the cart',
      body:  'Search for or scan the item being returned. Add it to the cart as normal, then tap <strong>Checkout</strong>. At checkout you can mark individual items as refunds using the refund toggle.',
      actions: [
        { icon: '✅', label: 'Checkout when ready →', style: 'primary', fn: () => highlightMany(['#checkoutBtn']) },
      ],
    },

    cart_ready_return: {
      title: 'Step 3 — Return items loaded',
      body:  'Refund lines are in the cart. Check quantities, then tap <strong>Checkout</strong> to process the refund.',
      actions: [
        { icon: '↩️', label: 'Process Refund →', style: 'primary', fn: () => highlightMany(['#checkoutBtn']) },
      ],
    },

    // ── Search ───────────────────────────────────────────
    idle_search: {
      title: 'Searching & browsing',
      body:  'Use the <strong>search box</strong> to find products by name, barcode, or style code. Tap any result to see its full size matrix, stock levels, and price.',
    },

    // ── Layaway ──────────────────────────────────────────
    idle_layaway: {
      title: 'Step 1 — Add items to put on layaway',
      body:  'Scan or search for the items the customer wants to reserve. Add them to the cart as normal — you\'ll confirm the layaway on the checkout screen.',
    },

    cart_ready_layaway: {
      title: 'Step 2 — Review the cart',
      body:  'Check the items are correct, then tap <strong>Checkout</strong> to proceed to the layaway confirmation.',
      actions: [
        { icon: '✅', label: 'Checkout →', style: 'primary', fn: () => highlightMany(['#checkoutBtn']) },
      ],
    },

    checkout_open_layaway: {
      title: 'Step 3 — Put items on layaway',
      body:  'Tap the highlighted <strong>Put on Layaway</strong> button to begin the layaway process.',
      actions: [
        { icon: '📦', label: 'Put on Layaway →', style: 'primary', fn: () => highlightMany(['#putOnLayawayBtn']) },
      ],
    },

    layaway_customer: {
      title: 'Step 4 — Enter customer details',
      body:  'Type the customer\'s name in the highlighted field (e.g. <em>Smith, Jane</em>), then tap <strong>Next: Payment</strong>.',
      actions: [
        { icon: '➡️', label: 'Next: Payment →', style: 'primary', fn: () => highlightMany(['#layawayCustomerNextBtn']) },
      ],
    },

    layaway_payment_q: {
      title: 'Step 5 — Deposit payment',
      body:  'Is the customer making a deposit payment today? Choose a method or skip to confirm the layaway without a deposit.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash deposit',    style: 'primary', fn: () => showLayawayDepositGuide('cash')    },
        { icon: '💳', label: 'Card deposit',    style: 'outline', fn: () => showLayawayDepositGuide('card')    },
        { icon: '🏷️', label: 'Voucher deposit', style: 'outline', fn: () => showLayawayDepositGuide('voucher') },
        { icon: '✅', label: 'No deposit — confirm', style: 'outline', fn: () => highlightMany(['#layawayPaymentConfirmBtn']) },
      ],
    },

    layaway_done: {
      title: '✅ Layaway saved',
      body:  'The layaway has been recorded. Hand the customer their receipt and let them know the item is reserved under their name in the Layaway store.',
    },

    // ── Layaway Payment ──────────────────────────────────
    idle_layaway_payment: {
      title: 'Step 1 — Open the Layaway store',
      body:  'Click the highlighted <strong>Layaway</strong> button in the top bar to open the list of active layaways.',
      actions: [
        { icon: '📦', label: 'Open Layaway →', style: 'primary', fn: () => highlightMany(['#layawayStoreBtn']) },
      ],
    },

    layaway_pay_list: {
      title: 'Step 2 — Select the customer',
      body:  'Find the customer\'s name in the list and tap their layaway record to open the payment screen.',
    },

    layaway_pay_amount: {
      title: 'Step 3 — Choose payment method',
      body:  'Select how the customer is paying, then enter the amount.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash',    style: 'primary', fn: () => showLayawayPayMethodGuide('cash')    },
        { icon: '💳', label: 'Card',    style: 'outline', fn: () => showLayawayPayMethodGuide('card')    },
        { icon: '🏷️', label: 'Voucher', style: 'outline', fn: () => showLayawayPayMethodGuide('voucher') },
      ],
    },

    layaway_pay_confirm: {
      title: 'Step 4 — Take the payment',
      body:  'Confirm the amount is correct, then tap <strong>Confirm Layaway</strong> to record the payment.',
      actions: [
        { icon: '✅', label: 'Confirm Layaway →', style: 'primary', fn: () => highlightMany(['#layawayPaymentConfirmBtn']) },
      ],
    },

    layaway_pay_done: {
      title: '✅ Payment recorded',
      body:  'The layaway balance has been updated. Hand the customer their receipt.',
    },

    // ── Gift Voucher ─────────────────────────────────────
    idle_voucher_sale: {
      title: 'Step 1 — Start a gift voucher sale',
      body:  'Click the highlighted <strong>Gift Voucher</strong> button to open the voucher issuance screen.',
      actions: [
        { icon: '🎁', label: 'Gift Voucher →', style: 'primary', fn: () => highlightMany(['#voucherSaleBtn']) },
      ],
    },

    voucher_sale_open: {
      title: 'Step 2 — Issue the voucher',
      body:  'Enter the <strong>voucher amount</strong> the customer is purchasing. Then take their payment and click <strong>Issue Voucher</strong> to generate and print it.',
      actions: [
        { icon: '✅', label: 'Issue Voucher →', style: 'primary', fn: () => highlightMany(['#voucherSubmitBtn']) },
      ],
    },

    // ── Checkout: return receipt load (existing) ─────────
    checkout_open_return_load: {
      title: 'Step 3 — Return from receipt',
      body:  'Tap the highlighted <strong>↩ Return</strong> button to scan the customer\'s receipt. This loads all original items automatically — select the ones being returned, then tap <strong>Load As Return</strong>.',
      actions: [
        { icon: '↩️', label: '↩ Tap Return from Receipt', style: 'primary', fn: () => highlightMany(['#checkoutReturnBtn']) },
      ],
    },

    // ── Checkout: payment picker ─────────────────────────
    checkout_open_pay: {
      title: 'How is the customer paying?',
      body:  'Tap a method below for guidance, then click the highlighted button on screen.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash',       style: 'primary', fn: () => showTenderGuide('cash')    },
        { icon: '💳', label: 'Card',       style: 'outline', fn: () => showTenderGuide('card')    },
        { icon: '🏷️', label: 'Voucher',   style: 'outline', fn: () => showTenderGuide('voucher') },
        { icon: '€',  label: 'Pay in €',  style: 'outline', fn: () => showTenderGuide('eur')     },
      ],
    },

    // ── Tender steps ─────────────────────────────────────
    tender_cash: {
      title: 'Cash payment',
      body:  '<ol><li>Count the cash the customer hands over.</li><li>Enter that amount in the highlighted field (or use the keypad).</li><li>The till will show the <strong>change due</strong>.</li><li>Tap <strong>Apply Cash</strong> to record it.</li></ol>',
      actions: [
        { icon: '⌨️', label: 'Click cash field', style: 'outline', fn: () => focusEl('#cashInputField') },
        { icon: '✅', label: 'Apply Cash →',      style: 'primary', fn: () => highlightMany(['#applyCashBtn'])  },
      ],
    },

    tender_card: {
      title: 'Card payment',
      body:  '<ol><li>Process the payment on the card terminal <em>first</em>.</li><li>Tap <strong>Fill Remaining</strong> to auto-fill the balance, or type the exact amount.</li><li>Tap <strong>Apply</strong> to record it.</li></ol>',
      actions: [
        { icon: '📋', label: 'Fill Remaining', style: 'primary', fn: () => highlightMany(['#otherFullAmountBtn']) },
        { icon: '✅', label: 'Apply →',         style: 'outline', fn: () => highlightMany(['#applyOtherBtn'])      },
      ],
    },

    tender_voucher: {
      title: 'Gift voucher',
      body:  '<ol><li>Ask the customer for their voucher.</li><li>Scan or type the voucher code.</li><li>Enter the amount to apply (up to the voucher balance).</li><li>Tap <strong>Use Voucher</strong> to apply it.</li></ol>',
      actions: [
        { icon: '✅', label: 'Use Voucher →', style: 'primary', fn: () => highlightMany(['#voucherSubmitBtn']) },
      ],
    },

    tender_eur: {
      title: 'Euro payment',
      body:  '<ol><li>The panel shows the GBP total and live exchange rate.</li><li>Choose <strong>Exact</strong>, <strong>Round Up</strong>, or <strong>Round Down</strong> as the EUR target.</li><li>Enter the euros handed over and tap <strong>Apply EUR</strong>.</li><li>The till calculates change in GBP or EUR.</li></ol>',
    },

    tender_discount: {
      title: 'Applying a discount',
      body:  '<ol><li>Tap items to discount (or use <em>Select All</em>).</li><li>Choose type: <strong>£ Off</strong>, <strong>% Off</strong>, or <strong>Set Price</strong>.</li><li>Enter the value on the keypad.</li><li>Tap <strong>Done</strong> to apply and return to checkout.</li></ol>',
    },

    // ── Split / partial payment ───────────────────────────
    payment_partial: {
      title: 'Part payment applied',
      body:  'Part of the balance is covered. There\'s still an <strong>amount outstanding</strong> — choose another method below for the rest.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash',     style: 'primary', fn: () => showTenderGuide('cash')    },
        { icon: '💳', label: 'Card',     style: 'outline', fn: () => showTenderGuide('card')    },
        { icon: '🏷️', label: 'Voucher', style: 'outline', fn: () => showTenderGuide('voucher') },
        { icon: '€',  label: 'Pay in €', style: 'outline', fn: () => showTenderGuide('eur')    },
      ],
    },

    // ── Payment ready ─────────────────────────────────────
    payment_ready: {
      title: 'Step 4 — Complete the transaction',
      body:  'Payment is fully covered! Count out any change for the customer, then tap <strong>Complete Sale</strong>.',
      actions: [
        { icon: '✅', label: 'Complete Sale →', style: 'primary', fn: () => highlightMany(['#completeSaleBtn']) },
      ],
    },

    // ── Done ─────────────────────────────────────────────
    complete: {
      title: '✅ Transaction complete',
      body:  'The transaction is recorded and a receipt is printing. Hand the customer any change and the receipt. The till will reset shortly.',
    },
  };

  // -------------------------------------------------------
  // Resolve the right GUIDE config for current step + txnType
  // -------------------------------------------------------
  function getGuideConfig(stepKey) {
    if (level < 3) return null;

    switch (stepKey) {
      case 'idle':
        return GUIDE[txnType ? `idle_${txnType}` : 'idle_null'];

      case 'cart_ready':
        if (txnType === 'layaway') return GUIDE.cart_ready_layaway;
        if (txnType === 'return')  return GUIDE.cart_ready_return;
        return GUIDE.cart_ready_sale;

      case 'checkout_open':
        if (txnType === 'layaway')               return GUIDE.checkout_open_layaway;
        if (txnType === 'return' && !returnLoaded) return GUIDE.checkout_open_return_load;
        return GUIDE.checkout_open_pay;

      // All other step keys fall through to a direct GUIDE lookup
      default:
        return GUIDE[stepKey] || null;
    }
  }

  // -------------------------------------------------------
  // Highlights — resolve highlight selectors for a step
  // -------------------------------------------------------
  function applyHighlights(stepKey) {
    clearHighlights();
    if (!level) return;

    let sels;
    if (level >= 3) {
      if (stepKey === 'idle') {
        sels = txnType ? (HIGHLIGHTS[`idle_${txnType}`] || []) : [];
      } else if (stepKey === 'cart_ready') {
        if (txnType === 'layaway') sels = HIGHLIGHTS.cart_ready_layaway;
        else if (txnType === 'return') sels = HIGHLIGHTS.cart_ready_return;
        else sels = HIGHLIGHTS.cart_ready_sale || HIGHLIGHTS.cart_ready;
      } else if (stepKey === 'checkout_open') {
        if (txnType === 'layaway')               sels = HIGHLIGHTS.checkout_open_layaway;
        else if (txnType === 'return' && !returnLoaded) sels = ['#checkoutReturnBtn'];
        else sels = ['[data-tender="cash"]', '[data-tender="card"]', '[data-tender="voucher"]'];
      } else {
        sels = HIGHLIGHTS[stepKey] || [];
      }
    } else {
      // Levels 1 & 2 — simpler highlight set
      if (stepKey === 'idle') {
        sels = HIGHLIGHTS.idle;
      } else {
        sels = HIGHLIGHTS[stepKey] || [];
      }
    }

    (sels || []).forEach(sel => {
      try {
        const el = document.querySelector(sel);
        if (el) { el.classList.add('training-highlight'); highlightedEls.push(el); }
      } catch (_) {}
    });
  }

  function clearHighlights() {
    highlightedEls.forEach(el => el.classList.remove('training-highlight'));
    highlightedEls = [];
  }

  // -------------------------------------------------------
  // Level 2 — floating hint pills
  // -------------------------------------------------------
  function clearHints() {
    activeHints.forEach(h => h.remove());
    activeHints = [];
  }

  function positionHint(hint, target, place) {
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hint.style.display = 'none'; return; }
    hint.style.display = '';
    const gap = 8;
    const hw = hint.offsetWidth;
    const hh = hint.offsetHeight;
    switch (place) {
      case 'right':
        hint.style.left = (r.right + gap) + 'px';
        hint.style.top  = (r.top + r.height / 2 - hh / 2) + 'px';
        break;
      case 'left':
        hint.style.left = (r.left - hw - gap) + 'px';
        hint.style.top  = (r.top + r.height / 2 - hh / 2) + 'px';
        break;
      case 'above':
        hint.style.left = (r.left + r.width / 2 - hw / 2) + 'px';
        hint.style.top  = (r.top - hh - gap) + 'px';
        break;
      case 'below':
        hint.style.left = (r.left + r.width / 2 - hw / 2) + 'px';
        hint.style.top  = (r.bottom + gap) + 'px';
        break;
    }
    const vw = window.innerWidth, vh = window.innerHeight;
    const l = parseFloat(hint.style.left), t = parseFloat(hint.style.top);
    hint.style.left = Math.max(4, Math.min(l, vw - hw - 4)) + 'px';
    hint.style.top  = Math.max(4, Math.min(t, vh - hh - 4)) + 'px';
  }

  function _hintKeyForStep(stepKey) {
    if (stepKey === 'idle')       return txnType ? `idle_${txnType}` : 'idle';
    if (stepKey === 'cart_ready') {
      if (txnType === 'layaway') return 'cart_ready_layaway';
      if (txnType === 'return')  return 'cart_ready_return'; // uses generic cart_ready hints
      return 'cart_ready_sale';
    }
    if (stepKey === 'checkout_open' && txnType === 'layaway') return 'checkout_open_layaway';
    return stepKey;
  }

  function showHints(stepKey) {
    clearHints();
    if (level !== 2) return;
    const key  = _hintKeyForStep(stepKey);
    const defs = HINTS[key] || HINTS[stepKey];
    if (!defs || !defs.length) return;
    const pending = [];
    defs.forEach(def => {
      try {
        const target = document.querySelector(def.sel);
        if (!target) return;
        const hint = document.createElement('div');
        hint.className = `tw-hint tw-${def.place}`;
        hint.textContent = def.text;
        document.body.appendChild(hint);
        activeHints.push(hint);
        pending.push({ hint, target, place: def.place });
      } catch (_) {}
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending.forEach(p => positionHint(p.hint, p.target, p.place));
      pending.forEach(p => p.hint.classList.add('tw-visible'));
    }));
  }

  // -------------------------------------------------------
  // Level 3 — guide panel renderer
  // -------------------------------------------------------
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Internal: render any title/body/actions into the panel
  function _renderPanel(title, body, actions, actionsClass) {
    const panel = document.getElementById('trainingGuidePanel');
    const titleEl = document.getElementById('tgpTitle');
    const bodyEl  = document.getElementById('tgpBody');
    const actsEl  = document.getElementById('tgpActions');
    if (!panel || !titleEl || !bodyEl || !actsEl) return;
    titleEl.textContent = title;
    bodyEl.innerHTML    = body || '';
    actsEl.className = `tgp-actions${actionsClass ? ' ' + actionsClass : ''}`;
    actsEl.innerHTML = '';
    (actions || []).forEach(act => {
      const btn = document.createElement('button');
      btn.className = `tgp-btn tgp-btn-${act.style || 'outline'}`;
      btn.innerHTML = (act.icon ? `<span>${act.icon}</span>` : '') + escHtml(act.label);
      btn.addEventListener('click', () => { if (act.fn) act.fn(); });
      actsEl.appendChild(btn);
    });
    panel.classList.add('tw-visible');
  }

  function showGuidePanel(stepKey) {
    const cfg = getGuideConfig(stepKey);
    if (!cfg) return;
    _renderPanel(cfg.title, cfg.body, cfg.actions, cfg.actionsClass);
  }

  function hideGuidePanel() {
    const panel = document.getElementById('trainingGuidePanel');
    if (panel) panel.classList.remove('tw-visible');
  }

  // -------------------------------------------------------
  // Topbar badge
  // -------------------------------------------------------
  function updateBadge() {
    const existing = document.getElementById('trainingModeBadge');
    if (level > 0) {
      const badge = existing || document.createElement('span');
      if (!existing) {
        badge.id = 'trainingModeBadge';
        badge.className = 'training-mode-badge';
        badge.title = 'Training mode active — change in Settings';
        const brand = document.querySelector('.app-topbar .brand');
        if (brand && brand.parentNode) brand.parentNode.insertBefore(badge, brand.nextSibling);
      }
      badge.textContent = `Training L${level}`;
    } else {
      if (existing) existing.remove();
    }
  }

  // -------------------------------------------------------
  // chooseTxnType — called from type-picker action buttons
  // Updates txnType and re-renders without resetting state
  // -------------------------------------------------------
  function chooseTxnType(type) {
    txnType = type;
    applyHighlights(currentStep);
    showHints(currentStep);
    showGuidePanel(currentStep);
  }

  // -------------------------------------------------------
  // Auto-reset for "done" steps
  // -------------------------------------------------------
  function scheduleReset(stepKey) {
    clearTimeout(stepCompleteTimer);
    stepCompleteTimer = setTimeout(() => {
      if (currentStep === stepKey) setStep('idle');
    }, 4000);
  }

  // -------------------------------------------------------
  // Public: setStep — called from script.js hooks
  // -------------------------------------------------------
  function setStep(stepKey) {
    if (!level) return;

    // Returning to idle means a new transaction — reset all type state
    if (stepKey === 'idle') {
      txnType      = null;
      returnLoaded = false;
      returnPath   = null;
    }

    // Entering the return overlay marks the return as loaded
    if (stepKey === 'return_open') {
      returnLoaded = true;
    }

    currentStep = stepKey;
    applyHighlights(stepKey);
    showHints(stepKey);
    showGuidePanel(stepKey);

    // Auto-reset done steps
    if (stepKey === 'complete' || stepKey === 'layaway_done' || stepKey === 'layaway_pay_done') {
      scheduleReset(stepKey);
    }
  }

  // -------------------------------------------------------
  // Public: onSaleDone — called after successful sale
  // -------------------------------------------------------
  function onSaleDone() {
    if (!level) return;
    setStep('complete');
  }

  // -------------------------------------------------------
  // Public: init — called from applySettings / login
  // -------------------------------------------------------
  function init(lvl) {
    level        = parseInt(lvl, 10) || 0;
    txnType      = null;
    returnLoaded = false;
    returnPath   = null;
    clearTimeout(stepCompleteTimer);
    clearHighlights();
    clearHints();
    hideGuidePanel();
    updateBadge();
    if (!level) return;
    window.removeEventListener('resize', onResize);
    if (level >= 2) window.addEventListener('resize', onResize);
    setStep('idle');
  }

  function onResize() { /* panel position is CSS-controlled */ }

  // Wire close button
  document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('tgpClose');
    if (closeBtn) closeBtn.addEventListener('click', hideGuidePanel);
  });

  // -------------------------------------------------------
  // Public API
  // -------------------------------------------------------
  window.TrainingWheels = {
    init,
    setStep,
    onSaleDone,
    hideGuidePanel,
    clearHints,
    clearHighlights,
    getLevel:   () => level,
    getTxnType: () => txnType,
  };

})();
