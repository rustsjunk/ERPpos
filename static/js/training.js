/* =========================================================
   Training Wheels — guided cashier onboarding engine
   Levels:
     0  Off
     1  Pulsing highlight on the next button only
     2  Level 1 + floating hint labels beside key buttons
     3  Level 2 + guide panel with transaction-type flow:
        — Type picker at start (Sale / Return / Search)
        — Step-by-step guidance tailored to the chosen type
        — Payment-type picker on checkout screen
   ========================================================= */
'use strict';

(function () {

  // -------------------------------------------------------
  // State
  // -------------------------------------------------------
  let level = 0;
  let currentStep = 'idle';
  let txnType = null;       // 'sale' | 'return' | 'search' | null
  let returnLoaded = false; // true once user has been to the return overlay
  let highlightedEls = [];
  let activeHints = [];
  let stepCompleteTimer = null;

  // -------------------------------------------------------
  // Step → highlighted elements (levels 1, 2, 3)
  // -------------------------------------------------------
  const HIGHLIGHTS = {
    idle:            ['#itemSearch', '#barcodeInput'],
    cart_ready:      ['#checkoutBtn'],
    checkout_open:   ['.tender-grid', '#checkoutReturnBtn', '.checkout-refund-btn'],
    tender_cash:     ['#cashSection'],
    tender_card:     ['#otherSection'],
    tender_voucher:  ['#voucherOverlay', '#tenderVoucherBtn'],
    tender_discount: ['#discountItemsList', '#discountValueInput'],
    tender_eur:      ['#eurConverterOverlay'],
    return_open:     ['#returnScanInput', '#returnFindBtn', '#returnLoadBtn'],
    payment_partial: ['#completeSaleBtn'],
    payment_ready:   ['#completeSaleBtn'],
    complete:        [],
  };

  // -------------------------------------------------------
  // Level 2 — hint pill definitions per step
  // -------------------------------------------------------
  const HINTS = {
    idle: [
      { sel: '#itemSearch',   text: 'Search for a product here',   place: 'right' },
      { sel: '#barcodeInput', text: 'Or scan / type a barcode',    place: 'right' },
    ],
    cart_ready: [
      { sel: '#checkoutBtn',  text: 'Tap to begin payment →',      place: 'above' },
    ],
    checkout_open: [
      { sel: '[data-tender="cash"]',         text: 'Notes & coins',              place: 'below' },
      { sel: '[data-tender="card"]',         text: 'Debit / credit card',        place: 'below' },
      { sel: '[data-tender="voucher"]',      text: 'Gift voucher',               place: 'below' },
      { sel: '[data-tender="other"]',        text: 'Other tender',               place: 'below' },
      { sel: '#openDiscountBtn',             text: 'Any discount?',              place: 'right' },
      { sel: '#convertToEuroBtn',            text: 'Customer paying in €',       place: 'above' },
      { sel: '#addPlasticBagBtn',            text: 'Add plastic bag',            place: 'above' },
      { sel: '.checkout-refund-btn',         text: 'Tap to mark item as return', place: 'left' },
      { sel: '#checkoutReturnBtn',           text: 'Return / receipt scan',      place: 'above' },
      { sel: '#completeSaleBtn',             text: 'Finish transaction',         place: 'left'  },
    ],
    return_open: [
      { sel: '#returnScanInput', text: 'Enter or scan the receipt ID', place: 'right' },
      { sel: '#returnFindBtn',   text: 'Tap to look up the receipt',   place: 'above' },
      { sel: '#returnLoadBtn',   text: 'Tick items then load return',  place: 'above' },
    ],
    tender_cash: [
      { sel: '#cashInputField', text: 'Enter cash amount given', place: 'right' },
      { sel: '#applyCashBtn',   text: 'Then tap here',           place: 'above' },
    ],
    tender_card: [
      { sel: '#otherAmountInput',   text: 'Enter card amount',    place: 'right' },
      { sel: '#otherFullAmountBtn', text: 'Or fill remaining',    place: 'above' },
      { sel: '#applyOtherBtn',      text: 'Then tap here',        place: 'above' },
    ],
    tender_voucher: [
      { sel: '#voucherCodeInput',  text: 'Scan or type voucher code', place: 'right' },
      { sel: '#voucherSubmitBtn',  text: 'Then tap here',             place: 'left'  },
    ],
    tender_eur: [
      { sel: '#eurOverlayGbpTotal', text: 'GBP total to collect',       place: 'right' },
      { sel: '#eurOverlayExact',    text: 'Exact EUR equivalent',        place: 'right' },
      { sel: '#eurOverlayRoundUp',  text: 'Rounded up — easier change',  place: 'right' },
    ],
    tender_discount: [
      { sel: '#discountItemsList',  text: 'Tick items to discount',   place: 'right' },
      { sel: '#discModePercent',    text: 'Or choose % off',          place: 'right' },
      { sel: '#discountValueInput', text: 'Enter the discount value', place: 'right' },
      { sel: '#discountCloseBtn',   text: 'Done — applies to cart',   place: 'left'  },
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
  function clickEl(sel) {
    try {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (el && !el.disabled) el.click();
    } catch (_) {}
  }
  function focusEl(sel) {
    try {
      const el = document.querySelector(sel);
      if (el) el.focus();
    } catch (_) {}
  }

  // Highlight a single element (used by showTenderGuide)
  function highlightOne(sel) {
    clearHighlights();
    try {
      const el = document.querySelector(sel);
      if (el) { el.classList.add('training-highlight'); highlightedEls.push(el); }
    } catch (_) {}
  }

  // -------------------------------------------------------
  // Pre-tender guidance: called when user taps a payment type
  // in the payment picker.  Shows guidance + highlights the
  // real UI button — does NOT auto-open the overlay.
  // A "← Back" button returns to the payment picker.
  // -------------------------------------------------------
  const PRETENDER = {
    cash: {
      highlightSel: '[data-tender="cash"]',
      title: 'Cash payment',
      body: 'Count the cash the customer hands over. Now click the highlighted <strong>Cash</strong> button on screen to open the cash entry section.',
    },
    card: {
      highlightSel: '[data-tender="card"]',
      title: 'Card payment',
      body: 'Process the payment on the card terminal <em>first</em>, then click the highlighted <strong>Card</strong> button on screen to record the amount.',
    },
    voucher: {
      highlightSel: '[data-tender="voucher"]',
      title: 'Gift voucher',
      body: 'Ask the customer for their voucher. Click the highlighted <strong>Voucher</strong> button on screen to open the voucher entry.',
    },
    eur: {
      highlightSel: '#convertToEuroBtn',
      title: 'Euro payment',
      body: 'The system converts the total to euros at today\'s rate and offers rounding options. Click the highlighted <strong>€ Euro</strong> button on screen to open the currency converter.',
    },
    bag: {
      highlightSel: '#addPlasticBagBtn',
      title: 'Plastic bag charge',
      body: 'Click the highlighted <strong>+ Bag</strong> button on screen to add the bag charge to this sale.',
    },
    discount: {
      highlightSel: '#openDiscountBtn',
      title: 'Applying a discount',
      body: 'Click the highlighted <strong>Discount</strong> button on screen to open the discount panel where you can reduce prices by amount or percentage.',
    },
  };

  function showTenderGuide(type) {
    const cfg = PRETENDER[type];
    if (!cfg) return;

    // Highlight the real UI button
    highlightOne(cfg.highlightSel);

    // Render guidance in the panel without changing currentStep
    const panel = document.getElementById('trainingGuidePanel');
    const title = document.getElementById('tgpTitle');
    const body  = document.getElementById('tgpBody');
    const acts  = document.getElementById('tgpActions');
    if (!panel || !title || !body || !acts) return;

    title.textContent = cfg.title;
    body.innerHTML    = cfg.body;
    acts.className    = 'tgp-actions';
    acts.innerHTML    = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'tgp-btn tgp-btn-outline';
    backBtn.innerHTML = '← Back to payment types';
    backBtn.addEventListener('click', () => {
      applyHighlights(currentStep);
      showGuidePanel(currentStep);
    });
    acts.appendChild(backBtn);

    panel.classList.add('tw-visible');
  }

  // -------------------------------------------------------
  // Level 3 — Guide panel content
  // Keyed by step name or step_txnType for type-specific entries.
  // getGuideConfig() resolves the right entry at runtime.
  // -------------------------------------------------------
  const GUIDE = {

    // ── Transaction type picker (idle, no type chosen yet) ─────────────
    idle_null: {
      title: 'What type of transaction?',
      body: 'Choose below to get tailored step-by-step guidance.',
      actionsClass: 'tgp-actions-picker',
      actions: [
        { icon: '🛒', label: 'Sale',              style: 'primary', fn: () => chooseTxnType('sale')   },
        { icon: '↩️', label: 'Return / Exchange', style: 'outline', fn: () => chooseTxnType('return') },
        { icon: '🔍', label: 'Search / Browse',   style: 'outline', fn: () => chooseTxnType('search') },
      ],
    },

    // ── Sale flow ──────────────────────────────────────────────────────
    idle_sale: {
      title: 'Step 1 — Add items to the cart',
      body: 'Scan a barcode or use the <strong>search box</strong> to find a product. Tap any item in the grid to add it directly.',
    },

    cart_ready: {
      title: 'Step 2 — Review the cart',
      body: 'Use <strong>+</strong> and <strong>−</strong> to adjust quantities. When everything looks right, tap <strong>Checkout</strong>.',
      actions: [
        { icon: '✅', label: 'Checkout →', style: 'primary', fn: () => clickEl('#checkoutBtn') },
      ],
    },

    // ── Return / Exchange flow ─────────────────────────────────────────
    idle_return: {
      title: 'Step 1 — Processing a return',
      body: 'Scan the returned item\'s barcode to add it to the cart, then tap <strong>Checkout</strong>. On the payment screen use <strong>↩ Return from Receipt</strong> to scan the original receipt — this is the fastest way and loads all items automatically.',
      actions: [
        { icon: '✅', label: 'Open Checkout →', style: 'primary', fn: () => clickEl('#checkoutBtn') },
      ],
    },

    cart_ready_return: {
      title: 'Step 2 — Return items loaded',
      body: 'Refund lines are in the cart. Check quantities, then tap <strong>Checkout</strong> to process the refund.',
      actions: [
        { icon: '↩️', label: 'Process Refund →', style: 'primary', fn: () => clickEl('#checkoutBtn') },
      ],
    },

    // ── Search / Browse only ───────────────────────────────────────────
    idle_search: {
      title: 'Searching & browsing',
      body: 'Use the <strong>search box</strong> to find products by name, barcode, or style code. Tap any result to see its variants, stock, and price.',
    },

    // ── Checkout: load return (before return overlay visited) ──────────
    checkout_open_return_load: {
      title: 'Step 3 — Return from receipt',
      body: 'Tap the highlighted <strong>↩ Return</strong> button to scan the customer\'s receipt. This loads all original items automatically — tick which ones are being returned, then tap <strong>Load As Return</strong>.',
      actions: [
        { icon: '↩️', label: '↩ Tap Return from Receipt', style: 'primary', fn: () => clickEl('#checkoutReturnBtn') },
      ],
    },

    // ── Checkout: payment picker (sale, or return after receipt loaded) ─
    checkout_open_pay: {
      title: 'How is the customer paying?',
      body: 'Tap a method below for guidance, then click the highlighted button on screen.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash',      style: 'primary', fn: () => showTenderGuide('cash')    },
        { icon: '💳', label: 'Card',      style: 'outline', fn: () => showTenderGuide('card')    },
        { icon: '🏷️', label: 'Voucher',  style: 'outline', fn: () => showTenderGuide('voucher') },
        { icon: '€',  label: 'Pay in €', style: 'outline', fn: () => showTenderGuide('eur')     },
        { icon: '🛍️', label: '+ Bag',    style: 'outline', fn: () => showTenderGuide('bag')     },
        { icon: '💸', label: 'Discount', style: 'outline', fn: () => showTenderGuide('discount') },
      ],
    },

    // ── Return overlay ─────────────────────────────────────────────────
    return_open: {
      title: 'Step 3 — Scan the receipt',
      body: '<ol><li>Scan the receipt barcode or type the receipt ID into the box.</li><li>Tap <strong>Find</strong> — the original items will appear.</li><li>Tick the items being returned (all pre-selected by default).</li><li>Tap <strong>Load As Return</strong> to add them to the cart.</li></ol>',
      actions: [
        { icon: '🔍', label: 'Tap Find →',          style: 'primary', fn: () => clickEl('#returnFindBtn') },
        { icon: '↩️', label: 'Load As Return →',    style: 'outline', fn: () => clickEl('#returnLoadBtn') },
      ],
    },

    // ── Cash payment ───────────────────────────────────────────────────
    tender_cash: {
      title: 'Cash payment',
      body: '<ol><li>Count the cash the customer hands over.</li><li>Enter that amount in the field, or use the keypad.</li><li>The till will show the <strong>change due</strong>.</li><li>Tap <strong>Apply Cash</strong> to record it.</li></ol>',
      actions: [
        { icon: '⌨️', label: 'Click cash field',  style: 'outline', fn: () => focusEl('#cashInputField') },
        { icon: '✅', label: 'Apply Cash →',       style: 'primary', fn: () => clickEl('#applyCashBtn')   },
      ],
    },

    // ── Card payment ───────────────────────────────────────────────────
    tender_card: {
      title: 'Card payment',
      body: '<ol><li>Process the payment on the card terminal <em>first</em>.</li><li>Tap <strong>Fill Remaining</strong> to auto-fill the balance, or type the amount manually.</li><li>Tap <strong>Apply</strong> to record it.</li></ol>',
      actions: [
        { icon: '📋', label: 'Fill Remaining', style: 'primary', fn: () => clickEl('#otherFullAmountBtn') },
        { icon: '✅', label: 'Apply →',         style: 'outline', fn: () => clickEl('#applyOtherBtn')      },
      ],
    },

    // ── Gift voucher ───────────────────────────────────────────────────
    tender_voucher: {
      title: 'Gift voucher',
      body: '<ol><li>Ask the customer for their voucher.</li><li>Scan or type the voucher code.</li><li>Enter the amount to apply (up to the voucher balance).</li><li>Tap <strong>Use Voucher</strong> to apply it.</li></ol>',
      actions: [
        { icon: '✅', label: 'Use Voucher →', style: 'primary', fn: () => clickEl('#voucherSubmitBtn') },
      ],
    },

    // ── Euro payment ───────────────────────────────────────────────────
    tender_eur: {
      title: 'Euro payment',
      body: '<ol><li>The panel shows the GBP total and live exchange rate.</li><li>Choose <strong>Exact</strong>, <strong>Round Up</strong>, or <strong>Round Down</strong> as the EUR target.</li><li>Enter the euros handed over and tap <strong>Apply EUR</strong>.</li><li>The till calculates change in GBP or EUR.</li></ol>',
    },

    // ── Discount ───────────────────────────────────────────────────────
    tender_discount: {
      title: 'Applying a discount',
      body: '<ol><li>Tick items to discount (or tap <em>Select All</em>).</li><li>Choose type: <strong>Amount off</strong>, <strong>Percent off</strong>, or <strong>Set unit price</strong>.</li><li>Enter the value on the keypad.</li><li>Tap <strong>Done</strong> to apply.</li></ol>',
    },

    // ── Split / partial payment ────────────────────────────────────────
    payment_partial: {
      title: 'Part payment applied',
      body: 'Part of the balance is covered. There\'s still an <strong>amount outstanding</strong> — choose another method below for the rest.',
      actionsClass: 'tgp-actions-grid',
      actions: [
        { icon: '💵', label: 'Cash',     style: 'primary', fn: () => showTenderGuide('cash')    },
        { icon: '💳', label: 'Card',     style: 'outline', fn: () => showTenderGuide('card')    },
        { icon: '🏷️', label: 'Voucher', style: 'outline', fn: () => showTenderGuide('voucher') },
      ],
    },

    // ── Payment complete ───────────────────────────────────────────────
    payment_ready: {
      title: 'Step 4 — Complete the transaction',
      body: 'Payment is fully covered! Count out any change for the customer, then tap <strong>Complete Sale</strong>.',
      actions: [
        { icon: '✅', label: 'Complete Sale →', style: 'primary', fn: () => clickEl('#completeSaleBtn') },
      ],
    },

    // ── Done ───────────────────────────────────────────────────────────
    complete: {
      title: '✅ Transaction complete',
      body: 'The transaction is recorded and a receipt is printing. Hand the customer any change and the receipt, then tap <strong>Done</strong> to reset the till.',
    },
  };

  // -------------------------------------------------------
  // Resolve the right GUIDE config for the current step + txnType
  // -------------------------------------------------------
  function getGuideConfig(stepKey) {
    if (level < 3) return null;

    switch (stepKey) {
      case 'idle':
        return GUIDE[txnType ? `idle_${txnType}` : 'idle_null'];

      case 'cart_ready':
        return txnType === 'return' ? GUIDE.cart_ready_return : GUIDE.cart_ready;

      case 'checkout_open':
        if (txnType === 'return' && !returnLoaded) return GUIDE.checkout_open_return_load;
        return GUIDE.checkout_open_pay;

      default:
        return GUIDE[stepKey] || null;
    }
  }

  // -------------------------------------------------------
  // Highlights — level-3 overrides for type-aware steps
  // -------------------------------------------------------
  function applyHighlights(stepKey) {
    clearHighlights();
    if (!level) return;

    let sels;
    if (level >= 3) {
      if (stepKey === 'idle' && !txnType) {
        sels = []; // Type picker: nothing to highlight
      } else if (stepKey === 'checkout_open') {
        if (txnType === 'return' && !returnLoaded) {
          sels = ['#checkoutReturnBtn'];
        } else {
          sels = ['[data-tender="cash"]', '[data-tender="card"]', '[data-tender="voucher"]'];
        }
      } else {
        sels = HIGHLIGHTS[stepKey] || [];
      }
    } else {
      sels = HIGHLIGHTS[stepKey] || [];
    }

    sels.forEach(sel => {
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
  // Level 2 — Floating hint pills
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

  function showHints(stepKey) {
    clearHints();
    if (level !== 2) return;
    const defs = HINTS[stepKey];
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
  // Level 3 — Guide panel
  // -------------------------------------------------------
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showGuidePanel(stepKey) {
    const cfg = getGuideConfig(stepKey);
    if (!cfg) return;

    const panel = document.getElementById('trainingGuidePanel');
    const title = document.getElementById('tgpTitle');
    const body  = document.getElementById('tgpBody');
    const acts  = document.getElementById('tgpActions');
    if (!panel || !title || !body || !acts) return;

    title.textContent = cfg.title;
    body.innerHTML    = cfg.body || '';

    acts.className = `tgp-actions${cfg.actionsClass ? ' ' + cfg.actionsClass : ''}`;
    acts.innerHTML = '';
    (cfg.actions || []).forEach(act => {
      const btn = document.createElement('button');
      btn.className = `tgp-btn tgp-btn-${act.style || 'outline'}`;
      btn.innerHTML = (act.icon ? `<span>${act.icon}</span>` : '') + escHtml(act.label);
      btn.addEventListener('click', () => { if (act.fn) act.fn(); });
      acts.appendChild(btn);
    });

    panel.classList.add('tw-visible');
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
  // Updates txnType and re-renders the current step without
  // resetting state (unlike setStep which resets on 'idle').
  // -------------------------------------------------------
  function chooseTxnType(type) {
    txnType = type;
    applyHighlights(currentStep);
    showGuidePanel(currentStep);
  }

  // -------------------------------------------------------
  // Public: setStep — called from script.js hooks
  // -------------------------------------------------------
  function setStep(stepKey) {
    if (!level) return;

    // Returning to idle means a new transaction — reset type state
    if (stepKey === 'idle') {
      txnType = null;
      returnLoaded = false;
    }

    // Once the return overlay has been opened, subsequent checkout_open
    // steps should show payment guidance rather than "load return".
    if (stepKey === 'return_open') {
      returnLoaded = true;
    }

    currentStep = stepKey;
    applyHighlights(stepKey);
    showHints(stepKey);
    showGuidePanel(stepKey);
  }

  // -------------------------------------------------------
  // Public: onSaleDone — called after successful sale
  // -------------------------------------------------------
  function onSaleDone() {
    if (!level) return;
    setStep('complete');
    clearTimeout(stepCompleteTimer);
    stepCompleteTimer = setTimeout(() => {
      if (currentStep === 'complete') setStep('idle');
    }, 4000);
  }

  // -------------------------------------------------------
  // Public: init — called from applySettings / login
  // -------------------------------------------------------
  function init(lvl) {
    level = parseInt(lvl, 10) || 0;
    txnType = null;
    returnLoaded = false;
    clearHighlights();
    clearHints();
    hideGuidePanel();
    updateBadge();
    if (!level) return;
    window.removeEventListener('resize', onResize);
    if (level >= 3) window.addEventListener('resize', onResize);
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
    getLevel: () => level,
  };

})();
