import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';
app.get('/', (req, res) => res.send('API is running 🚀'));

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
let ui = 0;

async function fetchECI(path, retries = 3) {
  const url = (path.startsWith('http') ? path : BASE + path);
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA[(ui++) % UA.length],
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Referer': 'https://results.eci.gov.in/',
          'Cache-Control': 'no-cache',
        }
      });
      const text = await res.text();
      console.log(`[${path.slice(-40)}] ${res.status} len=${text.length}`);
      if (res.status === 200 && text.length > 100) return { status: res.status, text };
      throw new Error(`${res.status} len=${text.length}`);
    } catch (e) {
      console.warn(`  retry ${i+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return null;
}

// ✅ Party totals (cached 90s)
let partyCache = { html: null, ts: 0 };
app.get('/api/party', async (req, res) => {
  if (partyCache.html && Date.now() - partyCache.ts < 90_000)
    return res.send(partyCache.html);
  const r = await fetchECI('partywiseresult-S25.htm');
  if (r) { partyCache = { html: r.text, ts: Date.now() }; res.send(r.text); }
  else if (partyCache.html) res.send(partyCache.html);
  else res.status(500).send('ECI unavailable');
});

// ══════════════════════════════════════════
// ✅ SEATMAP — tries multiple ECI endpoints
//    to get constituency-level data
// ══════════════════════════════════════════
let seatmapCache = { data: null, ts: 0 };

function detectParty(text) {
  const t = text.toUpperCase();
  const P = [
    ['BHARATIYA JANATA PARTY','BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS','AITC'],['TRINAMOOL CONGRESS','AITC'],
    ['ALL INDIA SECULAR FRONT','AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK','BGPM'],
    ['AAM JANATA UNNAYAN PARTY','AJUP'],
    ['BAHUJAN SAMAJ PARTY','BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY','RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)','CPI(M)'],['CPIM','CPI(M)'],
    ['COMMUNIST PARTY OF INDIA','CPI'],
    ['INDIAN NATIONAL CONGRESS','INC'],
    [' BJP ','BJP'],['>BJP<','BJP'],
    [' AITC ','AITC'],['>AITC<','AITC'],
    [' INC ','INC'],[' BSP ','BSP'],[' AISF ','AISF'],[' AJUP ','AJUP'],
  ];
  for (const kw of ['LEADING','WON']) {
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

// Parse ALL constituencies from a single HTML page
// (ECI constituency-wise or statewise summary page)
function parseAllConst(html) {
  const doc = new (require('node-html-parser').parse || (() => null))(html);
  // fallback: regex-based parsing
  const seatMap = {};
  // Pattern: look for AC numbers with party info
  const rows = html.split(/<tr[^>]*>/i).slice(1);
  for (const row of rows) {
    const cells = row.split(/<td[^>]*>/i).map(c => c.replace(/<[^>]+>/g, '').trim());
    if (cells.length < 3) continue;
    // Try to find a cell that's a number 1-294
    for (let i = 0; i < cells.length; i++) {
      const num = parseInt(cells[i]);
      if (num >= 1 && num <= 294 && /^\d{1,3}$/.test(cells[i].trim())) {
        const id = num.toString().padStart(3, '0');
        const rowText = cells.join(' ');
        const party = detectParty(rowText);
        if (party) { seatMap[id] = party; break; }
      }
    }
  }
  return seatMap;
}

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 300_000) {
    console.log('Cache hit:', seatmapCache.data.count);
    return res.json(seatmapCache.data);
  }

  console.log('Trying ECI endpoints for constituency data...');

  // ── Try 1: ECI JSON endpoints ──────────────────
  const jsonPaths = [
    'JSONDATA/statewiseS25data.json',
    'jsonData/statewiseS25data.json',
    'data/statewiseS25.json',
    'Data/statewiseS25.json',
    'api/statewiseS25.json',
    'statewiseS25.json',
    'ResultAcGenMay2026.json',
    'S25/statewise.json',
  ];

  for (const path of jsonPaths) {
    const r = await fetchECI(path, 1);
    if (r && r.text.trim().startsWith('[') || r?.text.trim().startsWith('{')) {
      try {
        const json = JSON.parse(r.text);
        console.log('✅ JSON found at:', path);
        // Try to extract seatMap from JSON
        const seatMap = {};
        const arr = Array.isArray(json) ? json : (json.data || json.results || []);
        arr.forEach(item => {
          const id = String(item.ac_no || item.AC_NO || item.id || '').padStart(3,'0');
          const party = item.party || item.PARTY || item.party_abbr || '';
          if (id !== '000' && party) seatMap[id] = party.toUpperCase();
        });
        if (Object.keys(seatMap).length > 0) {
          const out = { seatMap, count: Object.keys(seatMap).length, source: 'eci-json:'+path };
          seatmapCache = { data: out, ts: Date.now() };
          return res.json(out);
        }
      } catch {}
    }
  }

  // ── Try 2: Constituency-wise HTML page ─────────
  const htmlPaths = [
    'constituencywiseresult-S25.htm',
    'ConstituencywiseResult-S25.htm',
    'acwiseresult-S25.htm',
    'statewiseresult-S25.htm',
    'Statewise-S25.htm',
  ];

  for (const path of htmlPaths) {
    const r = await fetchECI(path, 2);
    if (r) {
      console.log('✅ HTML page found:', path, 'len=', r.text.length);
      const seatMap = parseAllConst(r.text);
      console.log('Parsed:', Object.keys(seatMap).length, 'constituencies');
      if (Object.keys(seatMap).length > 10) {
        const out = { seatMap, count: Object.keys(seatMap).length, source: path };
        seatmapCache = { data: out, ts: Date.now() };
        return res.json(out);
      }
      // Return raw HTML for debugging
      console.log('Preview:', r.text.substring(0, 500));
    }
  }

  // ── Try 3: Individual pages (sequential, slow) ─
  console.log('Falling back to individual pages...');
  const seatMap = {};
  const ids = Array.from({length:294}, (_,i) => (i+1).toString().padStart(3,'0'));
  let ok = 0;

  for (const id of ids) {
    const r = await fetchECI(`statewiseS25${id}.htm`, 1);
    if (r) {
      const p = detectParty(r.text);
      if (p) { seatMap[id] = p; ok++; }
    }
    await new Promise(r => setTimeout(r, 150));
    if (ok > 0 && ok % 30 === 0) console.log(`Individual: ${ok} done`);
  }

  const out = { seatMap, count: Object.keys(seatMap).length, source: 'individual', errors: 294 - ok };
  if (out.count > 0) seatmapCache = { data: out, ts: Date.now() };
  res.json(out);
});

// Debug: try a specific path
app.get('/api/try', async (req, res) => {
  const path = req.query.path || 'constituencywiseresult-S25.htm';
  const r = await fetchECI(path, 1);
  res.setHeader('Content-Type','text/plain');
  res.send(r ? `✅ ${path}\nstatus=${r.status} len=${r.text.length}\n\n${r.text.substring(0,2000)}` : `❌ ${path} failed`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
