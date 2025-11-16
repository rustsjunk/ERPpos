// Safe override for resumePaused to avoid recursion wrappers
(function(){
  try{
    if (typeof window === 'undefined') return;

    async function doResumePaused(id){
      try{
        // Detect logged-in via global lexical var (not on window)
        try{
          if (typeof currentCashier === 'undefined' || !currentCashier){
            // Defer until after login using the same lexical variable
            if (typeof pendingResumeId !== 'undefined') pendingResumeId = id; else window.pendingResumeId = id;
            if (typeof showLogin === 'function') showLogin();
            return;
          }
        }catch(_){ /* fallback: proceed */ }

        const r = await fetch(`/api/paused-sales/${encodeURIComponent(id)}?consume=1`);
        const d = await r.json();
        if (!d || d.status !== 'success'){
          alert((d && d.message) || 'Failed to load paused transaction');
          return;
        }
        const rec = d.paused || {};
        const rows = Array.isArray(rec.cart) ? rec.cart : [];
        // Assign to lexical globals (not window.*)
        try { cart = rows.map(i=>({ item_code:i.item_code, item_name:i.item_name, qty:Number(i.qty||0), rate:Number(i.rate||0), amount:Number(i.qty||0)*Number(i.rate||0), refund: !!i.refund, vat_rate: i.vat_rate!=null ? Number(i.vat_rate) : null })); } catch(_){ window.cart = rows; }
        try { vouchers = Array.isArray(rec.vouchers) ? rec.vouchers : []; } catch(_){ window.vouchers = Array.isArray(rec.vouchers) ? rec.vouchers : []; }
        const v = rec.customer || '';
        const top = document.getElementById('topCustomerSelect');
        const bottom = document.getElementById('customerSelect');
        if (top && v) top.value = v;
        if (bottom && v) bottom.value = v;
        try { updateCartDisplay(); } catch(_){ if (typeof window.updateCartDisplay==='function') window.updateCartDisplay(); }
        const ov = document.getElementById('pausedOverlay'); if (ov) ov.style.display = 'none';
        try {
          const cartCard = document.getElementById('cartCard');
          if (cartCard){ cartCard.classList.add('cart-pulse'); setTimeout(()=>cartCard.classList.remove('cart-pulse'), 700); }
        } catch(_){ }
      } catch(e){
        alert('Failed to resume paused transaction');
      }
    }

    // Override any previous wrapper to avoid recursion
    window.resumePaused = doResumePaused;
  }catch(_){ }
})();
