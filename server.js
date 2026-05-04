import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI_ROOT = 'https://results.eci.gov.in/';
const ECI_BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

// ══════════════════════════════════════════
// SESSION MANAGEMENT
// ECI needs cookies from the main page
// ══════════════════════════════════════════
let session = { cookies: '', ts: 0 };

async function getSession() {
  if (session.cookies && Date.now() - session.ts < 600_000) return session.cookies;
  try {
    console.log('Getting ECI session...');
    const res = await fetch(ECI_ROOT, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      redirect: 'follow',
    });
    // Collect all Set-Cookie headers
    const raw = res.headers.raw()['set-cookie'] || [];
    const cookies = raw.map(c => c.split(';')[0]).join('; ');
    console.log('Session cookies:', cookies || '(none)');
    session = { cookies, ts: Date.now() };
    return cookies;
  } catch (e) {
    console.warn('Session fetch failed:', e.message);
    return '';
  }
}

async function eciGet(path, extraHdrs = {}) {
  const cookies = await getSession();
  const url = path.startsWith('http') ? path : ECI_BASE + path;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Referer': ECI_BASE,
        'Cookie': cookies,
        ...extraHdrs,
      },
    });
    const text = await res.text();
    console.log(`[${res.status}] ${path.slice(-50)} len=${text.length}`);
    return { ok: res.status === 200 && text.length > 300 && !text.includes('Access Denied'), status: res.status, text };
  } catch (e) {
    console.warn(`FAIL ${path}: ${e.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// ══════════════════════════════════════════
// PARTY TOTALS
// ══════════════════════════════════════════
let partyCache = { html: null, ts: 0 };
app.get('/api/party', async (req, res) => {
  if (partyCache.html && Date.now() - partyCache.ts < 90_000)
    return res.send(partyCache.html);
  const r = await eciGet('partywiseresult-S25.htm');
  if (r.ok) partyCache = { html: r.text, ts: Date.now() };
  partyCache.html ? res.send(partyCache.html) : res.status(500).send('ECI unavailable');
});

// ══════════════════════════════════════════
// PARTY DETECTION
// ══════════════════════════════════════════
function detectParty(html) {
  const t = html.toUpperCase();
  const P = [
    ['BHARATIYA JANATA PARTY', 'BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS', 'AITC'], ['TRINAMOOL CONGRESS', 'AITC'],
    ['ALL INDIA SECULAR FRONT', 'AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK', 'BGPM'],
    ['AAM JANATA UNNAYAN PARTY', 'AJUP'],
    ['BAHUJAN SAMAJ PARTY', 'BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY', 'RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)', 'CPI(M)'], ['CPIM', 'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA', 'CPI'],
    ['INDIAN NATIONAL CONGRESS', 'INC'],
    [' BJP ', 'BJP'], ['"BJP"', 'BJP'], ['>BJP<', 'BJP'],
    [' AITC ', 'AITC'], ['"AITC"', 'AITC'],
    [' INC ', 'INC'], [' BSP ', 'BSP'], [' AISF ', 'AISF'], [' AJUP ', 'AJUP'],
  ];
  for (const kw of ['LEADING', 'WON']) {
    let pos = 0;
    while (pos < t.length) {
      const idx = t.indexOf(kw, pos);
      if (idx === -1) break;
      const before = t.substring(Math.max(0, idx - 800), idx);
      for (const [p, a] of P) if (before.includes(p)) return a;
      pos = idx + 1;
    }
  }
  for (const [p, a] of P) if (t.includes(p)) return a;
  return null;
}

// ══════════════════════════════════════════
// TEST: single constituency with session
// Open: /api/consttest/001
// ══════════════════════════════════════════
app.get('/api/consttest/:id', async (req, res) => {
  const id = req.params.id.padStart(3, '0');
  const r = await eciGet(`statewiseS25${id}.htm`);
  const party = r.ok ? detectParty(r.text) : null;
  res.setHeader('Content-Type', 'text/plain');
  res.send(
    `Seat ${id}: status=${r.status} ok=${r.ok} party=${party}\n` +
    `Cookie used: ${session.cookies || '(none)'}\n\n` +
    `First 2000 chars:\n${r.text.slice(0, 2000)}`
  );
});

// ══════════════════════════════════════════
// SEATMAP — session-based batch fetch
// ══════════════════════════════════════════
let smCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (smCache.data && Date.now() - smCache.ts < 300_000) {
    console.log('Cache hit:', smCache.data.count);
    return res.json(smCache.data);
  }

  // Refresh session before batch fetch
  await getSession();

  const seatMap = {}, failed = [];
  const ids = Array.from({ length: 294 }, (_, i) => (i + 1).toString().padStart(3, '0'));
  const BATCH = 8;

  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async id => {
      const r = await eciGet(`statewiseS25${id}.htm`);
      if (r.ok) {
        const p = detectParty(r.text);
        if (p) seatMap[id] = p; else failed.push(id + '(OTH)');
      } else {
        failed.push(id + `(${r.status})`);
      }
    }));
    await new Promise(r => setTimeout(r, 300));
    console.log(`${Math.min(i + BATCH, 294)}/294 | mapped:${Object.keys(seatMap).length}`);
  }

  const out = {
    seatMap,
    count: Object.keys(seatMap).length,
    failed: failed.slice(0, 20),
    source: 'eci-session',
  };
  if (out.count > 0) smCache = { data: out, ts: Date.now() };
  res.json(out);
});

// Generic URL tester
app.get('/api/try', async (req, res) => {
  const url = req.query.url || (req.query.path ? ECI_BASE + req.query.path : null);
  if (!url) return res.status(400).send('?url= required');
  const r = await eciGet(url);
  res.setHeader('Content-Type', 'text/plain');
  res.send(`${r.ok ? '✅' : '❌'} ${url}\nstatus=${r.status} cookie=${session.cookies || 'none'}\nlen=${r.text.length}\n\n${r.text.slice(0, 3000)}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API on port ${PORT}`));
