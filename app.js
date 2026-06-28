/* ============================================================
   Salmon — клиентская логика (app.js)
   PWA-фронтенд: вход по токену, роли admin/viewer,
   регистрация продаж и чтение данных через Google Apps Script.
   Модель соответствует листу «Продажи» из Salmon.xlsx.
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   1. КОНФИГ — вставьте URL вашего Web App из Apps Script
------------------------------------------------------------- */
const API_URL = 'ВСТАВЬТЕ_СЮДА_URL_ВЕБ_ПРИЛОЖЕНИЯ';

const TOKEN_KEY = 'salmon_token';

/* ------------------------------------------------------------
   2. Хелперы
------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

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
   3. Сетевой слой (CORS-safe: POST как text/plain)
------------------------------------------------------------- */
function ensureConfigured() {
  if (!API_URL || API_URL.startsWith('ВСТАВЬТЕ')) {
    throw new Error('Не задан URL бэкенда. Откройте app.js и впишите API_URL.');
  }
}

async function apiGet(action, extra = {}) {
  ensureConfigured();
  const params = new URLSearchParams({ token: getToken(), action, ...extra });
  const res = await fetch(`${API_URL}?${params.toString()}`, { method: 'GET' });
  return parseResponse(res);
}

async function apiPost(action, payload = {}) {
  ensureConfigured();
  const res = await fetch(API_URL, {
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

/* ------------------------------------------------------------
   4. Состояние
------------------------------------------------------------- */
let currentRole = null;
let products = [];   // [{sku, name, price}]
let accounts = [];   // ["Касса (сомони)", ...]

function showLogin() {
  $('topbar').hidden = true;
  $('appScreen').hidden = true;
  $('loginScreen').hidden = false;
  $('tokenInput').value = '';
}

function showApp(role) {
  currentRole = role;
  $('loginScreen').hidden = true;
  $('topbar').hidden = false;
  $('appScreen').hidden = false;

  const badge = $('roleBadge');
  badge.textContent = role === 'admin' ? 'admin' : 'viewer';
  badge.className = 'role-badge ' + (role === 'admin' ? 'admin' : 'viewer');

  $('formCard').hidden = (role !== 'admin');
  $('fDate').value = new Date().toISOString().slice(0, 10);
}

/* Заполняем выпадающие списки из справочников бэкенда */
function fillReferences() {
  // товары
  const sel = $('fSku');
  sel.innerHTML = '<option value="">— выберите товар —</option>';
  products.forEach(p => {
    const o = document.createElement('option');
    o.value = p.sku;
    o.textContent = `${p.sku} — ${p.name}`;
    sel.appendChild(o);
  });
  // счета
  const pay = $('fPay');
  pay.innerHTML = '';
  accounts.forEach(a => {
    const o = document.createElement('option');
    o.value = a; o.textContent = a;
    pay.appendChild(o);
  });
}

/* ------------------------------------------------------------
   5. Действия
------------------------------------------------------------- */
async function doLogin() {
  const token = $('tokenInput').value.trim();
  const btn = $('btnLogin');
  status($('loginError'), '', '');
  if (!token) { status($('loginError'), 'Введите токен.', 'err'); return; }

  setToken(token);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Проверка…';
  try {
    const data = await apiGet('whoami');
    products = data.products || [];
    accounts = data.accounts || [];
    fillReferences();
    showApp(data.role);
    toast(`Вы вошли как ${data.role}`, 'ok');
    loadData();
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
  currentRole = null;
  $('dataList').innerHTML = '';
  $('summary').hidden = true;
  showLogin();
  toast('Вы вышли');
}

/* Выбор товара → подставить цену из справочника */
function onPickProduct() {
  const p = products.find(x => x.sku === $('fSku').value);
  $('fPrice').value = p ? p.price : '';
  recalcSum();
}

/* Переключатель «в долг» — прячем выбор счёта */
function onToggleDebt() {
  $('payField').style.display = $('fDebt').checked ? 'none' : 'block';
}

/* Пересчёт итоговой суммы со скидкой */
function recalcSum() {
  const qty = parseFloat($('fQty').value) || 0;
  const price = parseFloat($('fPrice').value) || 0;
  const disc = parseFloat($('fDisc').value) || 0;
  const base = qty * price;
  const sum = $('fDiscType').value === '%' ? base - base * disc / 100 : base - disc;
  $('fSum').textContent = fmtMoney(Math.max(0, sum));
}

async function submitData() {
  const qty = parseFloat($('fQty').value);
  const price = parseFloat($('fPrice').value);

  if (!$('fSku').value)            return toast('Выберите товар', 'err');
  if (isNaN(qty) || qty <= 0)      return toast('Введите количество', 'err');
  if (isNaN(price) || price < 0)   return toast('Нет цены товара', 'err');

  const inDebt = $('fDebt').checked;
  const payload = {
    row: {
      date:       $('fDate').value,
      sku:        $('fSku').value,
      qty:        qty,
      discount:   parseFloat($('fDisc').value) || 0,
      discType:   $('fDiscType').value,
      client:     $('fClient').value.trim(),
      payment:    inDebt ? 'В долг' : $('fPay').value
    }
  };

  const btn = $('btnSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Отправка…';
  status($('submitStatus'), '', '');
  try {
    await apiPost('create', payload);
    status($('submitStatus'), 'Продажа сохранена ✓', 'ok');
    toast('Сохранено', 'ok');
    // сброс (дата/счёт/тип скидки остаются)
    $('fSku').value = ''; $('fPrice').value = ''; $('fDisc').value = 0;
    $('fClient').value = ''; $('fQty').value = 1; $('fDebt').checked = false;
    onToggleDebt(); recalcSum();
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
    const data = await apiGet('read');
    renderData(data.rows || []);
  } catch (err) {
    status($('loadStatus'), describeError(err), 'err');
    $('summary').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------
   6. Отрисовка списка продаж
------------------------------------------------------------- */
function renderData(rows) {
  const list = $('dataList');
  list.innerHTML = '';

  if (!rows.length) {
    $('summary').hidden = true;
    list.innerHTML = '<div class="row-item__empty">Пока нет записей</div>';
    return;
  }

  let total = 0;
  rows.forEach(r => { total += Number(r.sum) || 0; });
  $('sumCount').textContent = rows.length;
  $('sumTotal').textContent = fmtMoney(total);
  $('summary').hidden = false;

  rows.slice().reverse().forEach(r => {
    const div = document.createElement('div');
    div.className = 'row-item';
    const meta = [];
    if (r.date) meta.push(escapeHtml(formatDate(r.date)));
    if (r.qty)  meta.push(`${fmtMoney(r.qty)} × ${fmtMoney(r.price)}`);
    if (r.client)  meta.push(escapeHtml(r.client));
    if (r.payment) meta.push(escapeHtml(r.payment));
    div.innerHTML = `
      <div class="row-item__head">
        <span class="row-item__name">${escapeHtml(r.name || r.sku || '—')}</span>
        <span class="row-item__sum">${fmtMoney(r.sum)} ₽</span>
      </div>
      <div class="row-item__meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>`;
    list.appendChild(div);
  });
}

function formatDate(d) {
  if (!d) return '';
  const s = String(d);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return s.split('T')[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------
   7. Инициализация
------------------------------------------------------------- */
function init() {
  $('btnLogin').addEventListener('click', doLogin);
  $('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', doLogout);
  $('btnSubmit').addEventListener('click', submitData);
  $('btnLoad').addEventListener('click', loadData);
  $('fSku').addEventListener('change', onPickProduct);
  $('fDebt').addEventListener('change', onToggleDebt);
  ['fQty', 'fPrice', 'fDisc', 'fDiscType'].forEach(id =>
    $(id).addEventListener('input', recalcSum));

  if (getToken()) {
    apiGet('whoami')
      .then(data => {
        products = data.products || [];
        accounts = data.accounts || [];
        fillReferences();
        showApp(data.role);
        loadData();
      })
      .catch(() => { clearToken(); showLogin(); });
  } else {
    showLogin();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
