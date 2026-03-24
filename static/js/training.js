/* =========================================================
   Training Wheels — guided cashier onboarding engine
   Levels:
     0  Off
     1  Pulsing highlight on the next button only
     2  Level 1 + floating hint labels beside key buttons
     3  Level 2 + guide panel below topbar with full
        step-by-step instructions and decision prompts
   ========================================================= */
'use strict';

(function () {

  // -------------------------------------------------------
  // State
  // -------------------------------------------------------
  let level = 0;
  let currentStep = 'idle';
  let highlightedEls = [];
  let activeHints = [];     // DOM elements to remove on next step
  let stepCompleteTimer = null;

  // -------------------------------------------------------
  // Step → highlighted elements (all levels)
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
  // Each hint appears near its target element.
  // placement: 'right' | 'left' | 'above' | 'below'
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
      { sel: '#addPlasticBagBtn',            text: 'Add plastic bag (22c)',      place: 'above' },
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
      { sel: '#otherAmountInput', text: 'Enter card amount', place: 'right' },
      { sel: '#applyOtherBtn',    text: 'Then tap here',     place: 'above' },
    ],
    tender_voucher: [
      { sel: '#voucherCodeInput',   text: 'Scan or type voucher code', place: 'right' },
      { sel: '#voucherSubmitBtn',   text: 'Then tap here',             place: 'left'  },
    ],
    tender_eur: [
      { sel: '#eurOverlayGbpTotal',  text: 'GBP total to collect',        place: 'right' },
      { sel: '#eurOverlayExact',     text: 'Exact EUR equivalent',         place: 'right' },
      { sel: '#eurOverlayRoundUp',   text: 'Rounded up — easier change',   place: 'right' },
    ],
    tender_discount: [
      { sel: '#discountItemsList',  text: 'Tick items to discount',       place: 'right' },
      { sel: '#discModePercent',    text: 'Or choose % off',              place: 'right' },
      { sel: '#discountValueInput', text: 'Enter the discount value',     place: 'right' },
      { sel: '#discountCloseBtn',   text: 'Done — applies to cart',       place: 'left'  },
    ],
    payment_partial: [
      { sel: '.tender-grid', text: 'Add another payment method for the rest', place: 'above' },
    ],
    payment_ready: [
      { sel: '#completeSaleBtn', text: '✓ All paid — tap to complete!', place: 'left' },
    ],
  };

  // -------------------------------------------------------
  // Level 3 — guide panel content per step
  // body: may contain safe HTML (hardcoded, not user input)
  // actions: array of { icon, label, style, fn }
  // -------------------------------------------------------
  const GUIDE = {
    idle: {
      title: 'Step 1 of 4 — Start a transaction',
      body: 'Use the <strong>search box</strong> to find a product by name, or scan its barcode using the scanner at the bottom of the screen. You can also click any product in the grid below to add it to the cart.',
    },
    cart_ready: {
      title: 'Step 2 of 4 — Review the cart',
      body: 'Item added to the cart on the right. Use the <strong>+</strong> and <strong>−</strong> buttons to adjust quantities. When everything looks correct, tap <strong>Checkout</strong> in the bottom-right corner.',
    },
    checkout_open: {
      title: 'Step 3 of 4 — Before you take payment',
      body: 'Check for any extras. To <strong>return an item</strong>: tap its <em>Refund</em> button in the cart list — or use <em>↩ Return from receipt</em> to load a previous transaction.',
      actions: [
        {
          icon: '🏷️', label: 'Gift voucher',
          style: 'warning',
          fn: () => { const v = document.querySelector('[data-tender="voucher"]'); if (v) v.click(); }
        },
        {
          icon: '💸', label: 'Discount',
          style: 'outline',
          fn: () => { const d = document.getElementById('openDiscountBtn'); if (d) d.click(); }
        },
        {
          icon: '🛍️', label: 'Plastic bag',
          style: 'outline',
          fn: () => { const b = document.getElementById('addPlasticBagBtn'); if (b) b.click(); }
        },
        {
          icon: '€', label: 'Pay in euros',
          style: 'outline',
          fn: () => { const e = document.getElementById('convertToEuroBtn'); if (e) e.click(); }
        },
        {
          icon: '↩️', label: 'Return from receipt',
          style: 'outline',
          fn: () => { const r = document.getElementById('checkoutReturnBtn'); if (r) r.click(); }
        },
        {
          icon: '✅', label: 'No extras — go to payment',
          style: 'primary',
          fn: () => hideGuidePanel()
        },
      ],
    },
    tender_cash: {
      title: 'Cash payment — how to proceed',
      body: '<ol><li>Count the cash the customer hands over.</li><li>Enter that amount on the keypad or in the number field.</li><li>Tap <strong>Apply Cash</strong> — the till shows the change due.</li><li>If the total isn\'t fully covered, add a second payment method.</li></ol>',
    },
    tender_card: {
      title: 'Card payment — how to proceed',
      body: '<ol><li>Process the payment on the card terminal <em>first</em>.</li><li>Enter the amount charged to the card here.</li><li>Tap <strong>Remaining Amount</strong> to auto-fill the balance, or type it manually.</li><li>Click <strong>Apply</strong> to record it. Mix with other methods for split payments.</li></ol>',
    },
    tender_voucher: {
      title: 'Gift voucher — how to proceed',
      body: '<ol><li>Ask the customer for their voucher.</li><li>Scan or type the voucher code in the field.</li><li>Enter the amount to apply (cannot exceed the voucher\'s remaining balance).</li><li>Tap <strong>Use Voucher</strong> to apply it. Add another payment for any remainder.</li></ol>',
    },
    tender_eur: {
      title: 'Euro payment',
      body: '<ol><li>The panel shows the GBP total and the current exchange rate.</li><li>Choose a EUR target: <strong>Exact</strong>, <strong>Round Up</strong> (easier for customer), or <strong>Round Down</strong>.</li><li>The customer hands over euros — enter the amount they give and tap <strong>Apply EUR</strong>.</li><li>The system records the EUR taken and calculates any change in GBP or EUR.</li></ol>',
    },
    tender_discount: {
      title: 'Applying a discount',
      body: '<ol><li><strong>Select items</strong> to discount using the checkboxes — or tap <em>Select All</em>.</li><li>Choose the discount type: <strong>Amount off</strong> (fixed price reduction per item), <strong>Percent off</strong> (e.g. 10 for 10%), or <strong>Set unit price</strong> (override the price directly).</li><li>Type the value on the keypad.</li><li>Tap <strong>Done</strong> to apply. The updated prices appear in the cart immediately.</li></ol>',
    },
    return_open: {
      title: 'Processing a return',
      body: '<ol><li>Scan the customer\'s receipt barcode or type the receipt ID into the box.</li><li>Tap <strong>Find</strong> — the original items will appear with checkboxes.</li><li>Tick the items the customer is returning (all are pre-selected by default).</li><li>Tap <strong>Load As Return</strong> — the items are added to the cart as refund lines.</li><li>Process the refund payment: cash back, card refund, or issue a voucher.</li></ol>',
    },
    payment_partial: {
      title: 'Split payment in progress',
      body: 'Part of the balance has been applied. There\'s still an <strong>amount outstanding</strong> — you can see it in the "Remaining Due" field. Choose another payment method (Cash, Card, or Voucher) to cover the rest.',
    },
    payment_ready: {
      title: 'Step 4 of 4 — Complete the sale',
      body: 'Payment is fully covered! Count out any change for the customer. Tap <strong>Complete Sale</strong> to process the transaction — a receipt will print automatically.',
    },
    complete: {
      title: '✅ Transaction complete',
      body: 'The sale is recorded and a receipt is printing. Hand the customer their change (if any) and the receipt. Tap <strong>Done</strong> on the receipt screen to reset the till for the next customer.',
    },
  };

  // -------------------------------------------------------
  // Highlights
  // -------------------------------------------------------
  function clearHighlights() {
    highlightedEls.forEach(el => el.classList.remove('training-highlight'));
    highlightedEls = [];
  }

  function applyHighlights(stepKey) {
    clearHighlights();
    if (!level) return;
    (HIGHLIGHTS[stepKey] || []).forEach(sel => {
      try {
        const el = document.querySelector(sel);
        if (el) { el.classList.add('training-highlight'); highlightedEls.push(el); }
      } catch (_) {}
    });
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

    // Clamp to viewport
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

    // Wait two animation frames for the target to be laid out (overlay transitions)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending.forEach(p => positionHint(p.hint, p.target, p.place));
      // Fade in
      pending.forEach(p => p.hint.classList.add('tw-visible'));
    }));
  }

  // -------------------------------------------------------
  // Level 3 — Guide panel
  // -------------------------------------------------------
  function showGuidePanel(stepKey) {
    if (level < 3) return;
    const cfg = GUIDE[stepKey];
    if (!cfg) return;

    const panel  = document.getElementById('trainingGuidePanel');
    const title  = document.getElementById('tgpTitle');
    const body   = document.getElementById('tgpBody');
    const acts   = document.getElementById('tgpActions');
    if (!panel || !title || !body || !acts) return;

    // Position is handled by CSS (bottom-right floating card)

    title.textContent = cfg.title;
    body.innerHTML = cfg.body || '';

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

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  // Public: setStep — called from script.js hooks
  // -------------------------------------------------------
  function setStep(stepKey) {
    if (!level) return;
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
    // After 4 seconds transition back to idle
    clearTimeout(stepCompleteTimer);
    stepCompleteTimer = setTimeout(() => {
      if (currentStep === 'complete') setStep('idle');
    }, 4000);
  }

  // -------------------------------------------------------
  // Public: init — called from applySettings
  // -------------------------------------------------------
  function init(lvl) {
    level = parseInt(lvl, 10) || 0;
    clearHighlights();
    clearHints();
    hideGuidePanel();
    updateBadge();
    if (!level) return;
    // Reposition guide panel whenever window resizes
    window.removeEventListener('resize', onResize);
    if (level >= 3) window.addEventListener('resize', onResize);
    setStep('idle');
  }

  function onResize() { /* no-op: panel position is CSS-controlled */ }

  // Wire up close buttons after DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('tgpClose');
    if (closeBtn) closeBtn.addEventListener('click', hideGuidePanel);
  });

  // Expose public API
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
