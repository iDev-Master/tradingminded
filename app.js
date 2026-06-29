/* ============================================================
   Salmon — single, client-agnostic frontend (app.js)
   ------------------------------------------------------------
   This file is IDENTICAL for every client. Per-client values live
   in configs/<id>.js and the active client is chosen by the URL
   query param (?client=<id>). The frontend stays "dumb":
   it picks the client, sends the token, and renders whatever the
   backend returns (role, allowed actions, form schema, formatted
   data). No business logic, validation, math or formatting here.
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

/* ------------------------------------------------------------
   Global state for the active client/session
------------------------------------------------------------- */
const state = {
  clientId: null,   // from ?client=
  config: null,     // resolved config object from configs/<id>.js
  session: null     // last whoami response: {role, actions, form}
};

const tokenKey = () => 'salmon_token_' + state.clientId;   // namespaced per client
const getToken = () => localStorage.getItem(tokenKey()) || '';
const setToken = (t) => localStorage.setItem(tokenKey(), t);
const clearToken = () => localStorage.removeItem(tokenKey());

/* ============================================================
   1. CLIENT CONFIG LOADING (multi-tenant)
   ------------------------------------------------------------
   configs/<id>.js calls registerClient({...}). app.js injects that
   script based on ?client=, so adding a client = adding one file.
============================================================ */

// Called by every configs/<id>.js file.
window.registerClient = function (cfg) { window.__CLIENT__ = cfg; };

function loadClientConfig(id) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'configs/' + id + '.js';     // relative — works under /repo/ on Pages
    s.onload = () => resolve(window.__CLIENT__);
    s.onerror = () => reject(new Error('no-config'));
    document.head.appendChild(s);
  });
}

/* ------------------------------------------------------------
   Apply per-client theme + per-client PWA manifest
------------------------------------------------------------- */
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.bg)      root.setProperty('--bg', theme.bg);
  if (theme.accent)  root.setProperty('--accent', theme.accent);
  if (theme.accent2) root.setProperty('--accent-2', theme.accent2);
  if (theme.accent)  $('themeColorMeta').setAttribute('content', theme.accent);
}

// Build a per-client manifest at runtime so an installed PWA keeps
// the ?client= param (single static manifest can't do that).
function applyManifest(cfg) {
  const manifest = {
    name: cfg.name,
    short_name: cfg.name,
    description: 'Складской учёт и продажи',
    lang: 'ru',
    start_url: './?client=' + cfg.id,    // preserves the client on launch
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: (cfg.theme && cfg.theme.bg) || '#0f172a',
    theme_color: (cfg.theme && cfg.theme.accent) || '#0f766e',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  $('manifestLink').href = URL.createObjectURL(blob);
}

/* ============================================================
   2. NETWORK LAYER (CORS-safe for Apps Script)
   - POST is sent as text/plain to avoid the preflight Apps Script
     can't answer; token travels in the body / query, never a header.
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

// Normalise the response and surface backend errors as exceptions.
async function parseResponse(res) {
  let data;
  try { data = JSON.parse(await res.text()); }
  catch (e) { throw new Error('Пустой или некорректный ответ сервера.'); }
  if (data && data.error) {
    if (data.error === 'unauthorized') throw new Error('Неверный токен.');
    if (data.error === 'forbidden')    throw new Error('Недостаточно прав для этого действия.');
    throw new Error(data.message || data.error);   // validation/etc → server message
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
function showFatal(text) {
  ['topbar', 'loginScreen', 'appScreen'].forEach(id => $(id).hidden = true);
  $('fatalText').textContent = text;
  $('fatalScreen').hidden = false;
}

function showLogin() {
  $('topbar').hidden = true;
  $('appScreen').hidden = true;
  $('fatalScreen').hidden = true;
  $('loginScreen').hidden = false;
  $('tokenInput').value = '';
}

function showApp() {
  $('loginScreen').hidden = true;
  $('fatalScreen').hidden = true;
  $('topbar').hidden = false;
  $('appScreen').hidden = false;
}

/* ============================================================
   4. RENDERING — driven entirely by the server response
============================================================ */

// Build the whole UI from a whoami session: role badge, form, buttons.
function renderSession(session) {
  state.session = session;
  const actions = session.actions || [];

  const badge = $('roleBadge');
  badge.textContent = session.role || '';
  badge.className = 'role-badge ' + (session.role === 'admin' ? 'admin' : 'viewer');

  // Form is shown only if the server allows 'submit' and sent a schema.
  if (actions.indexOf('submit') !== -1 && session.form) {
    renderForm(session.form);
    $('formCard').hidden = false;
  } else {
    $('formCard').hidden = true;
  }

  // Data card / Load button shown if 'load' is allowed.
  $('dataCard').hidden = (actions.indexOf('load') === -1);
}

// Render form inputs from a schema: [{key,label,type,default,options}]
function renderForm(form) {
  $('formTitle').textContent = form.title || 'Форма';
  const box = $('formFields');
  box.innerHTML = '';

  (form.fields || []).forEach(f => {
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = '<span class="field__label">' + escapeHtml(f.label || f.key) + '</span>';

    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      (f.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
      if (f.type === 'number') input.inputMode = 'decimal';
    }
    input.dataset.key = f.key;

    // 'today' is just a convenience default value, not client-side logic.
    if (f.default === 'today') input.value = new Date().toISOString().slice(0, 10);
    else if (f.default != null) input.value = f.default;

    label.appendChild(input);
    box.appendChild(label);
  });
}

// Collect the form values into a flat object keyed by field key.
function collectForm() {
  const row = {};
  $('formFields').querySelectorAll('[data-key]').forEach(el => { row[el.dataset.key] = el.value; });
  return row;
}

// Render the data list: server sends pre-formatted strings only.
function renderData(list) {
  const items = (list && list.items) || [];
  const summary = (list && list.summary) || [];

  // Summary chips
  const sumBox = $('summary');
  if (summary.length) {
    sumBox.innerHTML = summary.map(s =>
      '<div class="summary__item"><span class="summary__val">' + escapeHtml(s.value) +
      '</span><span class="summary__lbl">' + escapeHtml(s.label) + '</span></div>'
    ).join('');
    sumBox.hidden = false;
  } else {
    sumBox.hidden = true;
  }

  // Items
  const listBox = $('dataList');
  if (!items.length) {
    listBox.innerHTML = '<div class="row-item__empty">Пока нет записей</div>';
    return;
  }
  listBox.innerHTML = items.map(it => {
    const meta = (it.meta || []).map(m => '<span>' + escapeHtml(m) + '</span>').join('');
    return '<div class="row-item"><div class="row-item__head">' +
           '<span class="row-item__name">' + escapeHtml(it.title || '') + '</span>' +
           '<span class="row-item__sum">' + escapeHtml(it.amount || '') + '</span></div>' +
           '<div class="row-item__meta">' + meta + '</div></div>';
  }).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ============================================================
   5. ACTIONS
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
    showApp();
    renderSession(session);
    toast('Вы вошли как ' + session.role, 'ok');
    if ((session.actions || []).indexOf('load') !== -1) loadData();
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
  $('dataList').innerHTML = '';
  $('summary').hidden = true;
  showLogin();
  toast('Вы вышли');
}

async function submitData() {
  const btn = $('btnSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Отправка…';
  status($('submitStatus'), '', '');
  try {
    // No client-side validation/maths: send raw inputs, let the server decide.
    const resp = await apiPost('create', { row: collectForm() });
    status($('submitStatus'), resp.message || 'Сохранено ✓', 'ok');
    toast('Сохранено', 'ok');
    if (state.session && state.session.form) renderForm(state.session.form);  // reset form
    loadData();
  } catch (err) {
    status($('submitStatus'), describeError(err), 'err');
    toast('Ошибка отправки', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Отправить';
  }
}

async function loadData() {
  const btn = $('btnLoad');
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  status($('loadStatus'), '', '');
  try {
    const resp = await apiGet('read');
    renderData(resp.list || { items: [], summary: [] });
  } catch (err) {
    status($('loadStatus'), describeError(err), 'err');
    $('summary').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ============================================================
   6. BOOTSTRAP
============================================================ */
async function init() {
  // Wire static controls once.
  $('btnLogin').addEventListener('click', doLogin);
  $('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', doLogout);
  $('btnSubmit').addEventListener('click', submitData);
  $('btnLoad').addEventListener('click', loadData);

  // Register the service worker (relative path → scope = /repo/ on Pages).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch(() => {});
  }

  // 1. Resolve the active client from the URL.
  state.clientId = (qsParam('client') || '').trim();
  if (!state.clientId) {
    return showFatal('Откройте ссылку с параметром клиента, например: …/?client=romashka');
  }

  // 2. Load its public config (configs/<id>.js).
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
  $('topClientName').textContent = state.config.name;
  document.title = state.config.name + ' — Salmon';

  // 4. Auto-login if a token for THIS client is already stored.
  if (getToken()) {
    try {
      const session = await apiGet('whoami');
      showApp();
      renderSession(session);
      if ((session.actions || []).indexOf('load') !== -1) loadData();
    } catch (e) {
      clearToken();
      showLogin();
    }
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
