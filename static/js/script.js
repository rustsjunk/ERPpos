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
let currentCashierSession = null;
let sessionPingTimer = null;
let sessionPingIntervalMs = 60 * 1000;
const FEATURED_ITEM_LIMIT = 12;
const RECENT_SALES_LIMIT = 3;
const giftVoucherItemCode = (document.documentElement && document.documentElement.dataset
  && document.documentElement.dataset.giftVoucherItem)
  ? document.documentElement.dataset.giftVoucherItem
  : 'GIFT-VOUCHER';
let recentSalesHistory = [];

// Checkout state
let currentTender = '';
let cashInput = '';
let denomSubtract = false;
let vouchers = [];
let issuedVouchers = [];
let pendingVoucherBalancePrints = [];
const CLOSING_DENOM_VALUES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
let voucherOverlayMode = 'redeem'; // 'redeem' | 'issue_refund' | 'issue_sale'
let voucherSaleMode = false;
let appliedPayments = [];
let cashEntryDirty = false;
let otherEntryDirty = false;
let barcodeFeedbackTimer = null;
let barcodeScanInProgress = false;

// Currency conversion state
let eurConversionData = null;  // { eur_exact, eur_round_up, eur_round_down, store_rate, gbp_total }
let eurConversionActive = false;  // Whether EUR conversion is currently being used
let saleEffectiveRate = null;  // Effective rate chosen for this sale (eur_target / gbp_total)
let eurSelectedMode = null;
let eurExpectedAmount = 0;
const DEFAULT_STORE_RATE = 1.30;
let cachedStoreRate = null;
let cachedStoreRateFetchedAt = 0;
const STORE_RATE_TTL_MS = 60 * 60 * 1000; // cache live rates for 1 hour
if (typeof window !== 'undefined') {
  window.saleEurMetadata = null;
}
function pickAttribute(attrs, keys){
  if(!attrs) return '';
  for(const key of keys){
    if(attrs[key]) return attrs[key];
  }
  return '';
}
function displayNameFrom(baseName, attrs){
  try{
    const a = attrs || {};
    const color = pickAttribute(a, ['Color','Colour','color','colour']);
    const width = pickAttribute(a, ['Width','width','Fit']);
    const size = pickAttribute(a, ['Size','EU half Sizes','UK half Sizes','eu half sizes','uk half sizes','size']);
    const parts = [color, width, size].filter(Boolean);
    const suffix = parts.length ? (' - ' + parts.join(' - ')) : '';
    const name = String(baseName||'');
    if(suffix && name.endsWith(suffix)) return name;
    return (name + suffix).trim();
  }catch(_){ return String(baseName||''); }
}

function hasSellableStock(item){
  if(!item) return false;
  const qty = Number(item.variant_stock != null ? item.variant_stock : (item.stock_qty != null ? item.stock_qty : item.qty));
  if(Number.isFinite(qty)){
    return qty > 0;
  }
  return true;
}

function isShowZeroStockEnabled(){
  return !!(settings && settings.show_zero_stock);
}

function getVisibleItems(){
  return isShowZeroStockEnabled() ? items.slice() : items.filter(hasSellableStock);
}

function setShowZeroStock(show){
  if(!settings) settings = {};
  settings.show_zero_stock = !!show;
  const zeroToggle = document.getElementById('zeroStockToggle');
  if(zeroToggle){
    zeroToggle.checked = !!show;
  }
  saveSettings();
  renderItems(items);
  refreshBrandFilterOptions();
  try { renderSearchResults(); } catch(_){}
}

const DEFAULT_VOUCHER_FUN_LINE = 'Thanks for sharing the joy!';

function normalizeReceiptLines(value){
  if(!value) return [];
  if(Array.isArray(value)){
    return value.map(v=> (v == null ? '' : String(v).trim())).filter(Boolean);
  }
  if(typeof value === 'string'){
    return value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  }
  return [];
}

function standardReceiptHeaderLines(){
  return normalizeReceiptLines(settings && settings.receipt_header);
}

function standardReceiptFooterLines(){
  return normalizeReceiptLines(settings && settings.receipt_footer);
}

function resolveReceiptLines(primary, secondary, fallback){
  const first = normalizeReceiptLines(primary);
  if(first.length) return first;
  const second = normalizeReceiptLines(secondary);
  if(second.length) return second;
  if(fallback === undefined) return [];
  return Array.isArray(fallback)
    ? normalizeReceiptLines(fallback)
    : normalizeReceiptLines(fallback);
}

function defaultVoucherFunLine(){
  const custom = settings && typeof settings.voucher_fun_line === 'string' ? settings.voucher_fun_line.trim() : '';
  return custom || DEFAULT_VOUCHER_FUN_LINE;
}

function refreshBrandFilterOptions(){
  const select = document.getElementById('brandFilter');
  if(!select) return;
  const previous = select.value || '';
  const brands = Array.from(new Set(getVisibleItems().map(it => (it.brand || 'Unbranded')))).sort();
  select.innerHTML = '<option value="">All Brands</option>' + brands.map(name => `<option value="${name}">${name}</option>`).join('');
  if(previous && brands.includes(previous)){
    select.value = previous;
  }
}

// ========== Currency Conversion Helpers ==========

async function fetchCurrencyRate(base = 'GBP', target = 'EUR') {
  try {
    const resp = await fetch(`/api/currency/rates?base=${base}&target=${target}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status === 'success' ? data.rate : null;
  } catch (e) {
    err('Failed to fetch currency rate:', e);
    return null;
  }
}

async function getStoreCurrencyRate(base = 'GBP', target = 'EUR') {
  const now = Date.now();
  if (cachedStoreRate && (now - cachedStoreRateFetchedAt) < STORE_RATE_TTL_MS) {
    return cachedStoreRate;
  }
  const live = await fetchCurrencyRate(base, target);
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
    cachedStoreRate = live;
    cachedStoreRateFetchedAt = now;
    try {
      if (settings) {
        settings.currency_rate = live;
        settings.currency_rate_updated = new Date().toISOString();
        saveSettings();
      }
    } catch (_){}
    return live;
  }
  const persisted = settings && settings.currency_rate ? Number(settings.currency_rate) : null;
  if (persisted && Number.isFinite(persisted) && persisted > 0) {
    cachedStoreRate = persisted;
    cachedStoreRateFetchedAt = now;
    return persisted;
  }
  warn('Falling back to default EUR store rate; live rate unavailable');
  return DEFAULT_STORE_RATE;
}

async function convertCurrency(amount, base = 'GBP', target = 'EUR', roundMode = 'nearest') {
  try {
    const resp = await fetch('/api/currency/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, base, target, round_mode: roundMode })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status === 'success' ? data.conversion : null;
  } catch (e) {
    err('Failed to convert currency:', e);
    return null;
  }
}

async function fetchEurSuggestions(gbpTotal, storeRate) {
  /**
   * Fetch EUR rounding suggestions (round up/down to nearest 5 EUR).
   */
  try {
    const resp = await fetch('/api/currency/eur-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gbp_total: gbpTotal, store_rate: storeRate })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status === 'success' ? data : null;
  } catch (e) {
    err('Failed to fetch EUR suggestions:', e);
    return null;
  }
}

function resetEurTenderState() {
  eurSelectedMode = null;
  eurExpectedAmount = 0;
  if (!eurConversionActive) {
    saleEffectiveRate = null;
  }
  const input = document.getElementById('eurReceivedInput');
  if (input) {
    resetNumericInput(input, '0.00');
  }
  const applyBtn = document.getElementById('eurApplyBtn');
  if (applyBtn) {
    applyBtn.textContent = 'Apply EUR Tender';
    applyBtn.disabled = true;
  }
  const status = document.getElementById('eurOverlayStatus');
  if (status) status.textContent = 'Select a rate option to begin.';
  updateEurOptionUI();
  updateEurEffectiveRateDisplay();
  updateEurDifferenceUI();
}

function showEurOverlay() {
  const overlay = document.getElementById('eurConverterOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.style.visibility = 'visible';
  overlay.style.opacity = '1';
}

function hideEurOverlay() {
  const overlay = document.getElementById('eurConverterOverlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.style.visibility = 'hidden';
  overlay.style.opacity = '0';
  resetEurTenderState();
}

function isEurOverlayVisible() {
  const overlay = document.getElementById('eurConverterOverlay');
  if (!overlay) return false;
  return overlay.style.display && overlay.style.display !== 'none';
}

function updateEurOptionUI() {
  try {
    document.querySelectorAll('[data-eur-option]').forEach(btn => {
      const mode = btn.getAttribute('data-eur-option');
      btn.classList.toggle('active', mode === eurSelectedMode);
    });
  } catch (_){}
  const expectedEl = document.getElementById('eurExpectedAmount');
  if (expectedEl) {
    expectedEl.textContent = eurExpectedAmount > 0 ? `€${eurExpectedAmount.toFixed(2)}` : '--';
  }
}

function selectEurOption(mode) {
  if (!eurConversionData) {
    alert('No EUR conversion data available. Close and retry.');
    return;
  }
  const gbpTotal = eurConversionData.gbp_total || 0;
  if (gbpTotal <= 0) {
    alert('Invalid GBP total');
    return;
  }
  let target = 0;
  if (mode === 'exact') {
    target = eurConversionData.eur_exact || 0;
  } else if (mode === 'up') {
    target = eurConversionData.eur_round_up || 0;
  } else {
    target = eurConversionData.eur_round_down || 0;
  }
  if (target <= 0) {
    alert('Unable to use this rate option. Please choose another.');
    return;
  }
  eurSelectedMode = mode;
  eurExpectedAmount = Number(target.toFixed(2));
  saleEffectiveRate = Number((eurExpectedAmount / gbpTotal).toFixed(4));
  updateEurOptionUI();
  updateEurEffectiveRateDisplay();
  updateEurDifferenceUI();
}

function getEurReceivedAmount() {
  const input = document.getElementById('eurReceivedInput');
  if (!input) return 0;
  const raw = Number(input.value || 0);
  return Number.isFinite(raw) ? raw : 0;
}

function updateEurDifferenceUI() {
  const statusEl = document.getElementById('eurDifferenceStatus');
  const sterlingEl = document.getElementById('eurSterlingImpact');
  const actualEl = document.getElementById('eurActualGbp');
  const applyBtn = document.getElementById('eurApplyBtn');
  const actual = getEurReceivedAmount();
  const effectiveRate = saleEffectiveRate || 0;
  let statusText = 'Select a rate to continue.';
  let sterlingText = '--';
  if (actualEl) {
    if (effectiveRate > 0 && actual > 0) {
      const gbp = Number((actual / effectiveRate).toFixed(2));
      actualEl.textContent = `€${actual.toFixed(2)} ≈ £${gbp.toFixed(2)}`;
    } else {
      actualEl.textContent = '€0.00 ≈ £0.00';
    }
  }
  if (!eurSelectedMode || eurExpectedAmount <= 0 || effectiveRate <= 0) {
    if (statusEl) statusEl.textContent = statusText;
    const overlayStatus = document.getElementById('eurOverlayStatus');
    if (overlayStatus) overlayStatus.textContent = statusText;
    if (sterlingEl) sterlingEl.textContent = sterlingText;
    if (applyBtn) {
      applyBtn.textContent = 'Apply EUR Tender';
      applyBtn.disabled = true;
    }
    return;
  }
  if (actual <= 0) {
    statusText = 'Enter the EUR amount presented.';
    if (statusEl) statusEl.textContent = statusText;
    const overlayStatus = document.getElementById('eurOverlayStatus');
    if (overlayStatus) overlayStatus.textContent = statusText;
    if (sterlingEl) sterlingEl.textContent = sterlingText;
    if (applyBtn) {
      applyBtn.textContent = 'Apply EUR Tender';
      applyBtn.disabled = true;
    }
    return;
  }
  const eurDiff = Number((actual - eurExpectedAmount).toFixed(2));
  const gbpDiff = Number((eurDiff / effectiveRate).toFixed(2));
  if (Math.abs(eurDiff) < 0.01) {
    statusText = 'Exact amount received.';
    sterlingText = 'No GBP adjustment required.';
  } else if (eurDiff > 0) {
    statusText = `Over by €${eurDiff.toFixed(2)}`;
    sterlingText = `Give £${Math.abs(gbpDiff).toFixed(2)} change`;
  } else {
    statusText = `Short by €${Math.abs(eurDiff).toFixed(2)}`;
    sterlingText = `Still due £${Math.abs(gbpDiff).toFixed(2)}`;
  }
  if (statusEl) statusEl.textContent = statusText;
  const overlayStatus = document.getElementById('eurOverlayStatus');
  if (overlayStatus) overlayStatus.textContent = statusText;
  if (sterlingEl) sterlingEl.textContent = sterlingText;
  if (applyBtn) {
    applyBtn.textContent = `Apply €${actual.toFixed(2)}`;
    applyBtn.disabled = false;
  }
}

function fillEurWithExpected() {
  if (eurExpectedAmount <= 0) return;
  const input = document.getElementById('eurReceivedInput');
  if (!input) return;
  const cents = Math.round(eurExpectedAmount * 100);
  _setFromCents(input, cents);
  updateEurDifferenceUI();
}

function applySelectedEurTender() {
  if (!eurConversionData) {
    alert('No EUR conversion data available');
    return;
  }
  if (!eurSelectedMode || eurExpectedAmount <= 0 || !saleEffectiveRate) {
    alert('Select a rate before applying.');
    return;
  }
  const actual = getEurReceivedAmount();
  if (actual <= 0) {
    alert('Enter the EUR amount received.');
    return;
  }
  const gbpTotal = eurConversionData.gbp_total || 0;
  const gbpEquivalent = Number((actual / saleEffectiveRate).toFixed(2));
  const eurDiff = Number((actual - eurExpectedAmount).toFixed(2));
  const gbpDiff = Number((gbpEquivalent - gbpTotal).toFixed(2));
  appliedPayments.push({
    mode_of_payment: 'Cash',
    amount: gbpEquivalent,
    reference_no: null,
    currency: 'EUR',
    amount_eur: Number(actual.toFixed(2)),
    eur_rate: saleEffectiveRate,
    currency_rate: saleEffectiveRate,
    meta: {
      currency: 'EUR',
      eur_amount: Number(actual.toFixed(2)),
      eur_rate: saleEffectiveRate,
      gbp_equivalent: gbpEquivalent,
      eur_expected: eurExpectedAmount,
      eur_diff: eurDiff,
      gbp_diff: gbpDiff
    }
  });
  window.saleEurMetadata = {
    store_rate: eurConversionData.store_rate,
    effective_rate: saleEffectiveRate,
    eur_target: eurExpectedAmount,
    gbp_total: Number(gbpTotal.toFixed(2)),
    eur_exact: eurConversionData.eur_exact,
    eur_received: Number(actual.toFixed(2)),
    gbp_equivalent: gbpEquivalent,
    eur_difference: eurDiff,
    gbp_difference: gbpDiff,
    selection_mode: eurSelectedMode
  };
  eurConversionActive = true;
  hideEurOverlay();
  updateCashSection();
  resetTenderInputs();
}

function updateEurEffectiveRateDisplay() {
  const el = document.getElementById('eurEffectiveRateDisplay');
  if (!el) return;
  if (!saleEffectiveRate) {
    el.textContent = '1 GBP = -- EUR';
    return;
  }
  el.textContent = `1 GBP = ${saleEffectiveRate.toFixed(4)} EUR`;
}

function clearSaleFxState() {
  eurConversionActive = false;
  saleEffectiveRate = null;
  eurConversionData = null;
  eurSelectedMode = null;
  eurExpectedAmount = 0;
  if (typeof window !== 'undefined') {
    window.saleEurMetadata = null;
  }
  hideEurOverlay();
}

function summarizeFxFromPayments(payments, gbpTotal) {
  const rows = (payments || []).filter(p => {
    const cur = (p.currency || '').toUpperCase();
    return cur === 'EUR' && p.amount_eur != null;
  });
  if (!rows.length) return null;
  const totalEur = rows.reduce((sum, row) => sum + Math.abs(Number(row.amount_eur || 0)), 0);
  const totalGbp = rows.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
  const meta = window.saleEurMetadata || null;
  const expectedEur = meta && meta.eur_target != null ? Number(meta.eur_target) : null;
  const gbpBase = typeof gbpTotal === 'number'
    ? Math.abs(Number(gbpTotal))
    : (meta && meta.gbp_total != null ? Number(meta.gbp_total) : null);
  const differenceEur = meta && meta.eur_difference != null
    ? Number(meta.eur_difference)
    : (expectedEur != null ? Number((totalEur - expectedEur).toFixed(2)) : 0);
  const differenceGbp = meta && meta.gbp_difference != null
    ? Number(meta.gbp_difference)
    : (gbpBase != null ? Number((totalGbp - gbpBase).toFixed(2)) : 0);
  const effectiveRate = meta && meta.effective_rate
    ? Number(meta.effective_rate)
    : (rows.find(r => r.eur_rate)?.eur_rate || (totalGbp > 0 ? Number((totalEur / totalGbp).toFixed(4)) : null));
  return {
    eur_amount: Number(totalEur.toFixed(2)),
    gbp_equivalent: Number(totalGbp.toFixed(2)),
    effective_rate: effectiveRate,
    store_rate: meta && meta.store_rate != null ? Number(meta.store_rate) : null,
    expected_eur: expectedEur,
    gbp_total: gbpBase != null ? Number(gbpBase.toFixed(2)) : null,
    difference_eur: differenceEur,
    difference_gbp: differenceGbp,
    selection_mode: meta && meta.selection_mode ? meta.selection_mode : null
  };
}

async function openEurConversionOverlay(gbpTotal) {
  /**
   * Open the EUR conversion overlay modal.
   * Fetch suggestions and populate the overlay with GBP total, store rate, and EUR amounts.
   */
  if (gbpTotal <= 0) return;

  // Live store rate pulled from backend (falls back to last cached/default)
  const storeRate = await getStoreCurrencyRate('GBP', 'EUR');
  
  // Fetch EUR suggestions
  const suggestions = await fetchEurSuggestions(gbpTotal, storeRate);
  if (!suggestions) {
    alert('Failed to fetch EUR conversion suggestions');
    return;
  }

  // Store in global for later use
  eurConversionData = suggestions;

  // Populate panel elements
  const gbpEl = document.getElementById('eurOverlayGbpTotal');
  if (gbpEl) gbpEl.textContent = `£${gbpTotal.toFixed(2)}`;
  const rateEl = document.getElementById('eurOverlayStoreRate');
  if (rateEl) rateEl.textContent = `${storeRate.toFixed(4)} EUR`;
  const exactEl = document.getElementById('eurOverlayExact');
  if (exactEl) exactEl.textContent = `€${(suggestions.eur_exact || 0).toFixed(2)}`;
  const upEl = document.getElementById('eurOverlayRoundUp');
  if (upEl) upEl.textContent = `€${(suggestions.eur_round_up || 0).toFixed(2)}`;
  const downEl = document.getElementById('eurOverlayRoundDown');
  if (downEl) downEl.textContent = `€${(suggestions.eur_round_down || 0).toFixed(2)}`;

  resetEurTenderState();
  const status = document.getElementById('eurOverlayStatus');
  if (status) status.textContent = `Total £${gbpTotal.toFixed(2)} — choose a EUR target.`;
  showEurOverlay();
}

// App settings and receipt state
// App-wide persisted settings + simple Z-read aggregates
const RECEIPT_DEFAULT_HEADER_LINES = [
  'Russells of Omagh',
  'Quality Footwear & Apparel'
];
const RECEIPT_DEFAULT_FOOTER_LINES = [
  'Thank you for shopping with us!',
  'Please retain your receipt for 30 days.'
];
const RECEIPT_DEFAULT_HEADER = RECEIPT_DEFAULT_HEADER_LINES.join('\n');
const RECEIPT_DEFAULT_FOOTER = RECEIPT_DEFAULT_FOOTER_LINES.join('\n');
const RECEIPT_LINE_WIDTH = 42;
let settings = {
  till_number: '',
  branch_name: '',
  dark_mode: false,
  christmas_mode: false,
  auto_print: false,
  opening_float: 0,
  opening_date: '',
  net_cash: 0,
  net_card: 0,
  net_voucher: 0,
  net_cash_change: 0,
  vat_rate: 20,
  vat_inclusive: true,
  currency_rate: DEFAULT_STORE_RATE,
  currency_rate_updated: null,
  // Aggregates keyed by ISO date (YYYY-MM-DD).
  // Minimal shape: { date: 'YYYY-MM-DD', totals:{...}, perCashier:{...}, perGroup:{...}, tenders:{...}, discounts:{...} }
  z_agg: {},
  receipt_header: RECEIPT_DEFAULT_HEADER,
  receipt_footer: RECEIPT_DEFAULT_FOOTER,
  open_drawer_after_print: true,
  show_zero_stock: false,
  till_open: false,
  till_opened_at: null,
  till_closed_at: null
};
let lastReceiptInfo = null;
const RECEIPT_PORT_STORAGE_KEY = 'receipt_serial_port';
const RECEIPT_DEFAULT_SERIAL_PORT = (typeof document !== 'undefined' && document.documentElement.dataset.receiptDefaultPort)
  ? document.documentElement.dataset.receiptDefaultPort
  : 'COM3';
let receiptSerialPort = (()=> {
  try{
    if(typeof window !== 'undefined' && window.localStorage){
      return window.localStorage.getItem(RECEIPT_PORT_STORAGE_KEY) || RECEIPT_DEFAULT_SERIAL_PORT;
    }
  }catch(_){}
  return RECEIPT_DEFAULT_SERIAL_PORT;
})();
let receiptPortSelectEl = null;
let receiptPortStatusEl = null;

function setReceiptSerialPort(port, { persist = true } = {}) {
  if(!port) return;
  receiptSerialPort = port;
  if(persist){
    try{
      if(typeof window !== 'undefined' && window.localStorage){
        window.localStorage.setItem(RECEIPT_PORT_STORAGE_KEY, port);
      }
    }catch(_){}
  }
  if(receiptPortSelectEl){
    receiptPortSelectEl.value = port;
  }
  updateReceiptPortStatus(`Using ${port}.`);
}

function updateReceiptPortStatus(message){
  if(!receiptPortStatusEl) return;
  receiptPortStatusEl.textContent = message || `Using ${receiptSerialPort}.`;
}

async function refreshSerialPortOptions(){
  if(!receiptPortSelectEl) return;
  receiptPortSelectEl.disabled = true;
  const busyOption = document.createElement('option');
  busyOption.value = '';
  busyOption.textContent = 'Detecting serial ports...';
  receiptPortSelectEl.innerHTML = '';
  receiptPortSelectEl.appendChild(busyOption);
  updateReceiptPortStatus('Detecting serial ports...');
  try{
    const response = await fetch('/api/serial-ports', { cache: 'no-store' });
    if(!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const ports = Array.isArray(data?.ports) ? data.ports : [];
    receiptPortSelectEl.innerHTML = '';
    if(!ports.length){
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No serial ports detected';
      receiptPortSelectEl.appendChild(option);
      updateReceiptPortStatus(`No serial ports detected; using ${receiptSerialPort}.`);
    }else{
      ports.forEach(port=>{
        const option = document.createElement('option');
        option.value = port.device || '';
        option.textContent = port.description ? `${port.device} (${port.description})` : (port.device || 'Unknown port');
        receiptPortSelectEl.appendChild(option);
      });
      if(!ports.some(p=>p.device === receiptSerialPort)){
        setReceiptSerialPort(ports[0].device, { persist:false });
      }else{
        receiptPortSelectEl.value = receiptSerialPort;
        updateReceiptPortStatus(`Using ${receiptSerialPort}.`);
      }
    }
  }catch(err){
    receiptPortSelectEl.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Error listing ports';
    receiptPortSelectEl.appendChild(option);
    updateReceiptPortStatus(`Port list error: ${err.message}`);
  }finally{
    receiptPortSelectEl.disabled = false;
  }
}

const receiptBuilder = (() => {
  const ESC = '\x1B';
  const GS = '\x1D';

  function parseLines(value){
    if(typeof value !== 'string') return [];
    return value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  }

  function wrapText(text){
    const words = String(text||'').split(/\s+/);
    const lines = [];
    let current = '';
    words.forEach(word=>{
      if(!word) return;
      const candidate = current ? `${current} ${word}` : word;
      if(candidate.length > RECEIPT_LINE_WIDTH){
        if(current) lines.push(current);
        if(word.length > RECEIPT_LINE_WIDTH){
          for(let i=0; i<word.length; i+=RECEIPT_LINE_WIDTH){
            lines.push(word.slice(i, i+RECEIPT_LINE_WIDTH));
          }
          current = '';
        }else{
          current = word;
        }
      }else{
        current = candidate;
      }
    });
    if(current) lines.push(current);
    return lines;
  }

  function centerText(text){
    const t = String(text||'').trim();
    if(!t) return '';
    const trimmed = t.length > RECEIPT_LINE_WIDTH ? t.slice(0, RECEIPT_LINE_WIDTH) : t;
    return ESC + 'a' + '\x01' + trimmed + ESC + 'a' + '\x00';
  }

  function padLine(left, right){
    const l = String(left||'');
    const r = String(right||'');
    if(!r) return l;
    if(l.length + r.length >= RECEIPT_LINE_WIDTH){
      return `${l}\n${r}`;
    }
    const spaces = Math.max(1, RECEIPT_LINE_WIDTH - l.length - r.length);
    return l + ' '.repeat(spaces) + r;
  }

  function moneyFmt(value){
    const n = Number(value||0);
    return (n<0?'-':'') + 'GBP ' + Math.abs(n).toFixed(2);
  }

  function eurFmt(value){
    const n = Number(value||0);
    return (n<0?'-':'') + 'EUR ' + Math.abs(n).toFixed(2);
  }

  function buildEuroSlip(summary){
    if(!summary) throw new Error('Missing FX summary payload');
    const lines = [];
    lines.push(centerText('EUR WRAP SLIP'));
    lines.push(centerText('Russells of Omagh'));
    lines.push('');
    lines.push(`EUR accepted: ${moneyFmt(summary.eur_amount || 0).replace('GBP', 'EUR')}`);
    lines.push(`GBP equivalent: ${moneyFmt(summary.gbp_equivalent || 0)}`);
    if(summary.effective_rate){
      lines.push(`Rate used: 1 GBP = ${Number(summary.effective_rate).toFixed(4)} EUR`);
    }
    if(summary.store_rate){
      lines.push(`Store ref: 1 GBP = ${Number(summary.store_rate).toFixed(4)} EUR`);
    }
    const diff = Number(summary.difference_gbp || 0);
    if(Math.abs(diff) >= 0.01){
      const label = diff > 0 ? 'Change due' : 'Still due';
      lines.push(`${label}: ${moneyFmt(diff)}`);
    }
    lines.push('');
    if(summary.invoice){
      lines.push(`Invoice: ${summary.invoice}`);
      lines.push('');
    }
    lines.push('Please retain this slip for future reference.');
    lines.push('');
    lines.push(`Printed: ${new Date().toLocaleString()}`);
    return lines.join('\n');
  }

  function headerLinesFrom(info){
    const headerSrc = typeof info?.header === 'string'
      ? info.header
      : (typeof settings.receipt_header === 'string' ? settings.receipt_header : RECEIPT_DEFAULT_HEADER);
    const lines = parseLines(headerSrc);
    if(lines.length) return lines;
    return RECEIPT_DEFAULT_HEADER_LINES.slice();
  }

  function footerLinesFrom(info){
    const footerSrc = typeof info?.footer === 'string'
      ? info.footer
      : (typeof settings.receipt_footer === 'string' ? settings.receipt_footer : RECEIPT_DEFAULT_FOOTER);
    const lines = parseLines(footerSrc);
    if(lines.length) return lines;
    return RECEIPT_DEFAULT_FOOTER_LINES.slice();
  }

  const CODE39_SANITIZER = /[^A-Z0-9\-\. \$\/\+\%]/gi;
  function bytesToHex(str){
    if(!str) return '';
    return Array.from(str).map(ch=> ch.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
  }


  function buildBarcode(value) {
    if (!value) return '';

    // Code 39 allowed chars – same as Python
    const allowed = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./";

    let normalized = String(value || '').toUpperCase();
    let safe = '';
    for (const c of normalized) {
      if (allowed.includes(c)) safe += c;
    }
    if (!safe) safe = 'INV0001';

    let out = '';

    // ESC @ (init)
    out += ESC + '@';
    // Set a modest left margin so barcode appears centered
    out += GS + 'L' + '\x18' + '\x00';

    // Barcode parameters (match test 1)
    out += GS + 'h' + '\x50';  // height 80
    out += GS + 'w' + '\x02';  // width 2
    out += GS + 'H' + '\x02';  // HRI below

    // GS k 4 d1..dk 00  (Code39 Function A)
    out += GS + 'k' + '\x04';  // m = 4
    out += safe;               // data bytes
    out += '\x00';             // NUL terminator

    // Newline + human-readable text
    out += '\n';
    out += centerText(`Invoice: ${safe}`);
    out += '\n';

    log('buildBarcode', {
      invoice: value,
      encoded: safe,
      hex: bytesToHex(out),
    });

    return out;
  }


  function invoiceBarcodeValue(info){
    const raw = info?.barcode_value || info?.invoice || '';
    if(!raw) return '';
    return String(raw).trim();
  }

  function barcodeHexFrom(info){
    const raw = info?.barcode_hex;
    if(!Array.isArray(raw)) return [];
    return raw
      .map(chunk => String(chunk || '').trim())
      .filter(Boolean);
  }

  function buildReceipt(info, opts){
    if(!info) throw new Error('Missing receipt payload');
    const gift = !!opts.gift;
    let buffer = ESC + '@';
    const write = (line='')=>{ buffer += (line||'') + '\n'; };
    const separator = ()=> write('-'.repeat(RECEIPT_LINE_WIDTH));
    const headerLines = headerLinesFrom(info);
    if(headerLines.length){
      buffer += ESC + '!' + '\x30';
      write(centerText(headerLines[0]));
      buffer += ESC + '!' + '\x00';
      headerLines.slice(1).forEach(line=> write(centerText(line)));
    }
    const meta = [];
    const created = info.created ? new Date(info.created) : new Date();
    meta.push(['Date', created.toLocaleString()]);
    meta.push(['Invoice', info.invoice || '']);
    if(info.branch || settings.branch_name){
      meta.push(['Branch', info.branch || settings.branch_name || '']);
    }
    if(info.till || info.till_number || settings.till_number){
      meta.push(['Till', info.till || info.till_number || settings.till_number || '']);
    }
    if(info.cashier && (info.cashier.code || info.cashier.name)){
      const cashierLine = [info.cashier.code||'', info.cashier.name||''].filter(Boolean).join(' ').trim();
      meta.push(['Cashier', cashierLine]);
    }
    if(info.customer){
      meta.push(['Customer', info.customer]);
    }
    meta.forEach(([label, value])=>{ if(value) write(padLine(`${label}:`, value)); });
    if(gift){
      write(centerText('*** GIFT RECEIPT ***'));
    }
    separator();
    const items = Array.isArray(info.items) ? info.items : [];
    const vatInclusive = info.vat_inclusive!=null ? !!info.vat_inclusive : !!settings.vat_inclusive;
    let vatTotal = 0;
    items.forEach(item=>{
      const nameLines = wrapText(item.name || item.item_name || item.code || 'Item');
      if(!nameLines.length) nameLines.push('Item');
      nameLines.forEach((line, idx)=> write(idx ? `  ${line}` : line));
      const styleLabel = (item.style_code || item.style || item.StyleCode || '').trim();
      if(styleLabel){
        write(`Style: ${styleLabel}`);
      }
      const qty = Number(item.qty||0);
      const rate = Number(item.rate||0);
      const lineTotal = Number(item.amount!=null ? item.amount : qty * rate * (item.refund ? -1 : 1));
      vatTotal += calcVatPortion(lineTotal, effectiveVatRate(item.vat_rate), vatInclusive);
      if(gift){
        write(`Qty: ${qty}${item.refund ? ' (refund)' : ''}`);
      }else{
        const qtyLabel = `${item.refund ? '-' : ''}${qty} x ${moneyFmt(rate)}`;
        write(padLine(qtyLabel, moneyFmt(lineTotal)));
      }
    });
    separator();
    if(gift){
      write(centerText('Totals hidden for gift receipt'));
    }else{
      const gross = Number(info.total||0);
      let net = gross;
      const vatAmount = vatTotal;
      if(vatInclusive){
        net = gross - vatAmount;
      }
      write(padLine('Net', moneyFmt(net)));
      if(vatAmount){
        write(padLine('VAT', moneyFmt(vatAmount)));
      }
      write(padLine(info.isRefund ? 'Refund Total' : 'Total', moneyFmt(gross)));
      const paymentList = Array.isArray(info.payments)?info.payments:[];
      paymentList.forEach(p=>{
        if(!p) return;
        const mode = p.mode || p.mode_of_payment || 'Payment';
        write(padLine(mode, moneyFmt(p.amount||0)));
        if(p.reference) write(`  Ref: ${p.reference}`);
      });
      if(info.change){
        write(padLine(info.isRefund ? 'Refunded' : 'Change', moneyFmt(info.change)));
      }
      if(info.tender){
        write(padLine('Tender', String(info.tender).toUpperCase()));
      }

      if(info.fx_summary){
        const fx = info.fx_summary;
        write('');
        const header = centerText('EUR PAYMENT');
        write(header);
        if(fx.eur_amount != null){
          write(padLine('EUR accepted', eurFmt(fx.eur_amount)));
        }
        if(fx.gbp_equivalent != null){
          write(padLine('GBP recorded', moneyFmt(fx.gbp_equivalent)));
        }
        if(fx.effective_rate){
          write(`Rate used: 1 GBP = ${Number(fx.effective_rate).toFixed(4)} EUR`);
        }
        if(fx.store_rate && (!fx.effective_rate || Math.abs(Number(fx.store_rate) - Number(fx.effective_rate || 0)) > 0.0001)){
          write(`Store ref: 1 GBP = ${Number(fx.store_rate).toFixed(4)} EUR`);
        }
        const fxDiff = Number(fx.difference_gbp || 0);
        if(Math.abs(fxDiff) >= 0.01){
          const diffLabel = fxDiff > 0 ? 'Change due' : 'Still due';
          write(padLine(diffLabel, moneyFmt(fxDiff)));
        }
      }
    }
    const footerLines = footerLinesFrom(info);
    if(footerLines.length){
      separator();
      footerLines.forEach(line=> write(centerText(line)));
    }
    const sanitizedBarcodeValue = invoiceBarcodeValue(info);
    const barcodeHex = barcodeHexFrom(info);
    if(barcodeHex.length){
      buffer += '\n';
      if(sanitizedBarcodeValue){
        write(centerText(`Invoice: ${sanitizedBarcodeValue}`));
      }
    } else if(sanitizedBarcodeValue){
      buffer += '\n';
      const barcodeChunk = buildBarcode(sanitizedBarcodeValue);
      if(barcodeChunk){
        buffer += barcodeChunk;
      } else {
        write(centerText(`Invoice: ${sanitizedBarcodeValue}`));
      }
    }

    return buffer;
  }

  function buildFxSlip(summary){
    const slip = buildEuroSlip(summary);
    const header = headerLinesFrom(summary);
    const footer = footerLinesFrom(summary);
    return assembleLineSections(slip, header, footer);
  }

  return {
    buildReceiptPayload: buildReceipt,
    buildFxSlipPayload: buildFxSlip,
    headerLinesFrom,
    footerLinesFrom,
    barcodeHexFrom
  };
})();

function decorateWithReceiptLayout(body, info = {}) {
  const header = receiptBuilder.headerLinesFrom(info);
  const footer = receiptBuilder.footerLinesFrom(info);
  return assembleLineSections(body, header, footer);
}

const DRAWER_PULSE_HEX = '1B 70 00 19 FA';

const receiptAgentClient = (() => {
  const rawUrl = (typeof window !== 'undefined' ? window.POS_PRINT_AGENT_URL : '') || '';
  const endpoint = rawUrl.trim();
  if(!endpoint) return null;

  function deriveVoucherEndpoint(baseUrl) {
    if(!baseUrl) return '';
    try {
      const url = new URL(baseUrl);
      const normalized = url.pathname.endsWith('/print-voucher')
        ? url.pathname
        : url.pathname.replace(/\/print(?:\/)?$/i, '/print-voucher');
      url.pathname = normalized.endsWith('/print-voucher')
        ? normalized
        : `${normalized.replace(/\/$/, '')}/print-voucher`;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch(_) {
      if(/\/print\/?$/i.test(baseUrl)){
        return baseUrl.replace(/\/print\/?$/i, '/print-voucher');
      }
      return baseUrl.endsWith('/')
        ? `${baseUrl}print-voucher`
        : `${baseUrl}/print-voucher`;
    }
  }

  const voucherEndpoint = deriveVoucherEndpoint(endpoint);

  async function send(payload, targetUrl) {
    const target = targetUrl || endpoint;
    if(!target) throw new Error('Receipt agent endpoint missing');
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    if(!response.ok){
      const text = await response.text().catch(()=> '');
      throw new Error(`Receipt agent ${response.status}: ${text}`);
    }
    const data = await response.json().catch(()=> null);
    return data?.ok !== false;
  }

  return {
    isReady: () => !!endpoint,
    async print(info, opts = {}) {
      const payload = {
        text: receiptBuilder.buildReceiptPayload(info, opts),
        line_feeds: opts.line_feeds ?? 6
      };
      const hexChunks = receiptBuilder.barcodeHexFrom(info);
      if(hexChunks.length){
        payload.hex = hexChunks.slice();
      }
      if(Array.isArray(opts.hex) && opts.hex.length){
        payload.hex = (payload.hex || []).concat(opts.hex);
      }
      if(opts.openDrawer){
        payload.hex = (payload.hex || []).concat(DRAWER_PULSE_HEX);
      }
      if(Object.prototype.hasOwnProperty.call(opts, 'cut')){
        payload.cut = opts.cut;
      }
      return await send(payload);
    },
    async printFxSlip(summary, opts = {}) {
      const payload = {
        text: receiptBuilder.buildFxSlipPayload(summary),
        line_feeds: opts.line_feeds ?? 6
      };
      if(Object.prototype.hasOwnProperty.call(opts, 'cut')){
        payload.cut = opts.cut;
      }
      return await send(payload);
    },
    async printText(text, opts = {}) {
      return await send({ text, line_feeds: opts.line_feeds ?? 4, ...opts });
    },
    async printVoucher(voucherPayload = {}) {
      if(!voucherEndpoint) return false;
      const payload = { ...voucherPayload };
      if(!Object.prototype.hasOwnProperty.call(payload, 'line_feeds')){
        payload.line_feeds = 6;
      }
      if(!Object.prototype.hasOwnProperty.call(payload, 'cut')){
        payload.cut = true;
      }
      return await send(payload, voucherEndpoint);
    },
    async cut() {
      return await send({ text: '', line_feeds: 0, cut: true });
    },
    async kickDrawer() {
      return await send({ text: '', hex: [DRAWER_PULSE_HEX], line_feeds: 0, cut: false });
    }
  };
})();

const FX_SLIP_WAIT_AFTER_RECEIPT_MS = 150;
const FX_SLIP_WAIT_AFTER_FIRST_CUT_MS = 80;
const FX_SLIP_WAIT_AFTER_SLIP_MS = 140;
const GIFT_RECEIPT_EXTRA_CUT_DELAY_MS = 130;

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cutReceiptIfReady() {
  if(!receiptAgentClient || typeof receiptAgentClient.cut !== 'function') return;
  try {
    await receiptAgentClient.cut();
  } catch(err) {
    warn('Receipt agent cut failed', err);
  }
}

async function pulseCashDrawer(){
  if(!receiptAgentClient || typeof receiptAgentClient.kickDrawer !== 'function' || !receiptAgentClient.isReady()){
    return false;
  }
  try{
    return await receiptAgentClient.kickDrawer();
  }catch(err){
    warn('Drawer pulse failed', err);
    return false;
  }
}

async function sendTextToReceiptAgent(text, opts = {}) {
  if(!text || !receiptAgentClient || !receiptAgentClient.isReady()) return false;
  const sendOpts = Object.assign({ line_feeds: 4 }, opts);
  try{
    return await receiptAgentClient.printText(text, sendOpts);
  }catch(err){
    warn('Receipt agent text print failed', err);
    return false;
  }
}

async function tryReceiptAgentPrint(info, opts = {}){
  if(!info || !receiptAgentClient || !receiptAgentClient.isReady()) return false;
  try{
    const receiptOpts = Object.assign({}, opts);
    if(!Object.prototype.hasOwnProperty.call(receiptOpts, 'cut')){
      receiptOpts.cut = true;
    }
    const needsFxSlip = !opts.gift && !!info.fx_summary;
    if(needsFxSlip){
      receiptOpts.cut = false;
    }
    const ok = await receiptAgentClient.print(info, receiptOpts);
    if(!ok) return false;
    if(needsFxSlip){
      await waitFor(FX_SLIP_WAIT_AFTER_RECEIPT_MS);
      await cutReceiptIfReady();
      await waitFor(FX_SLIP_WAIT_AFTER_FIRST_CUT_MS);
      await receiptAgentClient.printFxSlip(info.fx_summary, { cut: false });
      await waitFor(FX_SLIP_WAIT_AFTER_SLIP_MS);
      await cutReceiptIfReady();
    }
    return true;
  }catch(err){
    warn('Local receipt agent print failed', err);
    return false;
  }
}

async function ensureReceiptPrinted(info, opts = {}){
  return await tryReceiptAgentPrint(info, opts);
}

function scheduleAutoReceiptPrint(info){
  if(!info) return;
  setTimeout(async ()=>{
    const ok = await ensureReceiptPrinted(info, { gift:false });
    if(!ok){
      alert('Unable to print receipt. Please ensure the local receipt agent is running and try again.');
    }
  }, 75);
}

function handleReceiptPrintRequest(info, wantsGift){
  const target = info || lastReceiptInfo;
  if(!target){
    return;
  }
  (async ()=>{
    const resetGiftCheckbox = ()=>{
      const giftToggle = document.getElementById('giftReceiptCheckbox');
      if(giftToggle){
        giftToggle.checked = false;
      }
    };
    if(wantsGift){
      const giftOk = await ensureReceiptPrinted(target, { gift:true, cut:false });
      if(giftOk){
        await waitFor(GIFT_RECEIPT_EXTRA_CUT_DELAY_MS);
        await cutReceiptIfReady();
        await waitFor(GIFT_RECEIPT_EXTRA_CUT_DELAY_MS);
      }
      const standardOk = await ensureReceiptPrinted(target, { gift:false });
      if(!giftOk || !standardOk){
        alert('Gift or standard receipt failed to print. Please retry with the local receipt agent.');
      }
    }else{
      const ok = await ensureReceiptPrinted(target, { gift:false });
      if(!ok){
        alert('Receipt failed to print. Please retry with the local receipt agent.');
      }
    }
    resetGiftCheckbox();
  })().catch(e=> err('receipt print handler failed', e));
}

function buildVoucherPrintPayload(issuedVoucher, saleInfo = {}){
  if(!issuedVoucher) return null;
  const code = issuedVoucher.code || issuedVoucher.voucher_code;
  if(!code) return null;
  const voucherNameRaw = issuedVoucher.name || issuedVoucher.label || issuedVoucher.voucher_name || `Voucher ${code}`;
  const amountRaw = issuedVoucher.amount ?? issuedVoucher.value ?? issuedVoucher.balance;
  const titleOverride = issuedVoucher.title || saleInfo.voucher_print_title;
  const title = (titleOverride && String(titleOverride).trim()) || (settings && settings.voucher_print_title) || 'GIFT VOUCHER';
  const contextCurrency = saleInfo.currency || saleInfo.currency_used || (settings && settings.currency) || 'GBP';
  const payloadCurrency = issuedVoucher.currency || issuedVoucher.currency_code;
  const currency = (payloadCurrency && String(payloadCurrency).trim()) || contextCurrency;
  const issuedTsSource = issuedVoucher.issue_date || saleInfo.created;
  const issuedTs = issuedTsSource ? new Date(issuedTsSource) : new Date();
  const issueDate = Number.isNaN(issuedTs.getTime()) ? new Date() : issuedTs;
  const tillRef = saleInfo.till_number || saleInfo.till || (settings && settings.till_number) || undefined;
  let termsSetting = issuedVoucher.terms;
  if(!termsSetting){
    termsSetting = settings && settings.voucher_terms;
  }
  const parsedAmount = Number(amountRaw);
  const displayName = String(voucherNameRaw).trim() || code;
  const payload = {
    voucher_code: code,
    voucher_name: displayName,
    amount: Number.isFinite(parsedAmount) ? parsedAmount : amountRaw,
    currency,
    title,
    issue_date: issueDate.toISOString().slice(0, 10),
    cashier: saleInfo.cashier ? (saleInfo.cashier.name || saleInfo.cashier.code || '') : undefined,
    till_number: tillRef
  };
  const headerLines = resolveReceiptLines(
    issuedVoucher.header_lines,
    saleInfo.header_lines || saleInfo.header,
    standardReceiptHeaderLines()
  );
  const footerLines = resolveReceiptLines(
    issuedVoucher.footer_lines,
    saleInfo.footer_lines || saleInfo.footer,
    standardReceiptFooterLines()
  );
  if(headerLines.length){
    payload.header_lines = headerLines;
  }
  if(footerLines.length){
    payload.footer_lines = footerLines;
  }
  if(Array.isArray(termsSetting) && termsSetting.length){
    payload.terms = termsSetting;
  } else if(typeof termsSetting === 'string' && termsSetting.trim()){
    payload.terms = [termsSetting.trim()];
  }
  const funCandidates = [issuedVoucher.fun_line, saleInfo.voucher_fun_line, defaultVoucherFunLine()];
  for(const candidate of funCandidates){
    if(candidate == null) continue;
    const line = String(candidate).trim();
    if(line){
      payload.fun_line = line;
      break;
    }
  }
  return payload;
}

async function printVoucherSlip(voucherInfo, context = {}){
  if(!receiptAgentClient || typeof receiptAgentClient.printVoucher !== 'function' || !receiptAgentClient.isReady()){
    return;
  }
  const payload = buildVoucherPrintPayload(voucherInfo, context);
  if(!payload) return;
  try{
    await receiptAgentClient.printVoucher(payload);
  }catch(err){
    warn('Voucher print failed', err);
  }
}

function buildVoucherPrintContext(overrides = {}){
  const base = {
    cashier: currentCashier ? { code: currentCashier.code, name: currentCashier.name } : null,
    till_number: settings && settings.till_number,
    till: settings && settings.till_number,
    currency_used: (settings && settings.currency) || 'GBP',
    created: new Date().toISOString(),
    header_lines: standardReceiptHeaderLines(),
    footer_lines: standardReceiptFooterLines(),
    voucher_fun_line: defaultVoucherFunLine()
  };
  return Object.assign(base, overrides);
}

async function printIssuedVouchersAfterSale(info, opts = {}){
  if(!info) return false;
  const issued = Array.isArray(info.issued_vouchers) ? info.issued_vouchers : [];
  if(!issued.length) return false;
  const force = !!opts.force;
  if(info.__voucherPrintComplete && !force) return false;
  if(!force){
    info.__voucherPrintComplete = true;
  }
  const overrides = {
    cashier: info.cashier || currentCashier || null,
    till_number: info.till_number || info.till || (settings && settings.till_number),
    till: info.till_number || info.till || (settings && settings.till_number),
    currency_used: info.currency_used || info.currency || (settings && settings.currency) || 'GBP',
    created: info.created || new Date().toISOString(),
    header_lines: info.header_lines || standardReceiptHeaderLines(),
    footer_lines: info.footer_lines || standardReceiptFooterLines(),
    voucher_fun_line: info.voucher_fun_line || defaultVoucherFunLine()
  };
  const context = buildVoucherPrintContext(overrides);
  let printed = false;
  for (const voucherInfo of issued){
    try{
      await printVoucherSlip(voucherInfo, context);
      printed = true;
      await waitFor(60);
    }catch(err){
      warn('Voucher slip failed after sale', err);
    }
  }
  return printed;
}

async function printVoucherBalanceSlipsAfterSale(info, opts = {}){
  if(!info) return false;
  const balances = Array.isArray(info.voucher_balance_prints) ? info.voucher_balance_prints : [];
  if(!balances.length) return false;
  const force = !!opts.force;
  if(info.__voucherBalancePrintComplete && !force) return false;
  if(!force){
    info.__voucherBalancePrintComplete = true;
  }
  const overrides = {
    cashier: info.cashier || currentCashier || null,
    till_number: info.till_number || info.till || (settings && settings.till_number),
    till: info.till_number || info.till || (settings && settings.till_number),
    currency_used: info.currency_used || info.currency || (settings && settings.currency) || 'GBP',
    created: info.created || new Date().toISOString(),
    header_lines: info.header_lines || standardReceiptHeaderLines(),
    footer_lines: info.footer_lines || standardReceiptFooterLines(),
    voucher_fun_line: info.voucher_fun_line || defaultVoucherFunLine()
  };
  const context = buildVoucherPrintContext(overrides);
  let printed = false;
  for (const voucherInfo of balances){
    try{
      await printVoucherSlip(voucherInfo, context);
      printed = true;
      await waitFor(60);
    }catch(err){
      warn('Voucher balance slip failed after sale', err);
    }
  }
  return printed;
}

function hasVoucherPrintData(info){
  if(!info) return false;
  const issued = Array.isArray(info.issued_vouchers) && info.issued_vouchers.length>0;
  const balances = Array.isArray(info.voucher_balance_prints) && info.voucher_balance_prints.length>0;
  return issued || balances;
}

async function reprintVouchersForInfo(info){
  if(!hasVoucherPrintData(info)){
    alert('No vouchers to print for this receipt.');
    return;
  }
  const issuedOk = await printIssuedVouchersAfterSale(info, { force:true }).catch(err=>{ warn('Voucher reprint failed', err); return false; });
  const balanceOk = await printVoucherBalanceSlipsAfterSale(info, { force:true }).catch(err=>{ warn('Voucher balance reprint failed', err); return false; });
  if(!issuedOk && !balanceOk){
    alert('Unable to reprint voucher for this receipt.');
  }
}

// Currency
const CURRENCY = 'GBP';
const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY });
const money = v => fmt.format(Number(v || 0));

function normalizeVatRate(value){
  if(value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function effectiveVatRate(value){
  const direct = normalizeVatRate(value);
  if(direct !== null) return direct;
  return normalizeVatRate(settings?.vat_rate);
}

function calcVatPortion(amount, vatRate, inclusive = null){
  const rate = normalizeVatRate(vatRate);
  if(rate === null || rate <= 0) return 0;
  const amt = Number(amount || 0);
  const inclusiveFlag = inclusive !== null ? !!inclusive : !!settings.vat_inclusive;
  if(inclusiveFlag){
    return amt * (rate / (100 + rate));
  }
  return amt * (rate / 100);
}

function tenderTargetAmount(){
  const total = getCartTotal();
  return total < 0 ? Math.abs(total) : total;
}

function tenderPaidTotal(){
  return appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
}

function tenderRemainingAmount(){
  return Math.max(0, tenderTargetAmount() - tenderPaidTotal());
}

function fillInputWithRemainingAmount(el){
  if(!el) return;
  const remaining = tenderRemainingAmount();
  el.value = Number(remaining).toFixed(2);
  el.dispatchEvent(new Event('input', { bubbles:true }));
}

// Monetary keypad helpers: maintain cents and render as 0.00
function _getCents(el){
  try{
    const raw = (el && el.dataset && el.dataset.cents) ? el.dataset.cents : '0';
    const n = parseInt(String(raw).replace(/\D/g,''), 10);
    return isNaN(n) ? 0 : Math.max(0, n);
  }catch(_){ return 0; }
}
function _setFromCents(el, cents){
  try{
    const c = Math.max(0, Number.isFinite(cents)? Math.floor(cents) : 0);
    if(el && el.dataset) el.dataset.cents = String(c);
    const val = (c/100).toFixed(2);
    if(el) el.value = val;
    return val;
  }catch(_){ return '0.00'; }
}
function resetNumericInput(el, preset='0.00'){
  if(!el) return;
  el.value = preset;
  if(el.dataset) el.dataset.cents = '0';
}
function resetCashEntry(){
  cashInput = '';
  cashEntryDirty = false;
  resetNumericInput(document.getElementById('cashInputField'), '0.00');
}
function resetOtherEntry(){
  otherEntryDirty = false;
  resetNumericInput(document.getElementById('otherAmountInput'), '0.00');
}
function resetTenderInputs(){
  resetCashEntry();
  resetOtherEntry();
}
function resetDiscountValueInput(){
  resetNumericInput(document.getElementById('discountValueInput'), '');
}
function addCashAmount(delta){
  const field = document.getElementById('cashInputField');
  if(!field) return;
  const centsDelta = Math.round(Number(delta||0) * 100);
  const next = Math.max(0, _getCents(field) + centsDelta);
  const val = _setFromCents(field, next);
  cashInput = val;
  cashEntryDirty = true;
  updateCashSection();
}
function applyMoneyKey(el, k){
  if(!el) return '0.00';
  let cents = _getCents(el);
  if(k === 'C'){
    cents = 0;
  } else if(k === 'B'){
    cents = Math.floor(cents / 10);
  } else if(/^[0-9]$/.test(k||'')){
    const digit = Number(k);
    cents = cents * 10 + digit;
  } else {
    // ignore other keys e.g. '.'
  }
  return _setFromCents(el, cents);
}

// ----- Z-read aggregation helpers -----
function _ensureZAggToday(){
  const d = todayStr();
  if(!settings.z_agg || typeof settings.z_agg !== 'object') settings.z_agg = {};
  if(!settings.z_agg[d]){
    settings.z_agg[d] = {
      date: d,
      totals: { gross:0, net:0, vat_sales:0, vat_returns:0, returns_amount:0, sale_count:0, return_count:0, items_qty:0 },
      discounts: { sales:0, returns:0 },
      tenders: { Cash:0, Card:0, Voucher:0, Other:0 },
      perCashier: {},
      perGroup: {}
    };
  }
  return settings.z_agg[d];
}
function updateZAggWithSale(ctx){
  // ctx: { net, lines:[{qty,rate,original_rate,refund,brand,item_group}], payments:[{mode_of_payment,amount}], cashier:{code,name} }
  try{
    const agg = _ensureZAggToday();
    let gross = 0;
    let itemsQty = 0;
    let discSales = 0;
    let discReturns = 0;
    let vatSales = 0;
    let vatReturns = 0;
    const isReturn = Number(ctx.net||0) < 0;
    (ctx.lines||[]).forEach(ln=>{
      const qty = Math.abs(Number(ln.qty||0));
      const rate = Number(ln.rate||0);
      const orig = Number(ln.original_rate!=null?ln.original_rate:ln.rate||0);
      const sign = ln.refund ? -1 : 1;
      const lineNet = sign * qty * rate;
      const lineGrossAbs = qty * rate;
      const lineDisc = Math.max(0, (orig - rate) * qty);
      const lineVatRate = effectiveVatRate(ln.vat_rate);
      const lineVat = calcVatPortion(lineNet, lineVatRate);
      if(ln.refund){ discReturns += lineDisc; vatReturns += lineVat; }
      else { discSales += lineDisc; vatSales += lineVat; }
      gross += Math.abs(lineGrossAbs) * (ln.refund?-1:1);
      itemsQty += qty * (ln.refund?-1:1);
      const groupKey = ln.item_group || ln.brand || 'Ungrouped';
      const g = agg.perGroup[groupKey] || { qty:0, amount:0 };
      g.qty += (ln.refund?-qty:qty);
      g.amount += lineNet;
      agg.perGroup[groupKey] = g;
    });
    agg.totals.gross += gross;
    agg.totals.net += Number(ctx.net||0);
    agg.totals.items_qty += itemsQty;
    if(isReturn){ agg.totals.return_count += 1; agg.totals.returns_amount += Math.abs(Number(ctx.net||0)); }
    else { agg.totals.sale_count += 1; }
    agg.discounts.sales += discSales;
    agg.discounts.returns += discReturns;
    agg.totals.vat_sales += vatSales;
    agg.totals.vat_returns += vatReturns;
    // tenders
    (ctx.payments||[]).forEach(p=>{
      const m = (p.mode_of_payment||'Other');
      const key = (/cash/i.test(m)?'Cash':/card/i.test(m)?'Card':/voucher/i.test(m)?'Voucher':'Other');
      agg.tenders[key] = (agg.tenders[key]||0) + Number(p.amount||0);
    });
    // cashier totals by net
    const cname = (ctx.cashier && (ctx.cashier.name||ctx.cashier.code)) || 'Unknown';
    agg.perCashier[cname] = (agg.perCashier[cname]||0) + Number(ctx.net||0);
    saveSettings();
  }catch(e){ /* ignore aggregation errors */ }
}

// Demo cashiers
const CASHIER_CODES = { '1111':'Alice','2222':'Bob','3333':'Charlie' };

// Idle
const IDLE_TIMEOUT_MS = 120000; let idleTimer=null;
function resetIdleTimer(){
  if(idleTimer) clearTimeout(idleTimer);
  if(currentCashier){
    idleTimer=setTimeout(()=>logoutToLogin('Session timed out due to inactivity'),IDLE_TIMEOUT_MS);
  }
}

function setCashierSession(token, intervalSeconds){
  currentCashierSession = token || null;
  if(!currentCashierSession){
    stopCashierSessionPing();
    return;
  }
  const seconds = Number(intervalSeconds || 60);
  sessionPingIntervalMs = Math.max(15000, (isNaN(seconds) ? 60 : seconds) * 1000);
  startCashierSessionPing();
}

function startCashierSessionPing(){
  if(!currentCashierSession) return;
  stopCashierSessionPing();
  const tick = ()=>{ pingCashierSession().catch(()=>{}); };
  tick();
  sessionPingTimer = setInterval(tick, sessionPingIntervalMs);
}

function stopCashierSessionPing(){
  if(sessionPingTimer){
    clearInterval(sessionPingTimer);
    sessionPingTimer = null;
  }
}

async function pingCashierSession(){
  if(!currentCashierSession) return;
  try{
    await fetch('/api/cashier/ping', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ session: currentCashierSession })
    });
  }catch(e){
    warn('session ping failed', e);
    throw e;
  }
}

async function notifyCashierLogout(){
  if(!currentCashierSession) return;
  const payload = JSON.stringify({ session: currentCashierSession });
  try{
    if(typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'){
      const blob = new Blob([payload], { type:'application/json' });
      navigator.sendBeacon('/api/cashier/logout', blob);
    }else{
      await fetch('/api/cashier/logout', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: payload
      });
    }
  }catch(e){
    warn('cashier logout notify failed', e);
  }finally{
    currentCashierSession = null;
    stopCashierSessionPing();
  }
}

if(typeof window !== 'undefined'){
  window.addEventListener('beforeunload', ()=>{
    if(!currentCashierSession) return;
    try{
      const payload = JSON.stringify({ session: currentCashierSession });
      if(typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'){
        const blob = new Blob([payload], { type:'application/json' });
        navigator.sendBeacon('/api/cashier/logout', blob);
      }
    }catch(_){}
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  log('DOMContentLoaded fired');
  loadSettings();
  applySettings();
  try { getStoreCurrencyRate().catch(()=>{}); } catch(_){}
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
  // Start sync status polling to show pending/failed counts
  try { pollSyncStatus(); setInterval(pollSyncStatus, 30000); } catch(_){}
});

async function pollSyncStatus(){
  try{
    const r = await fetch('/api/sales/status');
    if(!r.ok) return;
    const d = await r.json();
    if(!d || d.status!=='success') return;
    const counts = d.counts||{};
    const queued = Number(counts.queued||0);
    const failed = Number(counts.failed||0);
    const invoicesPending = Number(d.invoices_pending||0);
    const pendingTotal = queued + invoicesPending;
    const notif = document.getElementById('notifIcon')
    if(notif){
      const base = '\u{1F514}'; // bell icon
      let txt = base;
      const totalBadge = (failed>0? `${pendingTotal} (!${failed})` : String(pendingTotal));
      if(pendingTotal>0){ txt = `${base} ${totalBadge}`; }
      notif.textContent = txt;
      notif.title = `Pending sync: ${pendingTotal} | Failed: ${failed}`;
    }
  }catch(e){ /* ignore */ }
}

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
        entry.vat_rate = normalizeVatRate(entry.vat_rate);
        return entry;
      });
      renderItems(items);
    }
  } catch (error) {
    console.error(error);
  }
}
async function loadCustomers(){ try{ const r=await fetch('/api/customers'); const d=await r.json(); if(d.status==='success'){ customers=d.customers; const b=document.getElementById('customerSelect'); const t=document.getElementById('topCustomerSelect'); customers.forEach(c=>{ if(b){const o=document.createElement('option'); o.value=c.name;o.textContent=c.customer_name;b.appendChild(o);} if(t){const o2=document.createElement('option'); o2.value=c.name;o2.textContent=c.customer_name;t.appendChild(o2);} }); setDefaultCustomer(); } }catch(e){ console.error(e);} }

function renderItems(list){
  items = list || [];
  renderFeaturedPanel(false);
  renderRecentItems();
  try { renderSearchResults(); } catch(_){}
}

function formatItemPrice(it){
  const min = it.price_min;
  const max = it.price_max;
  if(min != null && max != null){
    if(Number(min) === Number(max)){
      return money(min);
    }
    return `${money(min)} - ${money(max)}`;
  }
  if(min != null){
    return money(min);
  }
  if(max != null){
    return money(max);
  }
  if(it.standard_rate != null){
    return money(it.standard_rate);
  }
  return '-';
}

function formatVariantPriceRange(min, max, fallback){
  if(min != null && max != null){
    if(Number(min) === Number(max)){
      return money(min);
    }
    return `${money(min)} - ${money(max)}`;
  }
  if(min != null){
    return money(min);
  }
  if(max != null){
    return money(max);
  }
  return fallback || '-';
}

function clearVariantMatrix(){
  const h=document.getElementById('matrixHead');
  const b=document.getElementById('matrixBody');
  if(h){
    h.innerHTML='';
  }
  if(b){
    b.innerHTML='<tr><td colspan="99" class="text-muted text-center small" style="padding:12px;">Loading variant data…</td></tr>';
  }
  variantCellRefs=new Map();
  resetVariantQueue();
}

function resetVariantQueue(){
  variantSelectionQueue=[];
  updateVariantQueueDisplay();
}

function variantSelectionKey(variant){
  return [variant.color||'', variant.width||'', variant.size||''].join('|');
}

function renderFeaturedPanel(shuffle = false){
  const grid=document.getElementById('itemsGrid');
  if(!grid){
    return;
  }
  const source = getVisibleItems();
  if(!source.length){
    grid.innerHTML='<div class="col"><div class="card item-card h-100 d-flex align-items-center justify-content-center text-muted small">No in-stock items. Enable "Show zero-stock lines" in Search to browse everything.</div></div>';
    return;
  }
  const selection=selectFeaturedItems(source, shuffle);
  grid.innerHTML='';
  selection.forEach(it=>{
    const wrapper=document.createElement('div');
    wrapper.className='col';
    const card=document.createElement('div');
    card.className='card item-card h-100';
    const media=document.createElement('div');
    media.className='item-card-media';
    const imageUrl=findItemImageUrl(it);
    if(imageUrl){
      const img=document.createElement('img');
      img.src=imageUrl;
      img.alt=it.item_name || it.name || it.item_code || 'Product image';
      img.loading='lazy';
      media.appendChild(img);
    } else {
      const placeholder=document.createElement('span');
      placeholder.className='text-muted small';
      placeholder.textContent='No image';
      media.appendChild(placeholder);
    }
    card.appendChild(media);
    const body=document.createElement('div');
    body.className='card-body item-card-body';
    const title=document.createElement('p');
    title.className='item-card-title';
    title.textContent=it.item_name || it.name || it.item_code || '';
    const priceEl=document.createElement('div');
    priceEl.className='item-card-price';
    priceEl.textContent=formatItemPrice(it);
    body.appendChild(title);
    body.appendChild(priceEl);
    const stockLabel=(it.variant_stock != null) ? `Stock: ${it.variant_stock}` : (it.stock_uom || '');
    if(stockLabel){
      const stockEl=document.createElement('p');
      stockEl.className='card-text item-card-stock small mb-0';
      stockEl.textContent=stockLabel;
      body.appendChild(stockEl);
    }
    card.appendChild(body);
    wrapper.appendChild(card);
    wrapper.addEventListener('click', ()=>openProduct(it));
    grid.appendChild(wrapper);
  });
}

function selectFeaturedItems(sourceList, shuffle){
  const grid=document.getElementById('itemsGrid');
  const explicit=(grid&&grid.dataset?grid.dataset.featuredCodes:'')||'';
  const codes=explicit.split(',').map(value=>value.trim()).filter(Boolean);
  const selection=[];
  const used=new Set();
  codes.forEach(code=>{
    const match=findItemByCode(code);
    if(match && (isShowZeroStockEnabled() || hasSellableStock(match)) && !used.has(match.item_code)){
      selection.push(match);
      used.add(match.item_code);
    }
  });
  const pool=(Array.isArray(sourceList)?sourceList.slice():items.slice()).filter(it=>!used.has(it.item_code));
  const ordered=shuffle?shuffleArray(pool):pool;
  for(const candidate of ordered){
    if(selection.length>=FEATURED_ITEM_LIMIT){
      break;
    }
    if(!used.has(candidate.item_code)){
      selection.push(candidate);
      used.add(candidate.item_code);
    }
  }
  return selection.slice(0, FEATURED_ITEM_LIMIT);
}

function shuffleArray(arr){
  const copy=[]; copy.push(...(arr||[]));
  for(let i=copy.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy;
}

function renderRecentItems(){
  const container=document.getElementById('recentSalesList');
  if(!container){
    return;
  }
  container.innerHTML='';
  if(!recentSalesHistory.length){
    const placeholder=document.createElement('div');
    placeholder.className='text-muted';
    placeholder.textContent='No recent sales yet.';
    container.appendChild(placeholder);
    return;
  }
  recentSalesHistory.forEach(entry=>{
    const row=document.createElement('div');
    row.className='recent-sale';
    const thumb=document.createElement('div');
    thumb.className='recent-sale-thumb';
    if(entry.image){
      const img=document.createElement('img');
      img.src=entry.image;
      img.alt=entry.name || entry.item_code || 'Recent item';
      img.loading='lazy';
      thumb.appendChild(img);
    } else {
      thumb.textContent=(entry.name||entry.item_code||'')[0] || '';
    }
    const info=document.createElement('div');
    info.className='recent-sale-info';
    const nameEl=document.createElement('p');
    nameEl.className='recent-sale-name';
    nameEl.textContent=entry.name || entry.item_code || 'Unknown item';
    const priceEl=document.createElement('div');
    priceEl.className='recent-sale-price';
    priceEl.textContent=money(Number(entry.rate||0));
    info.appendChild(nameEl);
    info.appendChild(priceEl);
    row.appendChild(thumb);
    row.appendChild(info);
    container.appendChild(row);
  });
}

function trackRecentItems(receiptItems){
  if(!Array.isArray(receiptItems) || !receiptItems.length){
    return;
  }
  receiptItems.forEach(line=>{
    const code=line.code || line.item_code || line.item_id;
    if(!code){
      return;
    }
    const idx=recentSalesHistory.findIndex(entry=>entry.item_code===code);
    if(idx!==-1){
      recentSalesHistory.splice(idx,1);
    }
    const image=line.image || findItemImageUrl(code);
    recentSalesHistory.unshift({
      item_code: code,
      name: line.name || line.item_name || code,
      rate: Number(line.rate||0),
      image
    });
  });
  if(recentSalesHistory.length>RECENT_SALES_LIMIT){
    recentSalesHistory.length=RECENT_SALES_LIMIT;
  }
  renderRecentItems();
}

function findItemImageUrl(itemOrCode){
  const code=typeof itemOrCode==='string' ? itemOrCode : (itemOrCode && (itemOrCode.item_code || itemOrCode.code || itemOrCode.name || ''));
  if(!code){
    return '';
  }
  const match=findItemByCode(code);
  if(match){
    return match.image || match.image_url || '';
  }
  return '';
}

function addToCart(item) {
  // Always open product overlay to choose a specific variant to ensure consistent IDs
  try{ return openProduct(item); }catch(e){ /* fallback: no-op */ }
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

function setBarcodeProcessingState(isProcessing) {
  barcodeScanInProgress = isProcessing;
  const input = document.getElementById('barcodeInput');
  if (input) {
    input.disabled = isProcessing;
    input.classList.toggle('barcode-loading', isProcessing);
    if (!isProcessing) {
      input.classList.remove('is-invalid');
    }
  }
  const button = document.getElementById('barcodeAddBtn');
  if (button) {
    button.disabled = isProcessing;
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

async function processBarcodeScan(rawValue) {
  if (barcodeScanInProgress) return;
  const input = document.getElementById('barcodeInput');
  const value = String(rawValue || (input && input.value) || '').trim();
  if (!value) {
    if (input) input.value = '';
    showBarcodeFeedback('', false);
    focusBarcodeInput();
    return;
  }
  setBarcodeProcessingState(true);
  try {
    // Try server-side barcode lookup for variants first
    const addedByBarcode = await tryAddVariantByBarcode(value);
    if (!addedByBarcode){
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
    }
  } finally {
    setBarcodeProcessingState(false);
    focusBarcodeInput();
  }
}

async function tryAddVariantByBarcode(code){
  try{
    const r = await fetch(`/api/lookup-barcode?code=${encodeURIComponent(code)}`);
  if (!r.ok) return false;
  const d = await r.json();
  if (!d || d.status!=='success' || !d.variant) return false;
  const v = d.variant;
  const existing = cart.find(ci => ci.item_code === v.item_id && !ci.refund);
  const rate = Number(v.rate||0);
    if (existing){
      existing.qty += 1;
      existing.amount = existing.qty * existing.rate;
    } else {
      cart.push({
        item_code: v.item_id,
        item_name: displayNameFrom(v.name, v.attributes||{}),
        qty: 1,
        rate: rate,
        original_rate: rate,
        amount: rate,
        image: null,
        variant: v.attributes || {},
        brand: null,
        item_group: v.item_group || null,
        vat_rate: effectiveVatRate(v.vat_rate),
        style_code: v.style_code || v.custom_style_code || '',
        refund: false
      });
    }
    updateCartDisplay();
    const feedbackName = displayNameFrom(v.name || code, v.attributes||{});
    showBarcodeFeedback(`Added ${feedbackName}`, false);
    const input = document.getElementById('barcodeInput');
    if (input){ input.value=''; input.classList.remove('is-invalid'); }
    try{ const cartCard=document.getElementById('cartCard'); if(cartCard){ cartCard.classList.add('cart-pulse'); setTimeout(()=>cartCard.classList.remove('cart-pulse'),700); } }catch(_){ }
    return true;
  }catch(e){ return false; }
}

function bindEvents(){
  // Settings/menu overlay
  const settingsBtn=document.getElementById('settingsBtn');
  const menuOverlay=document.getElementById('menuOverlay');
  const menuClose=document.getElementById('menuCloseBtn');
  const openSettingsBtn=document.getElementById('openSettingsBtn');
  const settingsView=document.getElementById('settingsView');
  const menuView=document.getElementById('menuView');
  const openAdminBtn=document.getElementById('openAdminBtn');
  const adminView=document.getElementById('adminView');
  const adminBackBtn=document.getElementById('adminBackBtn');
  const receiptPortSelect=document.getElementById('receiptPortSelect');
  const receiptPortRefreshBtn=document.getElementById('receiptPortRefreshBtn');
  const receiptPortStatus=document.getElementById('receiptPortStatus');
  const settingsSaveBtn=document.getElementById('settingsSaveBtn');
  const settingsBackBtn=document.getElementById('settingsBackBtn');
  const reprintLastBtn=document.getElementById('reprintLastBtn');
  // Cash management front menu
  const openCashMenuBtn=document.getElementById('openCashMenuBtn');
  const cashMenuOverlay=document.getElementById('cashMenuOverlay');
  const cashMenuCloseBtn=document.getElementById('cashMenuCloseBtn');
  const cashMenuOpenBtn=document.getElementById('cashMenuOpenBtn');
  const cashMenuZReadBtn=document.getElementById('cashMenuZReadBtn');
  const cashMenuFloatBtn=document.getElementById('cashMenuFloatBtn');
  // Return from receipt
  const returnBtn=document.getElementById('returnFromReceiptBtn');
  const returnOverlay=document.getElementById('returnOverlay');
  const returnCloseBtn=document.getElementById('returnCloseBtn');
  const returnScanInput=document.getElementById('returnScanInput');
  const returnFindBtn=document.getElementById('returnFindBtn');
  const returnLoadBtn=document.getElementById('returnLoadBtn');
  if(returnBtn&&returnOverlay){ returnBtn.addEventListener('click',()=>openReturnOverlay()); }
  if(returnCloseBtn){ returnCloseBtn.addEventListener('click', ()=>hideReturnOverlay()); }
  if(returnOverlay){ returnOverlay.addEventListener('click', e=>{ if(e.target===returnOverlay) hideReturnOverlay(); }); document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideReturnOverlay(); }); }
  if(returnFindBtn){ returnFindBtn.addEventListener('click', ()=>findReturnSale()); }
  if(returnScanInput){ returnScanInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); findReturnSale(); } }); }
  if(returnLoadBtn){ returnLoadBtn.addEventListener('click', ()=>loadReturnAsRefund()); }
  const shuffleFeaturedBtn=document.getElementById('shuffleFeaturedBtn');
  if(shuffleFeaturedBtn){ shuffleFeaturedBtn.addEventListener('click', ()=>renderFeaturedPanel(true)); }
  if(settingsBtn&&menuOverlay){ settingsBtn.addEventListener('click',()=>{ showMenu(); }); }
  if(menuClose&&menuOverlay){ menuClose.addEventListener('click',()=>{ menuOverlay.style.display='none'; }); }
  if(openSettingsBtn){ openSettingsBtn.addEventListener('click',()=>{ if(menuView) menuView.style.display='none'; if(settingsView){ settingsView.style.display='block'; populateSettingsForm(); } }); }
  if(settingsBackBtn){ settingsBackBtn.addEventListener('click',()=>{ if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(settingsSaveBtn){ settingsSaveBtn.addEventListener('click',()=>{ saveSettingsFromForm(); applySettings(); if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(openCashMenuBtn){ openCashMenuBtn.addEventListener('click', ()=>{ if(cashMenuOverlay){ cashMenuOverlay.style.display='flex'; cashMenuOverlay.style.visibility='visible'; cashMenuOverlay.style.opacity='1'; } }); }
  if(cashMenuCloseBtn){ cashMenuCloseBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; }); }
  if(cashMenuOverlay){ cashMenuOverlay.addEventListener('click', e=>{ if(e.target===cashMenuOverlay) cashMenuOverlay.style.display='none'; }); }
  if(cashMenuOpenBtn){ cashMenuOpenBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showOpeningOverlay(); }); }
  if(cashMenuZReadBtn){ cashMenuZReadBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; printZRead(); }); }
  const cashMenuXReadBtn=document.getElementById('cashMenuXReadBtn');
  if(cashMenuXReadBtn){ cashMenuXReadBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; printXRead(); }); }
  if(cashMenuFloatBtn){ cashMenuFloatBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showClosingOverlay(); }); }
  if(openAdminBtn){ openAdminBtn.addEventListener('click',()=>{ if(menuView) menuView.style.display='none'; if(settingsView) settingsView.style.display='none'; if(adminView) adminView.style.display='block'; refreshSerialPortOptions().catch(e=>warn('refresh serial ports failed', e)); }); }
  if(adminBackBtn){ adminBackBtn.addEventListener('click',()=>{ if(adminView) adminView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  // Opening/Closing overlays
  const openingOverlay=document.getElementById('openingOverlay');
  const openingCloseBtn=document.getElementById('openingCloseBtn');
  const openingSaveBtn=document.getElementById('openingSaveBtn');
  const openingKeypad=document.getElementById('openingKeypad');
  const openingInput=document.getElementById('openingFloatInput');
  if(openingCloseBtn){
    openingCloseBtn.addEventListener('click', ()=>{
      if(!canDismissOpeningOverlay()) return;
      if(openingOverlay) openingOverlay.style.display='none';
    });
  }
  if(openingOverlay){
    openingOverlay.addEventListener('click', e=>{
      if(e.target===openingOverlay && canDismissOpeningOverlay()){
        openingOverlay.style.display='none';
      }
    });
  }
  if(openingSaveBtn){ openingSaveBtn.addEventListener('click', saveOpeningFloat); }
  if(openingKeypad){
    openingKeypad.querySelectorAll('.key-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const k = btn.getAttribute('data-k');
        if(k==='C'){ openingDigits=''; }
        else if(k==='B'){ backspaceOpeningDigit(); }
        else if(k && k.length===1 && k>='0' && k<='9'){ appendOpeningDigit(k); }
        setOpeningFromDigits();
      });
    });
  }
  if(openingInput){
    openingInput.addEventListener('keydown', (e)=>{
      const k = e.key;
      if(k>='0' && k<='9'){ e.preventDefault(); appendOpeningDigit(k); setOpeningFromDigits(); }
      else if(k==='Backspace'){ e.preventDefault(); backspaceOpeningDigit(); setOpeningFromDigits(); }
      else if(k==='Delete'){ e.preventDefault(); openingDigits=''; setOpeningFromDigits(); }
      else if(k==='Enter'){ e.preventDefault(); saveOpeningFloat(); }
    });
  }
  const closingOverlay=document.getElementById('closingOverlay');
  const closingCloseBtn=document.getElementById('closingCloseBtn');
  const reconcileBtn=document.getElementById('reconcileBtn');
  const reconConfirmBtn=document.getElementById('reconConfirmBtn');
  const reconSummary=document.getElementById('reconSummary');
  const reconResult=document.getElementById('reconResult');
  const sumPayoutsInput=document.getElementById('sumPayoutsInput');
  const denomInputs = document.querySelectorAll('#denomsGrid .denom-qty');
  denomInputs.forEach(input=>{
    input.addEventListener('input', ()=>{ computeReconciliation(true); });
    input.addEventListener('focus', ()=>{ try{ input.select(); }catch(_){ } });
  });
  if(closingCloseBtn){ closingCloseBtn.addEventListener('click', ()=>{ if(closingOverlay) closingOverlay.style.display='none'; }); }
  if(closingOverlay){ closingOverlay.addEventListener('click', e=>{ if(e.target===closingOverlay) closingOverlay.style.display='none'; }); }
  if(reconcileBtn){ reconcileBtn.addEventListener('click', ()=>{ computeReconciliation(true); }); }
  if(reconConfirmBtn){ reconConfirmBtn.addEventListener('click', completeClosingFlow); }
  if(sumPayoutsInput){ sumPayoutsInput.addEventListener('input', ()=>{ computeReconciliation(true); }); }
  // Closing menu overlay wiring
  const closingMenuOverlay=document.getElementById('closingMenuOverlay');
  const closingMenuCloseBtn=document.getElementById('closingMenuCloseBtn');
  const closingMenuReprintBtn=document.getElementById('closingMenuReprintBtn');
  if(closingMenuOverlay){ closingMenuOverlay.addEventListener('click', e=>{ if(e.target===closingMenuOverlay) closingMenuOverlay.style.display='none'; }); }
  if(closingMenuCloseBtn){ closingMenuCloseBtn.addEventListener('click', ()=>{ if(closingMenuOverlay) closingMenuOverlay.style.display='none'; }); }
  if(closingMenuReprintBtn){ closingMenuReprintBtn.addEventListener('click', ()=>{ try{ printReconciliation(); }catch(_){} }); }

  // Admin actions
  const adminInitDbBtn=document.getElementById('adminInitDbBtn');
  const adminSeedBtn=document.getElementById('adminSeedBtn');
  const adminEnsureBtn=document.getElementById('adminEnsureBtn');
  const adminSyncBtn=document.getElementById('adminSyncBtn');
  const adminStatusBtn=document.getElementById('adminStatusBtn');
  const adminStatusOut=document.getElementById('adminStatusOut');
  receiptPortSelectEl = receiptPortSelect;
  receiptPortStatusEl = receiptPortStatus;
  if(receiptPortStatusEl){
    updateReceiptPortStatus();
  }
  if(receiptPortSelect){
    receiptPortSelect.addEventListener('change', ()=>{ setReceiptSerialPort(receiptPortSelect.value); });
  }
  if(receiptPortRefreshBtn){
    receiptPortRefreshBtn.addEventListener('click', ()=>{ refreshSerialPortOptions().catch(e=>warn('refresh serial ports failed', e)); });
  }
  const showStatus=(text)=>{ if(adminStatusOut){ adminStatusOut.textContent = text; } };
  async function postJson(url){
    try{
      const r = await fetch(url, { method:'POST' });
      const t = await r.text();
      return `${url}: ${r.status} ${r.statusText}\n${t}`;
    }catch(e){ return `${url}: failed ${e}`; }
  }
  async function getJson(url){
    try{
      const r = await fetch(url);
      const t = await r.text();
      return `${url}: ${r.status} ${r.statusText}\n${t}`;
    }catch(e){ return `${url}: failed ${e}`; }
  }
  if(adminInitDbBtn){ adminInitDbBtn.addEventListener('click', async()=>{ showStatus('Initializing database...'); const out = await postJson('/api/db/init'); showStatus(out); }); }
  if(adminSeedBtn){ adminSeedBtn.addEventListener('click', async()=>{ showStatus('Seeding demo data...'); const out = await postJson('/api/db/seed-demo'); showStatus(out); }); }
  if(adminEnsureBtn){ adminEnsureBtn.addEventListener('click', async()=>{ showStatus('Ensuring demo DB...'); const out = await postJson('/api/db/ensure-demo'); showStatus(out); }); }
  if(adminSyncBtn){ adminSyncBtn.addEventListener('click', async()=>{ showStatus('Syncing items...'); const out = await postJson('/api/db/sync-items'); showStatus(out); }); }
  if(adminStatusBtn){ adminStatusBtn.addEventListener('click', async()=>{ showStatus('Fetching DB status...'); const out = await getJson('/api/db/status'); showStatus(out); }); }
  if(reprintLastBtn){ reprintLastBtn.addEventListener('click',()=>{ if(lastReceiptInfo) showReceiptOverlay(lastReceiptInfo); else alert('No receipt available to reprint yet.'); }); }
  // search field opens overlay
  const s=document.getElementById('itemSearch'); if(s){ s.addEventListener('focus',()=>showSearchOverlay()); s.addEventListener('input',e=>showSearchOverlay(e.target.value)); }
  const zeroToggle=document.getElementById('zeroStockToggle');
  if(zeroToggle){
    zeroToggle.checked = isShowZeroStockEnabled();
    zeroToggle.addEventListener('change', e=>setShowZeroStock(e.target.checked));
  }
  // checkout
  const chk=document.getElementById('checkoutBtn'); if(chk) chk.addEventListener('click',()=>{ if(!currentCashier) return showLogin(); if(cart.length===0) return alert('Cart is empty'); openCheckoutOverlay(); });
  // clear cart
  const clr=document.getElementById('clearCartBtn'); if(clr) clr.addEventListener('click',()=>{ if(cart.length===0) return; if(confirm('Clear all items from cart?')){ cart=[]; appliedPayments=[]; vouchers=[]; issuedVouchers=[]; pendingVoucherBalancePrints=[]; voucherSaleMode=false; updateCartDisplay(); renderAppliedPayments(); updateCashSection(); }});
  const voucherSaleBtn=document.getElementById('voucherSaleBtn'); if(voucherSaleBtn){ voucherSaleBtn.addEventListener('click', startGiftVoucherSale); }
  // cashier badge/menu
  const badge=document.getElementById('cashierBadge'), menu=document.getElementById('cashierMenu'), logout=document.getElementById('logoutBtn');
  if(!badge) warn('cashierBadge not found');
  if(!document.getElementById('loginOverlay')) warn('loginOverlay not found');
  if(badge){ badge.addEventListener('click',e=>{ e.stopPropagation(); log('cashier badge clicked', { signedIn: !!currentCashier }); if(!currentCashier) { showLogin(); return; } if(menu) menu.classList.toggle('open'); }); }
  // hold/pause actions
  const holdBtn = document.getElementById('holdBtn');
  if (holdBtn){ holdBtn.addEventListener('click', e=>{ e.stopPropagation(); if(menu) menu.classList.remove('open'); holdCurrentTransaction(); }); }
  const pausedBtn = document.getElementById('pausedBtn');
  if (pausedBtn){ pausedBtn.addEventListener('click', e=>{ e.stopPropagation(); if(menu) menu.classList.remove('open'); openPausedOverlay(); }); }
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
  // paused overlay wiring
  const pausedOverlay = document.getElementById('pausedOverlay');
  const pausedCloseBtn = document.getElementById('pausedCloseBtn');
  if (pausedOverlay){
    if (pausedCloseBtn) pausedCloseBtn.addEventListener('click', hidePausedOverlay);
    pausedOverlay.addEventListener('click', e=>{ if(e.target===pausedOverlay) hidePausedOverlay(); });
    document.addEventListener('keydown', e=>{ if(e.key==='Escape') hidePausedOverlay(); });
  }
  // product overlay
  const po=document.getElementById('productOverlay'), pc=document.getElementById('productCloseBtn'); if(po){ if(pc) pc.addEventListener('click',hideProductOverlay); po.addEventListener('click',e=>{ if(e.target===po) hideProductOverlay(); }); document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideProductOverlay(); }); }
  const addQueuedBtn=document.getElementById('addQueuedVariantsBtn');
  if(addQueuedBtn){ addQueuedBtn.addEventListener('click', addQueuedVariantsToCart); }
  const clearQueueBtn=document.getElementById('clearVariantQueueBtn');
  if(clearQueueBtn){ clearQueueBtn.addEventListener('click', resetVariantQueue); }
  // checkout overlay
  const co=document.getElementById('checkoutOverlay'), cc=document.getElementById('checkoutCloseBtn'), cs=document.getElementById('completeSaleBtn');
  if(co){
    if(cc) cc.addEventListener('click',hideCheckoutOverlay);
    co.addEventListener('click',e=>{ if(e.target===co) hideCheckoutOverlay(); });
    document.querySelectorAll('.tender-btn').forEach(b=>b.addEventListener('click',()=>selectTender(b.getAttribute('data-tender'))));
    co.querySelectorAll('.denom-btn').forEach(b=>b.addEventListener('click',()=>{ const a=Number(b.getAttribute('data-amount'))||0; addCashAmount(denomSubtract?-a:a); }));
    const sub=document.getElementById('toggleSubtractBtn');
    if(sub){ sub.addEventListener('click',()=>{ denomSubtract=!denomSubtract; sub.classList.toggle('active',denomSubtract); sub.textContent = denomSubtract ? '- Mode (On)' : '- Mode'; }); }
    const applyCashBtn = document.getElementById('applyCashBtn');
    if(applyCashBtn){
      applyCashBtn.addEventListener('click', ()=>{
        const cashField=document.getElementById('cashInputField');
        const val = Math.abs(Number((cashField && cashField.value) || cashInput || 0) || 0);
        if(val>0){
          appliedPayments.push({ mode_of_payment:'Cash', amount: val });
          resetCashEntry();
          updateCashSection();
        }
      });
    }
    const cashRemainingBtn = document.getElementById('cashFullAmountBtn');
    if(cashRemainingBtn){
      cashRemainingBtn.addEventListener('click', ()=>{
        const cashField = document.getElementById('cashInputField');
        if(!cashField) return;
        fillInputWithRemainingAmount(cashField);
        cashEntryDirty = true;
        updateCashSection();
      });
    }
    
    // Convert to Euro button
    const convertToEuroBtn = document.getElementById('convertToEuroBtn');
    if(convertToEuroBtn){
      convertToEuroBtn.addEventListener('click', async ()=>{
        const amountDueEl = document.getElementById('amountDue');
        const amountDue = amountDueEl ? Number(amountDueEl.textContent.replace(/[^\d.-]/g, '')) : 0;
        
        if(amountDue <= 0){
          alert('No amount due to convert.');
          return;
        }

        // Open the EUR conversion overlay
        await openEurConversionOverlay(amountDue);
      });
    }
    
    const applyOtherBtn = document.getElementById('applyOtherBtn');
    if(applyOtherBtn){
      applyOtherBtn.addEventListener('click', ()=>{
        const amtEl=document.getElementById('otherAmountInput');
        const val=Math.abs(Number(amtEl && amtEl.value) || 0);
        if(val>0){
          const mode = (currentTender==='card')?'Card':'Other';
          appliedPayments.push({ mode_of_payment: mode, amount: val });
          resetOtherEntry();
          updateCashSection();
        }
      });
    }
    
    document.querySelectorAll('[data-eur-option]').forEach(btn=>{
      btn.addEventListener('click', ()=> selectEurOption(btn.getAttribute('data-eur-option')));
    });
    const eurInput = document.getElementById('eurReceivedInput');
    if (eurInput) {
      eurInput.addEventListener('focus', ()=> eurInput.select());
      eurInput.addEventListener('input', updateEurDifferenceUI);
    }
    const eurKeypad = document.getElementById('eurKeypad');
    if (eurKeypad) {
      eurKeypad.querySelectorAll('.key-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const target = document.getElementById('eurReceivedInput');
          applyMoneyKey(target, btn.getAttribute('data-k'));
          updateEurDifferenceUI();
        });
      });
    }
    const eurApplyBtn = document.getElementById('eurApplyBtn');
    if (eurApplyBtn) {
      eurApplyBtn.addEventListener('click', applySelectedEurTender);
    }
    const eurUseExpectedBtn = document.getElementById('eurUseExpectedBtn');
    if (eurUseExpectedBtn) {
      eurUseExpectedBtn.addEventListener('click', fillEurWithExpected);
    }
    const eurOverlayCloseBtn = document.getElementById('eurOverlayCloseBtn');
    if (eurOverlayCloseBtn) {
      eurOverlayCloseBtn.addEventListener('click', hideEurOverlay);
    }
    const eurOverlay = document.getElementById('eurConverterOverlay');
    if (eurOverlay) {
      eurOverlay.addEventListener('click', e=>{
        if (e.target === eurOverlay) hideEurOverlay();
      });
    }
    document.addEventListener('keydown', e=>{
      if (e.key === 'Escape' && isEurOverlayVisible()) {
        hideEurOverlay();
      }
    });
    
    if(cs) cs.addEventListener('click',completeSaleFromOverlay);
  }
  // discount overlay wiring
  const openDiscountBtn = document.getElementById('openDiscountBtn');
  const discountOverlay = document.getElementById('discountOverlay');
  const discountCloseBtn = document.getElementById('discountCloseBtn');
  const discountItemsList = document.getElementById('discountItemsList');
  const discountSelectAllBtn = document.getElementById('discountSelectAllBtn');
  const discountDeselectAllBtn = document.getElementById('discountDeselectAllBtn');
  const applyDiscountBtn = document.getElementById('applyDiscountBtn');
  const discModeAmount = document.getElementById('discModeAmount');
  const discModePercent = document.getElementById('discModePercent');
  const discModeSet = document.getElementById('discModeSet');
  const discountValueLabel = document.getElementById('discountValueLabel');
  const discountKeypad = document.getElementById('discountKeypad');
  if(openDiscountBtn){ openDiscountBtn.addEventListener('click', openDiscountOverlay); }
  if(discountCloseBtn){ discountCloseBtn.addEventListener('click', commitDiscountsAndClose); }
  if(discountOverlay){ discountOverlay.addEventListener('click', e=>{ if(e.target===discountOverlay) hideDiscountOverlay(); }); document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideDiscountOverlay(); }); }
  if(discountSelectAllBtn){ discountSelectAllBtn.addEventListener('click', ()=>{ discountItemsList?.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=true); }); }
  if(discountDeselectAllBtn){ discountDeselectAllBtn.addEventListener('click', ()=>{ discountItemsList?.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=false); }); }
  if(applyDiscountBtn){ applyDiscountBtn.addEventListener('click', applyDiscountsToSelected); }
  const updateValueLabel=()=>{
    if(!discountValueLabel) return;
    if(discModeAmount && discModeAmount.checked){ discountValueLabel.textContent = 'Amount off'; return; }
    if(discModePercent && discModePercent.checked){ discountValueLabel.textContent = 'Percent'; return; }
    if(discModeSet && discModeSet.checked){ discountValueLabel.textContent = 'Set price'; return; }
    discountValueLabel.textContent = 'Value';
  };
  [discModeAmount, discModePercent, discModeSet].forEach(el=>{ if(el) el.addEventListener('change', updateValueLabel); });
  updateValueLabel();
  if(discountKeypad){
    const valEl = document.getElementById('discountValueInput');
    discountKeypad.querySelectorAll('.key-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        if(!valEl) return;
        const k = btn.getAttribute('data-k');
        let cur = (valEl.value||'').toString();
        if(k==='C') cur='';
        else if(k==='B' || k==='?') cur = cur.slice(0,-1);
        else if(k==='.' && cur.includes('.')){ /* ignore extra dot */ }
        else cur += k;
        valEl.value = cur;
      });
    });
  }
  layoutCashPanel();
  window.addEventListener('resize', layoutCashPanel);
  // cash input typing and keypad toggle
  const cashInputField = document.getElementById('cashInputField');
  if (cashInputField){
    cashInputField.addEventListener('focus', ()=>{
      cashInputField.select();
    });
    cashInputField.addEventListener('input', ()=> {
      const raw = (cashInputField.value || '').toString();
      const n = Number(raw);
      if(Number.isFinite(n)){
        const cents = Math.max(0, Math.round(n*100));
        if(cashInputField.dataset) cashInputField.dataset.cents = String(cents);
      }
      cashInput = raw;
      cashEntryDirty = true;
      updateCashSection();
    });
  }
  const otherAmountField = document.getElementById('otherAmountInput');
  if (otherAmountField){
    otherAmountField.addEventListener('focus', ()=>{
      otherAmountField.select();
    });
    otherAmountField.addEventListener('input', ()=>{
      otherEntryDirty = true;
    });
  }
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
    // Normalize backspace label
    try{ const bk = cashKeypad.querySelector('[data-k="B"]'); if(bk) bk.textContent = '⌫'; }catch(_){ }
    cashKeypad.querySelectorAll('.key-btn').forEach(btn => {
      btn.addEventListener('click', ()=>{
        const k = btn.getAttribute('data-k');
        const target = document.getElementById('cashInputField');
        const v = applyMoneyKey(target, k);
        cashInput = v;
        cashEntryDirty = true;
        updateCashSection();
      });
    });
  }
  // Other/Card keypad wiring (right-to-left cents entry)
  const otherKeypad = document.getElementById('otherKeypad');
  if (otherKeypad){
    try{ const bk = otherKeypad.querySelector('[data-k="B"]'); if(bk) bk.textContent = '⌫'; }catch(_){ }
    otherKeypad.querySelectorAll('.key-btn').forEach(btn => {
      btn.addEventListener('click', ()=>{
        const k = btn.getAttribute('data-k');
        const target = document.getElementById('otherAmountInput');
        applyMoneyKey(target, k);
        otherEntryDirty = true;
        updateCashSection();
      });
    });
  }
  // Card: Full Amount button
  const otherFullBtn = document.getElementById('otherFullAmountBtn');
  if (otherFullBtn){
    otherFullBtn.addEventListener('click', ()=>{
      const amtEl = document.getElementById('otherAmountInput');
      if(!amtEl) return;
      fillInputWithRemainingAmount(amtEl);
      otherEntryDirty = true;
      updateCashSection();
    });
  }
  // voucher overlay
  const vo=document.getElementById('voucherOverlay'), vclose=document.getElementById('voucherCloseBtn'), vsubmit=document.getElementById('voucherSubmitBtn'), vinput=document.getElementById('voucherCodeInput');
  if(vo){ if(vclose) vclose.addEventListener('click',hideVoucherOverlay); if(vsubmit) vsubmit.addEventListener('click',submitVoucher); if(vinput) vinput.addEventListener('keydown',e=>{ if(e.key==='Enter') submitVoucher(); }); document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideVoucherOverlay(); }); vo.addEventListener('click',e=>{ if(e.target===vo) hideVoucherOverlay(); }); }
  // Ensure tender buttons are always wired up (robust / idempotent)
  document.querySelectorAll('.tender-btn').forEach(btn => {
    if (btn.__posTenderBound) return; // avoid duplicate handlers
    btn.addEventListener('click', () => {
      const t = (btn.dataset && btn.dataset.tender) ? btn.dataset.tender : btn.getAttribute('data-tender');
      try { selectTender(String(t || '')); } catch (e) { err('selectTender failed', e); }
    });
    btn.__posTenderBound = true;
  });
}

function showMenu(){ const o=document.getElementById('menuOverlay'); const mv=document.getElementById('menuView'); const sv=document.getElementById('settingsView'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); if(mv) mv.style.display='block'; if(sv) sv.style.display='none'; o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){} }
function loadSettings(){
  try{
    const raw=localStorage.getItem('pos_settings');
    if(raw){
      const s=JSON.parse(raw);
      settings = Object.assign({
        till_number:'',
        branch_name:'',
        dark_mode:false,
        christmas_mode:false,
        auto_print:false,
        opening_float:0,
        opening_date:'',
        net_cash:0,
        net_card:0,
        net_voucher:0,
        net_cash_change:0,
        vat_rate:20,
        vat_inclusive:true,
        currency_rate: DEFAULT_STORE_RATE,
        currency_rate_updated: null,
        z_agg:{},
        receipt_header: RECEIPT_DEFAULT_HEADER,
        receipt_footer: RECEIPT_DEFAULT_FOOTER,
        open_drawer_after_print: true,
        show_zero_stock: false,
        till_open: false,
        till_opened_at: null,
        till_closed_at: null
      }, s);
    }
  }catch(e){}
  try{
    if(settings.opening_date !== todayStr()){
      settings.till_open = false;
      settings.net_cash_change = 0;
    }
  }catch(_){}
}
function saveSettings(){ try{ localStorage.setItem('pos_settings', JSON.stringify(settings)); }catch(e){} }
function normalizeMultilineInput(value){
  if(typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n');
}
function shouldOpenDrawerAfterSale(){
  return settings.open_drawer_after_print !== false;
}
function wantsDrawerPulseFor(info){
  if(!info) return false;
  if(info.isRefund) return false;
  return shouldOpenDrawerAfterSale();
}
let snowLayerEl = null;
let snowInterval = null;
function ensureSnowLayer(){
  try{
    if(snowLayerEl && document.body && document.body.contains(snowLayerEl)) return snowLayerEl;
    if(!document.body) return null;
    const layer=document.createElement('div');
    layer.id='snowLayer';
    layer.className='snow-layer';
    layer.setAttribute('aria-hidden','true');
    document.body.appendChild(layer);
    snowLayerEl = layer;
    return layer;
  }catch(e){
    warn('ensureSnowLayer failed', e);
    return null;
  }
}
function spawnSnowflake(){
  const layer = snowLayerEl || document.getElementById('snowLayer');
  if(!layer) return;
  const flake=document.createElement('div');
  flake.className='snowflake';
  flake.textContent='*';
  const size = 0.6 + Math.random()*0.8;
  flake.style.left = `${Math.random()*100}%`;
  flake.style.fontSize = `${size.toFixed(2)}rem`;
  flake.style.opacity = (0.6 + Math.random()*0.4).toFixed(2);
  flake.style.setProperty('--fall-duration', `${8 + Math.random()*9}s`);
  flake.style.setProperty('--fall-delay', `${(Math.random()*-10).toFixed(2)}s`);
  flake.style.setProperty('--drift', `${(Math.random()*16 - 8).toFixed(2)}px`);
  layer.appendChild(flake);
  setTimeout(()=>{ try{ flake.remove(); }catch(_){ /* ignore */ } }, 20000);
}
function enableSnow(){
  try{
    const layer = ensureSnowLayer();
    if(!layer) return;
    layer.style.display = 'block';
    for(let i=0;i<20;i++) spawnSnowflake();
    if(snowInterval) clearInterval(snowInterval);
    snowInterval = setInterval(spawnSnowflake, 450);
  }catch(e){
    warn('enableSnow failed', e);
  }
}
function disableSnow(){
  try{
    if(snowInterval){
      clearInterval(snowInterval);
      snowInterval = null;
    }
    if(snowLayerEl && snowLayerEl.parentNode){
      snowLayerEl.innerHTML = '';
      snowLayerEl.remove();
    }
    snowLayerEl = null;
  }catch(e){ /* ignore */ }
}
function setSnowEnabled(on){
  if(on){ enableSnow(); }
  else { disableSnow(); }
}
function populateSettingsForm(){
  const till=document.getElementById('tillNumberInput');
  const branch=document.getElementById('branchNameInput');
  const vat=document.getElementById('vatRateInput');
  const vatInc=document.getElementById('vatInclusiveSwitch');
  const dark=document.getElementById('darkModeSwitch');
  const christmas=document.getElementById('christmasSwitch');
  const auto=document.getElementById('autoPrintSwitch');
  const drawer=document.getElementById('openDrawerSwitch');
  const header=document.getElementById('receiptHeaderInput');
  const footer=document.getElementById('receiptFooterInput');
  if(till) till.value = settings.till_number || '';
  if(branch) branch.value = settings.branch_name || '';
  if(vat) vat.value = (settings.vat_rate!=null?settings.vat_rate:20);
  if(vatInc) vatInc.checked = !!settings.vat_inclusive;
  if(dark) dark.checked = !!settings.dark_mode;
  if(christmas) christmas.checked = !!settings.christmas_mode;
  if(auto) auto.checked = !!settings.auto_print;
  if(drawer) drawer.checked = settings.open_drawer_after_print !== false;
  if(header) header.value = (settings.receipt_header!=null?settings.receipt_header:RECEIPT_DEFAULT_HEADER);
  if(footer) footer.value = (settings.receipt_footer!=null?settings.receipt_footer:'');
}
function saveSettingsFromForm(){
  const till=document.getElementById('tillNumberInput');
  const branch=document.getElementById('branchNameInput');
  const vat=document.getElementById('vatRateInput');
  const vatInc=document.getElementById('vatInclusiveSwitch');
  const dark=document.getElementById('darkModeSwitch');
  const christmas=document.getElementById('christmasSwitch');
  const auto=document.getElementById('autoPrintSwitch');
  const drawer=document.getElementById('openDrawerSwitch');
  const header=document.getElementById('receiptHeaderInput');
  const footer=document.getElementById('receiptFooterInput');
  settings.till_number = till ? till.value.trim() : '';
  settings.branch_name = branch ? branch.value.trim() : '';
  settings.vat_rate = vat ? Math.max(0, Number(vat.value||0)) : 20;
  settings.vat_inclusive = vatInc ? !!vatInc.checked : true;
  settings.dark_mode = dark ? !!dark.checked : false;
  settings.christmas_mode = christmas ? !!christmas.checked : false;
  settings.auto_print = auto ? !!auto.checked : false;
  settings.open_drawer_after_print = drawer ? !!drawer.checked : true;
  if(header) settings.receipt_header = normalizeMultilineInput(header.value||'');
  if(footer) settings.receipt_footer = normalizeMultilineInput(footer.value||'');
  saveSettings();
}
function applySettings(){
  document.body.classList.toggle('dark-mode', !!settings.dark_mode);
  setSnowEnabled(!!settings.christmas_mode);
}

// Search overlay
function showSearchOverlay(q=''){
  const o=document.getElementById('searchOverlay'), i=document.getElementById('searchInputBig'), b=document.getElementById('brandFilter');
  const zeroToggle=document.getElementById('zeroStockToggle');
  if(!o||!i||!b) return;
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){}
  refreshBrandFilterOptions();
  if(zeroToggle){
    zeroToggle.checked = isShowZeroStockEnabled();
  }
  i.value=q;
  renderSearchResults();
  setTimeout(()=>i.focus(),0);
}
function hideSearchOverlay(){ const o=document.getElementById('searchOverlay'); if(o) o.style.display='none'; }
function itemMatchesSearch(item, needle){
  if(!needle) return true;
  const terms=[];
  const push=val=>{ if(val===undefined||val===null) return; const txt=String(val).trim(); if(txt) terms.push(txt.toLowerCase()); };
  push(item.item_name);
  push(item.brand);
  push(item.item_code);
  push(item.name);
  push(item.barcode);
  push(item.custom_style_code);
  push(item.custom_simple_colour);
  if(Array.isArray(item.barcodes)){
    item.barcodes.forEach(entry=>{
      if(!entry) return;
      if(typeof entry === 'object'){
        if(entry.barcode) push(entry.barcode);
        if(entry.value) push(entry.value);
      }else{
        push(entry);
      }
    });
  }
  const attrs=item.attributes;
  if(attrs){
    if(typeof attrs==='string'){
      push(attrs);
    }else if(Array.isArray(attrs)){
      attrs.forEach(push);
    }else if(typeof attrs==='object'){
      Object.entries(attrs).forEach(([k,v])=>{
        push(k);
        if(Array.isArray(v)){
          v.forEach(push);
        }else if(v&&typeof v==='object'){
          Object.values(v).forEach(push);
        }else{
          push(v);
        }
      });
    }
  }
  return terms.some(t=>t.includes(needle));
}
function renderSearchResults(){
  const g=document.getElementById('searchGrid'), i=document.getElementById('searchInputBig'), b=document.getElementById('brandFilter');
  if(!g) return;
  let list=isShowZeroStockEnabled() ? items.slice() : items.filter(hasSellableStock);
  const q=(i&&i.value||'').trim().toLowerCase();
  const br=(b&&b.value)||'';
  if(q) list=list.filter(x=>itemMatchesSearch(x,q));
  if(br) list=list.filter(x=>(x.brand||'Unbranded')===br);
  g.innerHTML='';
  if(!list.length){
    const msg=document.createElement('div');
    msg.className='col-12';
    msg.innerHTML=`<div class="alert alert-secondary mb-0 small">No matching products${isShowZeroStockEnabled()?'':' with stock'}. Toggle "Show zero-stock lines" to include everything.</div>`;
    g.appendChild(msg);
    return;
  }
  list.forEach(it=>{
    const c=document.createElement('div');
    c.className='col';
    const imgStyle=it.image?`style="background-image:url('${it.image}')"`:'';
    const priceHtml=formatItemPrice(it);
    c.innerHTML=`<div class="product-card" onclick='selectProduct("${it.name}")'><div class="product-img" ${imgStyle}></div><div class="fw-semibold">${it.item_name}</div><div class="text-muted small">${it.brand||'Unbranded'}</div><div class="mt-1">${priceHtml}</div></div>`;
    g.appendChild(c);
  });
}
function selectProduct(name){ const it=items.find(x=>x.name===name); if(it) openProduct(it); }

// Product detail overlay
let currentProduct=null;
let variantSelectionQueue=[];
let variantCellRefs=new Map();
async function openProduct(item){ currentProduct=item; const o=document.getElementById('productOverlay'), t=document.getElementById('productTitle'), im=document.getElementById('productImage'), br=document.getElementById('productBrand'), pr=document.getElementById('productPrice'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); t.textContent=item.item_name; br.textContent=item.brand||''; const fallbackPrice=formatItemPrice(item); if(pr) pr.textContent=fallbackPrice; im.style.backgroundImage=item.image?`url('${item.image}')`:''; o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){} clearVariantMatrix(); try{ const r=await fetch(`/api/item_matrix?item=${encodeURIComponent(item.name)}`); const d=await r.json(); if(d.status==='success'){ renderVariantMatrix(item,d.data); if(pr){ pr.textContent=formatVariantPriceRange(d.data.price_min,d.data.price_max,fallbackPrice); } } }catch(e){ console.error(e);} }
function hideProductOverlay(){
  const o=document.getElementById('productOverlay');
  if(o) o.style.display='none';
  variantCellRefs=new Map();
  resetVariantQueue();
}
function renderVariantMatrix(item,m){
  const h=document.getElementById('matrixHead'), b=document.getElementById('matrixBody');
  if(!h||!b) return;
  variantCellRefs=new Map();
  resetVariantQueue();
  h.innerHTML='';
  const headerLabels=['Colour','Style','Width',...(m.sizes||[])];
  const tr=document.createElement('tr'); 
  headerLabels.forEach(x=>{ const th=document.createElement('th'); th.textContent=x; tr.appendChild(th);}); 
  h.appendChild(tr); 
  b.innerHTML=''; 
  const styleCodes=(m.style_codes||{}); 
  (m.colors||[]).forEach(color=>{ 
    (m.widths||[]).forEach(width=>{ 
      const row=document.createElement('tr'); 
      const tc=document.createElement('th'); 
      tc.style.cursor='pointer';
      tc.textContent=color;
      // Click on color to show that color's image (get first variant with this color)
      tc.addEventListener('click',()=>{
        const firstVarKey=Object.keys(m.variants||{}).find(k=>k.startsWith(color+'|'));
        if(firstVarKey){
          const firstVar=m.variants[firstVarKey];
          if(firstVar && firstVar.image){
            const im=document.getElementById('productImage');
            if(im) im.style.backgroundImage=`url('${firstVar.image}')`;
          }
        }
      });
      row.appendChild(tc); 
      const styleCell=document.createElement('td');
      const styleText=styleCodes[color]||'';
      styleCell.className='variant-style-cell';
      styleCell.textContent=styleText;
      row.appendChild(styleCell);
      const tw=document.createElement('th'); 
      tw.textContent=width; 
      row.appendChild(tw); 
      (m.sizes||[]).forEach(sz=>{ 
        const key=`${color}|${width}|${sz}`;
        const qty=(m.stock&&m.stock[key])||0;
        const td=document.createElement('td');
        td.className='variant-cell'+(qty<=0?' disabled':'');
        td.textContent=qty;
        td.dataset.stockValue=String(qty);
        td.dataset.variantKey=key;
        variantCellRefs.set(key, td);
        if(qty>0){
          const vrec=(m.variants&&m.variants[key])||null;
          td.addEventListener('click',()=>queueVariantSelection(item,{color,width,size:sz,qtyAvailable:qty}, vrec));
        }
        row.appendChild(td);
      }); 
      b.appendChild(row);
    });
  });
}

function queueVariantSelection(item, variant, variantRec){
  if(!item || !variant) return;
  const key=variantSelectionKey(variant);
  const availableRaw=Number(variant.qtyAvailable);
  const stockCap=Number.isFinite(availableRaw)&&availableRaw>0 ? availableRaw : null;
  const existing=variantSelectionQueue.find(entry=>entry.key===key);
  const nextQty=(existing?existing.qty:0)+1;
  if(stockCap!==null && nextQty>stockCap){
    alert(`Only ${stockCap} in stock for ${variant.size||'this variant'}.`);
    return;
  }
  if(existing){
    existing.qty=nextQty;
  }else{
    variantSelectionQueue.push({
      key,
      item,
      variant:{ ...variant },
      variantRec: variantRec || null,
      qty:1,
      stock: stockCap
    });
  }
  updateVariantQueueDisplay();
}

function updateVariantQueueDisplay(){
  const list=document.getElementById('variantQueueList');
  const addBtn=document.getElementById('addQueuedVariantsBtn');
  const clearBtn=document.getElementById('clearVariantQueueBtn');
  const hasItems=variantSelectionQueue.length>0;
  if(addBtn) addBtn.disabled=!hasItems;
  if(clearBtn) clearBtn.disabled=!hasItems;
  if(list){
    if(!hasItems){
      list.innerHTML='<div class="list-group-item text-muted small">No variants queued. Tap a size to select it.</div>';
    }else{
      list.innerHTML='';
      variantSelectionQueue.forEach((entry, idx)=>{
        const row=document.createElement('div');
        row.className='list-group-item d-flex align-items-center justify-content-between gap-2 flex-wrap';
        const labelWrap=document.createElement('div');
        const parts=[entry.variant.color, entry.variant.width, entry.variant.size].filter(Boolean);
        labelWrap.innerHTML=`<div class="fw-semibold">${parts.length?parts.join(' / '):'Variant'}</div>`;
        const detailBits=[];
        if(entry.variantRec && entry.variantRec.style_code){
          detailBits.push(entry.variantRec.style_code);
        }
        if(Number.isFinite(entry.stock) && entry.stock>0){
          detailBits.push(`${entry.stock} in stock`);
        }
        if(detailBits.length){
          const meta=document.createElement('div');
          meta.className='text-muted small';
          meta.textContent=detailBits.join(' • ');
          labelWrap.appendChild(meta);
        }
        const controls=document.createElement('div');
        controls.className='d-flex align-items-center gap-2 flex-wrap justify-content-end';
        const minus=document.createElement('button');
        minus.type='button';
        minus.className='btn btn-outline-secondary btn-sm';
        minus.textContent='-';
        minus.addEventListener('click',()=>changeVariantQueueQty(idx,-1));
        const qty=document.createElement('span');
        qty.className='fw-semibold px-2';
        qty.textContent=entry.qty;
        const plus=document.createElement('button');
        plus.type='button';
        plus.className='btn btn-outline-secondary btn-sm';
        plus.textContent='+';
        const maxed=Number.isFinite(entry.stock)&&entry.stock>0&&entry.qty>=entry.stock;
        plus.disabled=maxed;
        plus.title=maxed?'Max stock selected':'';
        plus.addEventListener('click',()=>changeVariantQueueQty(idx,1));
        const remove=document.createElement('button');
        remove.type='button';
        remove.className='btn btn-outline-danger btn-sm';
        remove.textContent='Remove';
        remove.addEventListener('click',()=>removeVariantQueueEntry(idx));
        controls.appendChild(minus);
        controls.appendChild(qty);
        controls.appendChild(plus);
        controls.appendChild(remove);
        row.appendChild(labelWrap);
        row.appendChild(controls);
        list.appendChild(row);
      });
    }
  }
  refreshVariantCellHighlights();
}

function changeVariantQueueQty(index, delta){
  const entry=variantSelectionQueue[index];
  if(!entry) return;
  const next=entry.qty+delta;
  if(next<=0){
    variantSelectionQueue.splice(index,1);
  }else{
    const limit=Number(entry.stock);
    if(Number.isFinite(limit) && limit>0 && next>limit){
      alert(`Only ${limit} in stock for ${entry.variant.size||'this variant'}.`);
      return;
    }
    entry.qty=next;
  }
  updateVariantQueueDisplay();
}

function removeVariantQueueEntry(index){
  if(index<0) return;
  variantSelectionQueue.splice(index,1);
  updateVariantQueueDisplay();
}

function addQueuedVariantsToCart(){
  if(!variantSelectionQueue.length) return;
  variantSelectionQueue.forEach(entry=>{
    addVariantToCart(entry.item || currentProduct, entry.variant, entry.variantRec, entry.qty);
  });
  resetVariantQueue();
}

function refreshVariantCellHighlights(){
  if(!variantCellRefs) return;
  const queuedMap=new Map();
  variantSelectionQueue.forEach(entry=>queuedMap.set(entry.key, entry.qty));
  variantCellRefs.forEach((cell,key)=>{
    if(!cell) return;
    const queued=queuedMap.get(key)||0;
    const baseLabel=cell.dataset.stockValue || cell.textContent;
    cell.textContent=queued>0 ? `${baseLabel} (+${queued})` : baseLabel;
    cell.classList.toggle('queued', queued>0);
  });
}

function addVariantToCart(item, variant, variantRec, quantity=1){
  const name = displayNameFrom(item.item_name, { Color: variant.color, Width: variant.width, Size: variant.size });
  const code = (variantRec && (variantRec.item_id||variantRec.name)) || `${item.name}-${variant.color}-${variant.width}-${variant.size}`;
  const existing = cart.find(ci => ci.item_code === code && !ci.refund);
  const rate = (variantRec && variantRec.rate!=null) ? Number(variantRec.rate) : item.standard_rate;
  // Use variant image if available, otherwise fall back to parent image
  const variantImage = (variantRec && variantRec.image) ? variantRec.image : (item.image || null);
  if (existing) {
    existing.qty += quantity;
    existing.amount = existing.qty * existing.rate;
  } else {
      cart.push({
        item_code: code,
        item_name: name,
        qty: quantity,
        rate,
        original_rate: rate,
        amount: rate * quantity,
        image: variantImage,
        brand: item.brand || null,
        item_group: item.item_group || null,
        variant,
        vat_rate: effectiveVatRate((variantRec && variantRec.vat_rate) || item.vat_rate),
        style_code: (variantRec && variantRec.style_code) || item.custom_style_code || '',
        refund: false
      });
  }
  updateCartDisplay();
  try{ const cartCard=document.getElementById('cartCard'); if(cartCard){ cartCard.classList.add('cart-pulse'); setTimeout(()=>cartCard.classList.remove('cart-pulse'),700); } }catch(_){ }
}

// Checkout overlay
function openCheckoutOverlay(options = {}){
  const o=document.getElementById('checkoutOverlay');
  const c=document.getElementById('checkoutCart');
  if(!o||!c) return;
  // reset tender selection; user must choose
  currentTender = '';
  // fresh split payments state
  appliedPayments = [];
  vouchers = [];
  if(!options.preserveIssuedVouchers){
    issuedVouchers = [];
  }
  resetTenderInputs();
  updateVoucherButtonLabel();
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
function hideCheckoutOverlay(){
  const o=document.getElementById('checkoutOverlay');
  if(o) o.style.display='none';
  resetTenderInputs();
}
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
    const base = (item.original_rate!=null)? Number(item.original_rate) : Number(item.rate);
    const perDisc = Math.max(0, base - Number(item.rate||0));
    const perPct = base>0 ? (perDisc/base*100) : 0;
    meta.textContent = `${item.qty} x ${money(item.rate)}${isRefund ? ' (refund)' : ''}` + (perDisc>0 ? ` (was ${money(base)}, -${perPct.toFixed(1)}%)` : '');
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

function getCartTotal(){
  return cart.reduce((sum, item) => sum + (item.qty * item.rate * (item.refund ? -1 : 1)), 0);
}
function updateVoucherButtonLabel(){
  const btn = document.getElementById('tenderVoucherBtn');
  if(!btn) return;
  const count = appliedPayments.filter(x=>x.mode_of_payment==='Voucher').length;
  const baseLabel = getCartTotal() < 0 ? 'Voucher Refund' : 'Voucher';
  btn.textContent = count>0 ? `${baseLabel} (${count})` : baseLabel;
}

function renderAppliedPayments(){
  const list = document.getElementById('appliedPaymentsList');
  const totalEl = document.getElementById('paymentsTotal');
  if(list){
    list.innerHTML = '';
    appliedPayments.forEach((p, idx)=>{
      const row = document.createElement('div');
      row.className = 'd-flex justify-content-between align-items-center py-1 border-bottom';
      const left = document.createElement('div');
      // Show currency metadata if present (EUR payments)
      let label = p.mode_of_payment || '';
      try {
        if (p.meta && p.meta.currency === 'EUR') {
          label = `${label} (EUR €${Number(p.meta.eur_amount||0).toFixed(2)})`;
        } else if (p.currency) {
          label = `${label} (${p.currency})`;
        }
      } catch (e) {
        // ignore
      }
      left.textContent = `${label}${p.reference_no? ' ('+p.reference_no+')':''}`;
      const right = document.createElement('div');
      const amt = document.createElement('span');
      amt.className = 'me-2';
      amt.textContent = money(Number(p.amount||0));
      const rm = document.createElement('button');
      rm.className = 'btn btn-sm btn-outline-danger';
      rm.textContent = 'Remove';
      if (p.created_voucher) {
        rm.disabled = true;
        rm.title = 'Voucher already issued';
      }
      rm.addEventListener('click', ()=>{
        if(p.mode_of_payment === 'Voucher' && p.reference_no){
          const i = vouchers.findIndex(v=> (v.code===p.reference_no) && Number(v.amount||0)===Number(p.amount||0));
          if(i>=0) vouchers.splice(i,1);
        }
        if(p.created_voucher && p.reference_no){
          const idx = issuedVouchers.findIndex(v=> v.code===p.reference_no && Number(v.amount||0)===Number(p.amount||0));
          if(idx>=0) issuedVouchers.splice(idx,1);
        }
        appliedPayments.splice(idx,1);
        renderAppliedPayments();
        updateCashSection();
        resetTenderInputs();
        updateVoucherButtonLabel();
      });
      right.appendChild(amt);
      right.appendChild(rm);
      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    });
  }
  if(totalEl){
    const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
    totalEl.textContent = paid>0 ? money(paid) : '';
  }
  updateVoucherButtonLabel();
}
function updateCashSection() {
  const due = document.getElementById('amountDue');
  const tenderDueEl = document.getElementById('tenderDue');
  const cashEl = document.getElementById('amountCash');
  const cashEnteredEl = document.getElementById('amountCashEntered');
  const changeEl = document.getElementById('amountChange');
  const cashBtn = document.getElementById('tenderCashBtn');
  const clear = document.getElementById('clearCashBtn');
  const applyCashBtn = document.getElementById('applyCashBtn');
  const applyOtherBtn = document.getElementById('applyOtherBtn');
  const voucherBtn = document.getElementById('tenderVoucherBtn');
  const otherFullBtn = document.getElementById('otherFullAmountBtn');
  const total = getCartTotal();
  const isRefund = total < 0;
  const targetAmount = isRefund ? Math.abs(total) : total;
  const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
  const paidCash = appliedPayments.filter(p=>/cash/i.test(p.mode_of_payment||'')).reduce((s,p)=> s + Number(p.amount||0), 0);
  const remaining = Math.max(0, targetAmount - paid);
  if (due) due.textContent = money(isRefund ? -targetAmount : targetAmount);
  if (tenderDueEl) tenderDueEl.textContent = money(isRefund ? -remaining : remaining);
  if (cashEl) cashEl.textContent = money(paidCash);
  if (cashEnteredEl) cashEnteredEl.textContent = money(Number(cashInput||0));
  const dueOther = document.getElementById('amountDueOther');
  if (dueOther) dueOther.textContent = money(remaining);
  const changeVal = isRefund ? 0 : Math.max(0, paid - targetAmount);
  if (changeEl) changeEl.textContent = money(changeVal);
  const cashVal = Number(cashInput || 0);
  if (cashBtn){
    const labelAmount = Math.abs(cashVal||0);
    cashBtn.textContent = isRefund ? `Refund ${money(labelAmount)}` : `${money(cashVal)} Cash`;
  }
  if (clear) clear.onclick = () => { resetCashEntry(); updateCashSection(); };
  if (applyCashBtn) applyCashBtn.disabled = false;
  if (applyOtherBtn) applyOtherBtn.disabled = false;
  if (voucherBtn){
    voucherBtn.disabled = false;
  }
  updateVoucherButtonLabel();
  if (otherFullBtn) otherFullBtn.disabled = false;
  
  renderAppliedPayments();
}


// Select tender type (Cash / Card / Voucher / Other)
function selectTender(t){
  try{
    t = (t || '').toString();
    currentTender = t;
    // toggle active class on buttons
    document.querySelectorAll('.tender-btn').forEach(b=>{
      const tb = (b.dataset && b.dataset.tender) ? b.dataset.tender : b.getAttribute('data-tender');
      b.classList.toggle('active', tb === t);
    });

    // Show/hide cash section
    const cashSection = document.getElementById('cashSection');
    if (cashSection) {
      cashSection.style.display = (t === 'cash') ? 'block' : 'none';
      if (t !== 'cash') {
        cashSection.classList.remove('show-keypad');
        hideEurOverlay();
      }
    }

    // Show/hide other (Card/Other) section
    const otherSection = document.getElementById('otherSection');
    const otherLabel = document.getElementById('otherLabel');
    const otherFullBtn = document.getElementById('otherFullAmountBtn');
    if (otherSection){
      const isOther = (t === 'card' || t === 'other');
      otherSection.style.display = isOther ? 'block' : 'none';
      if (otherLabel){
        otherLabel.textContent = (t === 'card') ? 'Card Amount' : 'Amount';
      }
      if (otherFullBtn){
        otherFullBtn.style.display = isOther ? 'inline-block' : 'none';
      }
    }

    if (t === 'cash' && !cashEntryDirty) {
      resetCashEntry();
    }
    if ((t === 'card' || t === 'other') && !otherEntryDirty) {
      resetOtherEntry();
    }

    // If voucher selected, open voucher overlay
    if (t === 'voucher') {
      openVoucherOverlay();
    }

    updateCashSection();
    log('selectTender', t);
  }catch(e){ err('selectTender error', e); }
}

function getSelectedCustomerId(){
  const topSelect = document.getElementById('topCustomerSelect');
  const bottomSelect = document.getElementById('customerSelect');
  if (topSelect && topSelect.value) return topSelect.value;
  if (bottomSelect && bottomSelect.value) return bottomSelect.value;
  return getDefaultCustomerValue();
}

async function completeSaleFromOverlay() {
  let customer = getSelectedCustomerId();
  if (cart.length === 0) { alert('Cart is empty'); return; }

  const total = getCartTotal();
  const isRefund = total < 0;
  const refundDue = Math.abs(total);
  const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
  if (!isRefund && paid + 1e-9 < total) { alert('Please apply full payment before completing the sale.'); return; }
  if (isRefund){
    if (appliedPayments.length === 0){ alert('Apply the refund tender(s) before completing.'); return; }
    if (Math.abs(paid - refundDue) > 0.01){ alert('Refund tender total must match the refund amount.'); return; }
  }

  const payments = appliedPayments.map(p=>{
    const rawAmount = Number(p.amount||0);
    const signedAmount = isRefund ? -Math.abs(rawAmount) : rawAmount;
    return {
      mode_of_payment: p.mode_of_payment,
      amount: signedAmount,
      amount_gbp: signedAmount,
      amount_eur: p.amount_eur ? Number(p.amount_eur) * (isRefund ? -1 : 1) : undefined,
      currency: p.currency || 'GBP',
      eur_rate: p.eur_rate ? Number(p.eur_rate) : undefined,
      reference_no: p.reference_no || undefined,
      currency_rate: p.currency_rate || undefined
    };
  });
  const voucherList = isRefund ? [] : appliedPayments.filter(p=>p.mode_of_payment==='Voucher').map(p=>({ code: p.reference_no||'', amount: Number(p.amount||0) }));
  const tender = isRefund
    ? ((payments.length>1) ? 'refund_split' : (payments[0]?.mode_of_payment || 'refund'))
    : ((payments.length>1) ? 'split' : (payments[0]?.mode_of_payment||currentTender||''));
  const cashGiven = payments.filter(p=>/cash/i.test(p.mode_of_payment||'')).reduce((s,p)=> s + (isRefund ? Math.abs(Number(p.amount||0)) : Math.max(0, Number(p.amount||0))), 0);
  const targetAmount = isRefund ? refundDue : total;
  const changeVal = isRefund ? 0 : Math.max(0, paid - targetAmount);
  const fxMetadata = (eurConversionActive && window.saleEurMetadata) ? { ...window.saleEurMetadata } : null;
  const currencyRateUsed = fxMetadata && fxMetadata.effective_rate
    ? Number(fxMetadata.effective_rate)
    : (eurConversionActive
        ? (saleEffectiveRate || (eurConversionData && eurConversionData.store_rate) || 1.0)
        : 1.0);

  const payload = {
    customer,
    items: cart.map(i => ({
      item_code: i.item_code,
      qty: i.refund ? -Math.abs(i.qty) : i.qty,
      rate: i.rate,
      vat_rate: effectiveVatRate(i.vat_rate)
    })),
    payments,
    tender,
    cash_given: cashGiven,
    change: isRefund ? refundDue : changeVal,
    total: total,
    vouchers: voucherList,
    voucher_issue: issuedVouchers.map(v=>({ code: v.code, amount: Number(v.amount||0) })),
    till_number: settings.till_number,
    cashier: currentCashier ? { code: currentCashier.code, name: currentCashier.name } : null,
    // Currency information - include full FX metadata if EUR conversion was active
    currency_used: fxMetadata ? 'EUR' : 'GBP',
    currency_rate_used: fxMetadata ? Number(currencyRateUsed) : 1.0,
    fx_metadata: fxMetadata
  };
  if(pendingVoucherBalancePrints.length){
    payload.voucher_balance_prints = pendingVoucherBalancePrints.map(entry=>{
      const voucherCode = entry.voucher_code || entry.code || '';
      const amount = Number(entry.amount ?? entry.balance ?? 0);
      return {
        code: voucherCode,
        voucher_code: voucherCode,
        amount: Number.isFinite(amount) ? amount : entry.amount,
        name: entry.name || entry.voucher_name,
        voucher_name: entry.voucher_name || entry.name,
        currency: entry.currency,
        title: entry.title,
        header_lines: entry.header_lines,
        footer_lines: entry.footer_lines,
        fun_line: entry.fun_line
      };
    });
  }

  try {
    const response = await fetch('/api/create-sale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
  if (data.status === 'success') {
    try {
      if (!settings) settings = {};
      if (settings.net_cash == null) settings.net_cash = 0;
      if (settings.net_card == null) settings.net_card = 0;
      if (settings.net_voucher == null) settings.net_voucher = 0;
      if (settings.net_cash_change == null) settings.net_cash_change = 0;
      (payments||[]).forEach(p=>{
        const m = (p.mode_of_payment||'').toString();
        if(/cash/i.test(m)) settings.net_cash += Number(p.amount||0);
        else if(/card/i.test(m)) settings.net_card += Number(p.amount||0);
        else if(/voucher/i.test(m)) settings.net_voucher += Number(p.amount||0);
      });
      if(!isRefund && changeVal > 0){
        settings.net_cash_change += changeVal;
      }
      saveSettings();
    } catch(_){}
    // Update Z-read aggregates for today
    try{
      const saleCtx = {
        net: total,
        payments: payments,
        cashier: currentCashier ? { code: currentCashier.code, name: currentCashier.name } : null,
        lines: cart.map(i=>({
          qty: i.qty,
          rate: i.rate,
          original_rate: (i.original_rate!=null?i.original_rate:i.rate),
          refund: !!i.refund,
          brand: i.brand || null,
          item_group: i.item_group || null,
          vat_rate: effectiveVatRate(i.vat_rate)
        }))
      };
      updateZAggWithSale(saleCtx);
    }catch(_){ }
    const receiptItems = cart.map(item=>({
      code: item.item_code,
      name: item.item_name || item.item_code,
      qty: item.qty,
      rate: Number(item.rate||0),
      refund: !!item.refund,
      amount: Number(item.qty||0) * Number(item.rate||0) * (item.refund ? -1 : 1),
      vat_rate: effectiveVatRate(item.vat_rate),
      image: item.image || findItemImageUrl(item.item_code),
      style_code: item.style_code || ''
    }));
    const receiptPayments = payments.map(p=>({
      mode: p.mode_of_payment,
      mode_of_payment: p.mode_of_payment,
      amount: Math.abs(Number(p.amount||0)),
      reference: p.reference_no || ''
    }));
    const fxSummary = summarizeFxFromPayments(payments, total);
    if(fxSummary){
      fxSummary.invoice = data.invoice_name || fxSummary.invoice || '';
    }
    const barcodeValue = (data.invoice_barcode_value || data.invoice_name || '').toString().trim();
    const barcodeHex = Array.isArray(data.invoice_barcode_hex)
      ? data.invoice_barcode_hex.filter(entry => typeof entry === 'string' && entry.trim())
      : [];
    const receiptHeaderLines = standardReceiptHeaderLines();
    const receiptFooterLines = standardReceiptFooterLines();
    const voucherFunLine = defaultVoucherFunLine();
    const info = {
      invoice: data.invoice_name || 'N/A',
      change: isRefund ? Math.abs(total) : changeVal,
      total,
      items: receiptItems,
      payments: receiptPayments,
      paid,
      tender,
      customer,
      branch: settings.branch_name || '',
      till: settings.till_number || '',
      till_number: settings.till_number || '',
      cashier: currentCashier ? { code: currentCashier.code, name: currentCashier.name } : null,
      created: new Date().toISOString(),
      vouchers: voucherList,
      issued_vouchers: issuedVouchers.slice(),
      isRefund,
      vat_rate: settings.vat_rate,
      vat_inclusive: settings.vat_inclusive,
      header: settings.receipt_header,
      footer: settings.receipt_footer,
      header_lines: receiptHeaderLines,
      footer_lines: receiptFooterLines,
      voucher_fun_line: voucherFunLine,
      barcode_value: barcodeValue,
      barcode_hex: barcodeHex,
      cash_given: cashGiven,
      fx_summary: fxSummary
    };
    if(pendingVoucherBalancePrints.length){
      info.voucher_balance_prints = pendingVoucherBalancePrints.slice();
    }
    appliedPayments = [];
    vouchers = [];
    issuedVouchers = [];
    pendingVoucherBalancePrints = [];
    voucherSaleMode = false;
    hideCheckoutOverlay();
    updateCashSection();
    lastReceiptInfo = info;
    trackRecentItems(receiptItems);
    showReceiptOverlay(info);
    printIssuedVouchersAfterSale(info).catch(err=> warn('Voucher slip failed after sale', err));
    printVoucherBalanceSlipsAfterSale(info).catch(err=> warn('Voucher balance slip failed after sale', err));
    clearSaleFxState();
    if(wantsDrawerPulseFor(info)){
      pulseCashDrawer().catch(err=> warn('Drawer pulse failed', err));
    }
      if (settings.auto_print) {
        scheduleAutoReceiptPrint(info);
      }
    } else {
      alert('Error: ' + data.message);
    }
  } catch (error) {
    console.error(error);
    alert('Error creating sale. Please try again.');
  }
}

// Hold / Paused Transactions
function hidePausedOverlay(){ const o=document.getElementById('pausedOverlay'); if(o) o.style.display='none'; }
async function openPausedOverlay(){
  const o=document.getElementById('pausedOverlay');
  if(!o) return;
  try{
    const r = await fetch('/api/paused-sales');
    const d = await r.json();
    if(d && d.status==='success') renderPausedList(d.paused||[]);
  }catch(e){ err('failed to load paused sales', e); }
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
}
function renderPausedList(rows){
  const body = document.getElementById('pausedListBody');
  if(!body) return;
  body.innerHTML='';
  const mk = (tag, cls, txt)=>{ const el=document.createElement(tag); if(cls) el.className=cls; if(txt!=null) el.textContent=txt; return el; };
  (rows||[]).forEach(rec=>{
    const tr = document.createElement('tr');
    const when = rec.created_at ? new Date(rec.created_at) : null;
    tr.appendChild(mk('td','', when ? when.toLocaleString() : ''));
    const cashier = rec.cashier && (rec.cashier.code || rec.cashier.name) ? `${rec.cashier.code||''} ${rec.cashier.name||''}`.trim() : '';
    tr.appendChild(mk('td','', cashier));
    tr.appendChild(mk('td','', rec.customer || ''));
    tr.appendChild(mk('td','text-end', String(rec.items_count||0)));
    tr.appendChild(mk('td','text-end', money(rec.total||0)));
    const tdAct = mk('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = 'Resume';
    btn.addEventListener('click', ()=>{ try{ if(typeof window.resumePaused==='function'){ window.resumePaused(rec.id); } else { warn('resumePaused not available'); } }finally{ hidePausedOverlay(); } });
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    body.appendChild(tr);
  });
}
async function holdCurrentTransaction(){
  try{
    if(!currentCashier){ showLogin(); return; }
    if(!cart || cart.length===0){ alert('Cart is empty'); return; }
    // Determine customer
    let customer = '';
    const topSelect = document.getElementById('topCustomerSelect');
    const bottomSelect = document.getElementById('customerSelect');
    if (topSelect && topSelect.value) customer = topSelect.value;
    else if (bottomSelect && bottomSelect.value) customer = bottomSelect.value;
    if (!customer) customer = getDefaultCustomerValue();
    const payload = {
      customer,
      cart: cart.map(i=>({ item_code:i.item_code, item_name:i.item_name, qty:i.qty, rate:i.rate, refund: !!i.refund, vat_rate: effectiveVatRate(i.vat_rate) })),
      vouchers: Array.isArray(vouchers)?vouchers:[],
      cashier: { code: currentCashier.code, name: currentCashier.name },
      till_number: settings.till_number || null,
    };
    const res = await fetch('/api/hold-sale', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const data = await res.json();
    if(data && data.status==='success'){
      cart = [];
      pendingVoucherBalancePrints = [];
      updateCartDisplay();
      const cartCard=document.getElementById('cartCard'); if(cartCard){ cartCard.classList.add('cart-pulse'); setTimeout(()=>cartCard.classList.remove('cart-pulse'),700); }
      // Automatically log out after holding a transaction
      logoutToLogin('Transaction held. Sign in to continue.');
    } else {
      alert('Failed to hold: ' + ((data&&data.message)||'Unknown error'));
    }
  }catch(e){ err('hold failed', e); alert('Failed to hold current transaction'); }
}

function getVoucherTenderState(){
  const total = getCartTotal();
  const isRefund = total < 0;
  const due = isRefund ? Math.abs(total) : Math.max(0, total);
  const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
  const remaining = Math.max(0, due - paid);
  return { total, isRefund, due, paid, remaining };
}

// Voucher overlay
function startGiftVoucherSale(){
  if(!currentCashier){
    showLogin();
    return;
  }
  if(cart.length>0 && !confirm('Clear the current cart and start a gift voucher sale?')){
    return;
  }
  cart = [];
  appliedPayments = [];
  vouchers = [];
  issuedVouchers = [];
  pendingVoucherBalancePrints = [];
  voucherSaleMode = true;
  updateCartDisplay();
  renderAppliedPayments();
  updateCashSection();
  openVoucherOverlay({ forceSaleIssue: true });
}

function openVoucherOverlay(options = {}){
  const overlay = document.getElementById('voucherOverlay');
  const codeInput = document.getElementById('voucherCodeInput');
  const amountInput = document.getElementById('voucherAmountInput');
  const titleEl = document.getElementById('voucherOverlayTitle');
  const hintEl = document.getElementById('voucherOverlayHint');
  const statusEl = document.getElementById('voucherOverlayStatus');
  const submitBtn = document.getElementById('voucherSubmitBtn');
  if (!overlay) { err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays();
  const state = getVoucherTenderState();
  const forceSaleIssue = options.forceSaleIssue === true;
  if (forceSaleIssue) {
    voucherOverlayMode = 'issue_sale';
  } else if (state.isRefund) {
    voucherOverlayMode = 'issue_refund';
  } else {
    voucherOverlayMode = 'redeem';
  }
  const isIssue = voucherOverlayMode !== 'redeem';
  const isSaleIssue = voucherOverlayMode === 'issue_sale';
  const suggested = isSaleIssue ? 0 : (state.remaining > 0 ? state.remaining : state.due);
  overlay.style.display = 'flex';
  overlay.style.visibility = 'visible';
  overlay.style.opacity = '1';
  try {
    const cs = getComputedStyle(overlay);
    log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity });
  } catch (_) {}
  if (titleEl){
    if (isSaleIssue) {
      titleEl.textContent = 'Issue Gift Voucher';
    } else if (isIssue) {
      titleEl.textContent = 'Issue Gift Voucher';
    } else {
      titleEl.textContent = 'Scan Gift Voucher';
    }
  }
  if (hintEl){
    if (isSaleIssue) {
      hintEl.textContent = 'Enter the voucher amount to sell. A voucher line will be added to the cart so you can take payment.';
    } else if (voucherOverlayMode === 'issue_refund') {
      hintEl.textContent = 'Issue a new voucher for the refund amount. Leave the code empty to auto-generate one.';
    } else {
      hintEl.textContent = 'Focus the input and scan the voucher barcode, or type it in. Enter the voucher amount to apply.';
    }
  }
  if (statusEl){
    statusEl.style.display = 'none';
    statusEl.classList.remove('alert-danger','alert-success','alert-warning');
    statusEl.classList.add('alert-info');
    statusEl.textContent = '';
  }
  if (codeInput) {
    if (isIssue){
      codeInput.placeholder = 'Voucher code (leave blank to auto-generate)';
    } else {
      codeInput.placeholder = 'Voucher barcode';
    }
    codeInput.value = '';
  }
  if (amountInput) {
    amountInput.value = isSaleIssue ? '' : suggested.toFixed(2);
    amountInput.removeAttribute('max');
    delete amountInput.dataset.prefilledFor;
    delete amountInput.dataset.maxVoucherAmount;
  }
  const focusTarget = isIssue ? amountInput : codeInput;
  if(focusTarget){
    setTimeout(() => focusTarget.focus(), 0);
  }
  if (submitBtn){
    submitBtn.textContent = isIssue ? 'Issue Voucher' : 'Use Voucher';
  }
}

function hideVoucherOverlay(){
  const o=document.getElementById('voucherOverlay');
  if(o) o.style.display='none';
  voucherOverlayMode = 'redeem';
  if(voucherSaleMode && !cart.some(line=>line && line.isVoucherProduct)){
    voucherSaleMode = false;
  }
  const statusEl = document.getElementById('voucherOverlayStatus');
  if(statusEl){
    statusEl.style.display='none';
    statusEl.textContent='';
  }
}
async function submitVoucher(){
  const codeEl = document.getElementById('voucherCodeInput');
  const amountEl = document.getElementById('voucherAmountInput');
  const btn = document.getElementById('tenderVoucherBtn');
  const statusEl = document.getElementById('voucherOverlayStatus');
  const rawCode = (codeEl && codeEl.value.trim()) || '';
  const amount = Number(amountEl && amountEl.value) || 0;
  const state = getVoucherTenderState();
  const mode = voucherOverlayMode;
  const isIssue = mode !== 'redeem';
  const isSaleIssue = mode === 'issue_sale';
  const isRefundIssue = mode === 'issue_refund';
  if (isIssue && amount <= 0) return alert('Please enter a voucher amount greater than 0.');
  if (!isIssue && amount < 0) return alert('Voucher amount cannot be negative.');
  if (!isIssue && !rawCode) return alert('Please enter or scan a voucher code.');
  const remaining = state.remaining;
  try {
    if (isIssue) {
      const maxApplicable = remaining > 0 ? remaining : state.due;
      const applyAmount = isSaleIssue ? amount : Math.min(amount, maxApplicable);
      if (applyAmount <= 0) {
        alert(isSaleIssue ? 'Voucher amount must be greater than zero.' : 'Voucher amount cannot be applied to this transaction.');
        return;
      }
      const payload = {
        voucher_code: rawCode || undefined,
        amount: applyAmount,
        customer: getSelectedCustomerId() || undefined,
        till_number: settings.till_number || undefined,
        pos_profile: settings.branch_name || undefined,
        is_clearance: false,
        remarks: isSaleIssue ? 'POS gift voucher sale' : 'Refund voucher'
      };
      const issueResp = await fetch('/api/vouchers/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const issueData = await issueResp.json();
      if (issueResp.status !== 201 && issueResp.status !== 200) {
        throw new Error(issueData.message || 'Unable to issue voucher');
      }
      const issued = issueData.voucher || {};
      const finalCode = issued.code || issued.voucher_code || rawCode;
      if (!finalCode) {
        throw new Error('Voucher code missing from response');
      }
      if (isSaleIssue) {
        handleVoucherSaleIssue(finalCode, applyAmount);
      } else {
        appliedPayments.push({ mode_of_payment: 'Voucher', amount: applyAmount, reference_no: finalCode, created_voucher: true });
        issuedVouchers.push({ code: finalCode, amount: applyAmount });
        if (statusEl){
          statusEl.classList.remove('alert-info','alert-danger');
          statusEl.classList.add('alert-success');
          statusEl.textContent = `Issued voucher ${finalCode} for ${money(applyAmount)}.`;
          statusEl.style.display = 'block';
        }
        alert(`Issued voucher ${finalCode} for ${money(applyAmount)}.`);
        hideVoucherOverlay();
      }
    } else {
      const resp = await fetch('/api/vouchers/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: rawCode, amount })
      });
      const data = await resp.json();
      if (resp.status !== 200 || data.status !== 'success') {
        throw new Error(data.message || 'Voucher not accepted');
      }
      const info = data.voucher || {};
      if (!info.can_redeem) {
        alert(info.note || 'Voucher cannot be redeemed right now.');
        return;
      }
      const voucherCode = info.code || rawCode;
      const serverAllowed = Number(info.allowed_amount ?? info.balance ?? 0) || 0;
      const dueLimited = remaining > 0 ? remaining : serverAllowed;
      const cap = Math.min(serverAllowed, dueLimited);
      if (!Number.isFinite(cap) || cap <= 0) {
        alert('Voucher has no remaining balance.');
        return;
      }
      if (amountEl) {
        amountEl.max = cap.toFixed(2);
        amountEl.dataset.maxVoucherAmount = cap.toFixed(2);
      }
      const requested = amount > 0 ? amount : cap;
      const alreadyPrefilled = amountEl
        && amountEl.dataset.prefilledFor === voucherCode
        && Math.abs((Number(amountEl.value) || 0) - cap) < 0.005;
      if (!alreadyPrefilled && (amount <= 0 || requested - cap > 0.005)) {
        if (amountEl) {
          amountEl.value = cap.toFixed(2);
          amountEl.dataset.prefilledFor = voucherCode;
        }
        const msg = `Voucher balance is ${money(serverAllowed)}. Applied amount set to ${money(cap)}.`;
        if (statusEl) {
          statusEl.classList.remove('alert-info','alert-success','alert-danger');
          statusEl.classList.add('alert-warning');
          statusEl.textContent = msg;
          statusEl.style.display = 'block';
        } else {
          alert(msg);
        }
        return;
      }
      const applied = Math.min(requested, cap);
      if (applied <= 0) {
        alert('Voucher amount cannot be applied to this sale.');
        return;
      }
      appliedPayments.push({ mode_of_payment: 'Voucher', amount: applied, reference_no: voucherCode });
      const fullBalance = Number(info.balance ?? info.allowed_amount ?? serverAllowed) || serverAllowed;
      const remainingBalance = Math.max(0, fullBalance - applied);
      if(remainingBalance > 0.009){
        const balanceHeader = standardReceiptHeaderLines();
        const balanceFooter = standardReceiptFooterLines();
        pendingVoucherBalancePrints.push({
          code: voucherCode,
          voucher_code: voucherCode,
          amount: remainingBalance,
          name: info.voucher_name || info.name || undefined,
          voucher_name: info.voucher_name || info.name || undefined,
          currency: info.currency || undefined,
          title: (settings && settings.voucher_balance_title) || 'VOUCHER BALANCE',
          header_lines: balanceHeader,
          footer_lines: balanceFooter,
          fun_line: defaultVoucherFunLine()
        });
      }
      vouchers.push({ code: voucherCode, amount: applied });
      hideVoucherOverlay();
    }
    if (!isSaleIssue) {
      updateVoucherButtonLabel();
      renderAppliedPayments();
      updateCashSection();
    }
  } catch (err) {
    console.error('Voucher validation failed', err);
    alert(err && err.message ? `Voucher error: ${err.message}` : 'Unable to validate voucher.');
  }
}

function handleVoucherSaleIssue(voucherCode, amount){
  const rate = Number(amount || 0);
  const voucherLine = {
    item_code: giftVoucherItemCode,
    item_name: `Gift Voucher ${voucherCode}`,
    qty: 1,
    rate,
    brand: 'Gift Voucher',
    vat_rate: 0,
    attributes: { Voucher: voucherCode },
    isVoucherProduct: true
  };
  cart = [voucherLine];
  issuedVouchers = [{ code: voucherCode, amount: rate }];
  voucherSaleMode = true;
  hideVoucherOverlay();
  updateCartDisplay();
  updateVoucherButtonLabel();
  alert(`Voucher ${voucherCode} added to cart. Take payment and complete the sale.`);
  openCheckoutOverlay({ preserveIssuedVouchers: true });
}

// Opening/Closing helpers
function todayStr(){ const d=new Date(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${d.getFullYear()}-${m}-${day}`; }
function isTillOpenForToday(){
  try{
    const today = todayStr();
    return !!(settings && settings.till_open && settings.opening_date === today);
  }catch(_){
    return false;
  }
}

function enforceTillOpenState(){
  if(isTillOpenForToday()) return true;
  showOpeningOverlay({ force:true });
  return false;
}

function canDismissOpeningOverlay(){
  return isTillOpenForToday();
}

function showOpeningOverlay(options = {}){
  const o=document.getElementById('openingOverlay');
  const input=document.getElementById('openingFloatInput');
  const closeBtn=document.getElementById('openingCloseBtn');
  if(!o) return;
  neutralizeForeignOverlays();
  const forceOpen = options.force === true || !isTillOpenForToday();
  if(closeBtn){
    closeBtn.style.display = forceOpen ? 'none' : '';
  }
  if(forceOpen){
    o.setAttribute('data-force-open','1');
  }else{
    o.removeAttribute('data-force-open');
  }
  const amt = Number(settings.opening_float||0);
  openingDigits = amt>0 ? String(Math.round(amt*100)) : '';
  if(input){
    input.value = (openingDigits? (parseInt(openingDigits,10)/100).toFixed(2) : '0.00');
    setTimeout(()=>input.focus(),0);
  }
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
}
function digitsToAmountStr(d){ if(!d) return '0.00'; const n = Math.max(0, parseInt(d,10)||0); const v = (n/100).toFixed(2); return v; }
function setOpeningFromDigits(){ const input=document.getElementById('openingFloatInput'); if(input){ input.value = digitsToAmountStr(openingDigits); } }
function appendOpeningDigit(k){ openingDigits = (openingDigits||''); if(k>='0'&&k<='9'){ if(openingDigits.length>12) return; openingDigits = openingDigits + k; } }
function backspaceOpeningDigit(){ openingDigits = (openingDigits||''); if(openingDigits.length>0) openingDigits = openingDigits.slice(0,-1); }
// Print a float receipt (opening/closing)
async function printFloatReceipt(info) {
  try{
    if(!info) throw new Error('Missing float info');
    const ESC = '\x1B';
    const big = ESC + '!' + '\x11';
    const normal = ESC + '!' + '\x00';
    const lines = [];
    lines.push(`${big}${info.type} Float Receipt${normal}`);
    lines.push(`Date: ${info.date || todayStr()}`);
    if(settings.till_number){
      lines.push(`Till: ${settings.till_number}`);
    }
    if(currentCashier){
      const cashierName = String(currentCashier.name || currentCashier.code || '').trim();
      if(cashierName){
        lines.push(`Cashier: ${cashierName}`);
      }
    }
    lines.push('');
    lines.push(`${big}Amount: ${money(info.amount)}${normal}`);
    lines.push('');
    lines.push(`Printed: ${new Date().toLocaleString()}`);
    const payload = decorateWithReceiptLayout(lines.join('\n'), info);
    const ok = await sendTextToReceiptAgent(payload, { line_feeds: 5 });
    if(!ok) throw new Error('Receipt agent not ready');
  }catch(err){
    err('float print failed', err);
    alert('Failed to print float receipt.');
  }
}

// Save and print opening float
function saveOpeningFloat(){
  const input = document.getElementById('openingFloatInput');
  let v = 0;
  
  if(openingDigits && openingDigits.length){
    v = (parseInt(openingDigits,10)||0)/100;
  } else {
    v = Number(input && input.value || 0) || 0;
  }
  
  settings.opening_float = isNaN(v) ? 0 : v;
  settings.opening_date = todayStr();
  settings.net_cash = 0;
  settings.till_open = true;
  settings.till_opened_at = new Date().toISOString();
  settings.till_closed_at = null;
  saveSettings();
  openingDigits = '';
  
  const o = document.getElementById('openingOverlay');
  if(o) o.style.display = 'none';
  
  // Print float receipt
  printFloatReceipt({
    type: 'Opening',
    date: settings.opening_date,
    amount: settings.opening_float
  });
}

function guessClosingDenominationCounts(){
  document.querySelectorAll('#denomsGrid .denom-qty').forEach(inp=>{
    inp.value = '';
  });
}

function showClosingOverlay(){
  const o=document.getElementById('closingOverlay'); if(!o) return; neutralizeForeignOverlays();
  const sumBox=document.getElementById('reconSummary'); if(sumBox) sumBox.style.display='none';
  const resBox=document.getElementById('reconResult'); if(resBox){ resBox.style.display='none'; resBox.textContent=''; }
  const confirm=document.getElementById('reconConfirmBtn'); if(confirm){ confirm.style.display='none'; confirm.disabled=false; confirm.textContent='Confirm and Print'; }
  const payoutsInput = document.getElementById('sumPayoutsInput'); if(payoutsInput) payoutsInput.value='';
  guessClosingDenominationCounts();
  o.style.display='flex'; o.style.visibility='visible'; o.style.opacity='1';
  computeReconciliation(true);
  const firstInput = document.querySelector('#denomsGrid .denom-qty');
  if(firstInput){
    setTimeout(()=>{ try{ firstInput.focus(); firstInput.select(); }catch(_){ firstInput.focus(); } }, 50);
  }
}
function computeReconciliation(reveal){
  const payouts = Number(document.getElementById('sumPayoutsInput')?.value||0) || 0;
  let counted = 0;
  document.querySelectorAll('#denomsGrid .denom-qty').forEach(el=>{
    const qty = Number(el.value||0) || 0;
    const denom = Number(el.getAttribute('data-denom')||0) || 0;
    counted += qty * denom;
  });
  const opening = Number(settings.opening_float||0);
  const cashSales = Number(settings.net_cash||0);
  const cardSales = Number(settings.net_card||0);
  const changeGiven = Number(settings.net_cash_change||0);
  const expected = opening + cashSales - payouts - changeGiven;
  const variance = counted - expected;
  const setText = (id, val)=>{ const el=document.getElementById(id); if(el) el.textContent = money(val); };
  setText('sumOpening', opening);
  setText('sumCashSales', cashSales);
  setText('sumCardSales', cardSales);
  setText('sumChange', changeGiven);
  setText('sumExpected', expected);
  setText('sumCounted', counted);
  setText('sumVariance', variance);
  const sumBox=document.getElementById('reconSummary');
  const shouldReveal = reveal || (sumBox && sumBox.style.display==='block');
  if(shouldReveal && sumBox) sumBox.style.display='block';
  const resBox=document.getElementById('reconResult');
  const confirm=document.getElementById('reconConfirmBtn');
  if(resBox){
    resBox.style.display = shouldReveal ? 'block' : 'none';
    if(!shouldReveal){
      if(confirm) confirm.style.display='none';
      return;
    }
    if(Math.abs(variance) < 0.005){
      resBox.innerHTML = '<div class="text-success">Till matches expected. Well done.</div>';
      if(confirm) confirm.style.display='block';
    } else {
      const dir = variance>0 ? 'over' : 'short';
      const diff = Math.abs(variance);
      const denoms = [50,20,10,5,2,1,0.5,0.2,0.1,0.05,0.02,0.01];
      let remain = Math.round(diff*100)/100; const parts = [];
      for(const d of denoms){ const c = Math.floor((remain + 1e-9) / d); if(c>0){ parts.push(`${c} ? ${money(d)}`); remain = Math.round((remain - c*d)*100)/100; } }
      resBox.innerHTML = `<div class="text-danger">Till is ${dir} by <strong>${money(diff)}</strong>.</div>` + (parts.length? `<div class="small text-muted">Suggestions: ${parts.join(', ')}</div>` : '');
      if(confirm) confirm.style.display='block';
    }
  }
}
async function printReconciliation(){
  try{
    const opening = Number(settings.opening_float||0);
    const cashSales = Number(settings.net_cash||0);
    const cardSales = Number(settings.net_card||0);
    const changeGiven = Number(settings.net_cash_change||0);
    const payouts = Number(document.getElementById('sumPayoutsInput')?.value||0) || 0;
    const expected = opening + cashSales - payouts - changeGiven;
    let counted = 0; const denomLines=[];
    document.querySelectorAll('#denomsGrid .denom-qty').forEach(el=>{ 
      const qty = Number(el.value||0) || 0; 
      const denom = Number(el.getAttribute('data-denom')||0) || 0; 
      if(qty>0){ denomLines.push(`${qty} x ${money(denom)} = ${money(qty*denom)}`); counted += qty*denom; } 
    });
    const variance = counted - expected;
    const lines = [
      'End of Day Reconciliation',
      `Date: ${new Date().toLocaleString()}`,
      `Till: ${settings.till_number||''}`,
      '',
      'Session Summary',
      `Opening Float: ${money(opening)}`,
      `Cash Sales (net): ${money(cashSales)}`,
      `Card Sales (net): ${money(cardSales)}`,
      `Change Given: ${money(changeGiven)}`,
      `Payouts: ${money(payouts)}`,
      `Expected Till: ${money(expected)}`,
      '',
      'Denominations:',
      ...denomLines,
      '',
      `Counted: ${money(counted)}`,
      `Variance: ${money(variance)}`,
      '',
      `Card to check: ${money(cardSales)}`
    ];
    const decorated = decorateWithReceiptLayout(lines.join('\n'));
    const ok = await sendTextToReceiptAgent(decorated, { line_feeds: 5 });
    if(!ok) throw new Error('Receipt agent not ready');
    const closingOverlayEl = document.getElementById('closingOverlay'); if(closingOverlayEl) closingOverlayEl.style.display='none';
    return true;
  }catch(e){
    err('reconciliation print failed', e);
    alert('Failed to print reconciliation');
    return false;
  }
}

async function completeClosingFlow(){
  const btn = document.getElementById('reconConfirmBtn');
  if(!btn || btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Printing...';
  try{
    const reconOk = await printReconciliation();
    if(!reconOk) return;
    await waitFor(200);
    const zOk = await printZRead();
    if(!zOk) return;
  }catch(err){
    console.error('Closing flow failed', err);
  }finally{
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Discount overlay API
let __discountWork = null;
let __discountSummaryEl = null;
function openDiscountOverlay(){
  const o=document.getElementById('discountOverlay');
  const list=document.getElementById('discountItemsList');
  if(!o||!list) return;
  neutralizeForeignOverlays();
  // Build working copy from current cart
  __discountWork = cart.map(it=>({
    code: it.item_code,
    name: it.item_name,
    qty: Number(it.qty||0),
    orig: Number(it.rate||0),
    // if original_rate exists, use that as baseline for display/percent
    base: Number((it.original_rate!=null?it.original_rate:it.rate)||0),
    curr: Number(it.rate||0),
    refund: !!it.refund
  }));
  renderDiscountItems();
  resetDiscountValueInput();
  o.style.display='flex'; o.style.visibility='visible'; o.style.opacity='1';
}
function hideDiscountOverlay(){
  const o=document.getElementById('discountOverlay');
  if(o) o.style.display='none';
  resetDiscountValueInput();
}
function renderDiscountItems(){
  const list=document.getElementById('discountItemsList');
  if(!list) return;
  list.innerHTML='';
  // Ensure summary element exists
  if(!__discountSummaryEl){
    const rightCard = document.getElementById('discountValueInput')?.closest('.card');
    if(rightCard){
      __discountSummaryEl = document.createElement('div');
      __discountSummaryEl.id = 'discountSummary';
      __discountSummaryEl.className = 'mt-2 small text-muted';
      rightCard.appendChild(__discountSummaryEl);
    }
  }
  const rows = Array.isArray(__discountWork)?__discountWork:[];
  rows.forEach((it, idx)=>{
    const id = `disc_${idx}`;
    const isRefund = !!it.refund;
    const row = document.createElement('label');
    row.className = 'list-group-item d-flex justify-content-between align-items-center';
    if(isRefund) row.classList.add('refund');
    const base = Number(it.base||it.orig||0);
    const curr = Number(it.curr||0);
    const perAmt = Math.max(0, (base - curr) * it.qty);
    const perPct = base>0 ? ((base - curr)/base*100) : 0;
    row.innerHTML = `
      <div class="form-check">
        <input class="form-check-input" type="checkbox" id="${id}" data-code="${it.code}">
        <span class="ms-2">${it.name}${isRefund?' (refund)': ''}</span>
      </div>
      <div class="text-end small ${perAmt>0?'text-danger':'text-muted'}">
        <div>${it.qty} ? ${money(curr)}${perAmt>0?` (was ${money(base)})`:''}</div>
        ${perAmt>0?`<div class="fw-semibold">-${money(perAmt)} (${perPct.toFixed(1)}%)</div>`:`<div class="fw-semibold">${money(it.qty*curr)}</div>`}
      </div>`;
    list.appendChild(row);
  });
  // Summary totals
  if(__discountSummaryEl){
    const totBase = rows.reduce((s,r)=>s + r.qty * Number(r.base||r.orig||0), 0);
    const totCurr = rows.reduce((s,r)=>s + r.qty * Number(r.curr||0), 0);
    const discAmt = Math.max(0, totBase - totCurr);
    const discPct = totBase>0 ? (discAmt/totBase*100) : 0;
    __discountSummaryEl.innerHTML = discAmt>0
      ? `Discount total: <span class="fw-semibold">-${money(discAmt)}</span> (${discPct.toFixed(1)}%)`
      : 'No discounts applied';
  }
}
function applyDiscountsToSelected(){
  const list=document.getElementById('discountItemsList');
  const modeAmt = document.getElementById('discModeAmount');
  const modePct = document.getElementById('discModePercent');
  const modeSet = document.getElementById('discModeSet');
  const valEl = document.getElementById('discountValueInput');
  if(!list||!valEl) return;
  const raw = Number(valEl.value||0);
  const mode = (modeSet&&modeSet.checked)?'set':(modePct&&modePct.checked)?'percent':'amount';
  if(!(raw>0) && mode!=='set'){ alert('Enter a discount value greater than 0'); return; }
  if(mode==='set' && !(raw>=0)){ alert('Enter a set price (>= 0)'); return; }
  const chosen = Array.from(list.querySelectorAll('input.form-check-input[type="checkbox"]:checked'))
    .map(cb=>cb.getAttribute('data-code'))
    .filter(Boolean);
  if(!chosen.length){ alert('Select at least one item'); return; }
  (__discountWork||[]).forEach(it=>{
    if(!chosen.includes(it.code)) return;
    let newRate = Number(it.curr||0);
    if(mode==='amount') newRate = Math.max(0, newRate - raw);
    else if(mode==='percent') newRate = Math.max(0, newRate * (1 - (raw/100)));
    else if(mode==='set') newRate = Math.max(0, raw);
    it.curr = Number(newRate.toFixed(2));
  });
  renderDiscountItems();
  resetDiscountValueInput();
}

function commitDiscountsAndClose(){
  if(!Array.isArray(__discountWork)) { hideDiscountOverlay(); return; }
  // Apply working rates to cart and persist original_rate if not recorded
  const map = new Map(__discountWork.map(r=>[r.code, r]));
  cart.forEach(it=>{
    const w = map.get(it.item_code);
    if(!w) return;
    const newRate = Number(w.curr||it.rate||0);
    if(it.original_rate==null) it.original_rate = Number(it.rate||0);
    it.rate = newRate;
    it.amount = it.rate * it.qty;
  });
  updateCartDisplay();
  // If checkout overlay is open, refresh its contents and totals
  renderCheckoutCart();
  updateCashSection();
  hideDiscountOverlay();
}

// Return from receipt overlay
function openReturnOverlay(){
  const o=document.getElementById('returnOverlay');
  const input=document.getElementById('returnScanInput');
  const err=document.getElementById('returnError');
  const res=document.getElementById('returnResult');
  const load=document.getElementById('returnLoadBtn');
  if(!o) return;
  neutralizeForeignOverlays();
  if(err){ err.textContent=''; err.style.display='none'; }
  if(res){ res.innerHTML=''; }
  if(load){ load.disabled=true; load.dataset.saleId=''; }
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  setTimeout(()=>{ if(input){ input.value=''; input.focus(); } }, 0);
}
function hideReturnOverlay(){ const o=document.getElementById('returnOverlay'); if(o) o.style.display='none'; }
function extractSaleId(raw){
  const v = String(raw||'').trim();
  if(!v) return '';
  try{
    const u = new URL(v);
    const q = (u.searchParams.get('id')||u.searchParams.get('invoice')||'').trim();
    if(q) return q;
    const last = u.pathname.split('/').filter(Boolean).pop();
    if(last) return last;
  }catch(_){ /* not a URL, proceed */ }
  // Fallback: pick last long token of allowed chars
  const m = v.match(/[A-Za-z0-9_-]{8,}$/);
  return m ? m[0] : v;
}
async function findReturnSale(){
  const input=document.getElementById('returnScanInput');
  const err=document.getElementById('returnError');
  const res=document.getElementById('returnResult');
  const load=document.getElementById('returnLoadBtn');
  if(!input||!res) return;
  const raw = input.value;
  const id = extractSaleId(raw);
  if(!id){ if(err){ err.textContent='Please enter a receipt ID'; err.style.display='block'; } return; }
  if(err){ err.textContent=''; err.style.display='none'; }
  res.innerHTML = '<div class="text-muted">Looking up receipt...</div>';
  try{
    const r = await fetch(`/api/sale/${encodeURIComponent(id)}`);
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d || d.status!=='success' || !d.sale){
      res.innerHTML = '';
      if(err){ err.textContent = (d&&d.message)||'Receipt not found'; err.style.display='block'; }
      if(load){ load.disabled=true; load.dataset.saleId=''; }
      return;
    }
    const enriched = await enrichSaleItems(d.sale);
    renderReturnResult(enriched);
    if(load){ load.disabled=false; load.dataset.saleId = d.sale.id || id; }
  }catch(e){
    res.innerHTML = '';
    if(err){ err.textContent='Failed to lookup receipt'; err.style.display='block'; }
    if(load){ load.disabled=true; load.dataset.saleId=''; }
  }
}
function renderReturnResult(sale){
  const res=document.getElementById('returnResult');
  if(!res) return;
  const lines = Array.isArray(sale.items)?sale.items:[];
  // Build selectable list
  const make = (tag, cls, html)=>{ const el=document.createElement(tag); if(cls) el.className=cls; if(html!=null) el.innerHTML=html; return el; };
  const wrap = make('div','');
  const head = make('div','mb-2 fw-semibold', `Receipt: ${sale.id || ''} &mdash; Items (${lines.length})`);
  wrap.appendChild(head);
  const list = make('div','list-group');
  lines.forEach((ln, idx)=>{
    const id = `ret_${idx}`;
    const qty = Number(ln.qty||0);
    const rate = Number(ln.rate||0);
    const total = qty*rate;
    const vatRate = ln.vat_rate != null ? ln.vat_rate : '';
    const row = make('label','list-group-item d-flex justify-content-between align-items-center');
    row.innerHTML = `<div class=\"form-check\">\n        <input class=\"form-check-input\" type=\"checkbox\" id=\"${id}\" data-code=\"${ln.item_code}\" data-name=\"${ln.item_name}\" data-qty=\"${qty}\" data-rate=\"${rate}\" data-vat=\"${vatRate ?? ''}\" checked>\n        <span class=\"ms-2\">${ln.item_name}</span>\n      </div>\n      <div class=\"text-end small text-muted\">\n        <div>${qty} × ${money(rate)}</div>\n        <div class=\"fw-semibold\">${money(total)}</div>\n      </div>`;
    list.appendChild(row);
  });
  wrap.appendChild(list);
  res.innerHTML='';
  res.appendChild(wrap);
}
function loadReturnAsRefund(){
  const res=document.getElementById('returnResult');
  const overlay=document.getElementById('returnOverlay');
  if(!res) return;
  const checks = res.querySelectorAll('input.form-check-input[type="checkbox"]:checked');
  if(!checks.length){ alert('Select at least one item to return.'); return; }
  // Clear cart for a clean return transaction
  cart = [];
  checks.forEach(chk=>{
    const code = chk.getAttribute('data-code');
    const name = chk.getAttribute('data-name');
    const qty = Number(chk.getAttribute('data-qty')||0);
    const rate = Number(chk.getAttribute('data-rate')||0);
    if(!code || qty<=0) return;
    const vatAttr = chk.getAttribute('data-vat');
    cart.push({
      item_code: code,
      item_name: name || code,
      qty: qty,
      rate: rate,
      original_rate: rate,
      amount: qty*rate,
      image: null,
      variant: {},
      item_group: null,
      vat_rate: effectiveVatRate(vatAttr === null || vatAttr === '' ? null : Number(vatAttr)),
      style_code: '',
      refund: true
    });
  });
  updateCartDisplay();
  if(overlay) overlay.style.display='none';
  try{ const cartCard=document.getElementById('cartCard'); if(cartCard){ cartCard.classList.add('cart-pulse'); setTimeout(()=>cartCard.classList.remove('cart-pulse'),700); } }catch(_){ }
}

// Cashier/login helpers
function getDefaultCustomerValue(){ if(!customers||customers.length===0) return ''; const w=customers.find(c=>(c.name||'').toUpperCase().includes('WALKIN') || (c.customer_name||'').toLowerCase()==='walk-in customer'); return w?w.name:(customers[0]&&customers[0].name?customers[0].name:''); }
function setDefaultCustomer(){ const b=document.getElementById('customerSelect'), t=document.getElementById('topCustomerSelect'); const v=getDefaultCustomerValue(); if(v){ if(b) b.value=v; if(t) t.value=v; } }
async function attemptLogin(){
  const codeEl = document.getElementById('cashierCodeInput');
  const errEl = document.getElementById('loginError');
  const enterBtn = document.getElementById('loginEnterBtn');
  const raw = (codeEl && codeEl.value) || '';
  const v = String(raw).trim();
  if(!v){ if(errEl){ errEl.textContent='Please enter a code'; errEl.style.display='block'; } return; }
  try{
    if (enterBtn){ enterBtn.disabled = true; }
    const r = await fetch('/api/cashier/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: v }) });
    const d = await r.json().catch(()=>({}));
    if (!r.ok || !d || d.status!=='success' || !d.cashier){
      const msg = (d && d.message) ? d.message : (r.status===401 ? 'Invalid code' : 'Login failed');
      if(errEl){ errEl.textContent = msg; errEl.style.display='block'; }
      if(codeEl){ codeEl.value=''; codeEl.focus(); }
      return;
    }
    currentCashier = { code: d.cashier.code, name: d.cashier.name };
    setCashierSession(d.session || null, d.session_ping_interval || 60);
    updateCashierInfo();
    hideLogin();
    resetIdleTimer();
    enforceTillOpenState();
  }catch(e){
    err('login error', e);
    if(errEl){ errEl.textContent='Unable to contact database'; errEl.style.display='block'; }
    if(codeEl){ codeEl.value=''; codeEl.focus(); }
  }finally{
    if (enterBtn){ enterBtn.disabled = false; }
  }
}
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
function logoutToLogin(reason){
  cart=[];
  updateCartDisplay();
  setDefaultCustomer();
  pendingVoucherBalancePrints = [];
  if(isShowZeroStockEnabled()){
    setShowZeroStock(false);
  }else{
    const zeroToggle=document.getElementById('zeroStockToggle');
    if(zeroToggle) zeroToggle.checked=false;
  }
  const s=document.getElementById('itemSearch');
  if(s) s.value='';
  if(currentCashierSession){
    notifyCashierLogout().catch(()=>{});
  }
  currentCashier=null;
  updateCashierInfo();
  showLogin();
  if(reason){
    const e=document.getElementById('loginError');
    if(e){
      e.textContent=reason;
      e.style.display='block';
    }
  }
}

// Receipt overlay
function showReceiptOverlay(info){ const o=document.getElementById('receiptOverlay'); const inv=document.getElementById('receiptInvoice'); const ch=document.getElementById('receiptChange'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); if(inv) inv.textContent = info.invoice || 'N/A'; if(ch) ch.textContent = money(info.change || 0); o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); const r=o.getBoundingClientRect(); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity, rect: { x:r.x, y:r.y, w:r.width, h:r.height } }); } catch(_){}
  const printBtn=document.getElementById('printReceiptBtn');
  const doneBtn=document.getElementById('receiptDoneBtn');
  const closeBtn=document.getElementById('receiptCloseBtn');
  const reprintBtn=document.getElementById('receiptReprintBtn');
  const returnBtn=document.getElementById('receiptReturnBtn');
  const giftEl = document.getElementById('giftReceiptCheckbox');
  if(giftEl){
    giftEl.checked = false;
  }
  const voucherBox = document.getElementById('receiptVoucherDetails');
  const voucherList = document.getElementById('receiptVoucherList');
  if (voucherBox && voucherList){
    const entries = [];
    const redeemed = Array.isArray(info.vouchers) ? info.vouchers : [];
    redeemed.forEach(v=>{
      if(!v || !v.code) return;
      entries.push(`Redeemed ${v.code} (${money(Number(v.amount||0))})`);
    });
    const issued = Array.isArray(info.issued_vouchers) ? info.issued_vouchers : [];
    issued.forEach(v=>{
      if(!v || !v.code) return;
      entries.push(`Issued ${v.code} (${money(Number(v.amount||0))})`);
    });
    voucherList.innerHTML = '';
    if(entries.length){
      entries.forEach(text=>{
        const li = document.createElement('li');
        li.textContent = text;
        voucherList.appendChild(li);
      });
      voucherBox.style.display = 'block';
    } else {
      voucherBox.style.display = 'none';
    }
  }
  const fxWrap = document.getElementById('receiptFxSummary');
  if (fxWrap) {
    const summary = info && info.fx_summary;
    if (summary && summary.eur_amount) {
      fxWrap.style.display = 'block';
      const eurEl = document.getElementById('receiptFxEur');
      const gbpEl = document.getElementById('receiptFxGbp');
      const rateEl = document.getElementById('receiptFxRate');
      const noteEl = document.getElementById('receiptFxNote');
      if (eurEl) eurEl.textContent = `€${Number(summary.eur_amount || 0).toFixed(2)} accepted`;
      if (gbpEl) gbpEl.textContent = `≈ £${Number(summary.gbp_equivalent || 0).toFixed(2)} recorded`;
      if (rateEl) {
        const parts = [];
        if (summary.effective_rate) parts.push(`1 GBP = ${Number(summary.effective_rate).toFixed(4)} EUR`);
        if (summary.store_rate && (!summary.effective_rate || Math.abs(Number(summary.store_rate) - Number(summary.effective_rate || 0)) > 0.0001)) {
          parts.push(`Store ref: ${Number(summary.store_rate).toFixed(4)}`);
        }
        rateEl.textContent = parts.length ? `Rate used: ${parts.join(' | ')}` : 'Rate used: --';
      }
      if (noteEl) {
        const diff = Number(summary.difference_gbp || 0);
        if (Math.abs(diff) < 0.01) {
          noteEl.textContent = 'Exact EUR amount received.';
        } else if (diff > 0) {
          noteEl.textContent = `Give £${diff.toFixed(2)} change in GBP.`;
        } else {
          noteEl.textContent = `Still due £${Math.abs(diff).toFixed(2)} in GBP.`;
        }
      }
    } else {
      fxWrap.style.display = 'none';
    }
  }
  const triggerPrint = ()=>{ handleReceiptPrintRequest(info, giftEl ? !!giftEl.checked : false); };
  if(printBtn) printBtn.onclick = ()=>{
    const giftEl = document.getElementById('giftReceiptCheckbox');
    handleReceiptPrintRequest(info, giftEl ? !!giftEl.checked : false);
  };
  if(reprintBtn) reprintBtn.onclick = triggerPrint;
  if(returnBtn) returnBtn.onclick = ()=>{
    try{
      o.style.display='none';
      openReturnOverlay();
      const scan = document.getElementById('returnScanInput');
      const invEl = document.getElementById('receiptInvoice');
      if(invEl && scan){ scan.value = invEl.textContent || ''; findReturnSale(); }
    }catch(_){ openReturnOverlay(); }
  };
  const finish = ()=>{ if(giftEl){ giftEl.checked=false; } o.style.display='none'; hideCheckoutOverlay(); cart=[]; updateCartDisplay(); logoutToLogin(); };
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










async function enrichSaleItems(sale){
  try{
    const lines = Array.isArray(sale.items)?sale.items:[];
    const ids = [...new Set(lines.map(ln=>ln.item_code).filter(Boolean))];
    if(!ids.length) return sale;
    const r = await fetch(`/api/variant-info?ids=${encodeURIComponent(ids.join(','))}`);
    if(!r.ok) return sale;
    const d = await r.json().catch(()=>({}));
    if(!d || d.status!=='success' || !d.variants) return sale;
    const map = d.variants;
    const out = { ...sale, items: lines.map(ln=>{
      const vi = map[ln.item_code];
      if(!vi) return ln;
      const display = displayNameFrom(vi.name || ln.item_name || ln.item_code, vi.attributes||{});
      return { ...ln, item_name: display };
    }) };
    return out;
  }catch(_){ return sale; }
}





async function printZRead(){
  try{
    const opening = Number(settings.opening_float||0);
    const cashSales = Number(settings.net_cash||0);
    const cardSales = Number(settings.net_card||0);
    const voucher = Number(settings.net_voucher||0);
    const branch = settings.branch_name || '';
    const today = todayStr();
    const agg = (settings.z_agg && settings.z_agg[today]) || { totals:{}, discounts:{}, tenders:{}, perCashier:{}, perGroup:{} };
    const totals = Object.assign({gross:0, net:0, vat_sales:0, vat_returns:0, returns_amount:0, sale_count:0, return_count:0, items_qty:0}, agg.totals||{});
    const discounts = Object.assign({sales:0, returns:0}, agg.discounts||{});
    const tenders = Object.assign({Cash:cashSales, Card:cardSales, Voucher:voucher, Other:0}, agg.tenders||{});
    const perCashier = agg.perCashier || {};
    const perGroup = agg.perGroup || {};
    const tenderLines = Object.entries(tenders)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const cashierLines = Object.entries(perCashier)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const groupLines = Object.entries(perGroup)
      .filter(([_,v])=>v && (Math.abs(Number(v.amount||0))>0.0001 || Math.abs(Number(v.qty||0))>0.0001))
      .map(([k,v])=>`  ${k} (qty ${Number(v.qty||0)}): ${money(Number(v.amount||0))}`);
    const lines = [
      'Z-Read',
      `Date: ${new Date().toLocaleString()}`,
      `Branch: ${branch}`,
      `Till: ${settings.till_number||''}`,
      '',
      'Session Totals',
      `  Opening Float: ${money(opening)}`,
      `  Cash (net): ${money(cashSales)}`,
      `  Card (net): ${money(cardSales)}`,
      `  Vouchers Redeemed: ${money(voucher)}`,
      `  Gross Sales: ${money(totals.gross)}`,
      `  Net Sales: ${money(totals.net)}`,
      `  VAT Sales: ${money(totals.vat_sales)}`,
      `  VAT Returns: ${money(totals.vat_returns)}`,
      `  Returns Amount: ${money(totals.returns_amount)}`,
      `  Transactions: ${totals.sale_count} sales, ${totals.return_count} returns`,
      `  Items Sold: ${Number(totals.items_qty||0)}`,
      `  Discounts Sales: ${money(discounts.sales)}`,
      `  Discounts Returns: ${money(discounts.returns)}`,
      '',
      'By Tender',
      ...tenderLines,
      '',
      'By Cashier',
      ...(cashierLines.length ? cashierLines : ['  No data']),
      '',
      'By Item Group',
      ...(groupLines.length ? groupLines : ['  No data'])
    ];
    const decorated = decorateWithReceiptLayout(lines.join('\n'));
    const ok = await sendTextToReceiptAgent(decorated, { line_feeds: 5 });
    if(!ok) throw new Error('Receipt agent not ready');

    try{
      settings.opening_float = 0;
      settings.opening_date = '';
      settings.net_cash = 0;
      settings.net_card = 0;
      settings.net_voucher = 0;
      settings.net_cash_change = 0;
      settings.till_open = false;
      settings.till_closed_at = new Date().toISOString();
      const d = todayStr();
      if(settings.z_agg && settings.z_agg[d]) delete settings.z_agg[d];
      saveSettings();
    }catch(_){ }

    try{
      const cashMenu = document.getElementById('cashMenuOverlay'); if(cashMenu) cashMenu.style.display='none';
      const closingOverlay = document.getElementById('closingOverlay'); if(closingOverlay) closingOverlay.style.display='none';
      const closingMenu = document.getElementById('closingMenuOverlay'); if(closingMenu) closingMenu.style.display='none';
    }catch(_){ }
    showOpeningOverlay({ force:true });
    return true;
  }catch(e){
    err('z-read print failed', e);
    alert('Failed to print Z-read');
    return false;
  }
}

async function printXRead(){
  try{
    const opening = Number(settings.opening_float||0);
    const cashSales = Number(settings.net_cash||0);
    const cardSales = Number(settings.net_card||0);
    const voucher = Number(settings.net_voucher||0);
    const branch = settings.branch_name || '';
    const today = todayStr();
    const agg = (settings.z_agg && settings.z_agg[today]) || { totals:{}, discounts:{}, tenders:{}, perCashier:{}, perGroup:{} };
    const totals = Object.assign({gross:0, net:0, vat_sales:0, vat_returns:0, returns_amount:0, sale_count:0, return_count:0, items_qty:0}, agg.totals||{});
    const discounts = Object.assign({sales:0, returns:0}, agg.discounts||{});
    const tenders = Object.assign({Cash:cashSales, Card:cardSales, Voucher:voucher, Other:0}, agg.tenders||{});
    const perCashier = agg.perCashier || {};
    const perGroup = agg.perGroup || {};
    const tenderLines = Object.entries(tenders)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const cashierLines = Object.entries(perCashier)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const groupLines = Object.entries(perGroup)
      .filter(([_,v])=>v && (Math.abs(Number(v.amount||0))>0.0001 || Math.abs(Number(v.qty||0))>0.0001))
      .map(([k,v])=>`  ${k} (qty ${Number(v.qty||0)}): ${money(Number(v.amount||0))}`);
    const lines = [
      'X-Read',
      `Date: ${new Date().toLocaleString()}`,
      `Branch: ${branch}`,
      `Till: ${settings.till_number||''}`,
      '',
      'Session Totals',
      `  Opening Float: ${money(opening)}`,
      `  Cash (net): ${money(cashSales)}`,
      `  Card (net): ${money(cardSales)}`,
      `  Vouchers Redeemed: ${money(voucher)}`,
      `  Gross Sales: ${money(totals.gross)}`,
      `  Net Sales: ${money(totals.net)}`,
      `  VAT Sales: ${money(totals.vat_sales)}`,
      `  VAT Returns: ${money(totals.vat_returns)}`,
      `  Returns: ${money(totals.returns_amount)}`,
      `  Transactions: ${totals.sale_count} sales, ${totals.return_count} returns`,
      `  Items Sold: ${Number(totals.items_qty||0)}`,
      `  Discounts Sales: ${money(discounts.sales)}`,
      `  Discounts Returns: ${money(discounts.returns)}`,
      '',
      'By Tender',
      ...tenderLines,
      '',
      'By Cashier',
      ...(cashierLines.length ? cashierLines : ['  No data']),
      '',
      'By Item Group',
      ...(groupLines.length ? groupLines : ['  No data'])
    ];
    const decorated = decorateWithReceiptLayout(lines.join('\n'));
    const ok = await sendTextToReceiptAgent(decorated, { line_feeds: 5 });
    if(!ok) throw new Error('Receipt agent not ready');
  }catch(e){
    err('x-read print failed', e);
    alert('Failed to print X-read');
  }
}

// Invoices overlay
function hideInvoicesOverlay(){ const o=document.getElementById("invoicesOverlay"); if(o){ o.style.display="none"; o.style.visibility="hidden"; o.style.opacity="0"; } }
async function openInvoicesOverlay(){
  const o=document.getElementById('invoicesOverlay');
  if(!o) return;
  const inp = document.getElementById('invoiceDateInput');
  if(inp){
    const today = todayStr();
    if(!inp.value) inp.value = today;
    await loadInvoicesForDate(inp.value || today);
    inp.addEventListener('change', async ()=>{ await loadInvoicesForDate(inp.value); });
  } else {
    await loadInvoicesForDate(todayStr());
  }
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
}
async function loadInvoicesForDate(isoDate){
  try{
    const r = await fetch('/api/invoices?date=' + encodeURIComponent(isoDate||''));
    const d = await r.json();
    if(d && d.status==='success') renderInvoicesList(d.rows||[]);
    else renderInvoicesList([]);
  }catch(e){ err('failed to load invoices', e); renderInvoicesList([]); }
}
function renderInvoicesList(rows){
  const body = document.getElementById('invoicesListBody');
  if(!body) return;
  body.innerHTML = '';
  const mk = (tag, cls, txt)=>{ const el=document.createElement(tag); if(cls) el.className=cls; if(txt!=null) el.textContent=txt; return el; };
  (rows||[]).forEach(rec=>{
    const tr = document.createElement('tr');
    // Time
    let t = '';
    try{
      if(rec.created_at){
        const dt = new Date(rec.created_at);
        t = isNaN(dt.getTime()) ? ((rec.created_at.split('T')[1]||rec.created_at)) : dt.toLocaleTimeString();
      }
    }catch(_){ }
    tr.appendChild(mk('td','', t));
    tr.appendChild(mk('td','', rec.source||''));
    tr.appendChild(mk('td','', rec.status||''));
    tr.appendChild(mk('td','', rec.id||''));
    tr.appendChild(mk('td','', rec.customer||''));
    tr.appendChild(mk('td','', rec.cashier||''));
    tr.appendChild(mk('td','text-end', money(rec.total||0)));
    const tdAct = mk('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = 'View';
    btn.addEventListener('click', ()=>{ openInvoiceDetail(rec.id); });
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    body.appendChild(tr);
  });
}

// Wire buttons after DOM load
(function(){
  window.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('viewInvoicesBtn');
    if(btn){ btn.addEventListener('click', ()=>{ const mv=document.getElementById('menuOverlay'); if(mv) mv.style.display='none'; openInvoicesOverlay(); }); }
    const c = document.getElementById('invoicesCloseBtn');
    if(c) c.addEventListener('click', hideInvoicesOverlay);
  });
})();
(function(){
  window.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('viewInvoicesBtn');
    const menu = document.getElementById('cashierMenu');
    if(btn){ btn.addEventListener('click', e=>{ e.stopPropagation(); if(menu) menu.classList.remove('open'); openInvoicesOverlay(); }); }
  });
})();
(function(){
  window.addEventListener('DOMContentLoaded', ()=>{
    const ov = document.getElementById('invoicesOverlay');
    if(ov){ ov.addEventListener('click', (e)=>{ if(e.target===ov) hideInvoicesOverlay(); }); document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideInvoicesOverlay(); }); }
  });
})();



// Invoice detail overlay
function hideInvoiceDetail(){ const o=document.getElementById("invoiceDetailOverlay"); if(o){ o.style.display='none'; o.style.visibility='hidden'; o.style.opacity='0'; } }
async function openInvoiceDetail(invId){
  try{
    const r = await fetch('/api/invoices/' + encodeURIComponent(invId));
    const d = await r.json();
    let inv = (d && d.status==='success') ? d.invoice : null;
    if(inv){
      try{
        const ids = Array.from(new Set((inv.items||[]).map(it=>it.item_code).filter(Boolean)));
        if(ids.length){
          const r2 = await fetch('/api/variant-info?ids=' + encodeURIComponent(ids.join(',')));
          const dj = await r2.json();
          if(dj && dj.status==='success'){
            const vmap = dj.variants || {};
            (inv.items||[]).forEach(it=>{
              const v = vmap[it.item_code];
              if(v && v.attributes){ it.attributes = Object.assign({}, it.attributes||{}, v.attributes); }
              // Always derive a consistent display name for the line
              const base = (v && v.name) || it.item_name || it.item_code;
              it.display_name = displayNameFrom(base, (v && v.attributes) || it.attributes || {});
              // Also set a fallback item_name if missing
              if((!it.item_name || it.item_name==='') && v && v.name){ it.item_name = v.name; }
            });
          }
        }
      }catch(_){ }
      renderInvoiceDetail(inv);
      const o=document.getElementById('invoiceDetailOverlay');
      if(o){ o.style.display='flex'; o.style.visibility='visible'; o.style.opacity='1'; }
    }
  }catch(e){ err('load invoice detail failed', e); }
}

function normalizeVoucherPrintEntries(source){
  if(!Array.isArray(source)) return [];
  const rows = [];
  source.forEach(entry=>{
    if(!entry) return;
    const codeRaw = entry.code || entry.voucher_code || entry.id;
    if(!codeRaw) return;
    const code = String(codeRaw).trim();
    if(!code) return;
    const normalized = Object.assign({}, entry);
    normalized.code = code;
    if(!normalized.voucher_code){
      normalized.voucher_code = code;
    }
    if(normalized.amount == null){
      const fallback = entry.value ?? entry.balance ?? entry.remaining ?? entry.allowed_amount;
      if(fallback != null){
        const amt = Number(fallback);
        normalized.amount = Number.isFinite(amt) ? amt : fallback;
      }
    }else{
      const amt = Number(normalized.amount);
      if(Number.isFinite(amt)){
        normalized.amount = amt;
      }
    }
    if(!normalized.voucher_name && entry.name){
      normalized.voucher_name = entry.name;
    }
    if(!normalized.name && normalized.voucher_name){
      normalized.name = normalized.voucher_name;
    }
    rows.push(normalized);
  });
  return rows;
}

function buildReceiptInfoFromInvoice(inv){
  if(!inv) return null;
  const vatInclusive = inv.vat_inclusive!=null ? !!inv.vat_inclusive : !!settings.vat_inclusive;
  const headerLines = resolveReceiptLines(inv.header_lines, inv.header, standardReceiptHeaderLines());
  const footerLines = resolveReceiptLines(inv.footer_lines, inv.footer, standardReceiptFooterLines());
  const funRaw = inv.voucher_fun_line != null ? String(inv.voucher_fun_line).trim() : '';
  const voucherFunLine = funRaw || defaultVoucherFunLine();
  const items = (inv.items||[]).map(it=>{
    const qtyRaw = Number(it.qty||0);
    const qty = Math.abs(qtyRaw);
    const rate = Number(it.rate||0);
    const refund = qtyRaw < 0;
    const name = it.display_name || it.item_name || it.item_code || 'Item';
    return {
      code: it.item_code || it.code,
      item_name: name,
      name,
      qty: qty,
      rate,
      refund,
      amount: qty * rate * (refund ? -1 : 1),
      vat_rate: effectiveVatRate(it.vat_rate)
    };
  });
  const totalProvided = Number(inv.total!=null ? inv.total : items.reduce((s,r)=> s + r.amount, 0));
  const isRefund = totalProvided < 0;
  const payments = (inv.payments||[]).map(p=>{
    const amount = Math.abs(Number(p.amount||0));
    return {
      mode: p.method || p.mode_of_payment || 'Payment',
      mode_of_payment: p.method || p.mode_of_payment || 'Payment',
      amount,
      reference: p.ref || p.reference || ''
    };
  });
  const paid = payments.reduce((s,p)=> s + Number(p.amount||0), 0);
  const tender = payments.length>1
    ? (isRefund ? 'refund_split' : 'split')
    : (payments[0]?.mode || payments[0]?.mode_of_payment || (isRefund ? 'refund' : ''));
  const changeRaw = inv.change!=null ? Number(inv.change) : (isRefund ? Math.abs(totalProvided) : Math.max(0, paid - totalProvided));
  let cashierInfo = null;
  if(inv.cashier){
    if(typeof inv.cashier === 'object'){
      cashierInfo = Object.assign({}, inv.cashier);
    }else if(String(inv.cashier||'').trim()){
      cashierInfo = { name: String(inv.cashier).trim() };
    }
  }
  const tillValue = inv.till_number || inv.till || (settings && settings.till_number) || '';
  const branchValue = inv.branch || (settings && settings.branch_name) || '';
  const redeemed = Array.isArray(inv.vouchers) ? inv.vouchers : (Array.isArray(inv.voucher_redeem) ? inv.voucher_redeem : []);
  const issuedSource = Array.isArray(inv.issued_vouchers) && inv.issued_vouchers.length
    ? inv.issued_vouchers
    : (Array.isArray(inv.voucher_issue) ? inv.voucher_issue : []);
  const issued = normalizeVoucherPrintEntries(issuedSource);
  const balances = normalizeVoucherPrintEntries(inv.voucher_balance_prints);
  const info = {
    invoice: inv.id || inv.erp_docname || '',
    change: isRefund ? Math.abs(changeRaw||0) : changeRaw,
    total: totalProvided,
    items,
    payments,
    paid,
    tender,
    customer: inv.customer || '',
    branch: branchValue,
    till: tillValue,
    till_number: tillValue,
    cashier: cashierInfo,
    created: inv.created_at || inv.created || new Date().toISOString(),
    vouchers: redeemed,
    isRefund,
    vat_rate: inv.vat_rate!=null ? inv.vat_rate : settings.vat_rate,
    vat_inclusive: vatInclusive,
    header: inv.header!=null ? inv.header : settings.receipt_header,
    footer: inv.footer!=null ? inv.footer : settings.receipt_footer,
    header_lines: headerLines,
    footer_lines: footerLines,
    voucher_fun_line: voucherFunLine,
    currency_used: inv.currency_used || inv.currency || undefined
  };
  if(issued.length){
    info.issued_vouchers = issued;
  }else if(Array.isArray(issuedSource) && issuedSource.length){
    info.issued_vouchers = issuedSource.slice();
  }
  if(balances.length){
    info.voucher_balance_prints = balances;
  }else if(Array.isArray(inv.voucher_balance_prints) && inv.voucher_balance_prints.length){
    info.voucher_balance_prints = inv.voucher_balance_prints.slice();
  }
  return info;
}

function renderInvoiceDetail(inv){
  try{
    const title = document.getElementById('invDetailTitle');
    const meta = document.getElementById('invDetailMeta');
    const itemsBox = document.getElementById('invDetailItems');
    const paysBox = document.getElementById('invDetailPayments');
    const totalBox = document.getElementById('invDetailTotal');
    if(title) title.textContent = `Receipt ${inv.id||''}`;
    const when = inv.created_at ? new Date(inv.created_at) : null;
    const whenTxt = when ? when.toLocaleString() : (inv.created_at||'');
    if(meta) meta.textContent = `Time: ${whenTxt} | Customer: ${inv.customer||''} | Cashier: ${inv.cashier||''}`;
    if(itemsBox){
      itemsBox.innerHTML = '';
      (inv.items||[]).forEach(it=>{
        const row = document.createElement('div');
        row.className = 'list-group-item';
        const wrap = document.createElement('div');
        wrap.style.display='grid';
        wrap.style.gridTemplateColumns='48px 1fr auto';
        wrap.style.gap='10px';
        const img = document.createElement('div');
        img.className='img';
        img.style.width='48px'; img.style.height='48px'; img.style.borderRadius='8px'; img.style.background='#f1f3f5';
        if(it.image){ img.style.backgroundImage = `url(${it.image})`; img.style.backgroundSize='cover'; img.style.backgroundPosition='center'; }
        const name = document.createElement('div');
        const attrs = it.attributes || {};
        const colour = pickAttribute(attrs, ['Colour','Color','colour','color']);
        const size = pickAttribute(attrs, ['Size','EU half Sizes','UK half Sizes','size']);
        const attrLine = (colour || size) ? ("Colour: " + (colour || '-') + "  Size: " + (size || '-')) : '';
        const brandLine = (it.brand && it.brand!=="null" && it.brand!=='') ? ("<div class='text-muted small'>" + it.brand + "</div>") : '';
        const disp = it.display_name || displayNameFrom(it.item_name||it.item_code||'', attrs);
        name.innerHTML = "<div class='fw-semibold'>" + disp + "</div>" + brandLine + (attrLine?("<div class='small text-muted'>"+attrLine+"</div>"):'') + "<div class='small text-muted'>x" + (it.qty||1) + " @ " + money(it.rate||0) + "</div>";
        const amt = document.createElement('div');
        amt.className='fw-semibold';
        const lineTotal = (Number(it.qty||0)*Number(it.rate||0)) || 0;
        amt.textContent = money(lineTotal);
        wrap.appendChild(img); wrap.appendChild(name); wrap.appendChild(amt);
        row.appendChild(wrap);
        itemsBox.appendChild(row);
      });
    }
    if(paysBox){
      paysBox.innerHTML='';
      (inv.payments||[]).forEach(p=>{
        const div = document.createElement('div');
        div.textContent = `${p.method||p.mode_of_payment||'Payment'}: ${money(p.amount||0)}`;
        paysBox.appendChild(div);
      });
    }
    if(totalBox){ totalBox.textContent = money(inv.total||0); }
    // Wire return button in this overlay
    try{
      const getReceiptInfo = ()=> buildReceiptInfoFromInvoice(inv);
      const previewInfo = getReceiptInfo();
      const btn = document.getElementById('invDetailReturnBtn');
      if(btn){
        btn.onclick = ()=>{
          const ov = document.getElementById('invoiceDetailOverlay'); if(ov) ov.style.display='none';
          openReturnOverlay();
          const scan = document.getElementById('returnScanInput');
          if(scan){ scan.value = inv.id||''; findReturnSale(); }
        };
      }
      const printBtn = document.getElementById('invDetailPrintBtn');
      if(printBtn){
        printBtn.disabled = !previewInfo;
        printBtn.onclick = ()=>{
          const info = getReceiptInfo();
          if(!info){
            alert('Unable to prepare receipt for printing.');
            return;
          }
          handleReceiptPrintRequest(info, false);
        };
      }
      const voucherBtn = document.getElementById('invDetailVoucherBtn');
      if(voucherBtn){
        if(previewInfo && hasVoucherPrintData(previewInfo)){
          voucherBtn.style.display = 'inline-flex';
          voucherBtn.disabled = false;
          voucherBtn.onclick = ()=>{
            const info = getReceiptInfo();
            if(!info || !hasVoucherPrintData(info)){
              alert('No vouchers to print for this receipt.');
              return;
            }
            reprintVouchersForInfo(info);
          };
        }else{
          voucherBtn.style.display = 'none';
          voucherBtn.onclick = null;
        }
      }
    }catch(_){ }
  }catch(e){ err('renderInvoiceDetail failed', e); }
}
(function(){
  window.addEventListener('DOMContentLoaded', ()=>{
    const closeBtn = document.getElementById('invDetailCloseBtn');
    const ov = document.getElementById('invoiceDetailOverlay');
    if(closeBtn) closeBtn.addEventListener('click', hideInvoiceDetail);
    if(ov){ ov.addEventListener('click', e=>{ if(e.target===ov) hideInvoiceDetail(); }); document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideInvoiceDetail(); }); }
  });
})();


// Global barcode-like scan catcher: collects fast key bursts and routes
// them to the appropriate input/handler (works even if no field is focused).
let __scanBuffer = "";
let __scanLastTs = 0;
let __scanFlushTimer = null;
let __scanStartTs = 0;
const SCAN_COMPLETE_DELAY_MS = 80;
const SCAN_MIN_LENGTH = 3;
const SCAN_MAX_DURATION_MS = 500;
const SCAN_RESET_GAP_MS = 400;

function __isOverlayVisible(id){
  const el = document.getElementById(id);
  return !!(el && el.style && el.style.display !== 'none');
}

function __resetScanState(){
  if(__scanFlushTimer){
    clearTimeout(__scanFlushTimer);
    __scanFlushTimer = null;
  }
  __scanBuffer = "";
  __scanStartTs = 0;
}

function __flushScanBuffer(triggeredByEnter = false){
  if(__scanFlushTimer){
    clearTimeout(__scanFlushTimer);
    __scanFlushTimer = null;
  }
  const buffer = __scanBuffer;
  const duration = __scanStartTs ? (Date.now() - __scanStartTs) : 0;
  __scanBuffer = "";
  __scanStartTs = 0;
  if(!buffer){
    return false;
  }
  const withinDuration = duration <= SCAN_MAX_DURATION_MS;
  const shouldHandle = buffer.length >= SCAN_MIN_LENGTH && (triggeredByEnter || withinDuration);
  if(!shouldHandle){
    return false;
  }
  handleGlobalScan(buffer);
  return true;
}

function __scheduleScanFlush(){
  if(__scanFlushTimer){
    clearTimeout(__scanFlushTimer);
  }
  __scanFlushTimer = setTimeout(()=>{
    __flushScanBuffer(false);
  }, SCAN_COMPLETE_DELAY_MS);
}

function handleGlobalScan(code){
  try{
    const value = String(code||'').trim();
    if(!value) return;

    // 1) If Return overlay is open, populate and search immediately
    if(__isOverlayVisible('returnOverlay')){
      const input = document.getElementById('returnScanInput');
      if(input){
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        try{ findReturnSale(); }catch(_){ /* no-op */ }
      }
      return;
    }

    // 2) If Voucher overlay is open, populate its code field
    if(__isOverlayVisible('voucherOverlay')){
      const v = document.getElementById('voucherCodeInput');
      if(v){
        v.value = value;
        v.dispatchEvent(new Event('input', { bubbles:true }));
      }
      return;
    }

    // 3) Default: route to the barcode input for adding items
    const scanInput = document.getElementById('barcodeInput');
    if(scanInput){
      if (barcodeScanInProgress) return;
      scanInput.value = value;
      try{ processBarcodeScan(value); }catch(_){ /* ignore */ }
      return;
    }

    // 4) Fallback: push into the small search field + open overlay
    const search = document.getElementById('itemSearch');
    if(search){
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles:true }));
      try{ showSearchOverlay(value); }catch(_){ /* ignore */ }
    }
  }catch(e){ /* ignore scan errors */ }
}

// Install global keydown listener to capture scan-like bursts
document.addEventListener('keydown', (e)=>{
  try{
    // Ignore modified keys
    if(e.ctrlKey || e.altKey || e.metaKey) return;

    // If the user is typing into a normal input, don't hijack Enter
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    const allowedWhenFocused = new Set(['barcodeInput','returnScanInput','voucherCodeInput']);
    const inEditableNonScan = isInput && (!active || !allowedWhenFocused.has(active.id));

    const now = Date.now();
    if(now - __scanLastTs > SCAN_RESET_GAP_MS){
      __resetScanState();
    }
    __scanLastTs = now;

    if(e.key === 'Enter'){
      if(!inEditableNonScan){
        const handled = __flushScanBuffer(true);
        if(handled && !isInput) e.preventDefault();
      } else {
        __resetScanState();
      }
      return;
    }

    // Only collect printable characters when not typing in regular inputs
    if(inEditableNonScan) return;
    if(e.key && e.key.length === 1){
      if(!__scanBuffer){
        __scanStartTs = now;
      }
      __scanBuffer += e.key;
      __scheduleScanFlush();
    }
  }catch(_){ /* ignore */ }
});

function assembleLineSections(body, headerLines = [], footerLines = []) {
  const segments = [];
  const content = typeof body === 'string'
    ? body
    : (Array.isArray(body) ? body.join('\n') : '');
  if(headerLines.length){
    segments.push(headerLines.join('\n'));
  }
  if(content){
    if(segments.length) segments.push('');
    segments.push(content);
  }
  if(footerLines.length){
    if(segments.length) segments.push('');
    segments.push(footerLines.join('\n'));
  }
  return segments.join('\n');
}
