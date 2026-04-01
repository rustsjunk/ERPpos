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
let homeItems = [];
let searchItems = [];
let browseBrands = [];
let searchStage = 'brands';
let selectedBrand = '';
let browseLoading = false;
let searchNavIndex = -1;
let searchNavRows = [];
let searchNavItems = [];
const HOME_ITEMS_CACHE_KEY = 'pos_home_items_cache_v1';
const HOME_ITEMS_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_CACHE_MAX = 50;
let SEARCH_VIEW_MODE = 'variants';
let searchDebounceTimer = null;
const searchCache = new Map();
const BROWSE_CACHE_TTL_MS = 2 * 60 * 1000;
const browseCache = {
  brands: { data: [], ts: 0 },
  items: new Map()
};
let cart = [];
let customers = [];
let currentCashier = null;
let currentCashierSession = null;
let sessionPingTimer = null;
let sessionPingIntervalMs = 60 * 1000;
let _lastSyncCounts = { queued: 0, failed: 0, invoicesPending: 0 };
let _lastWebOrders = [];
const FEATURED_ITEM_LIMIT = 12;
const RECENT_SALES_LIMIT = 3;
const giftVoucherItemCode = (document.documentElement && document.documentElement.dataset
  && document.documentElement.dataset.giftVoucherItem)
  ? document.documentElement.dataset.giftVoucherItem
  : 'GIFT-VOUCHER';
const plasticBagItemCode = (document.documentElement && document.documentElement.dataset
  && document.documentElement.dataset.plasticBagItem)
  ? document.documentElement.dataset.plasticBagItem
  : '';
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
  const source = Array.isArray(homeItems) ? homeItems : items;
  return isShowZeroStockEnabled() ? source.slice() : source.filter(hasSellableStock);
}

function setShowZeroStock(show){
  if(!settings) settings = {};
  settings.show_zero_stock = !!show;
  const zeroToggle = document.getElementById('zeroStockToggle');
  if(zeroToggle){
    zeroToggle.checked = !!show;
  }
  saveSettings();
  renderItems(homeItems);
  try { renderSearchItems(); } catch(_){}
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
  const source = Array.isArray(searchItems) ? searchItems : [];
  const brands = Array.from(new Set(source.map(it => (it.brand || 'Unbranded')))).sort();
  select.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'All Brands';
  select.appendChild(defaultOpt);
  brands.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
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
  // Hide training UI first — the guide panel and hint pills can interfere with
  // fixed positioning inside the EUR overlay when training mode is active.
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.hideGuidePanel();
    TrainingWheels.clearHints();
    if(TrainingWheels.clearHighlights) TrainingWheels.clearHighlights();
  }
  overlay.scrollTop = 0;
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
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
    const cartTotal = getCartTotal();
    if(paid + 1e-9 >= cartTotal && paid > 0) TrainingWheels.setStep('payment_ready');
    else if(paid > 0) TrainingWheels.setStep('payment_partial');
    else TrainingWheels.setStep('checkout_open');
  }
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
  till_closed_at: null,
  training_level: 0,
  cashier_training_levels: {}
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
      perGroup: {},
      perBrand: {}
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
      if(!agg.perBrand) agg.perBrand = {};
      const brandKey = ln.brand || 'Unbranded';
      const b = agg.perBrand[brandKey] || { qty:0, amount:0 };
      b.qty += (ln.refund?-qty:qty);
      b.amount += lineNet;
      agg.perBrand[brandKey] = b;
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
  // Delay first ping slightly so the server has time to commit the new session
  setTimeout(tick, 1500);
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
  // Start sync status polling (updates admin panel) and web orders polling (updates bell)
  try { pollSyncStatus(); setInterval(pollSyncStatus, 30000); } catch(_){}
  try { pollWebOrders(); setInterval(pollWebOrders, 30000); } catch(_){}
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
    _lastSyncCounts = { queued, failed, invoicesPending };
    // Update sync status in admin panel
    const syncEl = document.getElementById('erpSyncStatus');
    if(syncEl){
      if(queued===0 && failed===0 && invoicesPending===0){
        syncEl.textContent = 'All sales synced.';
      } else {
        const parts = [];
        if(queued>0) parts.push(`Queued: ${queued}`);
        if(invoicesPending>0) parts.push(`Invoices pending: ${invoicesPending}`);
        if(failed>0) parts.push(`Failed: ${failed}`);
        syncEl.textContent = parts.join(' | ');
        syncEl.style.color = failed>0 ? '#c0392b' : '';
      }
    }
  }catch(e){ /* ignore */ }
}

async function pollWebOrders(){
  try{
    const r = await fetch('/api/web-orders');
    if(!r.ok) return;
    const d = await r.json();
    const orders = d.orders || [];
    const notif = document.getElementById('notifIcon');
    if(notif){
      const base = '\u{1F514}';
      notif.textContent = orders.length > 0 ? `${base} ${orders.length}` : base;
      notif.title = orders.length > 0 ? `${orders.length} pending web order(s)` : 'No pending web orders';
    }
    _lastWebOrders = orders;
  }catch(e){ /* ignore */ }
}

async function loadItems(){
  try {
    const now = Date.now();
    const cachedRaw = localStorage.getItem(HOME_ITEMS_CACHE_KEY);
    if(cachedRaw){
      try{
        const cached = JSON.parse(cachedRaw);
        if(cached && Array.isArray(cached.items) && (now - Number(cached.ts || 0)) < HOME_ITEMS_CACHE_TTL_MS){
          const cachedItems = cached.items.map(it => {
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
          renderItems(cachedItems);
        }
      }catch(_){}
    }
    const response = await fetch(`/api/browse/recent?limit=${FEATURED_ITEM_LIMIT * 3}`);
    const data = await response.json();
    if (data.status === 'success') {
      const recent = (data.items || []).map(it => {
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
      renderItems(recent);
      try{
        localStorage.setItem(HOME_ITEMS_CACHE_KEY, JSON.stringify({ ts: Date.now(), items: recent }));
      }catch(_){}
    }
  } catch (error) {
    console.error(error);
  }
}
async function loadCustomers(){ try{ const r=await fetch('/api/customers'); const d=await r.json(); if(d.status==='success'){ customers=d.customers; } }catch(e){ console.error(e);} }

function renderItems(list){
  homeItems = list || [];
  items = homeItems;
  renderFeaturedPanel(false);
  renderRecentItems();
  try { renderSearchStage(); } catch(_){}
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
    const thumb = imageUrl ? thumbUrl(imageUrl, 220, 220) : '';
    if(thumb){
      const img=document.createElement('img');
      img.src=thumb;
      img.alt=it.item_name || it.name || it.item_code || 'Product image';
      img.loading='lazy';
      img.onerror = () => {
        img.remove();
        const fb = document.createElement('span');
        fb.className = 'img-placeholder';
        fb.textContent = '📦';
        media.appendChild(fb);
      };
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
  const pool=(Array.isArray(sourceList)?sourceList.slice():homeItems.slice()).filter(it=>!used.has(it.item_code));
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
  const card = container.closest('.card');
  if(!recentSalesHistory.length){
    const placeholder=document.createElement('div');
    placeholder.className='text-muted small';
    placeholder.textContent='No recent sales yet.';
    container.appendChild(placeholder);
    if(card) card.classList.add('recent-empty');
    return;
  }
  if(card) card.classList.remove('recent-empty');
  recentSalesHistory.forEach(entry=>{
    const row=document.createElement('div');
    row.className='recent-sale';
    const thumb=document.createElement('div');
    thumb.className='recent-sale-thumb';
    if(entry.image){
      const img=document.createElement('img');
      img.src=thumbUrl(entry.image, 80, 80);
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

function thumbUrl(url, width=160, height=160){
  if(!url){
    return '';
  }
  return `/api/thumb?url=${encodeURIComponent(url)}&w=${width}&h=${height}`;
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
  if (cart.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cart-empty-hint';
    empty.textContent = 'Scan a barcode or tap a product to add items';
    wrap.appendChild(empty);
  }
  tot.textContent = money(sum);
  updateCheckoutButtonState(sum);
  if(typeof TrainingWheels !== 'undefined'){
    TrainingWheels.setStep(cart.length > 0 ? 'cart_ready' : 'idle');
  }
}

function findItemByCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  const matches = candidate => {
    if (!candidate) return false;
    return String(candidate).trim().toLowerCase() === normalized;
  };
  const pools = [searchItems || [], homeItems || [], items || []];
  for (const pool of pools) {
    for (const item of pool) {
      if (matches(item.barcode)) return item;
      if (matches(item.item_code)) return item;
      if (matches(item.name)) return item;
      if (Array.isArray(item.barcodes)) {
        const found = item.barcodes.some(bar => matches(bar.barcode || bar));
        if (found) return item;
      }
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
  // LAY- barcode → open layaway directly
  if (/^LAY-[A-Z0-9]{6}$/i.test(value)) {
    if (input) input.value = '';
    layawayOpenByRef(value.toUpperCase());
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
  const checkoutReturnBtn=document.getElementById('checkoutReturnBtn');
  if(checkoutReturnBtn){ checkoutReturnBtn.addEventListener('click',()=>openReturnOverlay()); }
  if(returnCloseBtn){ returnCloseBtn.addEventListener('click', ()=>hideReturnOverlay()); }
  if(returnOverlay){ returnOverlay.addEventListener('click', e=>{ if(e.target===returnOverlay) hideReturnOverlay(); }); document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideReturnOverlay(); }); }
  if(returnFindBtn){ returnFindBtn.addEventListener('click', ()=>findReturnSale()); }
  if(returnScanInput){ returnScanInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); findReturnSale(); } }); }
  if(returnLoadBtn){ returnLoadBtn.addEventListener('click', ()=>loadReturnAsRefund()); }
  const shuffleFeaturedBtn=document.getElementById('shuffleFeaturedBtn');
  if(shuffleFeaturedBtn){ shuffleFeaturedBtn.addEventListener('click', ()=>renderFeaturedPanel(true)); }
  const notifIcon = document.getElementById('notifIcon');
  if(notifIcon){ notifIcon.addEventListener('click', ()=>{ showWebOrdersOverlay(); }); }
  const webOrdersCloseBtn = document.getElementById('webOrdersCloseBtn');
  if(webOrdersCloseBtn){ webOrdersCloseBtn.addEventListener('click', ()=>{ hideWebOrdersOverlay(); }); }
  if(settingsBtn&&menuOverlay){ settingsBtn.addEventListener('click',()=>{ showMenu(); }); }
  if(menuClose&&menuOverlay){ menuClose.addEventListener('click',()=>{ menuOverlay.style.display='none'; }); }
  if(openSettingsBtn){ openSettingsBtn.addEventListener('click',()=>{ if(menuView) menuView.style.display='none'; if(settingsView){ settingsView.style.display='block'; populateSettingsForm(); } }); }
  if(settingsBackBtn){ settingsBackBtn.addEventListener('click',()=>{ if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(settingsSaveBtn){ settingsSaveBtn.addEventListener('click',()=>{ saveSettingsFromForm(); applySettings(); if(settingsView) settingsView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  if(openCashMenuBtn){ openCashMenuBtn.addEventListener('click', ()=>{ if(cashMenuOverlay){ cashMenuOverlay.style.display='flex'; cashMenuOverlay.style.visibility='visible'; cashMenuOverlay.style.opacity='1'; } }); }
  const openDrawerBtn=document.getElementById('openDrawerBtn');
  if(openDrawerBtn){ openDrawerBtn.addEventListener('click', async ()=>{
    const ok = await pulseCashDrawer();
    if(!ok) alert('Cash drawer could not be opened. Check the receipt agent is connected in Settings.');
  }); }

  // Petty cash
  let _pettyCashType = 'in';
  const pettyCashOverlay = document.getElementById('pettyCashOverlay');
  const pettyCashTitle = document.getElementById('pettyCashTitle');
  const pettyCashAmount = document.getElementById('pettyCashAmount');
  const pettyCashReason = document.getElementById('pettyCashReason');
  const pettyCashConfirm = document.getElementById('pettyCashConfirmBtn');
  const pettyCashClose = document.getElementById('pettyCashCloseBtn');
  function showPettyCash(type){
    _pettyCashType = type;
    if(pettyCashTitle) pettyCashTitle.textContent = type === 'in' ? 'Cash In' : 'Cash Out';
    if(pettyCashConfirm){ pettyCashConfirm.className = type === 'in' ? 'btn btn-success w-100' : 'btn btn-danger w-100'; pettyCashConfirm.textContent = type === 'in' ? 'Confirm Cash In' : 'Confirm Cash Out'; }
    if(pettyCashAmount) pettyCashAmount.value = '';
    if(pettyCashReason) pettyCashReason.value = '';
    if(pettyCashOverlay){ pettyCashOverlay.style.display='flex'; }
    setTimeout(()=>{ if(pettyCashAmount) pettyCashAmount.focus(); }, 50);
  }
  const cashInBtn = document.getElementById('cashInBtn');
  const cashOutBtn = document.getElementById('cashOutBtn');
  if(cashInBtn){ cashInBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showPettyCash('in'); }); }
  if(cashOutBtn){ cashOutBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showPettyCash('out'); }); }
  if(pettyCashClose){ pettyCashClose.addEventListener('click', ()=>{ if(pettyCashOverlay) pettyCashOverlay.style.display='none'; }); }
  if(pettyCashConfirm){ pettyCashConfirm.addEventListener('click', ()=>{
    const amt = parseFloat(pettyCashAmount && pettyCashAmount.value) || 0;
    const reason = (pettyCashReason && pettyCashReason.value.trim()) || '';
    if(amt <= 0){ if(pettyCashAmount){ pettyCashAmount.style.outline='2px solid #dc2626'; pettyCashAmount.focus(); } return; }
    if(pettyCashAmount) pettyCashAmount.style.outline='';
    recordPettyCash(_pettyCashType, amt, reason);
    if(pettyCashOverlay) pettyCashOverlay.style.display='none';
  }); }
  if(cashMenuCloseBtn){ cashMenuCloseBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; }); }
  if(cashMenuOverlay){ cashMenuOverlay.addEventListener('click', e=>{ if(e.target===cashMenuOverlay) cashMenuOverlay.style.display='none'; }); }
  if(cashMenuOpenBtn){ cashMenuOpenBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showOpeningOverlay(); }); }
  if(cashMenuZReadBtn){ cashMenuZReadBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; printZRead(); }); }
  const cashMenuXReadBtn=document.getElementById('cashMenuXReadBtn');
  if(cashMenuXReadBtn){ cashMenuXReadBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; printXRead(); }); }
  if(cashMenuFloatBtn){ cashMenuFloatBtn.addEventListener('click', ()=>{ if(cashMenuOverlay) cashMenuOverlay.style.display='none'; showClosingOverlay(); }); }
  if(openAdminBtn){ openAdminBtn.addEventListener('click',()=>{ if(menuView) menuView.style.display='none'; if(settingsView) settingsView.style.display='none'; if(adminView) adminView.style.display='block'; refreshSerialPortOptions().catch(e=>warn('refresh serial ports failed', e)); }); }
  if(adminBackBtn){ adminBackBtn.addEventListener('click',()=>{ if(adminView) adminView.style.display='none'; if(menuView) menuView.style.display='block'; }); }
  const adminZReadBtn = document.getElementById('adminZReadBtn');
  if(adminZReadBtn){ adminZReadBtn.addEventListener('click', ()=>{ if(adminView) adminView.style.display='none'; if(menuView) menuView.style.display='none'; const mo=document.getElementById('menuOverlay'); if(mo) mo.style.display='none'; printZRead(); }); }
  const adminCashOutBtn = document.getElementById('adminCashOutBtn');
  if(adminCashOutBtn){ adminCashOutBtn.addEventListener('click', ()=>{ if(adminView) adminView.style.display='none'; const mo=document.getElementById('menuOverlay'); if(mo) mo.style.display='none'; showPettyCash('out'); }); }
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
  document.querySelectorAll('input[name="floatEntryMode"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      const isDirect = document.getElementById('floatDirectMode')?.checked;
      const directEntry = document.getElementById('floatDirectEntry');
      const denomsGrid = document.getElementById('denomsGrid');
      if(directEntry) directEntry.style.display = isDirect ? '' : 'none';
      if(denomsGrid)  denomsGrid.style.display  = isDirect ? 'none' : '';
      computeReconciliation(false);
      if(isDirect) setTimeout(()=>{ document.getElementById('floatDirectTotal')?.focus(); }, 50);
    });
  });
  const floatDirectTotal = document.getElementById('floatDirectTotal');
  if(floatDirectTotal) floatDirectTotal.addEventListener('input', ()=>{ computeReconciliation(true); });
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
  const adminFullSyncBtn=document.getElementById('adminFullSyncBtn');
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
  async function getJsonData(url){
    const r = await fetch(url);
    if(!r.ok){
      const t = await r.text();
      throw new Error(`${r.status} ${r.statusText}: ${t}`);
    }
    return r.json();
  }
  let fullSyncPoll = null;
  function renderFullSyncStatus(data){
    if(!data){ return; }
    const totals = data.totals || {};
    const lines = [
      `Full sync status: ${data.status || 'unknown'}`,
      `Stage: ${data.stage || 'n/a'}`,
      `Last batch pulled: ${data.last_pulled || 0}`,
      data.fast_mode ? 'Mode: fast (skipping variant/tax hydration)' : '',
      `Totals: items=${totals.items || 0}, attrs=${totals.attr_defs || 0}, barcodes=${totals.barcodes || 0}, bins=${totals.bins || 0}, prices=${totals.prices || 0}`,
      data.message ? `Message: ${data.message}` : ''
    ].filter(Boolean);
    showStatus(lines.join('\n'));
  }
  if(adminInitDbBtn){ adminInitDbBtn.addEventListener('click', async()=>{ showStatus('Initializing database...'); const out = await postJson('/api/db/init'); showStatus(out); }); }
  if(adminSeedBtn){ adminSeedBtn.addEventListener('click', async()=>{ showStatus('Seeding demo data...'); const out = await postJson('/api/db/seed-demo'); showStatus(out); }); }
  if(adminEnsureBtn){ adminEnsureBtn.addEventListener('click', async()=>{ showStatus('Ensuring demo DB...'); const out = await postJson('/api/db/ensure-demo'); showStatus(out); }); }
  if(adminSyncBtn){ adminSyncBtn.addEventListener('click', async()=>{ showStatus('Syncing items...'); const out = await postJson('/api/db/sync-items'); showStatus(out); }); }
  if(adminFullSyncBtn){ adminFullSyncBtn.addEventListener('click', async()=>{
    showStatus('Running full sync (this can take a while)...');
    const out = await postJson('/api/db/full-sync-items');
    showStatus(out);
    if(fullSyncPoll){ clearInterval(fullSyncPoll); fullSyncPoll = null; }
    fullSyncPoll = setInterval(async()=>{
      try{
        const status = await getJsonData('/api/db/full-sync-status');
        renderFullSyncStatus(status);
        if(status && (status.status === 'complete' || status.status === 'error')){
          clearInterval(fullSyncPoll);
          fullSyncPoll = null;
        }
      }catch(e){
        showStatus(`/api/db/full-sync-status: failed ${e}`);
        clearInterval(fullSyncPoll);
        fullSyncPoll = null;
      }
    }, 2000);
  }); }
  if(adminStatusBtn){ adminStatusBtn.addEventListener('click', async()=>{ showStatus('Fetching DB status...'); const out = await getJson('/api/db/status'); showStatus(out); }); }

  // Invoice queue stats & retry
  const invoiceQueueRefreshBtn = document.getElementById('invoiceQueueRefreshBtn');
  const invoiceQueueRetryBtn   = document.getElementById('invoiceQueueRetryBtn');
  const invoiceQueueStatsEl    = document.getElementById('invoiceQueueStats');
  const posKeyInfoEl           = document.getElementById('posKeyInfo');
  async function loadQueueStats() {
    if(invoiceQueueStatsEl) invoiceQueueStatsEl.textContent = 'Loading…';
    let d;
    try { const r = await fetch('/api/admin/invoice-queue'); d = await r.json(); } catch(_){}
    if(!d || d.status !== 'success'){ if(invoiceQueueStatsEl) invoiceQueueStatsEl.textContent = 'Failed to load stats.'; return; }
    const s = d.stats;
    if(invoiceQueueStatsEl){
      invoiceQueueStatsEl.innerHTML =
        `<strong>Till agent:</strong> pending: ${s.pending}, <span class="${s.failed>0?'text-danger fw-semibold':''}">failed: ${s.failed}</span>, sent: ${s.sent}<br>` +
        `<strong>Server queue:</strong> pending: ${s.queue_pending}, failed: ${s.queue_failed}, confirmed: ${s.queue_confirmed}`;
    }
    if(posKeyInfoEl){
      if(s.pos_key_is_default){
        posKeyInfoEl.style.display = '';
        posKeyInfoEl.className = 'alert alert-warning py-2 small mb-0';
        posKeyInfoEl.textContent = `⚠ POS key is the default "SUPERSECRET123". Set POS_RECEIPT_KEY on both server and till agent to the same custom value.`;
      } else if(s.pos_key_set){
        posKeyInfoEl.style.display = '';
        posKeyInfoEl.className = 'alert alert-success py-2 small mb-0';
        posKeyInfoEl.textContent = `✓ POS key set (${s.pos_key_preview}). Ensure POS_RECEIPT_KEY in the till agent matches exactly.`;
      } else {
        posKeyInfoEl.style.display = '';
        posKeyInfoEl.className = 'alert alert-danger py-2 small mb-0';
        posKeyInfoEl.textContent = `✗ POS key is empty — set POS_RECEIPT_KEY env var to secure the ingest endpoint.`;
      }
    }
  }
  if(invoiceQueueRefreshBtn){ invoiceQueueRefreshBtn.addEventListener('click', loadQueueStats); }
  if(invoiceQueueRetryBtn){ invoiceQueueRetryBtn.addEventListener('click', async ()=>{
    invoiceQueueRetryBtn.disabled = true;
    let d;
    try { const r = await fetch('/api/admin/invoice-queue/retry-failed', {method:'POST'}); d = await r.json(); } catch(_){}
    invoiceQueueRetryBtn.disabled = false;
    if(d && d.status === 'success'){
      alert(`Moved ${d.moved} failed invoice(s) back to pending. The till agent will retry shortly.`);
      loadQueueStats();
    } else {
      alert('Retry request failed — check server logs.');
    }
  }); }

  // Trapped sales
  const trappedSalesRefreshBtn   = document.getElementById('trappedSalesRefreshBtn');
  const trappedSalesDeleteAllBtn = document.getElementById('trappedSalesDeleteAllBtn');
  const trappedSalesInfo         = document.getElementById('trappedSalesInfo');
  const trappedSalesList         = document.getElementById('trappedSalesList');
  const trappedSalesDeleteAll    = document.getElementById('trappedSalesDeleteAll');

  function _buildTrappedSaleRow(s) {
    const dt = (s.created_utc || '').replace('T',' ').substring(0,16) || '—';
    const STATUS_CLASS = { failed:'text-danger', queued:'text-warning fw-semibold', posting:'text-info' };
    const statusCls = STATUS_CLASS[s.queue_status] || '';
    const sid8 = s.sale_id.substring(0,8);

    // Items with diagnosis badges
    const lineHtml = (s.lines||[]).map(ln => {
      const badge = ln.in_local_db
        ? `<span class="badge bg-success ms-1" title="Item found in local DB">&#10003;</span>`
        : `<span class="badge bg-danger ms-1" title="Item not found in local DB — may not exist in ERPNext">missing</span>`;
      const attrs = ln.attributes ? ` <span class="text-muted">(${ln.attributes})</span>` : '';
      return `<div class="d-flex justify-content-between small py-1 border-bottom">
        <span>${ln.item_name}${attrs}${badge} &times;${ln.qty}</span>
        <span class="text-muted ms-2">£${parseFloat(ln.line_total||0).toFixed(2)}</span>
      </div>`;
    }).join('') || '<div class="small text-muted">No lines found</div>';

    const payHtml = (s.payments||[]).map(p =>
      `<span class="badge bg-secondary me-1">${p.method}: £${parseFloat(p.amount_gbp||0).toFixed(2)}</span>`
    ).join('') || '';

    const diagHtml = s.diagnosis
      ? `<div class="alert alert-warning py-1 px-2 small mt-2 mb-0">${s.diagnosis}</div>` : '';

    const errHtml = s.last_error
      ? `<div class="text-danger small mt-1" style="word-break:break-word;"><strong>Error:</strong> ${s.last_error}</div>` : '';

    return `<div class="border rounded mb-2 overflow-hidden" data-sale-id="${s.sale_id}">
      <div class="d-flex justify-content-between align-items-start px-2 py-2 gap-2 trapped-sale-header" style="cursor:pointer;background:#f8f9fa;">
        <div class="small" style="min-width:0;">
          <span class="font-monospace">${sid8}…</span>
          &nbsp;<span class="${statusCls}">${s.queue_status}</span>
          <span class="text-muted ms-2">${dt}</span>
          &nbsp;£${parseFloat(s.total||0).toFixed(2)}
          ${s.cashier ? `<span class="text-muted ms-1">(${s.cashier})</span>` : ''}
        </div>
        <span class="text-muted small flex-shrink-0">&#9660;</span>
      </div>
      <div class="trapped-sale-detail px-2 pb-2 pt-1" style="display:none;">
        <div class="mb-2">${lineHtml}</div>
        ${payHtml ? `<div class="mb-2">${payHtml}</div>` : ''}
        ${diagHtml}${errHtml}
        <div class="d-flex gap-2 mt-2 trapped-sale-actions" data-sale-id="${s.sale_id}">
          <button class="btn btn-outline-primary btn-sm trapped-retry-btn">Retry sync</button>
          <button class="btn btn-outline-danger btn-sm trapped-delete-btn">Delete</button>
        </div>
        <div class="trapped-retry-result small mt-1"></div>
      </div>
    </div>`;
  }

  async function loadTrappedSales() {
    if(trappedSalesInfo) trappedSalesInfo.textContent = 'Loading…';
    if(trappedSalesList){ trappedSalesList.innerHTML = ''; trappedSalesList.style.display = 'none'; }
    if(trappedSalesDeleteAll) trappedSalesDeleteAll.style.display = 'none';
    let d;
    try { const r = await fetch('/api/admin/trapped-sales'); d = await r.json(); } catch(_){}
    if(!d || d.status !== 'success'){
      if(trappedSalesInfo) trappedSalesInfo.textContent = 'Failed to load trapped sales.';
      return;
    }
    const sales = d.sales || [];
    if(!sales.length){
      if(trappedSalesInfo) trappedSalesInfo.textContent = 'No trapped sales — all synced.';
      return;
    }
    if(trappedSalesInfo) trappedSalesInfo.textContent = `${sales.length} sale${sales.length !== 1 ? 's' : ''} pending sync:`;
    if(trappedSalesList){
      trappedSalesList.innerHTML = sales.map(s => _buildTrappedSaleRow(s)).join('');
      trappedSalesList.style.display = 'block';
    }
    if(trappedSalesDeleteAll) trappedSalesDeleteAll.style.display = 'block';

    // Expand/collapse on header click
    trappedSalesList.querySelectorAll('.trapped-sale-header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const detail = hdr.nextElementSibling;
        const arrow  = hdr.querySelector('span:last-child');
        const open   = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : 'block';
        if(arrow) arrow.textContent = open ? '▼' : '▲';
      });
    });

    // Per-row retry
    trappedSalesList.querySelectorAll('.trapped-retry-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const actions = btn.closest('.trapped-sale-actions');
        const sid = actions.dataset.saleId;
        const resultEl = btn.closest('.trapped-sale-detail').querySelector('.trapped-retry-result');
        btn.disabled = true; btn.textContent = 'Retrying…';
        let d2;
        try {
          const r2 = await fetch('/api/admin/trapped-sales/retry', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ sale_id: sid })
          });
          d2 = await r2.json();
        } catch(_){}
        btn.disabled = false; btn.textContent = 'Retry sync';
        if(!d2){ if(resultEl) resultEl.innerHTML = '<span class="text-danger">Request failed.</span>'; return; }
        if(d2.posted){
          if(resultEl) resultEl.innerHTML = `<span class="text-success">Posted &#10003; — ${d2.erp_docname}</span>`;
          setTimeout(loadTrappedSales, 1200);
        } else {
          if(resultEl) resultEl.innerHTML = `<span class="text-danger"><strong>ERPNext error:</strong> ${d2.error || 'unknown'}</span>`;
        }
      });
    });

    // Per-row delete
    trappedSalesList.querySelectorAll('.trapped-delete-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const sid = btn.closest('.trapped-sale-actions').dataset.saleId;
        if(!confirm(`Delete sale ${sid.substring(0,8)}…? This cannot be undone.`)) return;
        await deleteTrappedSales([sid]);
      });
    });
  }

  async function deleteTrappedSales(saleIds) {
    let d;
    try {
      const r = await fetch('/api/admin/trapped-sales/delete', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sale_ids: saleIds })
      });
      d = await r.json();
    } catch(_){}
    if(d && d.status === 'success'){
      const msg = d.skipped && d.skipped.length
        ? `Deleted ${d.deleted}. Skipped ${d.skipped.length} (already posted).`
        : `Deleted ${d.deleted} sale${d.deleted !== 1 ? 's' : ''}.`;
      if(trappedSalesInfo) trappedSalesInfo.textContent = msg;
      loadTrappedSales();
    } else {
      alert('Delete failed — check server logs.');
    }
  }

  if(trappedSalesRefreshBtn) trappedSalesRefreshBtn.addEventListener('click', loadTrappedSales);
  if(trappedSalesDeleteAllBtn) trappedSalesDeleteAllBtn.addEventListener('click', async () => {
    const rows = trappedSalesList ? trappedSalesList.querySelectorAll('[data-sale-id]') : [];
    const ids = [...new Set([...rows].map(el => el.dataset.saleId))];
    if(!ids.length) return;
    if(!confirm(`Delete all ${ids.length} trapped sale${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    await deleteTrappedSales(ids);
  });

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
  if(logout){ logout.addEventListener('click',e=>{
    e.stopPropagation();
    if(menu) menu.classList.remove('open');
    if(cart && cart.length > 0){
      if(!confirm(`There ${cart.length === 1 ? 'is 1 item' : `are ${cart.length} items`} in the current cart.\nLog out anyway? (Items will be lost)`)) return;
    }
    logoutToLogin();
  }); }
  const trainingBtn=document.getElementById('cashierTrainingBtn');
  if(trainingBtn){ trainingBtn.addEventListener('click',e=>{ e.stopPropagation(); if(!currentCashier) return; const levels=settings.cashier_training_levels||{}; const cur=getActiveCashierTrainingLevel(); const next=(cur+1)%4; levels[currentCashier.code]=next; settings.cashier_training_levels=levels; saveSettings(); updateCashierTrainingBtn(); if(typeof TrainingWheels!=='undefined') TrainingWheels.init(next); }); }
  document.addEventListener('click',e=>{ const wrap=document.querySelector('.cashier-wrap'); if(menu&&wrap&&!wrap.contains(e.target)) menu.classList.remove('open'); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&menu) menu.classList.remove('open'); });
  // login overlay
  const login=document.getElementById('loginOverlay'); const code=document.getElementById('cashierCodeInput'); const enter=document.getElementById('loginEnterBtn'); const err=document.getElementById('loginError');
  if(login&&code&&enter){ enter.addEventListener('click',attemptLogin); code.addEventListener('keydown',e=>{ if(e.key==='Enter') attemptLogin(); }); login.querySelectorAll('.key-btn').forEach(b=>b.addEventListener('click',()=>{ const k=b.getAttribute('data-key'); if(k==='C'){ code.value=''; err.style.display='none'; } else if(k==='B'){ code.value=code.value.slice(0,-1);} else { code.value+=k; } })); }
  // search overlay
  const so=document.getElementById('searchOverlay');
  const sb=document.getElementById('searchInputBig');
  const sc=document.getElementById('searchCloseBtn');
  const backBtn=document.getElementById('searchBackBtn');
  if(so){
    if(sb){
    sb.addEventListener('input', ()=>{
        const q = (sb.value || '').trim();
        if(searchDebounceTimer){
          clearTimeout(searchDebounceTimer);
          searchDebounceTimer = null;
        }
        if(q){
          if(q.length < SEARCH_MIN_CHARS){
            browseLoading = false;
            searchItems = [];
            renderSearchItems();
            return;
          }
          browseLoading = true;
          renderSearchItems();
          searchDebounceTimer = setTimeout(()=>{
            fetchBrowseItems({ brand: selectedBrand || null, q, force: true })
              .then(list=>{
                searchItems = list;
                browseLoading = false;
                renderSearchItems();
              })
              .catch(()=>{
                browseLoading = false;
                renderSearchItems();
              });
          }, SEARCH_DEBOUNCE_MS);
          return;
        }
        browseLoading = false;
        renderSearchStage();
      });
      sb.addEventListener('keydown', handleSearchOverlayKeydown, { capture: true });
    }
    if(backBtn){
      backBtn.addEventListener('click', ()=>{
        if(sb) sb.value = '';
        if(searchStage === 'items'){
          selectedBrand = '';
          setSearchStage('brands');
        }
      });
    }
    if(sc) sc.addEventListener('click',hideSearchOverlay);
    so.addEventListener('keydown', handleSearchOverlayKeydown, { capture: true });
    document.addEventListener('keydown', handleSearchOverlayKeydown, { capture: true });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') hideSearchOverlay(); });
    so.addEventListener('click',e=>{ if(e.target===so) hideSearchOverlay(); });
  }
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
    
    // Plastic bag quick-add button
    const addPlasticBagBtn = document.getElementById('addPlasticBagBtn');
    if(addPlasticBagBtn){
      if(!plasticBagItemCode){ addPlasticBagBtn.style.display = 'none'; }
      else {
        addPlasticBagBtn.addEventListener('click', ()=>{
          const item = items.find(x => x.item_code === plasticBagItemCode || x.name === plasticBagItemCode);
          if(!item){ alert('Plastic bag item not found in catalogue. Check POS_PLASTIC_BAG_ITEM setting.'); return; }
          addSimpleItemToCart(item);
          renderCheckoutCart();
          updateCashSection();
        });
      }
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
  const mainDiscountBtn = document.getElementById('mainDiscountBtn');
  if(mainDiscountBtn){ mainDiscountBtn.addEventListener('click', openDiscountOverlay); }
  const mainBagBtn = document.getElementById('mainBagBtn');
  if(mainBagBtn){
    if(!plasticBagItemCode){ mainBagBtn.style.display = 'none'; }
    else {
      mainBagBtn.addEventListener('click', ()=>{
        const item = items.find(x => x.item_code === plasticBagItemCode || x.name === plasticBagItemCode);
        if(!item){ alert('Plastic bag item not found in catalogue. Check POS_PLASTIC_BAG_ITEM setting.'); return; }
        addSimpleItemToCart(item);
      });
    }
  }
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
  // Layaway store button
  const layStoreBtn = document.getElementById('layawayStoreBtn');
  if (layStoreBtn) layStoreBtn.addEventListener('click', () => openLayawayStore());
  // Put on Layaway button in checkout
  const putLayawayBtn = document.getElementById('putOnLayawayBtn');
  if (putLayawayBtn) putLayawayBtn.addEventListener('click', () => { hideCheckoutOverlay(); startLayawayFlow(); });
  // Layaway store close
  const layStoreClose = document.getElementById('layawayStoreCloseBtn');
  if (layStoreClose) layStoreClose.addEventListener('click', closeLayawayStore);
  // Layaway status filter
  const layFilter = document.getElementById('layawayStatusFilter');
  if (layFilter) layFilter.addEventListener('change', () => renderLayawayList());
  // Sync layaways from ERPNext
  const laySyncBtn = document.getElementById('lawaySyncFromErpBtn') || document.getElementById('layawaySyncFromErpBtn');
  if (laySyncBtn) laySyncBtn.addEventListener('click', syncLayawaysFromErp);
  // Layaway detail close
  const layDetailClose = document.getElementById('layawayDetailCloseBtn');
  if (layDetailClose) layDetailClose.addEventListener('click', closeLayawayDetail);
  // Customer name prompt
  const layCancelNameBtn = document.getElementById('layawayCustomerCancelBtn');
  if (layCancelNameBtn) layCancelNameBtn.addEventListener('click', closeLayawayModals);
  const layNextBtn = document.getElementById('layawayCustomerNextBtn');
  if (layNextBtn) layNextBtn.addEventListener('click', layawayCustomerNext);
  const layCustInput = document.getElementById('layawayCustomerInput');
  if (layCustInput) layCustInput.addEventListener('keydown', e => { if (e.key === 'Enter') layawayCustomerNext(); });
  // Payment modal
  const layPayBackBtn = document.getElementById('layawayPaymentBackBtn');
  if (layPayBackBtn) layPayBackBtn.addEventListener('click', () => { layawayHidePaymentModal(); layawayShowCustomerModal(); });
  const layPayConfirmBtn = document.getElementById('layawayPaymentConfirmBtn');
  if (layPayConfirmBtn) layPayConfirmBtn.addEventListener('click', layawayConfirmCreate);
  // Method pills
  document.querySelectorAll('.lay-method-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.lay-method-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
}

function showMenu(){ const o=document.getElementById('menuOverlay'); const mv=document.getElementById('menuView'); const sv=document.getElementById('settingsView'); const av=document.getElementById('adminView'); if(!o){ err('loginOverlay element missing'); return; }
  neutralizeForeignOverlays(); if(mv) mv.style.display='block'; if(sv) sv.style.display='none'; if(av) av.style.display='none'; o.style.display='flex';
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
        search_view_mode: 'variants',
        show_zero_stock: false,
        till_open: false,
        till_opened_at: null,
        till_closed_at: null,
        training_level: 0,
        cashier_training_levels: {}
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
  const searchView=document.getElementById('searchViewSelect');
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
  if(searchView) searchView.value = (settings.search_view_mode || 'variants');
  if(header) header.value = (settings.receipt_header!=null?settings.receipt_header:RECEIPT_DEFAULT_HEADER);
  if(footer) footer.value = (settings.receipt_footer!=null?settings.receipt_footer:'');
  const trainingSelect=document.getElementById('trainingLevelSelect');
  if(trainingSelect) trainingSelect.value = String(settings.training_level||0);
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
  const searchView=document.getElementById('searchViewSelect');
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
  if(searchView){
    settings.search_view_mode = (searchView.value === 'tiles') ? 'tiles' : 'variants';
  }
  if(header) settings.receipt_header = normalizeMultilineInput(header.value||'');
  if(footer) settings.receipt_footer = normalizeMultilineInput(footer.value||'');
  const trainingSelect=document.getElementById('trainingLevelSelect');
  settings.training_level = trainingSelect ? parseInt(trainingSelect.value||'0',10) : 0;
  saveSettings();
}
function getActiveCashierTrainingLevel(){
  if(currentCashier && currentCashier.code){
    const levels = settings.cashier_training_levels || {};
    if(levels[currentCashier.code] !== undefined) return levels[currentCashier.code];
  }
  return settings.training_level || 0;
}
function updateCashierTrainingBtn(){
  const btn = document.getElementById('cashierTrainingBtn');
  if(!btn) return;
  if(!currentCashier){ btn.style.display='none'; return; }
  btn.style.display='';
  const lvl = getActiveCashierTrainingLevel();
  const labels = ['Training: Off','Training: L1','Training: L2','Training: L3'];
  btn.textContent = labels[lvl] || 'Training: Off';
}
function applySettings(){
  document.body.classList.toggle('dark-mode', !!settings.dark_mode);
  setSnowEnabled(!!settings.christmas_mode);
  SEARCH_VIEW_MODE = (settings && settings.search_view_mode === 'tiles') ? 'tiles' : 'variants';
  if(typeof renderSearchStage === 'function'){
    try{ renderSearchStage(); }catch(_){}
  }
  if(typeof TrainingWheels !== 'undefined'){
    TrainingWheels.init(getActiveCashierTrainingLevel());
  }
}

// Search overlay
function isBrowseCacheFresh(ts){
  return ts && (Date.now() - ts) < BROWSE_CACHE_TTL_MS;
}
async function fetchBrowseBrands(force=false){
  if(!force && browseCache.brands.data.length && isBrowseCacheFresh(browseCache.brands.ts)){
    return browseCache.brands.data;
  }
  try{
    const r = await fetch('/api/browse/brands');
    const d = await r.json();
    const list = (d && d.status==='success' && Array.isArray(d.brands)) ? d.brands : [];
    browseCache.brands = { data: list, ts: Date.now() };
    return list;
  }catch(e){
    err('browse brands failed', e);
    return browseCache.brands.data || [];
  }
}
async function fetchBrowseItems({ brand=null, q='', force=false } = {}){
  const cacheKey = `${SEARCH_VIEW_MODE}:${brand||''}`;
  const qKey = (q || '').trim().toLowerCase();
  if(qKey && !force && searchCache.has(qKey)){
    return searchCache.get(qKey);
  }
  const cached = browseCache.items.get(cacheKey);
  if(!q && !force && cached && isBrowseCacheFresh(cached.ts)){
    return cached.data;
  }
  const params = new URLSearchParams();
  const normalizedQ = (q || '').trim();
  let serverQ = normalizedQ;
  let serverBrand = brand || null;
  if(SEARCH_VIEW_MODE === 'variants' && normalizedQ.includes(' ')){
    const tokens = normalizedQ.split(/\s+/).filter(Boolean);
    if(tokens.length > 1){
      if(!browseBrands || !browseBrands.length){
        try { browseBrands = await fetchBrowseBrands(false); } catch(_){}
      }
      if(browseBrands && browseBrands.length){
        const brandMap = new Map(browseBrands.map(b=>[String(b||'').toLowerCase(), b]));
        const matchedToken = tokens.find(tok => brandMap.has(tok));
        if(matchedToken){
          serverBrand = brandMap.get(matchedToken) || serverBrand;
          const remaining = tokens.filter(tok => tok !== matchedToken);
          serverQ = remaining[0] || '';
        } else {
          serverQ = tokens[0];
        }
      } else {
        serverQ = tokens[0];
      }
    }
  }
  if(serverBrand) params.set('brand', serverBrand);
  if(serverQ) params.set('q', serverQ);
  if(SEARCH_VIEW_MODE === 'variants'){
    params.set('mode', 'variants');
    params.set('fields', 'table');
  } else {
    params.set('fields', 'list');
  }
  params.set('limit', '240');
  try{
    const r = await fetch(`/api/browse/items?${params.toString()}`);
    const d = await r.json();
    const list = (d && d.status==='success' && Array.isArray(d.items)) ? d.items : [];
    if(!q){
      browseCache.items.set(cacheKey, { data: list, ts: Date.now() });
    }else{
      searchCache.set(qKey, list);
      if(searchCache.size > SEARCH_CACHE_MAX){
        const firstKey = searchCache.keys().next().value;
        if(firstKey) searchCache.delete(firstKey);
      }
    }
    return list;
  }catch(e){
    err('browse items failed', e);
    return cached ? cached.data : [];
  }
}
function updateSearchStageUI(){
  const label = document.getElementById('searchStageLabel');
  const backBtn = document.getElementById('searchBackBtn');
  const chips = document.getElementById('searchStageChips');
  const input = document.getElementById('searchInputBig');
  const zeroToggleWrap = document.getElementById('zeroStockToggle')?.closest('.form-check');
  if(backBtn){
    backBtn.style.display = (searchStage === 'brands') ? 'none' : 'inline-flex';
  }
  if(label){
    if(searchStage === 'brands') label.textContent = 'Choose a brand';
    else label.textContent = 'Browse products';
  }
  if(input){
    if(searchStage === 'brands') input.placeholder = 'Search brands...';
    else input.placeholder = 'Search products...';
  }
  if(chips){
    chips.innerHTML = '';
    if(selectedBrand){
      const chip = document.createElement('span');
      chip.className = 'badge bg-light text-dark border';
      chip.textContent = selectedBrand;
      chips.appendChild(chip);
    }
  }
  if(zeroToggleWrap){
    zeroToggleWrap.style.display = 'flex';
  }
}
async function setSearchStage(stage, opts={}){
  searchStage = stage;
  updateSearchStageUI();
  if(stage === 'brands'){
    browseBrands = await fetchBrowseBrands(!!opts.force);
    renderBrowseBrands();
    return;
  }
  browseLoading = true;
  renderSearchItems();
  searchItems = await fetchBrowseItems({
    brand: selectedBrand || null,
    q: opts.q || '',
    force: !!opts.force
  });
  browseLoading = false;
  renderSearchItems();
}
async function showSearchOverlay(q=''){
  const o=document.getElementById('searchOverlay'), i=document.getElementById('searchInputBig');
  const zeroToggle=document.getElementById('zeroStockToggle');
  if(!o||!i) return;
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try{ o.setAttribute('tabindex','-1'); }catch(_){}
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){}
  if(zeroToggle){
    zeroToggle.checked = isShowZeroStockEnabled();
  }
  const query = (q || '').toString().trim();
    if(query){
      selectedBrand = '';
      i.value = query;
      await setSearchStage('items', { force: true, q: query });
    } else {
      selectedBrand = '';
      i.value = '';
      await setSearchStage('brands');
    }
  setTimeout(()=>i.focus(),0);
  setTimeout(()=>{ try{ o.focus(); }catch(_){ } }, 10);
}
function hideSearchOverlay(){ const o=document.getElementById('searchOverlay'); if(o) o.style.display='none'; }
function itemMatchesSearch(item, needle){
  return itemSearchMeta(item, needle).score > 0;
}

function itemSearchMeta(item, needle){
  if(!needle) return { score: 0, matched: 0, total: 0 };
  const text = String(needle||'').trim().toLowerCase();
  if(!text) return { score: 0, matched: 0, total: 0 };
  const terms=[];
  const push=val=>{ if(val===undefined||val===null) return; const txt=String(val).trim(); if(txt) terms.push(txt.toLowerCase()); };
  const name = (item.item_name || item.name || '').toString().trim().toLowerCase();
  const brand = (item.brand || '').toString().trim().toLowerCase();
  const color = (item.color || item.custom_simple_colour || '').toString().trim().toLowerCase();
  const size = (item.size || '').toString().trim().toLowerCase();
  const width = (item.width || '').toString().trim().toLowerCase();
  push(name);
  push(brand);
  push(item.item_group);
  push(item.item_code);
  push(item.name);
  push(item.barcode);
  push(item.custom_style_code);
  push(item.custom_simple_colour);
  push(item.color);
  push(item.size);
  push(item.width);
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
  let score = 0;
  let matched = 0;
  if(name === text) score += 400;
  if(name.includes(text)) score += 280;
  if((brand + ' ' + name).includes(text)) score += 200;
  if(brand.includes(text)) score += 80;
  if(color && color.includes(text)) score += 70;
  if(size && size.includes(text)) score += 40;
  if(width && width.includes(text)) score += 30;
  const tokens = text.split(/\s+/).filter(Boolean);
  if(tokens.length > 1){
    tokens.forEach(tok=>{
      if(!tok) return;
      if(name.includes(tok)) { score += 55; matched++; return; }
      if(brand.includes(tok)) { score += 65; matched++; return; }
      if(color && color.includes(tok)) { score += 50; matched++; return; }
      if(size && size.includes(tok)) { score += 30; matched++; return; }
      if(width && width.includes(tok)) { score += 22; matched++; return; }
      if(terms.some(t=>t.includes(tok))) { score += 18; matched++; }
    });
    score += matched * 50;
    if(matched === tokens.length) score += 300;
  } else {
    if(terms.some(t=>t.includes(text))) { score += 20; matched = 1; }
  }
  return { score, matched, total: tokens.length || (text ? 1 : 0) };
}
function renderBrowseBrands(){
  const g=document.getElementById('searchGrid');
  const i=document.getElementById('searchInputBig');
  if(!g) return;
  const q=(i&&i.value||'').trim().toLowerCase();
  const list=(browseBrands||[]).filter(name => !q || name.toLowerCase().includes(q));
  g.innerHTML='';
  if(!list.length){
    const msg=document.createElement('div');
    msg.className='search-grid-full';
    msg.innerHTML=`<div class="alert alert-secondary mb-0 small">No brands found.</div>`;
    g.appendChild(msg);
    return;
  }
  // Wrap in a compact brand grid container
  const grid = document.createElement('div');
  grid.className = 'brand-chip-grid';
  list.forEach(name=>{
    const chip = document.createElement('button');
    chip.className = 'brand-chip';
    chip.type = 'button';
    chip.textContent = name;
    chip.addEventListener('click', ()=>{
      selectedBrand = name;
      setSearchStage('items');
      const inp = document.getElementById('searchInputBig');
      if (inp) setTimeout(() => inp.focus(), 50);
    });
    grid.appendChild(chip);
  });
  g.appendChild(grid);
}
function renderSearchItems(){
  const g=document.getElementById('searchGrid');
  const i=document.getElementById('searchInputBig');
  if(!g) return;
  g.classList.toggle('search-grid-table', SEARCH_VIEW_MODE === 'variants');
  let list=isShowZeroStockEnabled() ? (searchItems||[]).slice() : (searchItems||[]).filter(hasSellableStock);
  const q=(i&&i.value||'').trim().toLowerCase();
  if(q){
    const tokens = q.split(/\s+/).filter(Boolean);
    let scored = list
      .map(item=>({ item, meta: itemSearchMeta(item, q) }))
      .filter(entry=>entry.meta.score > 0);
    if(tokens.length > 1){
      scored = scored.filter(entry=>entry.meta.matched >= tokens.length);
    }
    list = scored
      .sort((a,b)=>b.meta.score - a.meta.score)
      .map(entry=>entry.item);
  }
  g.innerHTML='';
  if(q && q.length < SEARCH_MIN_CHARS){
    const msg=document.createElement('div');
    msg.className='search-grid-full';
    msg.innerHTML=`<div class="alert alert-secondary mb-0 small">Type at least ${SEARCH_MIN_CHARS} characters to search.</div>`;
    g.appendChild(msg);
    return;
  }
  if(browseLoading){
    const msg=document.createElement('div');
    msg.className='search-grid-full';
    msg.innerHTML=`<div class="alert alert-secondary mb-0 small">Loading products…</div>`;
    g.appendChild(msg);
    return;
  }
  if(!list.length){
    const msg=document.createElement('div');
    msg.className='search-grid-full';
    msg.innerHTML=`<div class="alert alert-secondary mb-0 small">No matching products${isShowZeroStockEnabled()?'':' with stock'}. Toggle "Show zero-stock lines" to include everything.</div>`;
    g.appendChild(msg);
    return;
  }
  if(SEARCH_VIEW_MODE === 'variants'){
    renderSearchVariantTable(g, list);
    return;
  }
  list.forEach(it=>{
    const thumb = it.image ? thumbUrl(it.image, 180, 180) : '';
    const card=document.createElement('div');
    card.className='product-card';
    card.addEventListener('click', ()=>selectProduct(it.name));
    const img=document.createElement('div');
    img.className='product-img';
    if(thumb) img.style.backgroundImage=`url('${thumb}')`;
    const nameEl=document.createElement('div');
    nameEl.className='fw-semibold';
    nameEl.textContent=it.item_name||'';
    const brandEl=document.createElement('div');
    brandEl.className='text-muted small';
    brandEl.textContent=it.brand||'Unbranded';
    const priceEl=document.createElement('div');
    priceEl.className='mt-1';
    priceEl.textContent=formatItemPrice(it);
    card.appendChild(img);
    card.appendChild(nameEl);
    card.appendChild(brandEl);
    card.appendChild(priceEl);
    g.appendChild(card);
  });
}

function renderSearchVariantTable(container, list){
  const wrap=document.createElement('div');
  wrap.className='table-responsive';
  const table=document.createElement('table');
  table.className='table table-sm table-hover search-table mb-0';
  const thead=document.createElement('thead');
  thead.innerHTML=`
    <tr>
      <th>Brand</th>
      <th>Item</th>
      <th>Style</th>
      <th>Colour</th>
      <th>Width</th>
      <th>Size</th>
      <th class="text-end">Price</th>
      <th class="text-end">Qty</th>
    </tr>
  `;
  table.appendChild(thead);
  const tbody=document.createElement('tbody');
  searchNavRows = [];
  searchNavItems = list || [];
  list.forEach(it=>{
    const row=document.createElement('tr');
    row.className='search-row';
    row.dataset.index = String(searchNavRows.length);
    row.innerHTML=`
      <td class="scroll-cell"><span class="scroll-text">${it.brand || 'Unbranded'}</span></td>
      <td class="scroll-cell"><span class="scroll-text">${it.item_name || it.name || ''}</span></td>
      <td class="scroll-cell"><span class="scroll-text">${it.custom_style_code || '-'}</span></td>
      <td class="scroll-cell"><span class="scroll-text">${it.color || '-'}</span></td>
      <td class="scroll-cell"><span class="scroll-text">${it.width || '-'}</span></td>
      <td class="scroll-cell"><span class="scroll-text">${it.size || '-'}</span></td>
      <td class="text-end scroll-cell"><span class="scroll-text">${formatItemPrice(it)}</span></td>
      <td class="text-end scroll-cell"><span class="scroll-text">${Number(it.stock_qty || 0)}</span></td>
    `;
    row.addEventListener('click', ()=>handleSearchVariantClick(it));
    row.addEventListener('mouseenter', ()=>{
      const idx = Number(row.dataset.index || -1);
      if(Number.isFinite(idx)) setSearchNavIndex(idx);
    });
    searchNavRows.push(row);
    tbody.appendChild(row);
  });
  setTimeout(()=>activateScrollText(table), 0);
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  if(searchNavRows.length){
    if(searchNavIndex < 0 || searchNavIndex >= searchNavRows.length){
      searchNavIndex = 0;
    }
    setSearchNavIndex(searchNavIndex, { scroll: false });
  } else {
    searchNavIndex = -1;
  }
}

function activateScrollText(table){
  if(!table) return;
  const cells = table.querySelectorAll('.scroll-cell');
  cells.forEach(cell=>{
    const text = cell.querySelector('.scroll-text');
    if(!text) return;
    text.classList.remove('scrolling');
    if(text.scrollWidth > cell.clientWidth){
      text.classList.add('scrolling');
    }
  });
}

function setSearchNavIndex(index, opts = {}){
  const { scroll = true } = opts;
  const rows = searchNavRows || [];
  if(!rows.length) return;
  const clamped = Math.max(0, Math.min(index, rows.length - 1));
  searchNavIndex = clamped;
  rows.forEach((row, idx)=>row.classList.toggle('active', idx === clamped));
  if(scroll){
    const row = rows[clamped];
    try{ row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }catch(_){}
  }
}

function handleSearchOverlayKeydown(e){
  if(SEARCH_VIEW_MODE !== 'variants') return;
  const overlay = document.getElementById('searchOverlay');
  if(!overlay || overlay.style.display === 'none') return;
  const key = e.key;
  if(key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
  // Prevent page from scrolling when search overlay is open
  if(typeof e.preventDefault === 'function') e.preventDefault();
  if(typeof e.stopPropagation === 'function') e.stopPropagation();
  if(key === 'Enter'){
    const sb = document.getElementById('searchInputBig');
    const val = sb ? sb.value.trim() : '';
    // If the debounce timer is still pending, the Enter arrived too fast for human typing —
    // treat it as a barcode scanner completing a scan, route through the barcode handler.
    if(searchDebounceTimer && val){
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
      hideSearchOverlay();
      processBarcodeScan(val);
      return;
    }
    // Manual typing: Enter does nothing — user clicks the item they want.
    return;
  }
  if(!searchNavRows.length) return;
  e.preventDefault();
  const delta = key === 'ArrowDown' ? 1 : -1;
  const next = (searchNavIndex < 0) ? 0 : (searchNavIndex + delta);
  setSearchNavIndex(next);
}
function renderSearchStage(){
  updateSearchStageUI();
  if(searchStage === 'brands'){ renderBrowseBrands(); return; }
  renderSearchItems();
}
function selectProduct(name){
  const it = (searchItems||[]).find(x=>x.name===name) || (homeItems||[]).find(x=>x.name===name) || items.find(x=>x.name===name);
  if(it) openProduct(it);
}

// Product detail overlay
let currentProduct=null;
let variantSelectionQueue=[];
let variantCellRefs=new Map();
function handleSearchVariantClick(item){
  const templateId = item.template_id || item.parent_id || '';
  if(templateId){
    openProductByTemplateId(templateId, item);
    return;
  }
  addSimpleItemToCart(item);
}
function addSimpleItemToCart(item){
  if(!item) return;
  const code = item.item_code || item.name;
  const rate = Number(item.standard_rate || 0);
  if(!code || !Number.isFinite(rate)) return;
  const existing = cart.find(ci => ci.item_code === code && !ci.refund);
  if(existing){
    existing.qty += 1;
    existing.amount = existing.qty * existing.rate;
  } else {
    cart.push({
      item_code: code,
      item_name: item.item_name || item.name || code,
      qty: 1,
      rate,
      original_rate: rate,
      amount: rate,
      image: item.image || null,
      brand: item.brand || null,
      item_group: item.item_group || null,
      vat_rate: effectiveVatRate(item.vat_rate),
      refund: false
    });
  }
  updateCartDisplay();
}
async function openProduct(item){
  if(!item) return;
  const templateId = item.name || item.item_code || '';
  await openProductByTemplateId(templateId, item);
}
async function openProductByTemplateId(templateId, fallbackItem){
  const o=document.getElementById('productOverlay');
  const t=document.getElementById('productTitle');
  const im=document.getElementById('productImage');
  const br=document.getElementById('productBrand');
  const pr=document.getElementById('productPrice');
  if(!o){ err('loginOverlay element missing'); return; }
  currentProduct=fallbackItem || { name: templateId, item_name: templateId };
  const fallbackTitle = (fallbackItem && (fallbackItem.item_name || fallbackItem.name)) || templateId || 'Product';
  const fallbackPrice = fallbackItem ? formatItemPrice(fallbackItem) : '-';
  neutralizeForeignOverlays();
  if(t) t.textContent=fallbackTitle;
  if(br) br.textContent=(fallbackItem && fallbackItem.brand) || '';
  if(pr) pr.textContent=fallbackPrice;
  if(im) im.style.backgroundImage=(fallbackItem && fallbackItem.image)?`url('${fallbackItem.image}')`:'';
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  try { const cs = getComputedStyle(o); log('loginOverlay computed', { display: cs.display, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity }); } catch(_){}
  clearVariantMatrix();
  if(!templateId) return;
  try{
    const r=await fetch(`/api/item_matrix?item=${encodeURIComponent(templateId)}`);
    const d=await r.json();
    if(d.status==='success'){
      const data = d.data || {};
      const tpl = d.template || {};
      if(tpl.item_name && t) t.textContent = tpl.item_name;
      if(br) br.textContent = tpl.brand || br.textContent || '';
      if(tpl.image && im) im.style.backgroundImage = `url('${tpl.image}')`;
      const priceFallback = tpl.standard_rate != null ? money(tpl.standard_rate) : fallbackPrice;
      if(pr) pr.textContent = formatVariantPriceRange(data.price_min, data.price_max, priceFallback);
      const itemForMatrix = {
        name: tpl.item_id || templateId,
        item_name: tpl.item_name || fallbackTitle,
        brand: tpl.brand || (fallbackItem && fallbackItem.brand) || '',
        standard_rate: tpl.standard_rate != null ? tpl.standard_rate : (fallbackItem && fallbackItem.standard_rate),
        image: tpl.image || (fallbackItem && fallbackItem.image) || null,
        vat_rate: tpl.vat_rate != null ? tpl.vat_rate : (fallbackItem && fallbackItem.vat_rate),
        item_group: (fallbackItem && fallbackItem.item_group) || null,
        custom_style_code: (fallbackItem && fallbackItem.custom_style_code) || ''
      };
      currentProduct = itemForMatrix;
      renderVariantMatrix(itemForMatrix, data);
    }
  }catch(e){ console.error(e); }
}
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
  hideProductOverlay();
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
  if(typeof TrainingWheels !== 'undefined') TrainingWheels.setStep('checkout_open');
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
    if (item.image) img.style.backgroundImage = `url('${thumbUrl(item.image, 80, 80)}')`;
    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    // Build structured name: strip variant suffix, show brand separately
    let baseName = item.item_name;
    const v = item.variant || {};
    const colorVal = v.Color || v.Colour || v.color || v.colour || '';
    const sizeVal = v.Size || v.size || '';
    const widthVal = v.Width || v.width || v.Fit || '';
    const vparts = [colorVal, widthVal, sizeVal].filter(Boolean);
    if(vparts.length){
      const suffix = ' - ' + vparts.join(' - ');
      if(baseName.endsWith(suffix)) baseName = baseName.slice(0, -suffix.length).trim();
    }
    if(item.brand){
      const brandTag = document.createElement('span');
      brandTag.className = 'item-brand-tag';
      brandTag.textContent = item.brand;
      name.appendChild(brandTag);
      name.appendChild(document.createTextNode(' '));
    }
    name.appendChild(document.createTextNode(baseName));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const base = (item.original_rate!=null)? Number(item.original_rate) : Number(item.rate);
    const perDisc = Math.max(0, base - Number(item.rate||0));
    const perPct = base>0 ? (perDisc/base*100) : 0;
    meta.textContent = `${item.qty} × ${money(item.rate)}${isRefund ? ' (refund)' : ''}` + (perDisc>0 ? ` (was ${money(base)}, -${perPct.toFixed(1)}%)` : '');
    details.appendChild(name);
    details.appendChild(meta);
    // Attributes sub-line: style code, colour, size
    const attrs = [];
    if(item.style_code) attrs.push(item.style_code);
    if(colorVal) attrs.push(colorVal);
    if(widthVal) attrs.push(widthVal);
    if(sizeVal) attrs.push(`Sz ${sizeVal}`);
    if(attrs.length){
      const attrEl = document.createElement('div');
      attrEl.className = 'meta';
      attrEl.textContent = attrs.join(' · ');
      details.appendChild(attrEl);
    }
    const refundBtn = document.createElement('button');
    refundBtn.type = 'button';
    refundBtn.className = 'checkout-refund-btn' + (isRefund ? ' active' : '');
    refundBtn.textContent = isRefund ? 'Refunding' : 'Refund';
    refundBtn.title = isRefund ? 'Click to remove refund flag' : 'Mark this item as a return';
    refundBtn.addEventListener('click', () => {
      toggleRefund(item.item_code);
      renderCheckoutCart();
      updateCashSection();
    });
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = money(lineTotal);
    row.appendChild(img);
    row.appendChild(details);
    row.appendChild(refundBtn);
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
    if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
      const cartTotal = getCartTotal();
      if(paid > 0 && cartTotal > 0 && paid + 1e-9 >= cartTotal){
        TrainingWheels.setStep('payment_ready');
      } else if(paid > 0 && cartTotal > 0){
        TrainingWheels.setStep('payment_partial');
      }
    }
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
    if(typeof TrainingWheels !== 'undefined'){
      if(t==='cash') TrainingWheels.setStep('tender_cash');
      else if(t==='card'||t==='other') TrainingWheels.setStep('tender_card');
      else if(t==='voucher') TrainingWheels.setStep('tender_voucher');
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
      try { loadItems(); } catch(_){}
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
    if(typeof TrainingWheels !== 'undefined') TrainingWheels.onSaleDone();
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

// ---- Web Orders (Shopify) ----
function hideWebOrdersOverlay(){ const o=document.getElementById('webOrdersOverlay'); if(o) o.style.display='none'; }
async function showWebOrdersOverlay(){
  const o=document.getElementById('webOrdersOverlay');
  if(!o) return;
  o.style.display='flex';
  await pollWebOrders();
  renderWebOrders(_lastWebOrders);
}
function renderWebOrders(orders){
  const list=document.getElementById('webOrdersList');
  if(!list) return;
  if(!orders || orders.length===0){
    list.innerHTML='<p class="text-muted small">No pending web orders.</p>';
    return;
  }
  list.innerHTML = orders.map(o=>{
    const printed = o.status==='printed' || !!o.printed_at;
    const printedAt = o.printed_at ? new Date(o.printed_at).toLocaleString() : '';
    const itemCards = (o.items||[]).map(i=>{
      const img = i.image_url ? `<img src="${i.image_url}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:4px;flex-shrink:0;" onerror="this.style.display='none'">` : '';
      const details = [i.brand&&`<span style="color:#555;">${i.brand}</span>`, i.item_group&&`<span style="color:#777;">${i.item_group}</span>`, i.style_code&&`<span style="color:#555;">Style: ${i.style_code}</span>`, i.colour&&`<span>Colour: ${i.colour}</span>`, i.size&&`<span>Size: ${i.size}</span>`].filter(Boolean).join(' &bull; ');
      return `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid #eee;">
        ${img}
        <div style="flex:1;font-size:0.8rem;">
          <div style="font-weight:600;">${i.item_name||i.item_code}</div>
          ${details ? `<div style="color:#666;font-size:0.75rem;">${details}</div>` : ''}
          <div style="color:#888;font-size:0.75rem;">SKU: ${i.barcode||i.item_code||''}  &bull;  Qty: ${i.qty}</div>
        </div>
      </div>`;
    }).join('');
    const itemsSection = o.items && o.items.length ? `<div style="margin:6px 0;">${itemCards}</div>` : '<p class="small text-muted" style="margin:4px 0;">No items</p>';
    const printedBanner = printed ? `<div style="background:#e0a800;color:#fff;font-size:0.75rem;font-weight:700;padding:3px 8px;border-radius:4px;margin-bottom:6px;letter-spacing:0.5px;">&#9888; ALREADY PRINTED${printedAt ? ' — ' + printedAt : ''} — check someone isn't already picking this order</div>` : '';
    return `
      <div class="border rounded p-2 mb-2" style="${printed?'background:#fffde7;border-color:#e0a800!important;':''}">
        ${printedBanner}
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <span class="fw-bold">${o.order_number||o.id}</span>
            <span class="text-muted ms-2 small">${o.customer_name||''}</span>
          </div>
          <span class="small text-muted">${o.date||''}</span>
        </div>
        <div class="small text-muted mb-1">£${(o.outstanding||0).toFixed(2)} outstanding</div>
        ${itemsSection}
        <button class="btn btn-sm mt-1 ${printed?'btn-warning':'btn-outline-secondary'}" onclick="printPickingNote('${o.id}',${printed})">
          ${printed?'&#9888; Reprint Picking Note':'Print Picking Note'}
        </button>
      </div>`;
  }).join('');
}
async function printPickingNote(orderId, alreadyPrinted){
  if(alreadyPrinted && !confirm('This picking note has already been printed.\n\nMake sure nobody else is already collecting this order before printing again.\n\nPrint anyway?')) return;
  try{
    await fetch('/api/web-orders/'+orderId+'/print-picking', {method:'POST'});
    await pollWebOrders();
    renderWebOrders(_lastWebOrders);
  }catch(e){ alert('Could not print picking note.'); }
}

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
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.hideGuidePanel();
    TrainingWheels.clearHints();
  }
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
  // Return to checkout_open step if voucher was dismissed without completing
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    const paid = appliedPayments.reduce((s,p)=> s + Number(p.amount||0), 0);
    const cartTotal = getCartTotal();
    if(paid + 1e-9 >= cartTotal && paid > 0) TrainingWheels.setStep('payment_ready');
    else if(paid > 0) TrainingWheels.setStep('payment_partial');
    else TrainingWheels.setStep('checkout_open');
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
  }catch(e){
    err('float print failed', e);
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
  const directMode = document.getElementById('floatDirectMode')?.checked;
  if (directMode) {
    counted = Number(document.getElementById('floatDirectTotal')?.value || 0) || 0;
  } else {
    document.querySelectorAll('#denomsGrid .denom-qty').forEach(el=>{
      const qty = Number(el.value||0) || 0;
      const denom = Number(el.getAttribute('data-denom')||0) || 0;
      counted += qty * denom;
    });
  }
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
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.hideGuidePanel();
    TrainingWheels.clearHints();
  }
  o.style.display='flex'; o.style.visibility='visible'; o.style.opacity='1';
  if(typeof TrainingWheels !== 'undefined') TrainingWheels.setStep('tender_discount');
}
function hideDiscountOverlay(){
  const o=document.getElementById('discountOverlay');
  if(o) o.style.display='none';
  resetDiscountValueInput();
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.setStep('checkout_open');
  }
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
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.hideGuidePanel();
    TrainingWheels.clearHints();
    if(TrainingWheels.clearHighlights) TrainingWheels.clearHighlights();
  }
  if(err){ err.textContent=''; err.style.display='none'; }
  if(res){ res.innerHTML=''; }
  if(load){ load.disabled=true; load.dataset.saleId=''; }
  o.style.display='flex';
  o.style.visibility='visible';
  o.style.opacity='1';
  setTimeout(()=>{ if(input){ input.value=''; input.focus(); } }, 0);
  if(typeof TrainingWheels !== 'undefined') TrainingWheels.setStep('return_open');
}
function hideReturnOverlay(){
  const o=document.getElementById('returnOverlay');
  if(o) o.style.display='none';
  if(typeof TrainingWheels !== 'undefined' && TrainingWheels.getLevel() > 0){
    TrainingWheels.setStep('checkout_open');
  }
}
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
function getDefaultCustomerValue(){ return 'CUST-WALKIN'; }
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
    updateCashierTrainingBtn();
    if(typeof TrainingWheels !== 'undefined') TrainingWheels.init(getActiveCashierTrainingLevel());
    hideLogin();
    resetIdleTimer();
    enforceTillOpenState();
    layawayRefreshBadge();
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
  updateCashierTrainingBtn();
  if(typeof TrainingWheels !== 'undefined') TrainingWheels.init(0);
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





function recordPettyCash(type, amount, reason){
  const agg = _ensureZAggToday();
  if(!agg.petty_cash) agg.petty_cash = { in:0, out:0, entries:[] };
  agg.petty_cash[type] = (agg.petty_cash[type] || 0) + amount;
  agg.petty_cash.entries.push({ type, amount, reason, time: new Date().toLocaleTimeString() });
  saveSettings();
  const label = type === 'in' ? 'Cash In' : 'Cash Out';
  alert(`${label} of £${amount.toFixed(2)} recorded${reason ? ': ' + reason : ''}.`);
  pulseCashDrawer();
}

function _pettyCashLines(agg){
  const pc = agg.petty_cash;
  if(!pc || (!pc.in && !pc.out)) return [];
  const lines = ['', 'Petty Cash'];
  if(pc.in) lines.push(`  Cash In: +${money(pc.in)}`);
  if(pc.out) lines.push(`  Cash Out: -${money(pc.out)}`);
  if(pc.entries && pc.entries.length){
    pc.entries.forEach(e=> lines.push(`    ${e.time} ${e.type==='in'?'+':'-'}${money(e.amount)}${e.reason?' ('+e.reason+')':''}`));
  }
  return lines;
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
    const perBrand = agg.perBrand || {};
    const tenderLines = Object.entries(tenders)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const cashierLines = Object.entries(perCashier)
      .filter(([_,v])=>Math.abs(Number(v||0))>0.0001)
      .map(([k,v])=>`  ${k}: ${money(v)}`);
    const groupLines = Object.entries(perGroup)
      .filter(([_,v])=>v && (Math.abs(Number(v.amount||0))>0.0001 || Math.abs(Number(v.qty||0))>0.0001))
      .map(([k,v])=>`  ${k} (qty ${Number(v.qty||0)}): ${money(Number(v.amount||0))}`);
    const brandLines = Object.entries(perBrand)
      .filter(([_,v])=>v && (Math.abs(Number(v.amount||0))>0.0001 || Math.abs(Number(v.qty||0))>0.0001))
      .sort((a,b)=>Number(b[1].amount||0)-Number(a[1].amount||0))
      .map(([k,v])=>`  ${k} (qty ${Number(v.qty||0)}): ${money(Number(v.amount||0))}`);
    const pc = agg.petty_cash || { in:0, out:0 };
    const expectedCash = opening + cashSales + (pc.in||0) - (pc.out||0);
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
      ..._pettyCashLines(agg),
      `  Expected Cash in Drawer: ${money(expectedCash)}`,
      '',
      'By Cashier',
      ...(cashierLines.length ? cashierLines : ['  No data']),
      '',
      'By Brand',
      ...(brandLines.length ? brandLines : ['  No data']),
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
      // petty cash entries are included in z_agg and cleared above
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
    const pc = agg.petty_cash || { in:0, out:0 };
    const expectedCash = opening + cashSales + (pc.in||0) - (pc.out||0);
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
      ..._pettyCashLines(agg),
      `  Expected Cash in Drawer: ${money(expectedCash)}`,
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
        if(it.image){ img.style.backgroundImage = `url(${thumbUrl(it.image, 64, 64)})`; img.style.backgroundSize='cover'; img.style.backgroundPosition='center'; }
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

async function handleGlobalScan(code){
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

    // 3) If search overlay is open, look up the barcode and open the product matrix
    if(__isOverlayVisible('searchOverlay')){
      hideSearchOverlay();
      try {
        const r = await fetch(`/api/lookup-barcode?code=${encodeURIComponent(value)}`);
        if(r.ok){
          const d = await r.json();
          if(d && d.status === 'success' && d.variant){
            const v = d.variant;
            const templateId = v.parent_id || v.item_id;
            await openProductByTemplateId(templateId, {
              name: templateId,
              item_name: v.name,
              brand: v.brand,
              item_group: v.item_group,
            });
            return;
          }
        }
      } catch(_){}
      // Barcode not found — fall through to normal add-to-cart
    }

    // 4) Default: route to the barcode input for adding items
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

// ── Layaway Module ────────────────────────────────────────────────────────────

let _layawayCart = null;       // snapshot of cart at "Put on Layaway" time
let _layawayCustomerTag = '';  // customer name entered in the modal
let _layawayCurrentRef = null; // ref of layaway open in detail view

// ── Badge ──────────────────────────────────────────────────────────────────────

async function layawayRefreshBadge() {
  try {
    if (!currentCashier) return;
    const url = `/api/layaways/badge?cashier=${encodeURIComponent(currentCashier.code)}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const d = await r.json();
    const badge = document.getElementById('layawayBadge');
    if (!badge) return;
    const count = d.count || 0;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (_) { /* ignore */ }
}

// Refresh badge on page load and periodically
setTimeout(layawayRefreshBadge, 2000);
setInterval(layawayRefreshBadge, 60000);

// ── Flow: Put on Layaway ───────────────────────────────────────────────────────

function startLayawayFlow() {
  if (!currentCashier) { showLogin(); return; }
  if (!cart || cart.length === 0) { alert('Cart is empty.'); return; }
  _layawayCart = cart.map(i => ({ ...i }));  // snapshot
  _layawayCustomerTag = '';
  layawayShowCustomerModal();
}

function layawayShowCustomerModal() {
  const m = document.getElementById('layawayCustomerModal');
  const inp = document.getElementById('layawayCustomerInput');
  const err = document.getElementById('layawayCustomerError');
  if (m) m.style.display = 'flex';
  if (inp) { inp.value = _layawayCustomerTag || ''; inp.focus(); }
  if (err) err.style.display = 'none';
}

function layawayHideCustomerModal() {
  const m = document.getElementById('layawayCustomerModal');
  if (m) m.style.display = 'none';
}

function layawayShowPaymentModal() {
  const m = document.getElementById('layawayPaymentModal');
  const inp = document.getElementById('layawayDepositInput');
  const err = document.getElementById('layawayPaymentError');
  if (m) m.style.display = 'flex';
  if (inp) { inp.value = '0'; inp.focus(); }
  if (err) err.style.display = 'none';
  // Reset method selection
  document.querySelectorAll('.lay-method-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });
}

function layawayHidePaymentModal() {
  const m = document.getElementById('layawayPaymentModal');
  if (m) m.style.display = 'none';
}

function closeLayawayModals() {
  layawayHideCustomerModal();
  layawayHidePaymentModal();
  _layawayCart = null;
}

function layawayCustomerNext() {
  const inp = document.getElementById('layawayCustomerInput');
  const errEl = document.getElementById('layawayCustomerError');
  const name = (inp ? inp.value : '').trim();
  if (!name) {
    if (errEl) { errEl.textContent = 'Please enter a customer name.'; errEl.style.display = 'block'; }
    if (inp) inp.focus();
    return;
  }
  _layawayCustomerTag = name;
  layawayHideCustomerModal();
  layawayShowPaymentModal();
}

async function layawayConfirmCreate() {
  const confirmBtn = document.getElementById('layawayPaymentConfirmBtn');
  const errEl = document.getElementById('layawayPaymentError');
  const depInput = document.getElementById('layawayDepositInput');
  const tendered = parseFloat(depInput ? depInput.value : '0') || 0;
  const activeMethod = document.querySelector('.lay-method-btn.active');
  const method = activeMethod ? activeMethod.dataset.method : 'Cash';

  // Calculate the agreed total from the cart snapshot
  const cartTotal = (_layawayCart || []).reduce((s, ci) => s + (ci.qty || 1) * (ci.rate || 0), 0);
  // Cap deposit at cart total — show change if tendered more
  const depositAmount = tendered > 0 ? Math.min(tendered, cartTotal) : 0;
  const depositChange = tendered - depositAmount;

  if (errEl) errEl.style.display = 'none';
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Creating…'; }

  try {
    const items = (_layawayCart || []).map(ci => ({
      item_code: ci.item_code,
      item_name: ci.item_name || ci.name || ci.item_code,
      qty: ci.qty || 1,
      rate: ci.rate || 0,
    }));

    const body = {
      customer_tag: _layawayCustomerTag,
      items,
      cashier_code: currentCashier ? currentCashier.code : '',
    };
    if (depositAmount > 0) {
      body.payment = { amount: depositAmount, method };
    }

    const r = await fetch('/api/layaways', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.status !== 'success') {
      throw new Error(d.message || 'Failed to create layaway');
    }

    const lay = d.layaway;
    layawayHidePaymentModal();
    _layawayCart = null;

    // Clear the cart — items go to the shelf
    cart = [];
    appliedPayments = [];
    vouchers = [];
    issuedVouchers = [];
    updateCartDisplay();
    renderAppliedPayments && renderAppliedPayments();

    // Use server-authoritative change (server caps deposit at total)
    const confirmedChange = d.change || 0;
    const confirmedDeposit = lay.paid || 0;

    // Refresh badge
    layawayRefreshBadge();

    if (d.auto_completed) {
      // Fully paid at creation — show the same completion screen as a normal final payment
      showLayawayCompletionScreen(lay, confirmedDeposit, method, confirmedChange);
    } else {
      // Print receipts and show a brief summary alert
      printLayawayReceipts(lay, confirmedDeposit, method, 'created');
      const balance = lay.total - confirmedDeposit;
      let successMsg = `Layaway ${lay.layaway_id} created!\nBalance: £${balance.toFixed(2)}\nExpires: ${formatLayawayDate(lay.expires_at)}`;
      if (confirmedChange > 0.005) {
        successMsg += `\n\n⚠ Give change: £${confirmedChange.toFixed(2)}`;
      }
      alert(successMsg);
    }
  } catch (e) {
    if (errEl) { errEl.textContent = e.message || 'Error creating layaway'; errEl.style.display = 'block'; }
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Layaway'; }
  }
}

// ── Store View ─────────────────────────────────────────────────────────────────

async function openLayawayStore() {
  const overlay = document.getElementById('layawayStoreOverlay');
  if (overlay) overlay.style.display = 'flex';
  await renderLayawayList();
  // Silently sync from ERPNext in the background; re-render if anything changed
  _silentLayawaySync();
}

async function _silentLayawaySync() {
  try {
    const r = await fetch('/api/layaways/pull-from-erp', { method: 'POST' });
    const d = await r.json();
    if (d.status === 'ok' && (d.updated > 0 || d.added > 0)) {
      renderLayawayList(); // something changed — refresh the list
    }
  } catch (_) { /* silent — no ERPNext connection is fine */ }
}

function closeLayawayStore() {
  const overlay = document.getElementById('layawayStoreOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function syncLayawaysFromErp() {
  const btn = document.getElementById('layawaySyncFromErpBtn');
  const list = document.getElementById('layawayStoreList');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  if (list) list.innerHTML = '<div class="text-muted small p-2">Pulling from ERPNext…</div>';
  try {
    const r = await fetch('/api/layaways/pull-from-erp', { method: 'POST' });
    const d = await r.json();
    if (d.status === 'ok') {
      const msg = `Sync complete — ${d.added} added, ${d.updated} updated, ${d.unchanged} unchanged${d.errors ? ', ' + d.errors + ' errors' : ''}.`;
      if (list) list.innerHTML = `<div class="alert alert-success m-2 small">${msg}</div>`;
      setTimeout(() => renderLayawayList(), 1800);
    } else {
      if (list) list.innerHTML = `<div class="alert alert-danger m-2 small">Sync failed: ${d.message || 'unknown error'}</div>`;
    }
  } catch (err) {
    if (list) list.innerHTML = `<div class="alert alert-danger m-2 small">Sync error: ${err.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync from ERPNext'; }
  }
}

async function renderLayawayList() {
  const list = document.getElementById('layawayStoreList');
  const filterEl = document.getElementById('layawayStatusFilter');
  if (!list) return;
  list.innerHTML = '<div class="text-muted small p-2">Loading…</div>';
  const status = filterEl ? filterEl.value : 'active';
  try {
    const url = status ? `/api/layaways?status=${encodeURIComponent(status)}` : '/api/layaways';
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Failed');
    const layaways = d.layaways || [];
    if (layaways.length === 0) {
      list.innerHTML = '<div class="text-muted small p-3 text-center">No layaways found.</div>';
      return;
    }
    list.innerHTML = '';
    const todayStr = new Date().toISOString().slice(0, 10);
    layaways.forEach(lay => {
      const balance = (lay.total || 0) - (lay.paid || 0);
      const expired = lay.expires_at && lay.expires_at.slice(0, 10) <= todayStr;
      const expiryStr = formatLayawayDate(lay.expires_at);
      const row = document.createElement('div');
      row.className = 'layaway-store-row' + (expired && lay.status === 'active' ? ' lay-expired' : '');
      row.innerHTML = `
        <div class="lay-row-id">${lay.layaway_id}</div>
        <div class="lay-row-info">
          <div class="lay-row-customer fw-semibold">${lay.customer_tag || ''}</div>
          <div class="lay-row-items text-muted">${(lay.items || []).length} item(s)</div>
          <div class="lay-row-expiry ${expired && lay.status === 'active' ? 'text-danger fw-semibold' : 'text-muted'}">${expired && lay.status === 'active' ? '⚠ Expired ' : ''}${expiryStr}</div>
        </div>
        <div class="lay-row-amounts">
          <div class="lay-row-total text-muted">Total £${(lay.total || 0).toFixed(2)}</div>
          <div class="lay-row-balance fw-bold ${balance <= 0 ? 'text-success' : ''}">Balance £${balance.toFixed(2)}</div>
        </div>
        <div class="lay-row-status badge bg-${layStatusColor(lay.status)}">${lay.status}</div>
      `;
      row.addEventListener('click', () => openLayawayDetail(lay.layaway_id));
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = `<div class="text-danger small p-2">${e.message}</div>`;
  }
}

function layStatusColor(status) {
  return { active: 'warning', completed: 'success', cancelled: 'secondary', expired: 'danger' }[status] || 'secondary';
}

// ── Detail View ────────────────────────────────────────────────────────────────

async function layawayOpenByRef(ref) {
  closeLayawayStore();
  await openLayawayDetail(ref);
  const overlay = document.getElementById('layawayDetailOverlay');
  if (overlay) overlay.style.display = 'flex';
}

async function openLayawayDetail(ref) {
  _layawayCurrentRef = ref;
  const overlay = document.getElementById('layawayDetailOverlay');
  const body = document.getElementById('layawayDetailBody');
  const title = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (overlay) overlay.style.display = 'flex';
  if (body) body.innerHTML = '<div class="text-muted small p-2">Loading…</div>';

  try {
    const r = await fetch(`/api/layaways/${encodeURIComponent(ref)}`);
    const d = await r.json();
    if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Not found');
    const lay = d.layaway;
    if (title) title.textContent = lay.layaway_id;
    if (subtitle) subtitle.textContent = `Status: ${lay.status}  |  Expires: ${formatLayawayDate(lay.expires_at)}`;
    if (body) body.innerHTML = renderLayawayDetailHTML(lay);
    // Bind actions
    bindLayawayDetailActions(lay);
  } catch (e) {
    if (body) body.innerHTML = `<div class="text-danger small p-2">${e.message}</div>`;
  }
}

function renderLayawayDetailHTML(lay) {
  const balance = (lay.total || 0) - (lay.paid || 0);
  const items = lay.items || [];
  const payments = lay.payments || [];
  const isActive = lay.status === 'active';
  const expired = lay.expires_at && new Date(lay.expires_at) < new Date();

  // Expiry banner — shown prominently above everything when past the warning date
  const expiryBannerHtml = (() => {
    if (!isActive || !lay.expires_at) return '';
    const expDate = new Date(lay.expires_at);
    const now = new Date();
    const daysUntil = Math.ceil((expDate - now) / 86400000);
    if (daysUntil < 0) {
      const daysOver = -daysUntil;
      return `<div class="alert alert-danger d-flex align-items-center gap-2 mb-3">
        <span style="font-size:1.4rem;">⚠️</span>
        <div>
          <div class="fw-bold">Expiry date passed ${daysOver} day${daysOver !== 1 ? 's' : ''} ago</div>
          <div class="small">This layaway is overdue — extend the date or cancel and refund the customer.</div>
        </div>
      </div>`;
    }
    if (daysUntil <= 7) {
      return `<div class="alert alert-warning d-flex align-items-center gap-2 mb-3">
        <span style="font-size:1.4rem;">🕐</span>
        <div>
          <div class="fw-bold">Expires in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}</div>
          <div class="small">Consider contacting the customer or extending the date.</div>
        </div>
      </div>`;
    }
    return '';
  })();

  let html = `${expiryBannerHtml}<div class="lay-detail-summary">
    <div class="lay-detail-stat"><div class="lay-stat-label">Agreed Total</div><div class="lay-stat-val">£${(lay.total || 0).toFixed(2)}</div></div>
    <div class="lay-detail-stat"><div class="lay-stat-label">Paid So Far</div><div class="lay-stat-val text-success">£${(lay.paid || 0).toFixed(2)}</div></div>
    <div class="lay-detail-stat"><div class="lay-stat-label">Balance Due</div><div class="lay-stat-val fw-bold ${balance <= 0 ? 'text-success' : ''}">£${balance.toFixed(2)}</div></div>
  </div>`;

  // Items table
  html += `<table class="table table-sm lay-items-table mt-3"><thead><tr><th>Item</th><th>Qty</th><th class="text-end">Price</th><th class="text-end">Can Collect?</th></tr></thead><tbody>`;
  items.forEach(it => {
    const canCollect = (lay.paid || 0) >= it.original_rate * it.qty;
    html += `<tr>
      <td>${it.item_name || it.item_code}</td>
      <td>${it.qty}</td>
      <td class="text-end">£${(it.original_rate * it.qty).toFixed(2)}</td>
      <td class="text-end">${canCollect ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}</td>
    </tr>`;
  });
  html += `</tbody></table>`;

  // Payments history
  if (payments.length > 0) {
    html += `<div class="fw-semibold small text-muted mb-1 mt-3">Payment History</div><ul class="lay-pay-history">`;
    payments.forEach(p => {
      html += `<li><span class="lay-pay-date">${formatLayawayDate(p.paid_at)}</span> <span class="lay-pay-method badge bg-secondary">${p.method}</span> <span class="lay-pay-amount">£${p.amount.toFixed(2)}</span></li>`;
    });
    html += `</ul>`;
  }

  // Action buttons
  if (isActive) {
    html += `<div class="lay-detail-actions mt-3">`;
    if (balance > 0) {
      html += `<div class="lay-payment-row mb-2">
        <div class="d-flex gap-2 align-items-end">
          <div class="input-group" style="max-width:200px;">
            <span class="input-group-text">£</span>
            <input type="number" id="layDetPayInput" class="form-control form-control-sm" min="0.01" step="0.01" placeholder="${balance.toFixed(2)}" />
          </div>
          <select id="layDetPayMethod" class="form-select form-select-sm" style="max-width:120px;">
            <option>Cash</option><option>Card</option><option>Voucher</option>
          </select>
          <button id="layDetPayBtn" class="btn btn-success btn-sm">Take Payment</button>
        </div>
        <div id="layDetChangeRow" class="lay-change-row" style="display:none;">
          <span class="lay-change-label">Change to give:</span>
          <span id="layDetChangeAmt" class="lay-change-amt">£0.00</span>
          <span class="lay-change-note text-muted">(payment will be capped at balance)</span>
        </div>
      </div>`;
    }
    if (balance <= 0) {
      html += `<button id="layDetCompleteBtn" class="btn btn-success btn-sm me-2">Complete &amp; Invoice</button>`;
    }
    // Extend expiry always available for active layaways (pre-emptive extension, not just after expiry)
    html += `<div class="d-flex gap-2 align-items-center mb-2">
      <input type="date" id="layDetExtendDate" class="form-control form-control-sm" style="max-width:160px;" />
      <button id="layDetExtendBtn" class="btn btn-outline-${expired ? 'danger' : 'primary'} btn-sm">
        ${expired ? '⚠ Extend Expired Date' : 'Extend Expiry'}
      </button>
    </div>`;
    const hasPaid = (lay.paid || 0) > 0;
    html += `<button id="layDetCancelBtn" class="btn btn-outline-danger btn-sm">${hasPaid ? 'Cancel (Refund Required)' : 'Cancel'}</button>`;
    html += `</div>`;
  }

  return html;
}

function bindLayawayDetailActions(lay) {
  const ref = lay.layaway_id;
  const cashierCode = currentCashier ? currentCashier.code : '';

  // Take payment — with change handling
  const payInput = document.getElementById('layDetPayInput');
  const changeRow = document.getElementById('layDetChangeRow');
  const changeAmt = document.getElementById('layDetChangeAmt');
  const balance = (lay.total || 0) - (lay.paid || 0);

  if (payInput && changeRow) {
    payInput.addEventListener('input', () => {
      const tendered = parseFloat(payInput.value) || 0;
      const change = tendered - balance;
      if (change > 0.005) {
        changeAmt.textContent = `£${change.toFixed(2)}`;
        changeRow.style.display = 'flex';
      } else {
        changeRow.style.display = 'none';
      }
    });
  }

  const payBtn = document.getElementById('layDetPayBtn');
  if (payBtn) {
    payBtn.addEventListener('click', () => {
      const tendered = parseFloat(payInput ? payInput.value : '0') || 0;
      const method = document.getElementById('layDetPayMethod').value;
      if (tendered <= 0) { alert('Enter a valid amount'); return; }
      const actualPayment = Math.min(tendered, balance);
      const change = tendered - actualPayment;
      showLayawayPaymentConfirm(lay, tendered, actualPayment, method, change, cashierCode);
    });
  }

  // Complete
  const completeBtn = document.getElementById('layDetCompleteBtn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      if (!confirm('Mark this layaway as complete and raise a Sales Invoice?')) return;
      completeBtn.disabled = true;
      try {
        const r = await fetch(`/api/layaways/${encodeURIComponent(ref)}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cashier_code: cashierCode }),
        });
        const d = await r.json();
        if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Failed');
        layawayRefreshBadge();
        closeLayawayDetail();
        alert('Layaway completed. Sales Invoice queued.');
      } catch (e) { alert(e.message); completeBtn.disabled = false; }
    });
  }

  // Extend
  const extendBtn = document.getElementById('layDetExtendBtn');
  if (extendBtn) {
    extendBtn.addEventListener('click', async () => {
      const dateVal = document.getElementById('layDetExtendDate').value;
      if (!dateVal) { alert('Pick a new expiry date'); return; }
      const newExpires = new Date(dateVal).toISOString();
      extendBtn.disabled = true;
      try {
        const r = await fetch(`/api/layaways/${encodeURIComponent(ref)}/extend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expires_at: newExpires, cashier_code: cashierCode }),
        });
        const d = await r.json();
        if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Failed');
        layawayRefreshBadge();
        await openLayawayDetail(ref);
      } catch (e) { alert(e.message); extendBtn.disabled = false; }
    });
  }

  // Cancel
  const cancelBtn = document.getElementById('layDetCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      showLayawayCancelConfirm(lay, cashierCode);
    });
  }
}

function closeLayawayDetail() {
  const overlay = document.getElementById('layawayDetailOverlay');
  if (overlay) overlay.style.display = 'none';
  _layawayCurrentRef = null;
  // Refresh store list if open
  const storeOverlay = document.getElementById('layawayStoreOverlay');
  if (storeOverlay && storeOverlay.style.display !== 'none') renderLayawayList();
}

// ── Receipt printing ───────────────────────────────────────────────────────────

function formatLayawayDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return isoStr; }
}

function showLayawayCancelConfirm(lay, cashierCode) {
  const overlay  = document.getElementById('layawayDetailOverlay');
  const body     = document.getElementById('layawayDetailBody');
  const title    = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (title)    title.textContent    = 'Cancel Layaway';
  if (subtitle) subtitle.textContent = `${lay.layaway_id} — ${lay.customer_tag || ''}`;

  const refundAmount = lay.paid || 0;
  const hasPaid = refundAmount > 0.005;

  const refundHtml = hasPaid
    ? `<div class="alert alert-danger fw-bold fs-5 text-center">
        Refund due to customer: £${refundAmount.toFixed(2)}
        <div class="fw-normal fs-6 mt-1">Process via till after cancelling</div>
       </div>`
    : `<div class="alert alert-secondary text-center">No payments to refund</div>`;

  const itemRows = (lay.items || []).map(it =>
    `<tr><td>${it.item_name || it.item_code}</td><td class="text-end">x${it.qty}</td><td class="text-end">£${((it.original_rate || it.rate || 0) * it.qty).toFixed(2)}</td></tr>`
  ).join('');

  body.innerHTML = `
    <div class="text-center mb-3">
      <div style="font-size:2.5rem;line-height:1;">⚠️</div>
      <div class="fw-bold fs-5 text-danger mt-1">This will permanently cancel the layaway</div>
    </div>
    ${refundHtml}
    <table class="table table-sm mb-3">
      <thead><tr><th>Item</th><th class="text-end">Qty</th><th class="text-end">Value</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Agreed Total</div>
        <div class="lay-stat-val">£${(lay.total || 0).toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Paid So Far</div>
        <div class="lay-stat-val">£${refundAmount.toFixed(2)}</div>
      </div>
    </div>
    <div class="d-flex gap-2 mt-3">
      <button id="layCancelBackBtn"    class="btn btn-outline-secondary flex-grow-1">Back</button>
      <button id="layCancelConfirmBtn" class="btn btn-danger flex-grow-1 fw-bold">Confirm Cancel</button>
    </div>
    <div id="layCancelError" class="alert alert-danger mt-3" style="display:none;"></div>`;

  if (overlay) overlay.style.display = 'flex';

  document.getElementById('layCancelBackBtn').addEventListener('click', () => {
    openLayawayDetail(lay.layaway_id);
  });

  const confirmBtn = document.getElementById('layCancelConfirmBtn');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Cancelling…';
    document.getElementById('layCancelError').style.display = 'none';
    try {
      const r = await fetch(`/api/layaways/${encodeURIComponent(lay.layaway_id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashier_code: cashierCode, refund_confirmed: true }),
      });
      const d = await r.json();
      if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Failed');
      layawayRefreshBadge();
      showLayawayCancelledScreen(lay, refundAmount);
    } catch (e) {
      const errEl = document.getElementById('layCancelError');
      if (errEl) { errEl.textContent = e.message || 'Cancellation failed'; errEl.style.display = 'block'; }
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Cancel';
    }
  });
}

function showLayawayCancelledScreen(lay, refundAmount) {
  const overlay  = document.getElementById('layawayDetailOverlay');
  const body     = document.getElementById('layawayDetailBody');
  const title    = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (title)    title.textContent    = 'Layaway Cancelled';
  if (subtitle) subtitle.textContent = `${lay.layaway_id} — ${lay.customer_tag || ''}`;

  const hasPaid = refundAmount > 0.005;
  const refundHtml = hasPaid
    ? `<div class="alert alert-warning fw-bold fs-4 text-center mt-2">
        Process refund: £${refundAmount.toFixed(2)}
        <div class="fw-normal fs-6 mt-1">Return cash / reverse card payment via till</div>
       </div>`
    : '';

  const payments = lay.payments || [];
  const payRows = payments.map(p =>
    `<tr>
      <td>${formatLayawayDate(p.paid_at)}</td>
      <td><span class="badge bg-secondary">${p.method}</span></td>
      <td class="text-end">£${(p.amount || 0).toFixed(2)}</td>
    </tr>`
  ).join('');

  const payTable = payments.length > 0 ? `
    <table class="table table-sm mb-3">
      <thead><tr><th>Date</th><th>Method</th><th class="text-end">Amount</th></tr></thead>
      <tbody>${payRows}</tbody>
    </table>` : '';

  body.innerHTML = `
    <div class="text-center mb-3">
      <div style="font-size:3rem;line-height:1;">❌</div>
      <div class="fw-bold fs-4 text-danger mt-1">CANCELLED</div>
      <div class="text-muted">${lay.customer_tag || ''}</div>
    </div>
    ${refundHtml}
    ${payTable}
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Agreed Total</div>
        <div class="lay-stat-val">£${(lay.total || 0).toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Refund Due</div>
        <div class="lay-stat-val ${hasPaid ? 'text-warning fw-bold' : ''}">£${refundAmount.toFixed(2)}</div>
      </div>
    </div>
    <div class="d-flex gap-2 mt-3">
      <button id="layCancelledPrintBtn" class="btn btn-outline-primary flex-grow-1">Print Cancellation</button>
      <button id="layCancelledDoneBtn"  class="btn btn-secondary flex-grow-1">Done</button>
    </div>`;

  if (overlay) overlay.style.display = 'flex';

  document.getElementById('layCancelledPrintBtn').addEventListener('click', () => {
    printLayawayReceipts(lay, refundAmount, '', 'cancelled');
  });
  document.getElementById('layCancelledDoneBtn').addEventListener('click', () => {
    if (overlay) overlay.style.display = 'none';
    openLayawayStore();
  });
}

function showLayawayPaymentConfirm(lay, tendered, actualPayment, method, change, cashierCode) {
  const overlay  = document.getElementById('layawayDetailOverlay');
  const body     = document.getElementById('layawayDetailBody');
  const title    = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (title)    title.textContent    = 'Confirm Payment';
  if (subtitle) subtitle.textContent = `${lay.layaway_id} — ${lay.customer_tag || ''}`;

  const balanceAfter = Math.max(0, (lay.total || 0) - (lay.paid || 0) - actualPayment);
  const changeHtml = change > 0.005
    ? `<div class="alert alert-warning fw-bold fs-5 text-center">Change to return: £${change.toFixed(2)}</div>`
    : '';

  body.innerHTML = `
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Tendered</div>
        <div class="lay-stat-val fw-bold">£${tendered.toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Applied to Layaway</div>
        <div class="lay-stat-val fw-bold text-success">£${actualPayment.toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Method</div>
        <div class="lay-stat-val">${method}</div>
      </div>
    </div>
    ${changeHtml}
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Balance After</div>
        <div class="lay-stat-val ${balanceAfter > 0 ? 'text-warning fw-bold' : 'text-success fw-bold'}">£${balanceAfter.toFixed(2)}</div>
      </div>
    </div>
    <div class="d-flex gap-2 mt-3">
      <button id="layConfirmBackBtn"    class="btn btn-outline-secondary flex-grow-1">Back</button>
      <button id="layConfirmPayBtn"     class="btn btn-success flex-grow-1 fw-bold">Confirm Payment</button>
    </div>
    <div id="layConfirmError" class="alert alert-danger mt-3" style="display:none;"></div>`;

  if (overlay) overlay.style.display = 'flex';

  document.getElementById('layConfirmBackBtn').addEventListener('click', () => {
    openLayawayDetail(lay.layaway_id);
  });

  const confirmPayBtn = document.getElementById('layConfirmPayBtn');
  confirmPayBtn.addEventListener('click', async () => {
    confirmPayBtn.disabled = true;
    confirmPayBtn.textContent = 'Processing…';
    document.getElementById('layConfirmError').style.display = 'none';
    try {
      const r = await fetch(`/api/layaways/${encodeURIComponent(lay.layaway_id)}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: tendered, method, cashier_code: cashierCode }),
      });
      const d = await r.json();
      if (!r.ok || d.status !== 'success') throw new Error(d.message || 'Failed');
      const confirmedChange  = d.change || 0;
      const confirmedAmount  = d.amount_applied || actualPayment;
      layawayRefreshBadge();
      if (d.auto_completed) {
        showLayawayCompletionScreen(d.layaway, confirmedAmount, method, confirmedChange);
      } else {
        showLayawayPaymentScreen(d.layaway, confirmedAmount, method, confirmedChange);
      }
    } catch (e) {
      const errEl = document.getElementById('layConfirmError');
      if (errEl) { errEl.textContent = e.message || 'Payment failed'; errEl.style.display = 'block'; }
      confirmPayBtn.disabled = false;
      confirmPayBtn.textContent = 'Confirm Payment';
    }
  });
}

function showLayawayPaymentScreen(lay, paymentAmount, paymentMethod, change) {
  const overlay  = document.getElementById('layawayDetailOverlay');
  const body     = document.getElementById('layawayDetailBody');
  const title    = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (title)    title.textContent    = 'Payment Accepted';
  if (subtitle) subtitle.textContent = `${lay.layaway_id} — ${lay.customer_tag || ''}`;

  const remaining = Math.max(0, (lay.total || 0) - (lay.paid || 0));
  const paidSoFar = lay.paid || 0;
  const numPayments = (lay.payments || []).length;

  const changeHtml = change > 0.005
    ? `<div class="alert alert-warning fw-bold fs-5 text-center mt-2">Give change: £${change.toFixed(2)}</div>`
    : '';

  body.innerHTML = `
    <div class="text-center mb-3">
      <div style="font-size:3rem;line-height:1;">💳</div>
      <div class="fw-bold fs-4 text-success mt-1">£${paymentAmount.toFixed(2)} RECEIVED</div>
      <div class="text-muted small">${paymentMethod}</div>
    </div>
    ${changeHtml}
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Agreed Total</div>
        <div class="lay-stat-val">£${(lay.total || 0).toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Paid So Far</div>
        <div class="lay-stat-val text-success fw-bold">£${paidSoFar.toFixed(2)}</div>
      </div>
      <div class="lay-detail-stat">
        <div class="lay-stat-label">Balance Remaining</div>
        <div class="lay-stat-val ${remaining > 0 ? 'text-warning fw-bold' : 'text-success fw-bold'}">£${remaining.toFixed(2)}</div>
      </div>
    </div>
    <div class="text-muted small text-center mb-3">
      ${numPayments} payment${numPayments !== 1 ? 's' : ''} made &nbsp;·&nbsp; Expires ${formatLayawayDate(lay.expires_at)}
    </div>
    <div class="d-flex gap-2 mt-3">
      <button id="layPaymentPrintBtn" class="btn btn-outline-primary flex-grow-1">Print Receipt</button>
      <button id="layPaymentDoneBtn" class="btn btn-success flex-grow-1">Done</button>
    </div>`;

  if (overlay) overlay.style.display = 'flex';

  document.getElementById('layPaymentPrintBtn').addEventListener('click', () => {
    printLayawayReceipts(lay, paymentAmount, paymentMethod, 'payment');
  });
  document.getElementById('layPaymentDoneBtn').addEventListener('click', async () => {
    if (overlay) overlay.style.display = 'none';
    await openLayawayDetail(lay.layaway_id);
  });
}

function showLayawayCompletionScreen(lay, lastPayment, lastMethod, change) {
  const overlay = document.getElementById('layawayDetailOverlay');
  const body = document.getElementById('layawayDetailBody');
  const title = document.getElementById('layawayDetailTitle');
  const subtitle = document.getElementById('layawayDetailSubtitle');
  if (title) title.textContent = 'Layaway Complete';
  if (subtitle) subtitle.textContent = `${lay.layaway_id} — ${lay.customer_tag || ''}`;

  const payments = lay.payments || [];
  let payRows = '';
  payments.forEach(p => {
    payRows += `<tr>
      <td>${formatLayawayDate(p.paid_at)}</td>
      <td><span class="badge bg-secondary">${p.method}</span></td>
      <td class="text-end fw-semibold">£${(p.amount || 0).toFixed(2)}</td>
    </tr>`;
  });

  const changeHtml = change > 0.005
    ? `<div class="alert alert-warning fw-bold fs-5 text-center mt-3">Give change: £${change.toFixed(2)}</div>`
    : '';

  body.innerHTML = `
    <div class="text-center mb-3">
      <div style="font-size:3rem;line-height:1;">✅</div>
      <div class="fw-bold fs-4 text-success mt-1">PAID IN FULL</div>
      <div class="text-muted">${lay.customer_tag || ''}</div>
    </div>
    ${changeHtml}
    <div class="lay-detail-summary mb-3">
      <div class="lay-detail-stat"><div class="lay-stat-label">Agreed Total</div><div class="lay-stat-val">£${(lay.total || 0).toFixed(2)}</div></div>
      <div class="lay-detail-stat"><div class="lay-stat-label">Total Paid</div><div class="lay-stat-val text-success fw-bold">£${(lay.paid || 0).toFixed(2)}</div></div>
      <div class="lay-detail-stat"><div class="lay-stat-label">Balance</div><div class="lay-stat-val text-success fw-bold">£0.00</div></div>
    </div>
    <table class="table table-sm mb-3">
      <thead><tr><th>Date</th><th>Method</th><th class="text-end">Amount</th></tr></thead>
      <tbody>${payRows}</tbody>
    </table>
    <div class="d-flex gap-2 mt-3">
      <button id="layCompletePrintBtn" class="btn btn-primary flex-grow-1">Print Collection Receipt</button>
      <button id="layCompleteDoneBtn" class="btn btn-success flex-grow-1">Done</button>
    </div>`;

  if (overlay) overlay.style.display = 'flex';

  document.getElementById('layCompletePrintBtn').addEventListener('click', () => {
    printLayawayReceipts(lay, lastPayment, lastMethod, 'completed');
  });
  document.getElementById('layCompleteDoneBtn').addEventListener('click', () => {
    if (overlay) overlay.style.display = 'none';
    openLayawayStore();
  });
}


async function printLayawayReceipts(lay, paymentAmount, paymentMethod, event) {
  const balance  = Math.max(0, (lay.total || 0) - (lay.paid || 0));
  const totalAmt = (lay.total || 0).toFixed(2);
  const paidAmt  = (lay.paid  || 0).toFixed(2);
  const balAmt   = balance.toFixed(2);
  const payAmt   = paymentAmount > 0 ? paymentAmount.toFixed(2) : '0.00';

  const W    = RECEIPT_LINE_WIDTH;
  const SEP  = '-'.repeat(W);
  const SEP2 = ('- ').repeat(W >> 1).trimEnd();
  const ESC  = '\x1B';
  const BIG  = ESC + '!' + '\x30';  // double height + width
  const WIDE = ESC + '!' + '\x20';  // double width only
  const NORM = ESC + '!' + '\x00';

  // Right-align value against label, padded to receipt width
  const rpad = (label, value) => {
    const l = String(label || '');
    const v = String(value || '');
    return l + ' '.repeat(Math.max(1, W - l.length - v.length)) + v;
  };

  const itemLines = (lay.items || []).map(it => {
    const name = (it.item_name || it.item_code || '').substring(0, 26);
    const amt  = `\xA3${((it.original_rate || it.rate || 0) * (it.qty || 1)).toFixed(2)}`;
    return rpad(`  x${it.qty || 1}  ${name}`, amt);
  });

  const expiryStr   = formatLayawayDate(lay.expires_at);
  const isCompleted = event === 'completed';
  const dateStr     = formatLayawayDate(lay.created_at || new Date().toISOString());
  const todayStr    = formatLayawayDate(new Date().toISOString());

  // ── Cancellation receipt ───────────────────────────────────────────────────
  if (event === 'cancelled') {
    const payHistLines = (lay.payments || []).map(p =>
      rpad(`  ${formatLayawayDate(p.paid_at)}  ${(p.method||'').padEnd(6)}`, `\xA3${(p.amount || 0).toFixed(2)}`)
    );
    await triggerReceiptPrint({ lines: [
      SEP,
      `${BIG}LAYAWAY CANCELLED${NORM}`,
      SEP,
      rpad('Ref:', lay.layaway_id),
      rpad('Customer:', lay.customer_tag || ''),
      rpad('Date:', todayStr),
      SEP2,
      ...itemLines,
      SEP2,
      ...(payHistLines.length ? ['Payments Made:', ...payHistLines, SEP2] : []),
      rpad('Total Was:', `\xA3${totalAmt}`),
      rpad('Total Paid:', `\xA3${paidAmt}`),
      SEP2,
      paymentAmount > 0.005
        ? `${BIG}REFUND DUE: \xA3${payAmt}${NORM}`
        : 'No refund due',
      SEP,
    ], title: `Cancelled ${lay.layaway_id}` });
    return;
  }

  // ── Customer copy ──────────────────────────────────────────────────────────
  const customerLines = [
    SEP,
    `${BIG}${isCompleted ? 'LAYAWAY \u2014 PAID IN FULL' : 'LAYAWAY RECEIPT'}${NORM}`,
    SEP,
    rpad('Ref:', lay.layaway_id),
    rpad('Date:', isCompleted ? todayStr : dateStr),
    SEP2,
    ...itemLines,
    SEP2,
    rpad('Agreed Total:', `\xA3${totalAmt}`),
    paymentAmount > 0 ? rpad(`Paid Today (${paymentMethod}):`, `\xA3${payAmt}`) : null,
    rpad('Total Paid:', `\xA3${paidAmt}`),
    isCompleted
      ? `${WIDE}Balance Due:         \xA30.00${NORM}`
      : `${WIDE}${rpad('Balance Due:', `\xA3${balAmt}`)}${NORM}`,
    SEP2,
    isCompleted ? `${BIG}THANK YOU \u2014 COLLECTED${NORM}` : rpad('Expires:', expiryStr),
    !isCompleted ? rpad('Barcode:', lay.layaway_id) : null,
    SEP,
  ].filter(l => l != null);

  // ── Store copy ─────────────────────────────────────────────────────────────
  const storeCopyLines = [
    SEP,
    `${BIG}${isCompleted ? 'STORE \u2014 COLLECTED' : 'LAYAWAY \u2014 STORE COPY'}${NORM}`,
    SEP,
    rpad('Ref:', lay.layaway_id),
    rpad('Customer:', lay.customer_tag || ''),
    rpad('Date:', isCompleted ? todayStr : dateStr),
    SEP2,
    ...itemLines,
    SEP2,
    rpad('Agreed Total:', `\xA3${totalAmt}`),
    paymentAmount > 0 ? rpad(`Paid Today (${paymentMethod}):`, `\xA3${payAmt}`) : null,
    rpad('Total Paid:', `\xA3${paidAmt}`),
    isCompleted
      ? `${WIDE}Balance Due:         \xA30.00${NORM}`
      : `${WIDE}${rpad('Balance Due:', `\xA3${balAmt}`)}${NORM}`,
    !isCompleted ? rpad('Expires:', expiryStr) : null,
    SEP,
  ].filter(l => l != null);

  // ── Collection: store note + customer receipt + store copy ─────────────────
  if (isCompleted) {
    const payHistLines = (lay.payments || []).map(p =>
      rpad(`  ${formatLayawayDate(p.paid_at)}  ${(p.method||'').padEnd(6)}`, `\xA3${(p.amount || 0).toFixed(2)}`)
    );
    const collectionLines = [
      SEP,
      `${BIG}LAYAWAY \u2014 COLLECTED${NORM}`,
      SEP,
      rpad('Ref:', lay.layaway_id),
      rpad('Customer:', lay.customer_tag || ''),
      rpad('Date:', todayStr),
      SEP2,
      ...itemLines,
      SEP2,
      'Payment History:',
      ...payHistLines,
      SEP2,
      rpad('Agreed Total:', `\xA3${totalAmt}`),
      `${WIDE}${rpad('TOTAL PAID:', `\xA3${paidAmt}`)}${NORM}`,
      paymentAmount > 0 ? rpad(`Last Payment (${paymentMethod}):`, `\xA3${payAmt}`) : null,
      SEP,
      `${BIG}THANK YOU \u2014 COLLECTED${NORM}`,
      SEP,
    ].filter(l => l != null);
    await triggerReceiptPrint({ lines: collectionLines, title: `Collected ${lay.layaway_id}` });
    await triggerReceiptPrint({ lines: customerLines,   title: `Receipt ${lay.layaway_id}` });
    await triggerReceiptPrint({ lines: storeCopyLines,  title: `Store Copy ${lay.layaway_id}` });
    return;
  }

  // ── Deposit / instalment ───────────────────────────────────────────────────
  await triggerReceiptPrint({ lines: customerLines,  title: `Layaway ${lay.layaway_id}` });
  await triggerReceiptPrint({ lines: storeCopyLines, title: `Store Copy ${lay.layaway_id}` });
}

async function triggerReceiptPrint(payload) {
  const rawText = (payload.lines || []).join('\n');
  const text = decorateWithReceiptLayout(rawText);
  const label = payload.title || 'Receipt';
  if (receiptAgentClient && receiptAgentClient.isReady()) {
    try {
      // Send text and cut in one request so the cut is guaranteed to follow the text
      await sendTextToReceiptAgent(text, { line_feeds: 5, cut: true });
      console.log(`[layaway] Printed: ${label}`);
    } catch (e) {
      console.warn(`[layaway] Print failed (${label}):`, e.message);
      showBarcodeFeedback(`Print failed: ${e.message}`, true);
    }
  } else {
    console.warn('[layaway] Receipt agent not configured — print skipped');
    showBarcodeFeedback('Receipt agent not configured', true);
  }
}
