/* ============================================================
   CLIENT CONFIG TEMPLATE — copy this file to configs/<id>.js
   ------------------------------------------------------------
   To onboard a new client: copy this file, rename it to the
   client's id (e.g. configs/romashka.js), fill in the values,
   and give the client the link:  …/?client=<id>
   PUBLIC VALUES ONLY. Never put tokens or passwords here — the
   repo is public. Tokens are entered by the user and checked
   in Apps Script.
============================================================ */
registerClient({
  // Must EXACTLY match the file name and the ?client= value.
  id: 'template',

  // Display name (login screen, top bar, PWA name).
  name: 'Название клиента',

  // The client's own Apps Script Web App URL (…/exec).
  apiUrl: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE',

  // Optional theme overrides (CSS variables).
  theme: {
    bg: '#0f172a',
    accent: '#0f766e',
    accent2: '#14b8a6'
  }
});
