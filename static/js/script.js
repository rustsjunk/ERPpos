try{ console.log('[POS] JS loaded'); }catch(_){ }
// Clean rebuilt POS frontend
// Debug logging helpers
const DEBUG = true;
function log(){ if(!DEBUG) return; try{ console.log('[POS]', ...arguments); }catch(_){} }
function warn(){ if(!DEBUG) return; try{ console.warn('[POS]', ...arguments); }catch(_){} }
function err(){ if(!DEBUG) return; try{ console.error('[POS]', ...arguments); }catch(_){} }

// Neutralize intrusive third-party overlays (e.g., extensions) that block the UI
function neutralizeForeignOverlays(){
  try{
    const selectors = [
      '.moda', '#mdlBlgPgLder', '#modalGenerico', '#modalFazerAlgo', '#modalLoad', '#modalQRCD', '#modalEft', '#modalBloque'
    ];
    const nodes = document.querySelectorAll(selectors.join(','));
    if(nodes.length){ log('neutralizing foreign overlays', nodes.length); }
    nodes.forEach(el=>{ el.style.display='none'; el.setAttribute('data-hidden-by-pos','1'); });
  }catch(e){ /* ignore */ }
}

// Continuously guard against re-injected overlays
function installOverlayGuard(){
  try{
    const mo = new MutationObserver((mutations)=>{
      let touched = 0;
      mutations.forEach(m=>{
        m.addedNodes && m.addedNodes.forEach(n=>{
          if(!(n instanceof HTMLElement)) return;
          if(n.matches && (n.matches('.moda') || ['mdlBlgPgLder','modalGenerico','modalFazerAlgo','modalLoad','modalQRCD','modalEft','modalBloque'].includes(n.id))){
            n.style.display='none';
            n.setAttribute('data-hidden-by-pos','1');
            touched++;
          }
          if(n.querySelectorAll){
            const q = n.querySelectorAll('.moda,#mdlBlgPgLder,#modalGenerico,#modalFazerAlgo,#modalLoad,#modalQRCD,#modalEft,#modalBloque');
            q.forEach(el=>{ el.style.display='none'; el.setAttribute('data-hidden-by-pos','1'); touched++; });
          }
        });
      });
      if(touched) log('overlay guard hid', touched, 'nodes');
    });
    mo.observe(document.documentElement || document.body, { childList:true, subtree:true });
  }catch(e){ /* ignore */ }
}
let items = [];
let cart = [];
let customers = [];
let currentCashier = null;

// Checkout state
let currentTender = '';
let cashInput = '';
let denomSubtract = false;
let vouchers = [];
let barcodeFeedbackTimer = null;
// App settings and receipt state
let settings = { till_number: '', dark_mode: false, auto_print: false };
let lastReceiptInfo = null;

// Currency
const CURRENCY = 'GBP';
const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY });
const money = v => fmt.format(Number(v || 0));

// Demo cashiers
const CASHIER_CODES = { '1111':'Alice','2222':'Bob','3333':'Charlie' };

// Idle
const IDLE_TIMEOUT_MS = 120000; let idleTimer=null;
function resetIdleTimer(){ if(idleTimer) clearTimeout(idleTimer); if(currentCashier) idleTimer=setTimeout(()=>logoutToLogin('Session timed out due to inactivity'),IDLE_TIMEOUT_MS);} 

document.addEventListener('DOMContentLoaded',()=>{
  log('DOMContentLoaded fired');
  loadSettings();
  applySettings();
  loadItems();
  loadCustomers();
  bindEvents();
  updateCartDisplay();
  updateCashierInfo();
  // Hide any foreign overlays that might cover the app
  neutralizeForeignOverlays();
  installOverlayGuard();
  const badge=document.getElementById('cashierBadge');
  const login=document.getElementById('loginOverlay');
  log('Initial elements', { hasBadge: !!badge, hasLogin: !!login });
  showLogin();
  // Fallback: ensure login overlay is visible shortly after load
  setTimeout(()=>{ if(!currentCashier) { log('Retry showLogin after delay'); showLogin(); } }, 200);
  ;['click','keydown','mousemove','touchstart'].forEach(ev=>document.addEventListener(ev,resetIdleTimer,{passive:true}));
  // Capture global errors for diagnostics
  window.addEventListener('error', e=>{ err('window error', e.message||e, e.error||null); });
  window.addEventListener('unhandledrejection', e=>{ err('unhandled rejection', e.reason||e); });
  focusBarcodeInput();
});

async function loadItems(){
  try {
    const response = await fetch('/api/items');
    const data = await response.json();
    if (data.status === 'success') {
      items = (data.items || []).map(it => {
        const entry = { ...it };
        entry.item_code = entry.item_code || entry.name;
        if (entry.barcode === undefined || entry.barcode === null || entry.barcode === '') {
          entry.barcode = null;
        } else {
          entry.barcode = String(entry.barcode).trim();
        }
        return entry;
      });
      renderItems(items);
    }
  } catch (error) {
    console.error(error);
  }
}
async function loadCustomers(){ try{ const r=await fetch('/api/customers'); const d=await r.json(); if(d.status==='success'){ customers=d.customers; const b=document.getElementById('customerSelect'); const t=document.getElementById('topCustomerSelect'); customers.forEach(c=>{ if(b){const o=document.createElement('option'); o.value=c.name;o.textContent=c.customer_name;b.appendChild(o);} if(t){const o2=document.createElement('option'); o2.value=c.name;o2.textContent=c.customer_name;t.appendChild(o2);} }); setDefaultCustomer(); } }catch(e){ console.error(e);} }

function renderItems(list){ const grid=document.getElementById('itemsGrid'); if(!grid) return; grid.innerHTML=''; list.forEach(it=>{ const d=document.createElement('div'); d.className='col'; d.innerHTML=`<div class="card item-card h-100"><div class="card-body"><h5 class="card-title">${it.item_name}</h5><p class="card-text">${money(it.standard_rate)}</p><p class="card-text"><small>${it.stock_uom}</small></p></div></div>`; d.onclick=()=>openProduct(it); grid.appendChild(d); });}

function addToCart(item) {
  const existing = cart.find(ci => ci.item_code === item.name);
  if (existing) {
    existing.qty += 1;
    existing.amount = existing.qty * existing.rate;
  } else {
    cart.push({
      item_code: item.name,
      item_name: item.item_name,
      qty: 1,
      rate: item.standard_rate,
      amount: item.standard_rate,
      image: item.image || null,
      refund: false
    });
  }
  updateCartDisplay();
}

function updateQuantity(code, change) {
  const item = cart.find(i => i.item_code === code);
  if (!item) return;
  item.qty += change;
  if (item.qty <= 0) {
    cart = cart.filter(i => i.item_code !== code);
  } else {
    item.amount = item.qty * item.rate;
  }
  updateCartDisplay();
}

function removeFromCart(code) {
  cart = cart.filter(i => i.item_code !== code);
  updateCartDisplay();
}

function toggleRefund(code) {
  const item = cart.find(i => i.item_code === code);
  if (!item) return;
  item.refund = !item.refund;
  updateCartDisplay();
}

function updateCheckoutButtonState(total) {
  const btn = document.getElementById('checkoutBtn');
  if (!btn) return;
  const isRefund = total < 0;
  btn.classList.toggle('btn-danger', isRefund);
  btn.classList.toggle('btn-primary', !isRefund);
  btn.textContent = isRefund ? 'Process Refund' : 'Checkout';
}

function updateCartDisplay() {
  const wrap = document.getElementById('cartItems');
  const tot = document.getElementById('cartTotal');
  if (!wrap || !tot) return;
  wrap.innerHTML = '';
  let sum = 0;
  cart.forEach(item => {
    const isRefund = !!item.refund;
    const sign = isRefund ? -1 : 1;
    const lineTotal = sign * item.qty * item.rate;
    sum += lineTotal;
    const element = document.createElement('div');
    element.className = 'cart-item' + (isRefund ? ' refund' : '');
    const refundTag = isRefund ? '<span class="cart-refund-tag">Refund</span>' : '';
    const refundBtnLabel = isRefund ? 'Refunding' : 'Refund';
    element.innerHTML = `
      <div class="cart-item-main">
        <div class="cart-item-name">${item.item_name}${refundTag}</div>
        <div class="cart-item-meta text-muted">${money(item.rate)} each</div>
        <div class="cart-item-actions">
          <button type="button" class="refund-btn${isRefund ? ' active' : ''}" onclick="toggleRefund('${item.item_code}')">${refundBtnLabel}</button>
        </div>
      </div>
      <div class="cart-item-quantity">
        <span class="quantity-btn" onclick="updateQuantity('${item.item_code}',-1)">-</span>
        <span>${item.qty}</span>
        <span class="quantity-btn" onclick="updateQuantity('${item.item_code}',1)">+</span>
      </div>
      <div class="cart-item-total">${money(lineTotal)}</div>
      <button type="button" class="remove-btn" onclick="removeFromCart('${item.item_code}')">Remove</button>
    `;
    wrap.appendChild(element);
  });
  tot.textContent = money(sum);
  updateCheckoutButtonState(sum);
}

function findItemByCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  const matches = candidate => {
    if (!candidate) return false;
    return String(candidate).trim().toLowerCase() === normalized;
  };
  for (const item of items) {
    if (matches(item.barcode)) return item;
    if (matches(item.item_code)) return item;
    if (matches(item.name)) return item;
    if (Array.isArray(item.barcodes)) {
      const found = item.barcodes.some(bar => matches(bar.barcode || bar));
      if (found) return item;
    }
  }
  return null;
}

function showBarcodeFeedback(message, isError = false) {
  const feedback = document.getElementById('barcodeFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('error', !!isError);
  if (barcodeFeedbackTimer) clearTimeout(barcodeFeedbackTimer);
  if (message) {
    barcodeFeedbackTimer = setTimeout(() => {
      feedback.textContent = '';
      feedback.classList.remove('error');
    }, 3000);
  }
}

function focusBarcodeInput() {
  const input = document.getElementById('barcodeInput');
  if (!input) return;
  setTimeout(() => {
    if (document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }, 0);
}

function processBarcodeScan(rawValue) {
  const input = document.getElementById('barcodeInput');
  const value = String(rawValue || (input && input.value) || '').trim();
  if (!value) {
    if (input) input.value = '';
    showBarcodeFeedback('', false);
    return;
  }
  const match = findItemByCode(value);
  if (match) {
    addToCart(match);
    showBarcodeFeedback(`Added ${match.item_name || match.name || value}`, false);
    if (input) {
      input.value = '';
      input.classList.remove('is-invalid');
    }
  } else {
    showBarcodeFeedback(`No product found for "${value}"`, true);
    if (input) {
      input.classList.add('is-invalid');
      input.select();
    }
  }
  focusBarcodeInput();
}

function bindEvents(){
  // Settings/menu overlay
  const settingsBtn=document.getElementById('settingsBtn');
  const menuOverlay=document.getElementById('menuOverlay');
  const menuClose=document.getElementById('menuCloseBtn');
  const openSettingsBtn=document.getElementById('openSettingsBtn');
  const settingsView=document.getElementById('settingsView');
  const menuView=document.getElementById('menuView');
  const settingsSaveBtn=document.getElementById('settingsSaveBtn');
  const settingsBackBtn=document.getElementById('settingsBackBtn');
  const reprintLastBtn=document.getElementById('reprintLastBtn');
  if(settingsBtn&&menuOverlay){ settingsBtn.addEventListener('click',()=>{ showMenu(); }); }
  if(menuClose&&menuOverlay){ menuClose.addEventListener('click',()=>{ menuOverlay.style.display='none'; }); }
  if(openSettingsBtn){ openSettingsBtn.addEventListener('click',()=>{ if(menuView) menuView.style.display='none'; if(settingsView){ settingsView.style.display='block'; populateSettingsForm(); } }); }
  if(settingsBackBtn){ settingsBackBtn.addEventListener('click',()=>{ if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(settingsSaveBtn){ settingsSaveBtn.addEventListener('click',()=>{ saveSettingsFromForm(); applySettings(); if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(reprintLastBtn){ reprintLastBtn.addEventListener('click',()=>{ if(lastReceiptInfo) showReceiptOverlay(lastReceiptInfo); else alert('No receipt available to reprint yet.'); }); }
  // search field opens overlay
  const s=document.getElementById('itemSearch'); if(s){ s.addEventListener('focus',()=>showSearchOverlay()); s.addEventListener('input',e=>showSearchOverlay(e.target.value)); }
  // checkout
  const chk=document.getElementById('checkoutBtn'); if(chk) chk.addEventListener('click',()=>{ if(!currentCashier) return showLogin(); if(cart.length===0) return alert('Cart is empty'); openCheckoutOverlay(); });
  // clear cart
  const clr=document.getElementById('clearCartBtn'); if(clr) clr.addEventListener('click',()=>{ if(cart.length===0) return; if(confirm('Clear all items from cart?')){ cart=[]; updateCartDisplay(); }});
  // cashier badge/menu
  const badge=document.getElementById('cashierBadge'), menu=document.getElementById('cashierMenu'), logout=document.getElementById('logoutBtn');
  if(!badge) warn('cashierBadge not found');
  if(!document.getElementById('loginOverlay')) warn('loginOverlay not found');
  if(badge){ badge.addEventListener('click',e=>{ e.stopPropagation(); log('cashier badge clicked', { signedIn: !!currentCashier }); if(!currentCashier) { showLogin(); return; } if(menu) menu.classList.toggle('open'); }); }
  const badgeWrap=document.querySelector('.cashier-wrap');
  if(badgeWrap){ badgeWrap.addEventListener('click',e=>{ if(e.target!==badge && !currentCashier){ e.stopPropagation(); log('cashier wrap clicked'); showLogin(); } }); }
  if(logout){ logout.addEventListener('click',e=>{ e.stopPropagation(); if(menu) menu.classList.remove('open'); logoutToLogin(); }); }
  document.addEventListener('click',e=>{ const wrap=document.querySelector('.cashier-wrap'); if(menu&&wrap&&!wrap.contains(e.target)) menu.classList.remove('open'); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&menu) menu.classList.remove('open'); });
  // login overlay
  const login=document.getElementById('loginOverlay'); const code=document.getElementById('cashierCodeInput'); const enter=document.getElementById('loginEnterBtn'); const err=document.getElementById('loginError');
  if(login&&code&&enter){ enter.addEventListener('click',attemptLogin); code.addEventListener('keydown',e=>{ if(e.key==='Enter') attemptLogin(); }); login.querySelectorAll('.key-btn').forEach(b=>b.addEventListener('click',()=>{ const k=b.getAttribute('data-key'); if(k==='C'){ code.value=''; err.style.display='none'; } else if(k==='B'){ code.value=code.value.slice(0,-1);} else { code.value+=k; } })); }
  // search overlay
  const so=document.getElementById('searchOverlay'), sb=document.getElementById('searchInputBig'), bf=document.getElementById('brandFilter'), sc=document.getElementById('searchCloseBtn');
  if(so){ if(sb) sb.addEventListener('input',renderSearchResults); if(bf) bf.addEventListener('change',renderSearchResults); if(sc) sc.addEventListener('click',hideSearchOverlay); document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideSearchOverlay(); }); so.addEventListener('click',e=>{ if(e.target===so) hideSearchOverlay(); }); }
  // barcode scanner bar
  const barcodeInput = document.getElementById('barcodeInput');
  const barcodeButton = document.getElementById('barcodeAddBtn');
  if (barcodeInput) {
    barcodeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        processBarcodeScan(barcodeInput.value);
      }
    });
    barcodeInput.addEventListener('focus', () => {
      barcodeInput.classList.remove('is-invalid');
      showBarcodeFeedback('', false);
    });
    barcodeInput.addEventListener('input', () => {
      barcodeInput.classList.remove('is-invalid');
    });
  }
  if (barcodeButton) {
    barcodeButton.addEventListener('click', () => {
      processBarcodeScan(barcodeInput && barcodeInput.value);
    });
  }
  // product overlay
  const po=document.getElementById('productOverlay'), pc=document.getElementById('productCloseBtn'); if(po){ if(pc) pc.addEventListener('click',hideProductOverlay); po.addEventListener('click',e=>{ if(e.target===po) hideProductOverlay(); }); document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideProductOverlay(); }); }
  // checkout overlay
  const co=document.getElementById('checkoutOverlay'), cc=document.getElementById('checkoutCloseBtn'), cs=document.getElementById('completeSaleBtn');
  if(co){ if(cc) cc.addEventListener('click',hideCheckoutOverlay); co.addEventListener('click',e=>{ if(e.target===co) hideCheckoutOverlay(); }); document.querySelectorAll('.tender-btn').forEach(b=>b.addEventListener('click',()=>selectTender(b.getAttribute('data-tender')))); co.querySelectorAll('.denom-btn').forEach(b=>b.addEventListener('click',()=>{ const a=Number(b.getAttribute('data-amount'))||0; addCashAmount(denomSubtract?-a:a); })); const sub=document.getElementById('toggleSubtractBtn'); if(sub){ sub.addEventListener('click',()=>{ denomSubtract=!denomSubtract; sub.classList.toggle('active',denomSubtract); sub.textContent = denomSubtract ? '- Mode (On)' : '- Mode'; }); } if(cs) cs.addEventListener('click',completeSaleFromOverlay); }
  layoutCashPanel();
  window.addEventListener('resize', layoutCashPanel);
  // cash input typing and keypad toggle
  const cashInputField = document.getElementById('cashInputField');
  if (cashInputField) cashInputField.addEventListener('input', ()=> { cashInput = (cashInputField.value || '').toString(); updateCashSection(); });
  const toggleKeypadBtn = document.getElementById('toggleKeypadBtn');
  const cashKeypad = document.getElementById('cashKeypad');
  const cashSection = document.getElementById('cashSection');
  if (toggleKeypadBtn && cashKeypad && cashSection) {
    toggleKeypadBtn.addEventListener('click', ()=>{
      const willShow = !cashSection.classList.contains('show-keypad');
      cashSection.classList.toggle('show-keypad', willShow);
      toggleKeypadBtn.textContent = willShow ? 'Hide Keypad' : 'Show Keypad';
      layoutCashPanel();
    });
    cashKeypad.querySelectorAll('.key-btn').forEach(btn => {
      btn.addEventListener('click', ()=>{
        const k = btn.getAttribute('data-k');
        if (k === 'C') { cashInput = ''; }
        else if (k === 'B') { cashInput = (cashInput || '').toString().slice(0,-1); }
        else { cashInput = (cashInput || '').toString() + k; }
        if (cashInputField) cashInputField.value = cashInput;
        updateCashSection();
      });
    });
  }
  // voucher overlay
  const vo=document.getElementById('voucherOverlay'), vclose=document.getElementById('voucherCloseBtn'), vsubmit=document.getElementById('voucherSubmitBtn'), vinput=document.getElementById('voucherCodeInput');
  if(vo){ if(vclose) vclose.addEventListener('click',hideVoucherOverlay); if(vsubmit) vsubmit.addEventListener('click',submitVoucher); if(vinput) vinput.addEventListener('keydown',e=>{ if(e.key==='Enter') submitVoucher(); }); document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideVoucherOverlay(); }); vo.addEventListener('click',e=>{ if(e.target===vo) hideVoucherOverlay(); }); }
}

function showMenu(){ const o=document.getElementById('menuOverlay'); const mv=document.getElementById('menuView'); const sv=document.getElementById('settingsView'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); if(mv) mv.style.display='block'; if(sv) sv.style.display='none'; o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){} }
function loadSettings(){ try{ const raw=localStorage.getItem('pos_settings'); if(raw){ const s=JSON.parse(raw); settings = Object.assign({ till_number:'', dark_mode:false, auto_print:false }, s); } }catch(e){} }
function saveSettings(){ try{ localStorage.setItem('pos_settings', JSON.stringify(settings)); }catch(e){} }
function populateSettingsForm(){ const till=document.getElementById('tillNumberInput'); const dark=document.getElementById('darkModeSwitch'); const auto=document.getElementById('autoPrintSwitch'); if(till) till.value = settings.till_number || ''; if(dark) dark.checked = !!settings.dark_mode; if(auto) auto.checked = !!settings.auto_print; }
function saveSettingsFromForm(){ const till=document.getElementById('tillNumberInput'); const dark=document.getElementById('darkModeSwitch'); const auto=document.getElementById('autoPrintSwitch'); settings.till_number = till ? till.value.trim() : ''; settings.dark_mode = dark ? !!dark.checked : false; settings.auto_print = auto ? !!auto.checked : false; saveSettings(); }
function applySettings(){ document.body.classList.toggle('dark-mode', !!settings.dark_mode); }

// Search overlay
function showSearchOverlay(q=''){ const o=document.getElementById('searchOverlay'), i=document.getElementById('searchInputBig'), b=document.getElementById('brandFilter'); if(!o||!i||!b) return; o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){} const brands=[...new Set(items.map(it=>it.brand||'Unbranded'))].sort(); b.innerHTML='<option value="">All Brands</option>'+brands.map(x=>`<option value="${x}">${x}</option>`).join(''); i.value=q; renderSearchResults(); setTimeout(()=>i.focus(),0);} 
function hideSearchOverlay(){ const o=document.getElementById('searchOverlay'); if(o) o.style.display='none'; }
function renderSearchResults(){ const g=document.getElementById('searchGrid'), i=document.getElementById('searchInputBig'), b=document.getElementById('brandFilter'); if(!g) return; let list=items.slice(); const q=(i&&i.value||'').toLowerCase(); const br=(b&&b.value)||''; if(q) list=list.filter(x=>x.item_name.toLowerCase().includes(q)); if(br) list=list.filter(x=>(x.brand||'Unbranded')===br); g.innerHTML=''; list.forEach(it=>{ const c=document.createElement('div'); c.className='col'; const imgStyle=it.image?`style="background-image:url('${it.image}')"`:''; c.innerHTML=`<div class="product-card" onclick='selectProduct("${it.name}")'><div class="product-img" ${imgStyle}></div><div class="fw-semibold">${it.item_name}</div><div class="text-muted small">${it.brand||'Unbranded'}</div><div class="mt-1">${money(it.standard_rate)}</div></div>`; g.appendChild(c); }); }
function selectProduct(name){ const it=items.find(x=>x.name===name); if(it) openProduct(it); }

// Product detail overlay
let currentProduct=null;
async function openProduct(item){ currentProduct=item; const o=document.getElementById('productOverlay'), t=document.getElementById('productTitle'), im=document.getElementById('productImage'), br=document.getElementById('productBrand'), pr=document.getElementById('productPrice'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); t.textContent=item.item_name; br.textContent=item.brand||''; pr.textContent=money(item.standard_rate); im.style.backgroundImage=item.image?`url('${item.image}')`:''; o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){} try{ const r=await fetch(`/api/item_matrix?item=${encodeURIComponent(item.name)}`); const d=await r.json(); if(d.status==='success') renderVariantMatrix(item,d.data);}catch(e){ console.error(e);} }
function hideProductOverlay(){ const o=document.getElementById('productOverlay'); if(o) o.style.display='none'; }
function renderVariantMatrix(item,m){ const h=document.getElementById('matrixHead'), b=document.getElementById('matrixBody'); if(!h||!b) return; h.innerHTML=''; const tr=document.createElement('tr'); ['Colour','Width',...(m.sizes||[])].forEach(x=>{ const th=document.createElement('th'); th.textContent=x; tr.appendChild(th);}); h.appendChild(tr); b.innerHTML=''; (m.colors||[]).forEach(color=>{ (m.widths||[]).forEach(width=>{ const row=document.createElement('tr'); const tc=document.createElement('th'); tc.textContent=color; row.appendChild(tc); const tw=document.createElement('th'); tw.textContent=width; row.appendChild(tw); (m.sizes||[]).forEach(sz=>{ const key=`${color}|${width}|${sz}`; const qty=(m.stock&&m.stock[key])||0; const td=document.createElement('td'); td.className='variant-cell'+(qty<=0?' disabled':''); td.textContent=qty; if(qty>0){ td.addEventListener('click',()=>addVariantToCart(item,{color,width,size:sz,qtyAvailable:qty})); } row.appendChild(td); }); b.appendChild(row); }); }); }
function addVariantToCart(item, variant){
  const name = `${item.item_name} - ${variant.color} - ${variant.width} - ${variant.size}`;
  const code = `${item.name}-${variant.color}-${variant.width}-${variant.size}`;
  const existing = cart.find(ci => ci.item_code === code);
  const rate = item.standard_rate;
  if (existing) {
    existing.qty += 1;
    existing.amount = existing.qty * existing.rate;
  } else {
    cart.push({
      item_code: code,
      item_name: name,
      qty: 1,
      rate,
      amount: rate,
      image: item.image || null,
      variant,
      refund: false
    });
  }
  updateCartDisplay();
}

// Checkout overlay
function openCheckoutOverlay(){
  const o=document.getElementById('checkoutOverlay');
  const c=document.getElementById('checkoutCart');
  if(!o||!c) return;
  // reset tender selection; user must choose
  currentTender = '';
  document.querySelectorAll('.tender-btn').forEach(b=>b.classList.remove('active'));
  const cashSection = document.getElementById('cashSection');
  if (cashSection) { cashSection.style.display = 'none'; cashSection.classList.remove('show-keypad'); }
  const toggleKeypadBtn = document.getElementById('toggleKeypadBtn');
  if (toggleKeypadBtn) toggleKeypadBtn.textContent = 'Show Keypad';
  renderCheckoutCart();
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); const r=o.getBoundingClientRect(); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity, rect: { x:r.x, y:r.y, w:r.width, h:r.height } }); } catch(_){}
}
function hideCheckoutOverlay(){ const o=document.getElementById('checkoutOverlay'); if(o) o.style.display='none'; cashInput=''; }
function renderCheckoutCart() {
  const el = document.getElementById('checkoutCart');
  if (!el) return;
  el.innerHTML = '';
  cart.forEach(item => {
    const isRefund = !!item.refund;
    const sign = isRefund ? -1 : 1;
    const lineTotal = sign * item.qty * item.rate;
    const row = document.createElement('div');
    row.className = 'checkout-item' + (isRefund ? ' refund' : '');
    const img = document.createElement('div');
    img.className = 'img';
    if (item.image) img.style.backgroundImage = `url('${item.image}')`;
    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.item_name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.qty} x ${money(item.rate)}${isRefund ? ' (refund)' : ''}`;
    details.appendChild(name);
    details.appendChild(meta);
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = money(lineTotal);
    row.appendChild(img);
    row.appendChild(details);
    row.appendChild(price);
    el.appendChild(row);
  });
  updateCashSection();
}

function updateCashSection() {
  const due = document.getElementById('amountDue');
  const cashEl = document.getElementById('amountCash');
  const changeEl = document.getElementById('amountChange');
  const cashBtn = document.getElementById('tenderCashBtn');
  const clear = document.getElementById('clearCashBtn');
  const voucherList = Array.isArray(vouchers) ? vouchers : [];
  const total = cart.reduce((sum, item) => sum + (item.qty * item.rate * (item.refund ? -1 : 1)), 0);
  const voucherTotal = voucherList.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const net = total - voucherTotal;
  if (due) due.textContent = money(net);
  const cashVal = Number(cashInput || 0);
  if (cashEl) cashEl.textContent = money(cashVal);
  const amountToCollect = net > 0 ? net : 0;
  if (changeEl) changeEl.textContent = money(Math.max(0, cashVal - amountToCollect));
  if (cashBtn) cashBtn.textContent = `${money(cashVal)} Cash`;
  if (clear) clear.onclick = () => { cashInput = ''; updateCashSection(); };
}

async function completeSaleFromOverlay() {
  let customer = '';
  const topSelect = document.getElementById('topCustomerSelect');
  const bottomSelect = document.getElementById('customerSelect');
  if (topSelect && topSelect.value) customer = topSelect.value;
  else if (bottomSelect && bottomSelect.value) customer = bottomSelect.value;
  if (!customer) customer = getDefaultCustomerValue();
  if (cart.length === 0) { alert('Cart is empty'); return; }

  const voucherList = Array.isArray(vouchers) ? vouchers : [];
  const total = cart.reduce((sum, item) => sum + (item.qty * item.rate * (item.refund ? -1 : 1)), 0);
  const voucherTotal = voucherList.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const net = total - voucherTotal;
  const amountToCollect = net > 0 ? net : 0;
  const isRefund = net < 0;

  let payments = [];
  voucherList.forEach(v => {
    payments.push({ mode_of_payment: 'Voucher', amount: Number(v.amount), reference_no: v.code });
  });

  let tender = currentTender;
  if (!tender) {
    if (isRefund) {
      tender = 'cash';
    } else {
      alert('Please select a tender type.');
      return;
    }
  }

  if (tender === 'cash') {
    const cashVal = Number(cashInput || 0);
    if (amountToCollect > 0 && cashVal < amountToCollect) {
      alert('Cash is less than remaining due');
      return;
    }
    if (amountToCollect > 0) {
      payments.push({ mode_of_payment: 'Cash', amount: amountToCollect });
    }
  } else if (tender === 'card') {
    if (amountToCollect > 0) payments.push({ mode_of_payment: 'Card', amount: amountToCollect });
  } else if (tender === 'other') {
    if (amountToCollect > 0) payments.push({ mode_of_payment: 'Other', amount: amountToCollect });
  } else if (tender === 'voucher') {
    if (amountToCollect > 0) {
      alert('Remaining due after vouchers. Select Cash or Card for the remainder.');
      return;
    }
  }

  const payload = {
    customer,
    items: cart.map(i => ({
      item_code: i.item_code,
      qty: i.refund ? -Math.abs(i.qty) : i.qty,
      rate: i.rate
    })),
    payments,
    tender,
    cash_given: tender === 'cash' ? Number(cashInput || 0) : null,
    change: tender === 'cash'
      ? (amountToCollect > 0 ? Number(cashInput || 0) - amountToCollect : Math.abs(net))
      : 0,
    total: net,
    vouchers,
    till_number: settings.till_number
  };

  try {
    const response = await fetch('/api/create-sale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.status === 'success') {
      const cashVal = Number(cashInput || 0);
      const changeVal = tender === 'cash'
        ? (amountToCollect > 0 ? cashVal - amountToCollect : Math.abs(net))
        : 0;
      const info = { invoice: data.invoice_name || 'N/A', change: changeVal };
      lastReceiptInfo = info;
      showReceiptOverlay(info);
      if (settings.auto_print) {
        setTimeout(() => window.print(), 50);
      }
    } else {
      alert('Error: ' + data.message);
    }
  } catch (error) {
    console.error(error);
    alert('Error creating sale. Please try again.');
  }
}

// Voucher overlay
function openVoucherOverlay(){
  const overlay = document.getElementById('voucherOverlay');
  const codeInput = document.getElementById('voucherCodeInput');
  const amountInput = document.getElementById('voucherAmountInput');
  if (!overlay) { err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays();
  const voucherList = Array.isArray(vouchers) ? vouchers : [];
  const total = cart.reduce((sum, item) => sum + (item.qty * item.rate * (item.refund ? -1 : 1)), 0);
  const voucherTotal = voucherList.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const net = total - voucherTotal;
  const suggested = Math.max(0, net);
  overlay.style.display = 'flex';
  overlay.style.visibility = 'visible';
  overlay.style.opacity = '1';
  try {
    const cs = getComputedStyle(overlay);
    log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity });
  } catch (_) {}
  if (codeInput) {
    codeInput.value = '';
    setTimeout(() => codeInput.focus(), 0);
  }
  if (amountInput) {
    amountInput.value = suggested.toFixed(2);
  }
}

function hideVoucherOverlay(){ const o=document.getElementById('voucherOverlay'); if(o) o.style.display='none'; }
function submitVoucher(){
  const codeEl = document.getElementById('voucherCodeInput');
  const amountEl = document.getElementById('voucherAmountInput');
  const btn = document.getElementById('tenderVoucherBtn');
  const code = (codeEl && codeEl.value.trim()) || '';
  const amount = Number(amountEl && amountEl.value) || 0;
  if (!code) return alert('Please enter or scan a voucher code.');
  if (amount <= 0) return alert('Please enter a voucher amount greater than 0.');
  const voucherList = Array.isArray(vouchers) ? vouchers : [];
  const total = cart.reduce((sum, item) => sum + (item.qty * item.rate * (item.refund ? -1 : 1)), 0);
  const voucherTotal = voucherList.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const remaining = Math.max(0, total - voucherTotal);
  const applied = Math.min(amount, remaining);
  vouchers.push({ code, amount: applied });
  if (btn) btn.textContent = `Voucher (${vouchers.length})`;
  hideVoucherOverlay();
  updateCashSection();
}

// Cashier/login helpers
function getDefaultCustomerValue(){ if(!customers||customers.length===0) return ''; const w=customers.find(c=>(c.name||'').toUpperCase().includes('WALKIN') || (c.customer_name||'').toLowerCase()==='walk-in customer'); return w?w.name:(customers[0]&&customers[0].name?customers[0].name:''); }
function setDefaultCustomer(){ const b=document.getElementById('customerSelect'), t=document.getElementById('topCustomerSelect'); const v=getDefaultCustomerValue(); if(v){ if(b) b.value=v; if(t) t.value=v; } }
function attemptLogin(){ const code=document.getElementById('cashierCodeInput'), err=document.getElementById('loginError'); const v=(code.value||'').trim(); if(!v){ err.textContent='Please enter a code'; err.style.display='block'; return; } const name=CASHIER_CODES[v]||`Cashier ${v}`; currentCashier={code:v,name}; updateCashierInfo(); hideLogin(); resetIdleTimer(); }
function updateCashierInfo(){
  const b=document.getElementById('cashierBadge');
  if(!b) return;
  if(currentCashier){
    b.textContent = `${currentCashier.code} \u2014 ${currentCashier.name}`;
    b.classList.remove('btn-light');
    b.classList.add('btn-success');
    b.title = 'Click to change cashier';
  } else {
    b.textContent = 'Not signed in';
    b.classList.remove('btn-success');
    b.classList.add('btn-light');
    b.title = 'Click to sign in';
  }
}
function showLogin(){
  const o=document.getElementById('loginOverlay');
  const i=document.getElementById('cashierCodeInput');
  const e=document.getElementById('loginError');
  if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays();
  // Ensure other overlays are closed so login isn't obscured
  const overlays=['searchOverlay','productOverlay','checkoutOverlay','voucherOverlay','menuOverlay','receiptOverlay'];
  overlays.forEach(id=>{ const el=document.getElementById(id); if(el) el.style.display='none'; });
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); const r=o.getBoundingClientRect(); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity, rect: { x:r.x, y:r.y, w:r.width, h:r.height } }); } catch(_){}
  if(i){ i.value=''; setTimeout(()=>i.focus(),0); }
  if(e) e.style.display='none';
}
function hideLogin(){
  const o = document.getElementById('loginOverlay');
  if (o) o.style.display = 'none';
  focusBarcodeInput();
}
function logoutToLogin(reason){ cart=[]; updateCartDisplay(); setDefaultCustomer(); const s=document.getElementById('itemSearch'); if(s) s.value=''; currentCashier=null; updateCashierInfo(); showLogin(); if(reason){ const e=document.getElementById('loginError'); if(e){ e.textContent=reason; e.style.display='block'; } } }

// Receipt overlay
function showReceiptOverlay(info){ const o=document.getElementById('receiptOverlay'); const inv=document.getElementById('receiptInvoice'); const ch=document.getElementById('receiptChange'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); if(inv) inv.textContent = info.invoice || 'N/A'; if(ch) ch.textContent = money(info.change || 0); o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); const r=o.getBoundingClientRect(); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity, rect: { x:r.x, y:r.y, w:r.width, h:r.height } }); } catch(_){}
  const printBtn=document.getElementById('printReceiptBtn'); const doneBtn=document.getElementById('receiptDoneBtn'); const closeBtn=document.getElementById('receiptCloseBtn');
  if(printBtn) printBtn.onclick = ()=>{
    const giftEl = document.getElementById('giftReceiptCheckbox');
    const wantsGift = giftEl && giftEl.checked;
    if(!wantsGift){ window.print(); return; }
    document.body.classList.add('gift-receipt');
    window.print();
    setTimeout(()=>{ document.body.classList.remove('gift-receipt'); window.print(); }, 400);
  };
  const finish = ()=>{ o.style.display='none'; hideCheckoutOverlay(); cart=[]; updateCartDisplay(); logoutToLogin(); };
  if(doneBtn) doneBtn.onclick = finish; if(closeBtn) closeBtn.onclick = finish;
}
function layoutCashPanel(){
  const panel = document.querySelector('.tender-panel');
  const actions = document.querySelector('.tender-actions');
  const cashSection = document.getElementById('cashSection');
  if (!panel || !cashSection || cashSection.style.display==='none') return;
  const keypad = document.getElementById('cashKeypad');
  const denom = cashSection.querySelector('.denom-row');
  const controls = document.querySelector('.cash-controls');
  const totalsH = Array.from(cashSection.querySelectorAll('.d-flex.justify-content-between')).reduce((s,el)=>s+el.offsetHeight,0);
  const ctrlH = controls ? controls.offsetHeight : 0;
  const actH = actions ? actions.offsetHeight : 0;
  const padding = 24;
  const available = panel.clientHeight - (totalsH + ctrlH + actH + padding);
  const target = (cashSection.classList.contains('show-keypad')) ? keypad : denom;
  if (target && available > 0){ target.style.maxHeight = available + 'px'; target.style.overflowY = 'auto'; }
}

// Debug wrappers and exports
try {
  if (typeof window !== 'undefined'){
    window.__posDebug = {
      showLogin: ()=>{ try{ log('debug: invoking showLogin'); }catch(_){}; try{ return showLogin(); }catch(e){ err('showLogin threw', e); } },
      state: ()=>({ currentCashier, overlays: {
        login: document.getElementById('loginOverlay')?.style.display,
        search: document.getElementById('searchOverlay')?.style.display,
        product: document.getElementById('productOverlay')?.style.display,
        checkout: document.getElementById('checkoutOverlay')?.style.display,
        voucher: document.getElementById('voucherOverlay')?.style.display,
        receipt: document.getElementById('receiptOverlay')?.style.display,
      }})
    };
  }
} catch(_) {}








