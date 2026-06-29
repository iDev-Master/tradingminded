/* Client: Ромашка (example second client). Link: …/?client=romashka
   Each client has its OWN Apps Script + Google Sheet → its own apiUrl.
   Public values only — no tokens here. */
registerClient({
  id: 'romashka',
  name: 'Ромашка',
  apiUrl: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE',
  theme: {
    bg: '#0f172a',
    accent: '#7c3aed',
    accent2: '#a78bfa'
  }
});
