/* ============================================================
   Salmon — backend (Google Apps Script, code.gs)
   ONE copy per client (own Sheet, own deployment, own URL).
   ------------------------------------------------------------
   This is the ONLY place with business logic: token/role check,
   validation, calculations, formatting, and deciding what the UI
   may show. The frontend just renders whatever this returns.

   ┌──────────────────────────────────────────────────────────┐
   │ SET TOKENS (never stored in code):                        │
   │  Project Settings (⚙) → Script properties → Add property  │
   │     Name (key)  = the token itself (e.g. a1b2c3d4)        │
   │     Value       = admin  OR  viewer                       │
   │  Or run seedTokens() once (see bottom), then clear it.    │
   └──────────────────────────────────────────────────────────┘
   After editing code: Deploy → Manage deployments → ✎ → New
   version → Deploy.
============================================================ */

/* ---- "Продажи" sheet column map ---- */
var SALES = 'Продажи';
var COL = { num:1, date:2, sku:3, name:4, qty:5, price:6, disc:7, discType:8,
            sum:9, cost:10, profit:11, client:12, pay:13 };
var SALES_WIDTH = 13;
var SALES_FIRST_ROW = 4;       // first data row (3 is the header)
var SALES_TEMPLATE_ROW = 4;    // row that holds the live formulas to copy down

/* ---- Reference ranges in "Справочники" ---- */
var REF = 'Справочники';
var GOODS_RANGE = 'A5:F104';   // A sku, C name, F sale price
var ACCOUNTS_RANGE = 'A109:A128';

/* ============================================================
   ENTRY POINTS
============================================================ */
function doGet(e)  { return handle(getParams(e)); }

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error: 'bad_request', message: 'Некорректный JSON' }); }
  return handle(body);
}

/* ============================================================
   ROUTER  (token → role → action)
============================================================ */
function handle(params) {
  var token = (params.token || '').toString().trim();
  var action = (params.action || '').toString();

  var role = roleForToken(token);
  if (!role) return json({ error: 'unauthorized' });

  switch (action) {
    case 'whoami':
      // The server decides what this role may do and which form to show.
      return json({
        ok: true,
        role: role,
        actions: role === 'admin' ? ['submit', 'load'] : ['load'],
        form: role === 'admin' ? buildFormSchema() : null
      });

    case 'read':
      return json({ ok: true, role: role, list: readSalesList() });

    case 'create':
      if (role !== 'admin')
        return json({ error: 'forbidden', message: 'Только admin может добавлять записи' });
      return createSale(params.row || {});

    default:
      return json({ error: 'bad_request', message: 'Неизвестное действие: ' + action });
  }
}

/* ============================================================
   AUTH
============================================================ */
function roleForToken(token) {
  if (!token) return null;
  var role = PropertiesService.getScriptProperties().getProperty(token);
  return (role === 'admin' || role === 'viewer') ? role : null;
}

/* ============================================================
   FORM SCHEMA  (server-built; frontend just renders it)
============================================================ */
function buildFormSchema() {
  return {
    title: 'Новая продажа',
    fields: [
      { key: 'date',     label: 'Дата',        type: 'date',   default: 'today' },
      { key: 'sku',      label: 'Товар',       type: 'select', options: productOptions() },
      { key: 'qty',      label: 'Кол-во',      type: 'number', default: 1 },
      { key: 'discount', label: 'Скидка',      type: 'number', default: 0 },
      { key: 'discType', label: 'Тип скидки',  type: 'select',
        options: [{ value: 'Сумма', label: 'сумма' }, { value: '%', label: '%' }] },
      { key: 'client',   label: 'Клиент',      type: 'text' },
      { key: 'payment',  label: 'Оплата',      type: 'select', options: paymentOptions() }
    ]
  };
}

function productOptions() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REF);
  if (!sh) return [];
  return sh.getRange(GOODS_RANGE).getValues()
    .filter(function (r) { return r[0] !== '' && r[0] != null; })
    .map(function (r) { return { value: r[0], label: r[0] + ' — ' + r[2] }; });
}

function paymentOptions() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REF);
  var opts = [];
  if (sh) {
    sh.getRange(ACCOUNTS_RANGE).getValues().forEach(function (r) {
      if (r[0] !== '' && r[0] != null) opts.push({ value: r[0], label: r[0] });
    });
  }
  opts.push({ value: 'В долг', label: 'В долг' });   // sell-on-credit option
  return opts;
}

/* ============================================================
   READ — return display-ready data (all formatting server-side)
============================================================ */
function getSalesSheet() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SALES);
  if (!sh) throw new Error('Нет листа «' + SALES + '»');
  return sh;
}

// Last data row is found by the "Артикул" column, because formula cells
// in empty rows make getLastRow() unreliable.
function lastSalesRow(sh) {
  var col = sh.getRange(SALES_FIRST_ROW, COL.sku,
                        Math.max(1, sh.getMaxRows() - SALES_FIRST_ROW + 1), 1).getValues();
  var last = SALES_FIRST_ROW - 1;
  for (var i = 0; i < col.length; i++) {
    if (col[i][0] !== '' && col[i][0] != null) last = SALES_FIRST_ROW + i;
  }
  return last;
}

function readSalesList() {
  var sh = getSalesSheet();
  var last = lastSalesRow(sh);
  var items = [], total = 0;

  if (last >= SALES_FIRST_ROW) {
    var vals = sh.getRange(SALES_FIRST_ROW, 1, last - SALES_FIRST_ROW + 1, SALES_WIDTH).getValues();
    vals.forEach(function (r) {
      var sum = Number(r[COL.sum - 1]) || 0;
      total += sum;
      var meta = [];
      var d = fmtDate(r[COL.date - 1]);                          if (d) meta.push(d);
      if (r[COL.qty - 1]) meta.push(fmtNum(r[COL.qty - 1]) + ' × ' + fmtMoney(r[COL.price - 1]));
      if (r[COL.client - 1]) meta.push(String(r[COL.client - 1]));
      if (r[COL.pay - 1])    meta.push(String(r[COL.pay - 1]));
      items.push({
        title: r[COL.name - 1] || r[COL.sku - 1] || '—',
        meta: meta,
        amount: fmtMoney(sum) + ' ₽'
      });
    });
  }

  items.reverse();   // newest first
  return {
    items: items,
    summary: [
      { label: 'записей',  value: String(items.length) },
      { label: 'выручка',  value: fmtMoney(total) + ' ₽' }
    ]
  };
}

/* ============================================================
   CREATE — validate + write (admin only)
   Writes only the INPUT cells; formula columns are copied from the
   template row so the sheet keeps computing sum/cost/profit.
============================================================ */
function createSale(row) {
  // --- server-side validation (no validation on the client) ---
  var sku = (row.sku || '').toString().trim();
  var qty = Number(row.qty);
  if (!sku)               return json({ error: 'validation', message: 'Выберите товар' });
  if (!(qty > 0))         return json({ error: 'validation', message: 'Количество должно быть больше 0' });
  var discType = (row.discType === '%') ? '%' : 'Сумма';
  var discount = Number(row.discount) || 0;

  var sh = getSalesSheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var newRow = lastSalesRow(sh) + 1;

    // Copy formulas + formats + data-validations from the template row.
    sh.getRange(SALES_TEMPLATE_ROW, 1, 1, SALES_WIDTH)
      .copyTo(sh.getRange(newRow, 1, 1, SALES_WIDTH));

    // Overwrite the input cells with real values.
    sh.getRange(newRow, COL.date).setValue(parseDate(row.date));
    sh.getRange(newRow, COL.sku).setValue(sku);
    sh.getRange(newRow, COL.qty).setValue(qty);
    sh.getRange(newRow, COL.disc).setValue(discount);
    sh.getRange(newRow, COL.discType).setValue(discType);
    sh.getRange(newRow, COL.client).setValue((row.client || '').toString().trim());
    sh.getRange(newRow, COL.pay).setValue((row.payment || '').toString().trim());

    SpreadsheetApp.flush();
    // Read back the computed total to confirm the saved amount.
    var sum = Number(sh.getRange(newRow, COL.sum).getValue()) || 0;
    return json({ ok: true, message: 'Продажа сохранена: ' + fmtMoney(sum) + ' ₽' });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   HELPERS  (parsing & formatting — all server-side)
============================================================ */
function getParams(e) { return (e && e.parameter) ? e.parameter : {}; }

function parseDate(s) {
  if (!s) return new Date();
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);   // yyyy-mm-dd from the frontend
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return s;
}

function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  return v ? String(v) : '';
}

// 1234.5 → "1 234,50"  (space thousands, comma decimal)
function fmtMoney(n) {
  n = Number(n) || 0;
  var parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return parts[0] + ',' + parts[1];
}

// Quantity without forced decimals: 3 → "3", 2.5 → "2,5"
function fmtNum(n) {
  n = Number(n) || 0;
  return (Number.isInteger(n) ? String(n) : String(n).replace('.', ',')).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   (OPTIONAL) one-shot token seeding — run once, then clear it
============================================================ */
function seedTokens() {
  PropertiesService.getScriptProperties().setProperties({
    'admin-CHANGE-ME-123':  'admin',
    'viewer-CHANGE-ME-456': 'viewer'
  });
  Logger.log('Tokens written to Script properties.');
}

function makeToken() {
  Logger.log(Utilities.getUuid().replace(/-/g, '').slice(0, 16));
}
