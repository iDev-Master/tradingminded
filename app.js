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

/* ------------------------------------------------------------
   Global state
------------------------------------------------------------- */
const state = {
  clientId: null,   // from ?client=
  config: null,     // resolved config object from configs/<id>.js
  session: null,    // whoami: {role, modules, currency}
  catalog: null,    // {products, payments, suppliers}
  cart: { sell: [], buy: [] },
  reloadData: null  // re-fetch fn for the active data screen
};

const tokenKey = () => 'salmon_token_' + state.clientId;
const getToken = () => localStorage.getItem(tokenKey()) || '';
const setToken = (t) => localStorage.setItem(tokenKey(), t);
const clearToken = () => localStorage.removeItem(tokenKey());

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
const ALL_SCREENS = ['fatalScreen', 'loginScreen', 'homeScreen', 'sellScreen', 'buyScreen', 'dataScreen'];

function hideScreens() { ALL_SCREENS.forEach(id => { $(id).hidden = true; }); }

function showFatal(text) {
  $('topbar').hidden = true;
  hideScreens();
  $('fatalText').textContent = text;
  $('fatalScreen').hidden = false;
}

function showLogin() {
  $('topbar').hidden = true;
  hideScreens();
  $('loginScreen').hidden = false;
  $('tokenInput').value = '';
}

// Show a module screen; manage the topbar title + back button.
function showScreen(id, title, withBack) {
  hideScreens();
  $('topbar').hidden = false;
  $(id).hidden = false;
  $('topTitle').textContent = title || state.config.name;
  $('btnBack').hidden = !withBack;
}

function goHome() {
  state.reloadData = null;
  showScreen('homeScreen', state.config.name, false);
}

/* ============================================================
   4. HOME GRID
============================================================ */
function renderHome(session) {
  const badge = $('roleBadge');
  badge.textContent = session.role || '';
  badge.className = 'role-badge ' + (session.role === 'admin' ? 'admin' : 'viewer');

  const allowed = session.modules || [];
  const grid = $('homeGrid');
  grid.innerHTML = '';
  MODULE_ORDER.filter(k => allowed.indexOf(k) !== -1).forEach(k => {
    const m = MODULES[k];
    const b = document.createElement('button');
    b.className = 'home-btn' + (m.full ? ' home-btn--full' : '');
    b.innerHTML = '<span class="home-btn__icon">' + m.icon + '</span>' +
                  '<span class="home-btn__label">' + escapeHtml(m.label) + '</span>';
    b.addEventListener('click', () => openModule(k));
    grid.appendChild(b);
  });
}

function openModule(key) {
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
  state.catalog = resp.catalog || { products: [], payments: [], suppliers: [] };
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
  showScreen('sellScreen', 'Продать', true);
  status($('sellStatus'), '', '');
  ensureCatalog()
    .then(cat => {
      fillSelect($('sellPayment'), cat.payments, ['Касса', 'В долг']);
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
  renderResults($('sellResults'), searchProducts(q, 8), addSellItem);
}

function onSellEnter() {
  const q = $('sellSearch').value.trim();
  if (!q) return;
  const exact = exactProduct(q) || (searchProducts(q, 2).length === 1 ? searchProducts(q, 1)[0] : null);
  if (exact) addSellItem(exact);
  else toast('Товар не найден', 'err');
}

function addSellItem(p) {
  const existing = state.cart.sell.find(i => i.sku === p.sku);
  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.sell.push({
      sku: p.sku, name: p.name, unit: p.unit, stock: p.stock,
      suggested: p.price, qty: 1, price: p.price   // price = фактическая (по умолч. = подсказка)
    });
  }
  $('sellSearch').value = '';
  $('sellResults').hidden = true;
  $('sellSearch').focus();
  renderSellCart();
}

function renderSellCart() {
  const cart = state.cart.sell;
  const box = $('sellCart');
  $('sellCount').textContent = String(cart.length);

  if (!cart.length) {
    box.innerHTML = '<div class="row-item__empty">Корзина пуста — найдите товар выше</div>';
  } else {
    box.innerHTML = cart.map((it, i) => {
      const lineTotal = it.qty * it.price;
      return '<div class="cart-item" data-i="' + i + '">' +
        '<div class="cart-item__top">' +
          '<span class="cart-item__name">' + escapeHtml(it.name) + '</span>' +
          '<button class="cart-item__del" data-del="' + i + '" aria-label="Удалить">×</button>' +
        '</div>' +
        '<div class="cart-item__sku muted small">' + escapeHtml(it.sku) +
          ' · ост: ' + it.stock + '</div>' +
        '<div class="cart-item__controls">' +
          '<div class="stepper">' +
            '<button data-dec="' + i + '">−</button>' +
            '<input class="qty" data-qty="' + i + '" inputmode="decimal" value="' + it.qty + '">' +
            '<button data-inc="' + i + '">+</button>' +
          '</div>' +
          '<label class="price-field">' +
            '<span>цена</span>' +
            '<input data-price="' + i + '" inputmode="decimal" value="' + it.price + '">' +
          '</label>' +
          '<span class="cart-item__sum">' + money(lineTotal) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  wireCart('sell');
  $('sellTotal').textContent = money(cartTotal('sell')) + ' ' + cur();
}

function cartTotal(kind) {
  if (kind === 'sell') return state.cart.sell.reduce((s, i) => s + i.qty * i.price, 0);
  return state.cart.buy.reduce((s, i) => s + i.qty * i.costPrice, 0);
}

// Wire steppers / qty / price / delete for either cart.
function wireCart(kind) {
  const cart = state.cart[kind];
  const box = $(kind === 'sell' ? 'sellCart' : 'buyCart');
  const rerender = kind === 'sell' ? renderSellCart : renderBuyCart;

  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    cart.splice(+b.dataset.del, 1); rerender();
  }));
  box.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => {
    cart[+b.dataset.inc].qty += 1; rerender();
  }));
  box.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => {
    const it = cart[+b.dataset.dec];
    it.qty = Math.max(1, it.qty - 1); rerender();
  }));
  box.querySelectorAll('[data-qty]').forEach(inp => inp.addEventListener('change', () => {
    const it = cart[+inp.dataset.qty];
    it.qty = Math.max(0, num(inp.value)); rerender();
  }));
  if (kind === 'sell') {
    box.querySelectorAll('[data-price]').forEach(inp => inp.addEventListener('change', () => {
      cart[+inp.dataset.price].price = Math.max(0, num(inp.value)); rerender();
    }));
  } else {
    box.querySelectorAll('[data-cost]').forEach(inp => inp.addEventListener('change', () => {
      cart[+inp.dataset.cost].costPrice = Math.max(0, num(inp.value)); rerender();
    }));
    box.querySelectorAll('[data-sale]').forEach(inp => inp.addEventListener('change', () => {
      cart[+inp.dataset.sale].salePrice = Math.max(0, num(inp.value)); rerender();
    }));
  }
}

async function submitSell() {
  const cart = state.cart.sell;
  if (!cart.length) { toast('Корзина пуста', 'err'); return; }
  const btn = $('btnSellSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Сохранение…';
  status($('sellStatus'), '', '');
  try {
    const rows = cart.map(i => ({
      date: todayISO(), sku: i.sku, qty: i.qty, price: i.price,
      client: $('sellClient').value.trim(),
      payment: $('sellPayment').value
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
  showScreen('buyScreen', 'Купить', true);
  status($('buyStatus'), '', '');
  ensureCatalog()
    .then(cat => {
      fillSelect($('buyPayment'), cat.payments, ['Касса', 'В долг']);
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
  renderResults($('buyResults'), searchProducts($('buySearch').value, 8), addBuyItem);
}
function onBuyEnter() {
  const q = $('buySearch').value.trim();
  if (!q) return;
  const exact = exactProduct(q) || (searchProducts(q, 2).length === 1 ? searchProducts(q, 1)[0] : null);
  if (exact) addBuyItem(exact); else toast('Товар не найден', 'err');
}

function addBuyItem(p) {
  const existing = state.cart.buy.find(i => i.sku === p.sku);
  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.buy.push({
      sku: p.sku, name: p.name, unit: p.unit, stock: p.stock,
      qty: 1, costPrice: p.cost || 0, salePrice: p.price || 0
    });
  }
  $('buySearch').value = '';
  $('buyResults').hidden = true;
  $('buySearch').focus();
  renderBuyCart();
}

function renderBuyCart() {
  const cart = state.cart.buy;
  const box = $('buyCart');
  $('buyCount').textContent = String(cart.length);

  if (!cart.length) {
    box.innerHTML = '<div class="row-item__empty">Пусто — найдите товар выше</div>';
  } else {
    box.innerHTML = cart.map((it, i) =>
      '<div class="cart-item" data-i="' + i + '">' +
        '<div class="cart-item__top">' +
          '<span class="cart-item__name">' + escapeHtml(it.name) + '</span>' +
          '<button class="cart-item__del" data-del="' + i + '" aria-label="Удалить">×</button>' +
        '</div>' +
        '<div class="cart-item__sku muted small">' + escapeHtml(it.sku) + ' · ост: ' + it.stock + '</div>' +
        '<div class="cart-item__controls">' +
          '<div class="stepper">' +
            '<button data-dec="' + i + '">−</button>' +
            '<input class="qty" data-qty="' + i + '" inputmode="decimal" value="' + it.qty + '">' +
            '<button data-inc="' + i + '">+</button>' +
          '</div>' +
          '<label class="price-field"><span>приход</span>' +
            '<input data-cost="' + i + '" inputmode="decimal" value="' + it.costPrice + '"></label>' +
          '<label class="price-field"><span>продажа</span>' +
            '<input data-sale="' + i + '" inputmode="decimal" value="' + it.salePrice + '"></label>' +
        '</div>' +
        '<div class="cart-item__sum cart-item__sum--right">' + money(it.qty * it.costPrice) + '</div>' +
      '</div>'
    ).join('');
  }
  wireCart('buy');
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
      payment: $('buyPayment').value
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
  showScreen('dataScreen', title, true);
  $('dataTitle').textContent = title;
  state.reloadData = fetcher;
  fetcher();
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
    renderHome(session);
    goHome();
    toast('Вы вошли как ' + session.role, 'ok');
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
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    btn.hidden = true;
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
  $('btnBack').addEventListener('click', goHome);

  $('sellSearch').addEventListener('input', onSellSearch);
  $('sellSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onSellEnter(); } });
  $('btnSellSubmit').addEventListener('click', submitSell);

  $('buySearch').addEventListener('input', onBuySearch);
  $('buySearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onBuyEnter(); } });
  $('btnBuySubmit').addEventListener('click', submitBuy);

  $('btnReload').addEventListener('click', () => { if (state.reloadData) state.reloadData(); });

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
  $('topTitle').textContent = state.config.name;
  document.title = state.config.name + ' — Salmon';

  // 4. Auto-login if a token for THIS client is stored.
  if (getToken()) {
    try {
      const session = await apiGet('whoami');
      state.session = session;
      renderHome(session);
      goHome();
    } catch (e) {
      clearToken();
      showLogin();
    }
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
