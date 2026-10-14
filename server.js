const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- storage ----------
const defaults = {
  settings: {
    message: 'Hello {name} 👋\nThis is Studio. We would love to work with you — reply to this message to get started.',
    countryCode: '20',
    minDelay: 20,
    maxDelay: 45,
    dailyLimit: 100,
  },
  clients: [], // {id, name, phone, status: pending|sent|failed|skipped, sentAt, error}
  sentToday: { date: '', count: 0 },
};
let db = defaults;
try { db = { ...defaults, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
db.settings = { ...defaults.settings, ...db.settings };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---------- helpers ----------
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  const international = d.startsWith('+') || d.startsWith('00');
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!international) {
    if (d.startsWith('0')) d = db.settings.countryCode + d.slice(1);
    else if (d.length <= 10) d = db.settings.countryCode + d;
  }
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t' || c === ';') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// Accepts "name,phone" rows with or without a header, in either column order.
function rowsToClients(rows) {
  const out = [];
  for (const r of rows) {
    const cells = r.map((x) => x.trim());
    let phoneIdx = cells.findIndex((c) => /^\+?[\d\s\-()]{7,}$/.test(c));
    if (phoneIdx === -1) continue; // header or junk
    const phone = normalizePhone(cells[phoneIdx]);
    const name = cells.find((c, i) => i !== phoneIdx && c) || '';
    if (phone) out.push({ name, phone });
  }
  return out;
}

function addClients(list) {
  const have = new Set(db.clients.map((c) => c.phone));
  let added = 0, dup = 0;
  for (const c of list) {
    if (have.has(c.phone)) { dup++; continue; }
    have.add(c.phone);
    db.clients.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: c.name, phone: c.phone, status: 'pending', sentAt: null, error: null });
    added++;
  }
  save();
  return { added, duplicates: dup };
}

function sheetUrlToCsv(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return url;
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- WhatsApp ----------
const wa = { state: 'starting', qr: null, error: null };
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});
client.on('qr', async (qr) => { wa.state = 'qr'; wa.qr = await QRCode.toDataURL(qr, { width: 320, margin: 1 }); });
client.on('authenticated', () => { wa.state = 'authenticated'; wa.qr = null; });
client.on('ready', () => { wa.state = 'ready'; wa.qr = null; });
client.on('auth_failure', (m) => { wa.state = 'error'; wa.error = m; });
client.on('disconnected', (r) => { wa.state = 'disconnected'; wa.error = String(r); campaign.running = false; });
client.initialize().catch((e) => { wa.state = 'error'; wa.error = e.message; });

// ---------- campaign ----------
const campaign = { running: false, current: null, note: '' };

async function runCampaign() {
  if (campaign.running) return;
  campaign.running = true;
  while (campaign.running) {
    if (wa.state !== 'ready') { campaign.note = 'WhatsApp not connected'; break; }
    if (db.sentToday.date !== today()) db.sentToday = { date: today(), count: 0 };
    if (db.sentToday.count >= db.settings.dailyLimit) { campaign.note = 'Daily limit reached'; break; }
    const next = db.clients.find((c) => c.status === 'pending');
    if (!next) { campaign.note = 'All targets done'; break; }

    campaign.current = next.id;
    try {
      const id = await client.getNumberId(next.phone);
      if (!id) {
        next.status = 'failed'; next.error = 'Number not on WhatsApp';
      } else {
        const text = db.settings.message.replaceAll('{name}', next.name || '').replace(/[ \t]+\n/g, '\n').trim();
        await client.sendMessage(id._serialized, text);
        next.status = 'sent'; next.sentAt = new Date().toISOString(); next.error = null;
        db.sentToday.count++;
      }
    } catch (e) {
      next.status = 'failed'; next.error = e.message;
    }
    save();
    campaign.current = null;
    if (!campaign.running) break;
    const { minDelay, maxDelay } = db.settings;
    const wait = (minDelay + Math.random() * Math.max(0, maxDelay - minDelay)) * 1000;
    campaign.note = `Waiting ${Math.round(wait / 1000)}s before next message`;
    const end = Date.now() + wait;
    while (campaign.running && Date.now() < end) await sleep(500);
  }
  campaign.running = false;
  campaign.current = null;
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const c = db.clients;
  const count = (s) => c.filter((x) => x.status === s).length;
  res.json({
    whatsapp: wa,
    campaign,
    settings: db.settings,
    sentToday: db.sentToday.date === today() ? db.sentToday.count : 0,
    stats: { target: c.length, sent: count('sent'), pending: count('pending'), failed: count('failed'), skipped: count('skipped') },
    clients: c,
  });
});

app.post('/api/settings', (req, res) => {
  const s = req.body || {};
  if (typeof s.message === 'string') db.settings.message = s.message;
  if (s.countryCode) db.settings.countryCode = String(s.countryCode).replace(/\D/g, '');
  for (const k of ['minDelay', 'maxDelay', 'dailyLimit']) if (Number(s[k]) >= 0) db.settings[k] = Number(s[k]);
  if (db.settings.maxDelay < db.settings.minDelay) db.settings.maxDelay = db.settings.minDelay;
  save();
  res.json(db.settings);
});

app.post('/api/clients/import', async (req, res) => {
  try {
    let text = req.body.text || '';
    if (req.body.url) {
      const r = await fetch(sheetUrlToCsv(req.body.url));
      if (!r.ok) throw new Error(`Could not read sheet (HTTP ${r.status}). Share it as "Anyone with the link can view".`);
      text = await r.text();
    }
    const list = rowsToClients(parseCSV(text));
    if (!list.length) throw new Error('No valid name/phone rows found');
    res.json(addClients(list));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/clients/:id/status', (req, res) => {
  const c = db.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).end();
  c.status = req.body.status; c.error = null; save(); res.json(c);
});
app.delete('/api/clients/:id', (req, res) => { db.clients = db.clients.filter((x) => x.id !== req.params.id); save(); res.end(); });
app.post('/api/clients/retry-failed', (req, res) => { db.clients.forEach((c) => { if (c.status === 'failed') { c.status = 'pending'; c.error = null; } }); save(); res.end(); });
app.post('/api/clients/clear', (req, res) => { db.clients = []; save(); res.end(); });

app.post('/api/campaign/start', (req, res) => {
  if (wa.state !== 'ready') return res.status(400).json({ error: 'Scan the QR code first' });
  runCampaign();
  res.json({ ok: true });
});
app.post('/api/campaign/stop', (req, res) => { campaign.running = false; campaign.note = 'Stopped'; res.json({ ok: true }); });

app.post('/api/whatsapp/logout', async (req, res) => {
  campaign.running = false;
  try { await client.logout(); } catch {}
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Studio marketing system: http://localhost:${PORT}`));
