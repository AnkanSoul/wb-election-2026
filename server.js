import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI = 'https://results.eci.gov.in/ResultAcGenMay2026/';

async function get(url, hdrs = {}, ms = 12000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': '*/*',
        ...hdrs,
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    console.log(`[${res.status}] ${url.slice(-70)} len=${text.length}`);
    return { ok: res.status === 200 && text.length > 50, status: res.status, text };
  } catch (e) {
    console.warn(`FAIL ${url.slice(-50)}: ${e.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// ══════════════════════════════════════════
// ✅ PARTY TOTALS
// ══════════════════════════════════════════
let partyCache = { html: null, ts: 0 };
app.get('/api/party', async (req, res) => {
  if (partyCache.html && Date.now() - partyCache.ts < 90_000)
    return res.send(partyCache.html);
  const r = await get(ECI + 'partywiseresult-S25.htm', { Referer: 'https://results.eci.gov.in/' });
  if (r.ok) partyCache = { html: r.text, ts: Date.now() };
  partyCache.html ? res.send(partyCache.html) : res.status(500).send('ECI unavailable');
});

// ══════════════════════════════════════════
// 🔍 DEBUG: test any URL from Render server
// ══════════════════════════════════════════
app.get('/api/try', async (req, res) => {
  const url = req.query.url || (req.query.path ? ECI + req.query.path : null);
  if (!url) return res.status(400).send('?url= required');
  const r = await get(url, {}, 15000);
  res.setHeader('Content-Type', 'text/plain');
  res.send(`${r.ok ? '✅' : '❌'} ${url}\nstatus=${r.status} len=${r.text.length}\n\n${r.text.slice(0, 4000)}`);
});

// ══════════════════════════════════════════
// 🔥 SEATMAP: tries multiple sources
// ══════════════════════════════════════════
let smCache = { data: null, ts: 0 };

function norm(s) {
  const t = (s || '').toUpperCase();
  if (t.match(/\bBJP\b/) || t.includes('BHARATIYA JANATA')) return 'BJP';
  if (t.match(/\b(AITC|TMC)\b/) || t.includes('TRINAMOOL')) return 'AITC';
  if (t.includes('AISF') || t.includes('SECULAR FRONT')) return 'AISF';
  if (t.includes('BGPM') || t.includes('GORKHA PRAJATANTRIK')) return 'BGPM';
  if (t.includes('GNLF') || t.includes('GORKHA NATIONAL')) return 'GNLF';
  if (t.includes('AJUP') || t.includes('UNNAYAN')) return 'AJUP';
  if (t.includes('BSP') || t.includes('BAHUJAN')) return 'BSP';
  if (t.includes('RSP') || t.includes('REVOLUTIONARY SOCIALIST')) return 'RSP';
  if (t.match(/CPI\s*\(M\)/) || t.includes('CPIM') || t.includes('MARXIST')) return 'CPI(M)';
  if (t.match(/\bCPI\b/) || t.includes('COMMUNIST PARTY OF INDIA')) return 'CPI';
  if (t.match(/\bINC\b/) || t.includes('INDIAN NATIONAL CONGRESS')) return 'INC';
  return null;
}

// ── Source 1: ECI index page → find JS data files ──
async function fromECIIndex() {
  console.log('Trying ECI index page...');
  const r = await get(ECI + 'index.htm', { Referer: 'https://results.eci.gov.in/' });
  if (!r.ok) return null;
  
  // Extract all JS/JSON file URLs from the index page
  const jsFiles = [...r.text.matchAll(/["']([\w\-/]+\.(?:js|json))["']/g)].map(m => m[1]);
  const dataUrls = [...r.text.matchAll(/fetch\s*\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  console.log('JS files found:', jsFiles.slice(0,10));
  console.log('Fetch URLs:', dataUrls.slice(0,10));

  // Try each JS file looking for constituency data
  for (const file of [...jsFiles, ...dataUrls].slice(0, 15)) {
    const url = file.startsWith('http') ? file : ECI + file;
    const jr = await get(url);
    if (jr.ok && jr.text.length > 500) {
      // Check if it contains constituency data
      if (jr.text.includes('S25') || jr.text.includes('constituency') || jr.text.includes('AC_NO')) {
        console.log('Found data in:', file);
        return { raw: jr.text, source: 'eci-js:'+file };
      }
    }
  }
  return null;
}

// ── Source 2: NDTV election API ──
async function fromNDTV() {
  console.log('Trying NDTV...');
  const urls = [
    'https://resultapi.ndtv.com/live/results/ac/wb/2026/?format=json',
    'https://resultapi.ndtv.com/live/results/wb/assembly/2026/',
    'https://elections.ndtv.com/results/liveresultapi/?state=wb&election_type=assembly&year=2026',
  ];
  for (const url of urls) {
    const r = await get(url, { Referer: 'https://elections.ndtv.com/' });
    if (r.ok) {
      console.log('NDTV found at:', url);
      return { raw: r.text, source: 'ndtv' };
    }
  }
  return null;
}

// ── Source 3: India Today / Aaj Tak ──
async function fromIndiaToday() {
  console.log('Trying India Today...');
  const urls = [
    'https://elections.indiatoday.in/api/results/assembly/2026/west-bengal',
    'https://elections.indiatoday.in/results/assembly-elections-2026/west-bengal',
  ];
  for (const url of urls) {
    const r = await get(url, { Referer: 'https://elections.indiatoday.in/' });
    if (r.ok) {
      console.log('India Today found at:', url);
      return { raw: r.text, source: 'indiatoday' };
    }
  }
  return null;
}

// ── Parse seatmap from raw JSON/HTML ──
function parseRaw(raw, source) {
  const seatMap = {};
  
  // Try JSON first
  try {
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json : (json.data || json.results || json.constituencies || []);
    arr.forEach(item => {
      const id = String(item.ac_no || item.AC_NO || item.constituency_no || item.id || '').padStart(3,'0');
      const p = norm(item.party || item.party_abbr || item.winning_party || item.result || '');
      if (id !== '000' && p) seatMap[id] = p;
    });
    if (Object.keys(seatMap).length > 0) return seatMap;
  } catch {}

  // Try HTML table parsing
  const rows = raw.split(/<tr[^>]*>/i).slice(1);
  for (const row of rows) {
    const cells = row.split(/<td[^>]*>/i)
      .map(c => c.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim())
      .filter(c => c.length > 0);
    if (cells.length < 2) continue;
    for (let i = 0; i < Math.min(4, cells.length); i++) {
      const n = parseInt(cells[i]);
      if (n >= 1 && n <= 294 && /^\d{1,3}$/.test(cells[i].trim())) {
        const p = norm(cells.join(' '));
        if (p) { seatMap[n.toString().padStart(3,'0')] = p; break; }
      }
    }
  }
  return seatMap;
}

app.get('/api/seatmap', async (req, res) => {
  if (smCache.data && Date.now() - smCache.ts < 300_000) {
    console.log('Cache:', smCache.data.count);
    return res.json(smCache.data);
  }

  let seatMap = null, source = 'none';

  // Try sources in order
  const sources = [
    { name: 'eci-index', fn: fromECIIndex },
    { name: 'ndtv',      fn: fromNDTV },
    { name: 'indiatoday',fn: fromIndiaToday },
  ];

  for (const { name, fn } of sources) {
    const result = await fn();
    if (result) {
      const parsed = parseRaw(result.raw, name);
      if (Object.keys(parsed).length > 10) {
        seatMap = parsed;
        source = result.source || name;
        break;
      }
    }
  }

  const out = { seatMap: seatMap || {}, count: Object.keys(seatMap || {}).length, source };
  if (out.count > 0) smCache = { data: out, ts: Date.now() };
  
  console.log(`Seatmap: ${out.count} seats, source=${source}`);
  res.json(out);
});

// ══════════════════════════════════════════
// 🔍 Source tester — check what's accessible
// Open: /api/sources
// ══════════════════════════════════════════
app.get('/api/sources', async (req, res) => {
  const tests = [
    ECI + 'index.htm',
    ECI + 'statewiseS25001.htm',
    'https://resultapi.ndtv.com/live/results/ac/wb/2026/?format=json',
    'https://elections.indiatoday.in/api/results/assembly/2026/west-bengal',
    'https://en.wikipedia.org/wiki/2026_West_Bengal_legislative_assembly_election',
  ];
  const results = [];
  for (const url of tests) {
    const r = await get(url, {}, 8000);
    results.push({ url, status: r.status, len: r.text.length, preview: r.text.slice(0,100).replace(/\s+/g,' ') });
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API on port ${PORT}`));
