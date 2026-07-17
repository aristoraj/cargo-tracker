require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const {
  PORT = 3000,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ACCOUNTS_DOMAIN = 'accounts.zoho.com',
  ZOHO_API_DOMAIN = 'www.zohoapis.com',
  ZOHO_ACCOUNT_OWNER_NAME = '2demoedzola1',
  ZOHO_APP_LINK_NAME = 'cargo-tracker',
  ZOHO_FORM_LINK_NAME = 'Scan_Event',
  ZOHO_REPORT_LINK_NAME = 'Scan_Event_Report',
  ZOHO_IMAGE_FIELD = 'Scanned_Image',
  ZOHO_UPLOAD_METHOD = 'POST',
  ALLOWED_ORIGIN = '*',
} = process.env;

// Maps the clean field names the widget sends to the actual Zoho Creator
// field link names (keeps Zoho-specific naming out of the frontend entirely).
const FIELD_MAP = {
  awb: 'AWB_No',
  piece: 'Piece_No',
  total: 'Total_Pieces',
  dest: 'Destination',
  ref: 'Ref_No',
  raw: 'Raw_Payload',
  scannedAt: 'Scanned_On',
};

// Zoho Creator's Date-Time fields don't reliably accept a raw ISO string
// via the Data API — instead of erroring, it tends to just leave the field
// blank, which is why "Scanned_On" wasn't showing up. Format explicitly
// as "DD-MMM-YYYY HH:mm:ss" in IST (this account's timezone), computed
// directly rather than relying on the server process's own timezone
// (Render defaults to UTC).
function toZohoDateTime(isoString) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(new Date(isoString).getTime() + IST_OFFSET_MS);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');
  return `${pad(ist.getUTCDate())}-${months[ist.getUTCMonth()]}-${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves index.html (the scanner) at '/'
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------------------------------------------------------------------
// Zoho OAuth — refresh_token grant, cached in memory until near expiry.
// ---------------------------------------------------------------------
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(`https://${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: 'POST',
    body: params,
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) {
    throw new Error(`Zoho token refresh failed: ${json.error || resp.status}`);
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

// ---------------------------------------------------------------------
// Routes consumed by the scanner widget. This is our own stable API
// contract — what Zoho actually requires underneath (method, endpoint
// shape) can change without the widget ever needing to know.
// ---------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Create the Scan_Event record (no image yet).
app.post('/api/scan-events', async (req, res) => {
  try {
    const { awb, piece, total, dest, ref, raw, scannedAt } = req.body;
    if (!awb || !piece || !total) {
      return res.status(400).json({ error: 'awb, piece, total are required' });
    }

    const accessToken = await getAccessToken();
    const payload = {
      [FIELD_MAP.awb]: awb,
      [FIELD_MAP.piece]: piece,
      [FIELD_MAP.total]: total,
      [FIELD_MAP.dest]: dest || '',
      [FIELD_MAP.ref]: ref || '',
      [FIELD_MAP.raw]: raw || '',
      [FIELD_MAP.scannedAt]: toZohoDateTime(scannedAt || new Date().toISOString()),
    };

    const url = `https://${ZOHO_API_DOMAIN}/creator/v2.1/data/${ZOHO_ACCOUNT_OWNER_NAME}/${ZOHO_APP_LINK_NAME}/form/${ZOHO_FORM_LINK_NAME}`;
    const zohoResp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: payload }),
    });
    const zohoJson = await zohoResp.json();
    if (!zohoResp.ok) throw new Error(zohoJson.message || `HTTP ${zohoResp.status}`);

    // NOTE: verify against your Zoho DC's actual response shape.
    const id = zohoJson?.data?.ID;
    res.json({ id, raw: zohoJson });
  } catch (err) {
    console.error('create scan-event failed:', err);
    res.status(502).json({ error: err.message });
  }
});

// Attach the captured image to a record already created above.
app.patch('/api/scan-events/:id/image', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const accessToken = await getAccessToken();
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || `scan-${id}.jpg`);

    const url = `https://${ZOHO_API_DOMAIN}/creator/v2.1/data/${ZOHO_ACCOUNT_OWNER_NAME}/${ZOHO_APP_LINK_NAME}/report/${ZOHO_REPORT_LINK_NAME}/${id}/${ZOHO_IMAGE_FIELD}/upload`;
    const zohoResp = await fetch(url, {
      method: ZOHO_UPLOAD_METHOD,
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      body: form,
    });

    // Read as text first — a 401/404 from Zoho's gateway (vs. the Creator
    // app itself) doesn't always come back as JSON, and swallowing that
    // detail is exactly why this was hard to diagnose from the outside.
    const rawText = await zohoResp.text();
    let zohoJson = null;
    try { zohoJson = JSON.parse(rawText); } catch { /* not JSON, keep rawText */ }

    if (!zohoResp.ok) {
      console.error(`image attach failed: HTTP ${zohoResp.status} url=${url} body=${rawText}`);
      throw new Error(`HTTP ${zohoResp.status}: ${(zohoJson && zohoJson.message) || rawText.slice(0, 200)}`);
    }

    res.json({ ok: true, raw: zohoJson || rawText });
  } catch (err) {
    console.error('image attach failed:', err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`cargo-tracker-api listening on ${PORT}`));
