/* ============================================================
   Salmon — single, client-agnostic frontend (app.js)
   ------------------------------------------------------------
   This file is IDENTICAL for every client. Per-client values live
   in configs/<id>.js and the active client is chosen by the URL
   query param (?client=<id>).

   Home screen = a grid of square buttons (Продать, Купить, Касса,
   Склад, Дашборды). Each opens a module screen. The backend stays
   the source of truth (catalog, validation, saved totals, formatted
   read data); the client handles the interactive cart UX.
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   Tiny DOM/utility helpers
------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const qsParam = (name) => new URLSearchParams(location.search).get(name);

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' toast--' + type : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function status(el, msg, kind) {
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = 'status ' + (kind || 'info');
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Parse a user-typed number that may use a comma decimal ("12,5" → 12.5).
function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/\s/g, ''));
  return isFinite(n) ? n : 0;
}

// Currency symbol comes from the backend (Tajikistan somoni by default).
const cur = () => (state.session && state.session.currency) || 'смн';

// "1234.5" → "1 234,50"  (thousands joined by a non-breaking space so a
// money value never wraps mid-number inside narrow summary chips).
function money(n) {
  n = Number(n) || 0;
  const p = n.toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return p[0] + ',' + p[1];
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------
   Module catalogue (the home buttons). `full` = full-width row.
------------------------------------------------------------- */
const MODULES = {
  sell:  { label: 'Продать',  icon: '🛒', full: false },
  buy:   { label: 'Купить',   icon: '📦', full: false },
  cash:  { label: 'Касса',    icon: '💰', full: false },
  stock: { label: 'Склад',    icon: '🏷️', full: false },
  dash:  { label: 'Дашборды', icon: '📊', full: true }
};
const MODULE_ORDER = ['sell', 'buy', 'cash', 'stock', 'dash'];

// Single-colour line icons (inherit the tab colour) — consistent with the
// theme, unlike the multicolour emoji that ignored the active state.
const SVG = (paths) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
const MODULE_ICONS = {
  sell:  SVG('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
  buy:   SVG('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/>'),
  cash:  SVG('<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>'),
  stock: SVG('<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  dash:  SVG('<line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="10"/>')
};

/* ------------------------------------------------------------
   Global state
------------------------------------------------------------- */
const state = {
  clientId: null,   // from ?client=
  config: null,     // resolved config object from configs/<id>.js
  session: null,    // whoami: {role, modules, currency}
  catalog: null,    // {products, payments, suppliers}
  cart: { sell: [], buy: [] },
  reloadData: null,         // re-fetch fn for the active data screen
  installAvailable: false,  // PWA install offer (mobile, not yet installed)
  payments: [],             // available payment/currency options (from catalog)
  payment: null,            // currently selected one (set via the header switcher)
  debtors: []               // clients with outstanding debt (for «Погашение кредита»)
};

const paymentKey = () => 'salmon_payment_' + state.clientId;   // remembered payment/currency choice

const tokenKey = () => 'salmon_token_' + state.clientId;       // active session token (drives auto-login)
const getToken = () => localStorage.getItem(tokenKey()) || '';
const setToken = (t) => localStorage.setItem(tokenKey(), t);
const clearToken = () => localStorage.removeItem(tokenKey());

// Last successfully-used token, kept even after logout so the login field
// can pre-fill it → one tap to sign back in (no retyping).
const rememberKey = () => 'salmon_lasttoken_' + state.clientId;
const getRemembered = () => localStorage.getItem(rememberKey()) || '';
const setRemembered = (t) => localStorage.setItem(rememberKey(), t);

/* ============================================================
   1. CLIENT CONFIG LOADING (multi-tenant)
============================================================ */
window.registerClient = function (cfg) { window.__CLIENT__ = cfg; };

function loadClientConfig(id) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'configs/' + id + '.js';
    s.onload = () => resolve(window.__CLIENT__);
    s.onerror = () => reject(new Error('no-config'));
    document.head.appendChild(s);
  });
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.bg)      root.setProperty('--bg', theme.bg);
  if (theme.accent)  root.setProperty('--accent', theme.accent);
  if (theme.accent2) root.setProperty('--accent-2', theme.accent2);
  if (theme.accent)  $('themeColorMeta').setAttribute('content', theme.accent);
}

function applyManifest(cfg) {
  // The manifest is served from a blob: URL, so every path inside it MUST
  // be absolute. Relative paths would resolve against the blob URL
  // (blob:…/uuid) instead of the site, breaking icon/start_url resolution —
  // which silently disables Chrome's "Install" prompt on Android/desktop.
  const abs = (path) => new URL(path, location.href).href;
  const manifest = {
    id: abs('./?client=' + cfg.id),        // stable per-client app identity
    name: cfg.name,
    short_name: cfg.name,
    description: 'Складской учёт и продажи',
    lang: 'ru',
    start_url: abs('./?client=' + cfg.id),
    scope: abs('./'),
    display: 'standalone',
    orientation: 'portrait',
    background_color: (cfg.theme && cfg.theme.bg) || '#0f172a',
    theme_color: (cfg.theme && cfg.theme.accent) || '#0f766e',
    icons: [
      { src: abs('icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: abs('icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: abs('icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: abs('icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  $('manifestLink').href = URL.createObjectURL(blob);
}

/* ============================================================
   2. NETWORK LAYER (CORS-safe for Apps Script)
============================================================ */
async function apiGet(action, extra = {}) {
  const params = new URLSearchParams({ token: getToken(), action, ...extra });
  const res = await fetch(state.config.apiUrl + '?' + params.toString(), { method: 'GET' });
  return parseResponse(res);
}

async function apiPost(action, payload = {}) {
  const res = await fetch(state.config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: getToken(), action, ...payload })
  });
  return parseResponse(res);
}

async function parseResponse(res) {
  let data;
  try { data = JSON.parse(await res.text()); }
  catch (e) { throw new Error('Пустой или некорректный ответ сервера.'); }
  if (data && data.error) {
    if (data.error === 'unauthorized') throw new Error('Неверный токен.');
    if (data.error === 'forbidden')    throw new Error('Недостаточно прав для этого действия.');
    throw new Error(data.message || data.error);
  }
  return data;
}

function describeError(err) {
  if (err instanceof TypeError) return 'Нет сети или сервер недоступен.';
  return err.message || 'Неизвестная ошибка.';
}

/* ============================================================
   3. SCREEN NAVIGATION
============================================================ */
const ALL_SCREENS = ['fatalScreen', 'loginScreen', 'sellScreen', 'buyScreen', 'dataScreen'];

function hideScreens() { ALL_SCREENS.forEach(id => { $(id).hidden = true; }); }

function showFatal(text) {
  $('topbar').hidden = true;
  $('tabbar').hidden = true;
  hideScreens();
  $('fatalText').textContent = text;
  $('fatalScreen').hidden = false;
}

function showLogin() {
  $('topbar').hidden = true;
  $('tabbar').hidden = true;
  $('btnPayment').hidden = true;
  closePayMenu();
  hideScreens();
  $('loginScreen').hidden = false;
  // Pre-fill the last-used token so the user can sign in with one tap.
  $('tokenInput').value = getRemembered();
  refreshInstallBtn();
}

// Show a single module screen. The header "Оплатить" button is only
// meaningful where there's a cart to submit (Продать / Купить).
function showScreen(id, title) {
  hideScreens();
  $('topbar').hidden = false;
  $(id).hidden = false;
  $('btnHeaderPay').hidden = !(id === 'sellScreen' || id === 'buyScreen');
  refreshInstallBtn();
}

// The install affordance is shown ONLY on the login screen, and only when an
// install is actually available (mobile, not already installed).
function refreshInstallBtn() {
  const onLogin = !$('loginScreen').hidden;
  $('btnInstall').hidden = !(state.installAvailable && onLogin);
}

/* ============================================================
   4. BOTTOM TAB BAR (primary navigation)
============================================================ */
function renderTabs(session) {
  // Header shows the user's name (falls back to role); trimmed to 9 chars + …
  const who = (session.name || session.role || '').trim();
  const user = $('topUser');
  user.textContent = who.length > 9 ? who.slice(0, 9) + '…' : who;
  user.title = who;

  const allowed = (session.modules || []).filter(k => MODULES[k]);
  const bar = $('tabbar');
  bar.innerHTML = '';
  MODULE_ORDER.filter(k => allowed.indexOf(k) !== -1).forEach(k => {
    const m = MODULES[k];
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.key = k;
    b.innerHTML = '<span class="tab__icon">' + (MODULE_ICONS[k] || m.icon) + '</span>' +
                  '<span class="tab__label">' + escapeHtml(m.label) + '</span>';
    b.addEventListener('click', () => activate(k));
    bar.appendChild(b);
  });
  bar.hidden = allowed.length === 0;
  return allowed;
}

// Switch to a module: highlight its tab and open its screen.
function activate(key) {
  state.activeTab = key;
  $('tabbar').querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('tab--active', t.dataset.key === key);
  });
  switch (key) {
    case 'sell':  return openSell();
    case 'buy':   return openBuy();
    case 'cash':  return openData('cash',  'Касса',    fetchCash);
    case 'stock': return openData('stock', 'Склад',    fetchStock);
    case 'dash':  return openData('dash',  'Дашборды', fetchDashboard);
  }
}

/* ============================================================
   5. CATALOG (shared by Продать / Купить)
============================================================ */
async function ensureCatalog() {
  if (state.catalog) return state.catalog;
  const resp = await apiGet('catalog');
  state.catalog = resp.catalog || { products: [], payments: [], suppliers: [], clients: [] };
  return state.catalog;
}

function fillSelect(sel, values, fallback) {
  sel.innerHTML = '';
  (values && values.length ? values : (fallback || [])).forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

/* ------------------------------------------------------------
   PAYMENT / CURRENCY SWITCHER (in the header)
   Chosen once from the top bar instead of a select at the bottom of
   every sale/purchase. Options come from the catalog (the Excel
   reference); the choice is remembered per client.
------------------------------------------------------------- */
function buildPaymentMenu(payments) {
  state.payments = (payments && payments.length) ? payments : ['Касса', 'В долг'];
  const stored = localStorage.getItem(paymentKey());
  if (!state.payment || state.payments.indexOf(state.payment) === -1) {
    state.payment = (stored && state.payments.indexOf(stored) !== -1) ? stored : state.payments[0];
  }
  renderPaymentMenu();
  $('payLabel').textContent = state.payment;
  $('btnPayment').hidden = false;
}

function renderPaymentMenu() {
  const menu = $('payMenu');
  menu.innerHTML = state.payments.map(p =>
    '<button type="button" class="menu__item' + (p === state.payment ? ' menu__item--on' : '') +
    '" data-pay="' + escapeHtml(p) + '">' + escapeHtml(p) + '</button>'
  ).join('');
  menu.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    state.payment = b.dataset.pay;
    localStorage.setItem(paymentKey(), state.payment);
    $('payLabel').textContent = state.payment;
    renderPaymentMenu();
    closePayMenu();
    if (!$('sellScreen').hidden) updateSellClientUI();
    toast('Оплата: ' + state.payment, 'ok');
  });
}

function closePayMenu() { $('payMenu').hidden = true; }

// A payment counts as "credit" (sale on debt) when its name says so. The
// credit option in the Excel reference must be named like «В долг»/«Кредит».
function isCreditPayment(p) { return /долг|кредит|credit/i.test(p || ''); }

// Reflect on the Продать screen whether a client is required right now
// (only for credit payments). The actual block happens on submit.
function updateSellClientUI() {
  const credit = isCreditPayment(state.payment);
  const inp = $('sellClient');
  inp.placeholder = credit ? 'Клиент (обязателен для долга)' : 'Розничный покупатель';
  inp.classList.toggle('field--required', credit);
}

// Filter products by barcode/article/name. Returns up to `limit` matches.
function searchProducts(q, limit) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const p of state.catalog.products) {
    if (p.sku.toLowerCase().indexOf(q) !== -1 ||
        p.name.toLowerCase().indexOf(q) !== -1) {
      out.push(p);
      if (out.length >= (limit || 8)) break;
    }
  }
  return out;
}

function exactProduct(q) {
  q = q.trim().toLowerCase();
  return state.catalog.products.find(p => p.sku.toLowerCase() === q) || null;
}

function renderResults(box, list, onPick) {
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = list.map((p, i) =>
    '<button class="result" data-i="' + i + '">' +
      '<span class="result__name">' + escapeHtml(p.name) + '</span>' +
      '<span class="result__meta">' + escapeHtml(p.sku) +
        ' · ' + money(p.price) + ' ' + cur() +
        ' · ост: ' + p.stock + '</span>' +
    '</button>'
  ).join('');
  box.hidden = false;
  box.querySelectorAll('.result').forEach(btn => {
    btn.addEventListener('click', () => onPick(list[+btn.dataset.i]));
  });
}

/* ============================================================
   6. ПРОДАТЬ
============================================================ */
function openSell() {
  showScreen('sellScreen', 'Продать');
  status($('sellStatus'), '', '');
  ensureCatalog()
    .then(cat => {
      buildPaymentMenu(cat.payments);
      $('clientList').innerHTML = (cat.clients || [])
        .map(c => '<option value="' + escapeHtml(c.name) + '">').join('');
      updateSellClientUI();
      renderSellCart();
      const s = $('sellSearch');
      s.value = '';
      $('sellResults').hidden = true;
      setTimeout(() => s.focus(), 50);
    })
    .catch(err => toast(describeError(err), 'err'));
}

function onSellSearch() {
  const q = $('sellSearch').value;
  renderResults($('sellResults'), searchProducts(q, 8), p => addToCart('sell', p));
}

function onSellEnter() {
  const q = $('sellSearch').value.trim();
  if (!q) return;
  const exact = exactProduct(q) || (searchProducts(q, 2).length === 1 ? searchProducts(q, 1)[0] : null);
  if (exact) addToCart('sell', exact);
  else toast('Товар не найден', 'err');
}

const qtyStr = (n) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));

function renderSellCart() {
  const cart = state.cart.sell;
  const box = $('sellCart');
  $('sellCount').textContent = String(cart.length);

  if (!cart.length) {
    box.innerHTML = '<div class="row-item__empty">Корзина пуста — найдите товар выше</div>';
  } else {
    box.innerHTML = cart.map((it, i) =>
      '<div class="cart-row">' +
        '<div class="cart-row__top">' +
          '<span class="cart-row__name">' + escapeHtml(it.name) + '</span>' +
          '<button class="cart-row__del" data-del="' + i + '" type="button" aria-label="Удалить">×</button>' +
        '</div>' +
        '<div class="cart-row__controls">' +
          stepperHTML(i, it.qty) +
          priceFieldHTML('price', i, it.price, 'Цена') +
          '<span class="cart-row__sum" data-sum="' + i + '">' + money(it.qty * it.price) + '</span>' +
        '</div>' +
      '</div>'
    ).join('');
    bindCart('sell');
  }
  $('sellTotal').textContent = money(cartTotal('sell')) + ' ' + cur();
}

function cartTotal(kind) {
  if (kind === 'sell') return state.cart.sell.reduce((s, i) => s + i.qty * i.price, 0);
  return state.cart.buy.reduce((s, i) => s + i.qty * i.costPrice, 0);
}

/* ------------------------------------------------------------
   ADD TO CART + INLINE EDITING (shared by Продать / Купить)
   One tap on a search result (or Enter on an exact match) adds the
   item immediately: qty 1, prices pulled from the catalog. Quantity
   and price are then edited right inside the cart row — no separate
   panel, no second step, no hunting for the line afterwards. Tapping
   the same product again just bumps its quantity by one.
------------------------------------------------------------- */
function addToCart(kind, product) {
  const cart = state.cart[kind];
  const ex = cart.findIndex(i => i.sku === product.sku);
  if (ex >= 0) {
    cart[ex].qty = num(cart[ex].qty) + 1;            // already in cart → +1
  } else if (kind === 'sell') {
    cart.push({ sku: product.sku, name: product.name, unit: product.unit,
                stock: product.stock, qty: 1, price: num(product.price) });
  } else {
    cart.push({ sku: product.sku, name: product.name, unit: product.unit, stock: product.stock,
                qty: 1, costPrice: num(product.cost), salePrice: num(product.price) });
  }
  // Clear the search and keep focus there so the next item is one tap away.
  const s = $(kind === 'sell' ? 'sellSearch' : 'buySearch');
  s.value = '';
  $(kind === 'sell' ? 'sellResults' : 'buyResults').hidden = true;
  if (kind === 'sell') renderSellCart(); else renderBuyCart();
  s.focus();
}

// Compact qty stepper (− [n] +). Empty price stays empty: no stray "0" to clear.
function stepperHTML(i, qty) {
  return '<div class="stepper">' +
    '<button type="button" data-dec="' + i + '" aria-label="Меньше">−</button>' +
    '<input class="stepper__val" data-qty="' + i + '" inputmode="decimal" value="' + qtyStr(qty) + '">' +
    '<button type="button" data-inc="' + i + '" aria-label="Больше">+</button>' +
  '</div>';
}

function priceFieldHTML(attr, i, val, label) {
  return '<label class="price-field">' +
    '<span class="price-field__lbl">' + label + '</span>' +
    '<input class="price-field__inp" data-' + attr + '="' + i + '" inputmode="decimal" value="' +
      (val ? val : '') + '">' +
  '</label>';
}

// Wire inline controls for the rendered cart of `kind`. Qty/price typing
// updates the line sum and grand total live (no re-render → focus is kept);
// the +/−/delete buttons re-render the whole cart.
function bindCart(kind) {
  const isSell = kind === 'sell';
  const box = $(isSell ? 'sellCart' : 'buyCart');
  const cart = state.cart[kind];
  const renderAll = isSell ? renderSellCart : renderBuyCart;

  const refresh = (i) => {
    const it = cart[i];
    const unit = isSell ? it.price : it.costPrice;
    const sumEl = box.querySelector('[data-sum="' + i + '"]');
    if (sumEl) sumEl.textContent = money(num(it.qty) * num(unit));
    $(isSell ? 'sellTotal' : 'buyTotal').textContent = money(cartTotal(kind)) + ' ' + cur();
  };

  box.querySelectorAll('[data-del]').forEach(b => b.onclick =
    () => { cart.splice(+b.dataset.del, 1); renderAll(); });
  box.querySelectorAll('[data-dec]').forEach(b => b.onclick =
    () => { const i = +b.dataset.dec; cart[i].qty = Math.max(1, num(cart[i].qty) - 1); renderAll(); });
  box.querySelectorAll('[data-inc]').forEach(b => b.onclick =
    () => { const i = +b.dataset.inc; cart[i].qty = num(cart[i].qty) + 1; renderAll(); });
  box.querySelectorAll('[data-qty]').forEach(inp => inp.oninput =
    () => { const i = +inp.dataset.qty; cart[i].qty = Math.max(0, num(inp.value)); refresh(i); });

  if (isSell) {
    box.querySelectorAll('[data-price]').forEach(inp => inp.oninput =
      () => { const i = +inp.dataset.price; cart[i].price = Math.max(0, num(inp.value)); refresh(i); });
  } else {
    box.querySelectorAll('[data-cost]').forEach(inp => inp.oninput =
      () => { const i = +inp.dataset.cost; cart[i].costPrice = Math.max(0, num(inp.value)); refresh(i); });
    box.querySelectorAll('[data-sale]').forEach(inp => inp.oninput =
      () => { const i = +inp.dataset.sale; cart[i].salePrice = Math.max(0, num(inp.value)); });
  }
}

async function submitSell() {
  const cart = state.cart.sell;
  if (!cart.length) { toast('Корзина пуста', 'err'); return; }
  const client = $('sellClient').value.trim();
  if (isCreditPayment(state.payment) && !client) {
    status($('sellStatus'), 'Для оплаты «' + state.payment + '» выберите клиента — на него оформится долг.', 'err');
    toast('Укажите клиента для долга', 'err');
    return;
  }
  const btn = $('btnSellSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Сохранение…';
  status($('sellStatus'), '', '');
  try {
    const rows = cart.map(i => ({
      date: todayISO(), sku: i.sku, qty: i.qty, price: i.price,
      client: client,
      payment: state.payment || ''
    }));
    const resp = await apiPost('createSales', { rows });
    state.cart.sell = [];
    $('sellClient').value = '';
    renderSellCart();
    status($('sellStatus'), resp.message || 'Сохранено ✓', 'ok');
    toast('Продажа сохранена', 'ok');
  } catch (err) {
    status($('sellStatus'), describeError(err), 'err');
    toast('Ошибка', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить продажу';
  }
}

/* ============================================================
   7. КУПИТЬ (приход)
============================================================ */
function openBuy() {
  showScreen('buyScreen', 'Купить');
  status($('buyStatus'), '', '');
  ensureCatalog()
    .then(cat => {
      buildPaymentMenu(cat.payments);
      $('supplierList').innerHTML = (cat.suppliers || [])
        .map(s => '<option value="' + escapeHtml(s) + '">').join('');
      renderBuyCart();
      const s = $('buySearch');
      s.value = '';
      $('buyResults').hidden = true;
      setTimeout(() => s.focus(), 50);
    })
    .catch(err => toast(describeError(err), 'err'));
}

function onBuySearch() {
  renderResults($('buyResults'), searchProducts($('buySearch').value, 8), p => addToCart('buy', p));
}
function onBuyEnter() {
  const q = $('buySearch').value.trim();
  if (!q) return;
  const exact = exactProduct(q) || (searchProducts(q, 2).length === 1 ? searchProducts(q, 1)[0] : null);
  if (exact) addToCart('buy', exact); else toast('Товар не найден', 'err');
}

function renderBuyCart() {
  const cart = state.cart.buy;
  const box = $('buyCart');
  $('buyCount').textContent = String(cart.length);

  if (!cart.length) {
    box.innerHTML = '<div class="row-item__empty">Пусто — найдите товар выше</div>';
  } else {
    box.innerHTML = cart.map((it, i) =>
      '<div class="cart-row">' +
        '<div class="cart-row__top">' +
          '<span class="cart-row__name">' + escapeHtml(it.name) + '</span>' +
          '<button class="cart-row__del" data-del="' + i + '" type="button" aria-label="Удалить">×</button>' +
        '</div>' +
        '<div class="cart-row__controls">' +
          stepperHTML(i, it.qty) +
          '<span class="cart-row__sum" data-sum="' + i + '">' + money(it.qty * it.costPrice) + '</span>' +
        '</div>' +
        '<div class="cart-row__prices">' +
          priceFieldHTML('cost', i, it.costPrice, 'Цена прихода') +
          priceFieldHTML('sale', i, it.salePrice, 'Цена продажи') +
        '</div>' +
      '</div>'
    ).join('');
    bindCart('buy');
  }
  $('buyTotal').textContent = money(cartTotal('buy')) + ' ' + cur();
}

async function submitBuy() {
  const cart = state.cart.buy;
  if (!cart.length) { toast('Пусто', 'err'); return; }
  const btn = $('btnBuySubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Сохранение…';
  status($('buyStatus'), '', '');
  try {
    const rows = cart.map(i => ({
      date: todayISO(), sku: i.sku, qty: i.qty,
      costPrice: i.costPrice, salePrice: i.salePrice,
      supplier: $('buySupplier').value.trim(),
      payment: state.payment || ''
    }));
    const resp = await apiPost('createPurchases', { rows });
    state.cart.buy = [];
    renderBuyCart();
    state.catalog = null;   // stock/prices changed → refresh catalog next open
    status($('buyStatus'), resp.message || 'Сохранено ✓', 'ok');
    toast('Приход сохранён', 'ok');
  } catch (err) {
    status($('buyStatus'), describeError(err), 'err');
    toast('Ошибка', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить приход';
  }
}

/* ============================================================
   8. DATA SCREENS — Касса / Склад / Дашборды
============================================================ */
function openData(key, title, fetcher) {
  showScreen('dataScreen', title);
  $('dataTitle').textContent = title;
  state.reloadData = fetcher;
  // Касса gets the «Погашение кредита» tool; other data screens hide it.
  if (key === 'cash') {
    renderCashTools();
  } else {
    $('dataTools').hidden = true;
    $('dataTools').innerHTML = '';
  }
  fetcher();
}

/* ------------------------------------------------------------
   ПОГАШЕНИЕ КРЕДИТА (операция в Кассе → ПКО)
   Выбираем клиента-должника (с остатком долга), вводим сумму,
   оформляем приходный кассовый ордер. Долг уменьшается на бэкенде.
------------------------------------------------------------- */
function renderCashTools() {
  const box = $('dataTools');
  box.hidden = false;
  box.innerHTML =
    '<button class="btn btn--soft" id="btnRepayToggle" type="button">💸 Погашение кредита</button>' +
    '<div id="repayForm" class="repay" hidden>' +
      '<label class="field"><span class="field__label">Клиент (должник)</span>' +
        '<input type="text" id="repayClient" list="debtorList" autocomplete="off" placeholder="Выберите должника"></label>' +
      '<datalist id="debtorList"></datalist>' +
      '<p class="muted small repay__debt" id="repayDebt" hidden></p>' +
      '<label class="field"><span class="field__label">Сумма погашения</span>' +
        '<input type="text" id="repayAmount" inputmode="decimal" placeholder="Сумма"></label>' +
      '<button class="btn btn--primary" id="btnRepaySubmit" type="button">Оформить ПКО</button>' +
      '<p class="status" id="repayStatus" hidden></p>' +
    '</div>';

  ensureCatalog().then(cat => {
    state.debtors = (cat.clients || []).filter(c => num(c.debt) > 0);
    $('debtorList').innerHTML = state.debtors
      .map(c => '<option value="' + escapeHtml(c.name) + '">долг ' + money(c.debt) + ' ' + cur() + '</option>')
      .join('');
  }).catch(() => {});

  $('btnRepayToggle').onclick = () => { $('repayForm').hidden = !$('repayForm').hidden; };
  $('repayClient').oninput = () => {
    const c = (state.debtors || []).find(d => d.name === $('repayClient').value.trim());
    const el = $('repayDebt');
    if (c) {
      el.textContent = 'Остаток долга: ' + money(c.debt) + ' ' + cur();
      el.hidden = false;
      if (!$('repayAmount').value) $('repayAmount').value = c.debt;   // default = full debt
    } else {
      el.hidden = true;
    }
  };
  $('btnRepaySubmit').onclick = submitRepay;
}

async function submitRepay() {
  const client = $('repayClient').value.trim();
  const amount = Math.max(0, num($('repayAmount').value));
  if (!client)        { status($('repayStatus'), 'Выберите клиента-должника.', 'err'); return; }
  if (!(amount > 0))  { status($('repayStatus'), 'Введите сумму погашения.', 'err'); return; }

  const btn = $('btnRepaySubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Оформление…';
  status($('repayStatus'), '', '');
  try {
    const resp = await apiPost('createRepayment',
      { date: todayISO(), client: client, amount: amount, payment: state.payment || '' });
    status($('repayStatus'), resp.message || 'ПКО оформлен ✓', 'ok');
    toast('Погашение оформлено', 'ok');
    state.catalog = null;                       // долги изменились → обновить каталог
    $('repayClient').value = '';
    $('repayAmount').value = '';
    $('repayDebt').hidden = true;
    if (state.reloadData) state.reloadData();    // перезагрузить кассу
  } catch (err) {
    status($('repayStatus'), describeError(err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Оформить ПКО';
  }
}

async function fetchInto(promise, renderer) {
  status($('dataStatus'), '', '');
  $('dataSummary').hidden = true;
  $('dataList').innerHTML = '<div class="row-item__empty"><span class="spin spin--dark"></span> Загрузка…</div>';
  try {
    renderer(await promise);
  } catch (err) {
    $('dataList').innerHTML = '';
    status($('dataStatus'), describeError(err), 'err');
  }
}

const fetchCash  = () => fetchInto(apiGet('cash'),      r => renderList(r.cash));
const fetchStock = () => fetchInto(apiGet('stock'),     r => renderList(r.stock));
const fetchDashboard = () => fetchInto(apiGet('dashboard'), r => renderDashboard(r.dashboard));

function renderSummary(summary) {
  const box = $('dataSummary');
  if (summary && summary.length) {
    box.innerHTML = summary.map(s =>
      '<div class="summary__item"><span class="summary__val">' + escapeHtml(s.value) +
      '</span><span class="summary__lbl">' + escapeHtml(s.label) + '</span></div>'
    ).join('');
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

// Generic list (cash / stock): {items:[{title,meta[],amount,status?}], summary:[]}
function renderList(data) {
  renderSummary(data && data.summary);
  const items = (data && data.items) || [];
  const box = $('dataList');
  if (!items.length) { box.innerHTML = '<div class="row-item__empty">Пока нет данных</div>'; return; }
  box.innerHTML = items.map(it => {
    const meta = (it.meta || []).map(m => '<span>' + escapeHtml(m) + '</span>').join('');
    const statusCls = it.status === 'Нет в наличии' ? ' amount--danger'
                    : it.status === 'Мало' ? ' amount--warn' : '';
    return '<div class="row-item"><div class="row-item__head">' +
           '<span class="row-item__name">' + escapeHtml(it.title || '') + '</span>' +
           '<span class="row-item__sum' + statusCls + '">' + escapeHtml(it.amount || '') + '</span></div>' +
           (meta ? '<div class="row-item__meta">' + meta + '</div>' : '') + '</div>';
  }).join('');
}

// Dashboard: {sections:[{title, items:[{label,value}]}]}
function renderDashboard(dash) {
  renderSummary(null);
  const sections = (dash && dash.sections) || [];
  const box = $('dataList');
  if (!sections.length) { box.innerHTML = '<div class="row-item__empty">Нет данных</div>'; return; }
  box.innerHTML = sections.map(sec =>
    '<div class="dash-section">' +
      '<div class="dash-section__title">' + escapeHtml(sec.title) + '</div>' +
      sec.items.map(it =>
        '<div class="dash-row"><span>' + escapeHtml(it.label) + '</span>' +
        '<b>' + escapeHtml(it.value) + '</b></div>'
      ).join('') +
    '</div>'
  ).join('');
}

/* ============================================================
   9. LOGIN / LOGOUT
============================================================ */
// Build the tab bar and open the first allowed section. Guards against an
// out-of-date backend that doesn't yet return `modules`.
function enterApp(session) {
  const allowed = renderTabs(session);
  if (!allowed.length) {
    showFatal('Сервер вернул устаревший ответ (нет разделов). Обновите код Apps Script: ' +
              'Deploy → Manage deployments → New version.');
    return false;
  }
  activate(allowed[0]);
  return true;
}

async function doLogin() {
  const token = $('tokenInput').value.trim();
  const btn = $('btnLogin');
  status($('loginError'), '', '');
  if (!token) { status($('loginError'), 'Введите токен.', 'err'); return; }

  setToken(token);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Проверка…';
  try {
    const session = await apiGet('whoami');
    state.session = session;
    setRemembered(token);   // remember for next time (pre-fill the login field)
    if (enterApp(session)) toast('Вы вошли как ' + session.role, 'ok');
  } catch (err) {
    clearToken();
    status($('loginError'), describeError(err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

function doLogout() {
  clearToken();
  state.session = null;
  state.catalog = null;
  state.cart = { sell: [], buy: [] };
  showLogin();
  toast('Вы вышли');
}

/* ============================================================
   10. PWA INSTALL PROMPT
============================================================ */
let deferredInstall = null;

function setupInstallPrompt() {
  const btn = $('btnInstall');
  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;

  // Already installed → nothing to offer.
  if (isStandalone) return;

  // iOS Safari has no install prompt API — offer a manual hint (phone only).
  if (isIOS) {
    state.installAvailable = true;
    refreshInstallBtn();
    btn.addEventListener('click', () => {
      toast('Нажмите «Поделиться» внизу Safari → «На экран Домой»', 'ok');
    });
    return;
  }

  // Android Chrome: real prompt. Desktop: never offered.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (isAndroid) { state.installAvailable = true; refreshInstallBtn(); }
  });
  btn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    state.installAvailable = false;
    refreshInstallBtn();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    state.installAvailable = false;
    refreshInstallBtn();
    toast('Приложение установлено', 'ok');
  });
}

/* ============================================================
   11. BOOTSTRAP
============================================================ */
async function init() {
  // Static controls
  $('btnLogin').addEventListener('click', doLogin);
  $('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', doLogout);

  // Show/hide token (eye toggle). Inline SVG → renders on every device
  // (the 👁 emoji is invisible on some Android builds).
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const eyeBtn = $('btnToggleToken');
  eyeBtn.innerHTML = EYE;
  eyeBtn.addEventListener('click', () => {
    const inp = $('tokenInput');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    eyeBtn.innerHTML = show ? EYE_OFF : EYE;
    eyeBtn.setAttribute('aria-label', show ? 'Скрыть токен' : 'Показать токен');
    inp.focus();
  });

  $('sellSearch').addEventListener('input', onSellSearch);
  $('sellSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onSellEnter(); } });
  $('btnSellSubmit').addEventListener('click', submitSell);

  $('buySearch').addEventListener('input', onBuySearch);
  $('buySearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onBuyEnter(); } });
  $('btnBuySubmit').addEventListener('click', submitBuy);

  // Header "Оплатить" — submits the cart of whichever action screen is open.
  $('btnHeaderPay').addEventListener('click', () => {
    if (state.activeTab === 'sell') submitSell();
    else if (state.activeTab === 'buy') submitBuy();
  });

  $('btnReload').addEventListener('click', () => { if (state.reloadData) state.reloadData(); });

  // Header payment/currency switcher: toggle on tap, close on outside tap.
  $('btnPayment').addEventListener('click', (e) => {
    e.stopPropagation();
    $('payMenu').hidden = !$('payMenu').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!$('payMenu').hidden && !e.target.closest('.paywrap')) closePayMenu();
  });

  setupInstallPrompt();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch(() => {});
  }

  // 1. Resolve the active client from the URL.
  state.clientId = (qsParam('client') || '').trim();
  if (!state.clientId) {
    return showFatal('Откройте ссылку с параметром клиента, например: …/?client=salmon');
  }

  // 2. Load its public config.
  try {
    const cfg = await loadClientConfig(state.clientId);
    if (!cfg || cfg.id !== state.clientId || !cfg.apiUrl) throw new Error('bad-config');
    state.config = cfg;
  } catch (e) {
    return showFatal('Неизвестный клиент: «' + state.clientId + '». Проверьте ссылку.');
  }

  // 3. Apply per-client look & PWA identity.
  applyTheme(state.config.theme);
  applyManifest(state.config);
  $('loginClientName').textContent = state.config.name;
  document.title = state.config.name + ' — Salmon';

  // 4. Auto-login if a token for THIS client is stored.
  if (getToken()) {
    try {
      const session = await apiGet('whoami');
      state.session = session;
      enterApp(session);
    } catch (e) {
      clearToken();
      showLogin();
    }
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
