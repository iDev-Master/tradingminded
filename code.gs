/* ============================================================
   Salmon — бэкенд на Google Apps Script (code.gs)
   Работает поверх таблицы Salmon (листы «Продажи», «Справочники»).
   Авторизация по токену, роли admin / viewer.

   ┌──────────────────────────────────────────────────────────┐
   │ КАК ЗАДАТЬ ТОКЕНЫ (не хранятся в коде):                   │
   │  ⚙ Настройки проекта → «Свойства скрипта» →               │
   │     Имя (key)  = сам токен (напр. a1b2c3d4)               │
   │     Значение   = admin  ИЛИ  viewer                       │
   │  Либо запустите один раз seedTokens() (см. внизу).        │
   └──────────────────────────────────────────────────────────┘
   После правок кода: Развернуть → Управление развёртываниями →
   ✎ → Новая версия → Развернуть.
============================================================ */

/* ---- Карта листа «Продажи» (номера колонок) ---- */
var SALES = 'Продажи';
var COL = { num:1, date:2, sku:3, name:4, qty:5, price:6, disc:7, discType:8,
            sum:9, cost:10, profit:11, client:12, pay:13 };
var SALES_WIDTH = 13;
var SALES_FIRST_ROW = 4;        // первая строка данных (3 — шапка)
var SALES_TEMPLATE_ROW = 4;     // строка-образец с формулами

/* ---- Справочники ---- */
var REF = 'Справочники';
var GOODS_RANGE   = 'A5:F104';   // товары: A арт, C наим, F цена
var GOODS_FIRST   = 5;
var ACCOUNTS_RANGE = 'A109:A128';

/* ============================================================
   ТОЧКИ ВХОДА
============================================================ */
function doGet(e)  { return handle(e, getParams(e)); }

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error:'bad_request', message:'Некорректный JSON' }); }
  return handle(e, body);
}

/* ============================================================
   ОБЩИЙ ОБРАБОТЧИК
============================================================ */
function handle(e, params) {
  var token = (params.token || '').toString().trim();
  var action = (params.action || '').toString();

  var role = roleForToken(token);
  if (!role) return json({ error:'unauthorized' });

  switch (action) {
    case 'whoami':
      // отдаём роль + справочники для выпадающих списков фронта
      return json({ ok:true, role:role, accounts:getAccounts(), products:getProducts() });

    case 'read':
      return json({ ok:true, role:role, rows:readSales() });

    case 'create':
      if (role !== 'admin')
        return json({ error:'forbidden', message:'Только admin может добавлять продажи' });
      return createSale(params.row || {}, role);

    default:
      return json({ error:'bad_request', message:'Неизвестное действие: ' + action });
  }
}

/* ============================================================
   АВТОРИЗАЦИЯ
============================================================ */
function roleForToken(token) {
  if (!token) return null;
  var role = PropertiesService.getScriptProperties().getProperty(token);
  return (role === 'admin' || role === 'viewer') ? role : null;
}

/* ============================================================
   СПРАВОЧНИКИ (для фронтенда)
============================================================ */
function getProducts() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REF);
  if (!sh) return [];
  var vals = sh.getRange(GOODS_RANGE).getValues();   // [A,B,C,D,E,F]
  var out = [];
  vals.forEach(function (r) {
    if (r[0] !== '' && r[0] != null) {
      out.push({ sku: r[0], name: r[2], price: Number(r[5]) || 0 });
    }
  });
  return out;
}

function getAccounts() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REF);
  if (!sh) return [];
  return sh.getRange(ACCOUNTS_RANGE).getValues()
           .map(function (r) { return r[0]; })
           .filter(function (v) { return v !== '' && v != null; });
}

/* ============================================================
   ПРОДАЖИ — чтение
============================================================ */
function getSalesSheet() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES);
  if (!sh) throw new Error('Нет листа «' + SALES + '»');
  return sh;
}

// Последняя строка с данными определяется по колонке «Артикул» (C),
// т.к. формулы в пустых строках делают getLastRow() ненадёжным.
function lastSalesRow(sh) {
  var col = sh.getRange(SALES_FIRST_ROW, COL.sku,
                        Math.max(1, sh.getMaxRows() - SALES_FIRST_ROW + 1), 1).getValues();
  var last = SALES_FIRST_ROW - 1;
  for (var i = 0; i < col.length; i++) {
    if (col[i][0] !== '' && col[i][0] != null) last = SALES_FIRST_ROW + i;
  }
  return last;
}

function readSales() {
  var sh = getSalesSheet();
  var last = lastSalesRow(sh);
  if (last < SALES_FIRST_ROW) return [];
  var vals = sh.getRange(SALES_FIRST_ROW, 1, last - SALES_FIRST_ROW + 1, SALES_WIDTH).getValues();
  return vals.map(function (r) {
    return {
      date:   fmtCell(r[COL.date - 1]),
      sku:    r[COL.sku - 1],
      name:   r[COL.name - 1],
      qty:    r[COL.qty - 1],
      price:  r[COL.price - 1],
      disc:   r[COL.disc - 1],
      sum:    r[COL.sum - 1],
      profit: r[COL.profit - 1],
      client: r[COL.client - 1],
      payment:r[COL.pay - 1]
    };
  });
}

/* ============================================================
   ПРОДАЖИ — создание (только admin)
   Пишем только во ВВОДНЫЕ колонки, формулы (Наименование, Цена,
   Сумма, Себест, Прибыль) копируем из строки-образца — чтобы
   расчёты на листе оставались «живыми».
============================================================ */
function createSale(row, role) {
  var sh = getSalesSheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var newRow = lastSalesRow(sh) + 1;

    // 1. Копируем строку-образец (формулы + форматы + проверки) на новую строку
    sh.getRange(SALES_TEMPLATE_ROW, 1, 1, SALES_WIDTH)
      .copyTo(sh.getRange(newRow, 1, 1, SALES_WIDTH));

    // 2. Перезаписываем вводные ячейки реальными значениями
    sh.getRange(newRow, COL.date).setValue(parseDate(row.date));
    sh.getRange(newRow, COL.sku).setValue(row.sku || '');
    sh.getRange(newRow, COL.qty).setValue(Number(row.qty) || 0);
    sh.getRange(newRow, COL.disc).setValue(Number(row.discount) || 0);
    sh.getRange(newRow, COL.discType).setValue(row.discType || 'Сумма');
    sh.getRange(newRow, COL.client).setValue(row.client || '');
    sh.getRange(newRow, COL.pay).setValue(row.payment || '');

    SpreadsheetApp.flush();
    return json({ ok:true, role:role });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   ВСПОМОГАТЕЛЬНОЕ
============================================================ */
function getParams(e) { return (e && e.parameter) ? e.parameter : {}; }

function parseDate(s) {
  if (!s) return new Date();
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);   // yyyy-mm-dd с фронта
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return s;
}

function fmtCell(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   (НЕОБЯЗАТЕЛЬНО) Быстрое создание токенов — запустите 1 раз
============================================================ */
function seedTokens() {
  PropertiesService.getScriptProperties().setProperties({
    'admin-CHANGE-ME-123':  'admin',
    'viewer-CHANGE-ME-456': 'viewer'
  });
  Logger.log('Токены записаны.');
}

function makeToken() {
  Logger.log(Utilities.getUuid().replace(/-/g, '').slice(0, 16));
}
