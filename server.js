import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

app.get('/', (req, res) => res.send('API is running 🚀'));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://results.eci.gov.in/ResultAcGenMay2026/index.htm",
  "Connection": "keep-alive",
  "Cache-Control": "no-cache"
};

async function fetchPage(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      console.log(`[FETCH] ${url} → status=${res.status} len=${text.length}`);
      if (res.status === 200 && text.length > 200) return { ok: true, text, status: res.status };
      throw new Error(`status=${res.status} len=${text.length}`);
    } catch (err) {
      console.log(`  Retry ${i + 1}/${retries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { ok: false, text: '', status: 0 };
}

// ✅ PARTY DATA
app.get('/api/party', async (req, res) => {
  const r = await fetchPage(BASE + 'partywiseresult-S25.htm');
  if (r.ok) res.send(r.text);
  else res.status(500).send('Failed to fetch party data');
});

// ══════════════════════════════════════════
// 🔍 DIAGNOSE: Returns full party page HTML
// Use to find constituency links / structure
// Open: https://wb-election-api.onrender.com/api/partyraw
// ══════════════════════════════════════════
app.get('/api/partyraw', async (req, res) => {
  const r = await fetchPage(BASE + 'partywiseresult-S25.htm');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (r.ok) {
    // Extract all href links from the page
    const links = [...r.text.matchAll(/href=["']([^"']+)["']/gi)]
      .map(m => m[1])
      .filter(l => l.includes('S25') || l.includes('statewise') || l.includes('const'));
    
    res.send(
      `=== PARTY PAGE HTML (len=${r.text.length}) ===\n\n` +
      `=== CONSTITUENCY LINKS FOUND (${links.length}) ===\n` +
      links.join('\n') +
      `\n\n=== FULL HTML ===\n` +
      r.text
    );
  } else {
    res.status(500).send('Failed');
  }
});

// ══════════════════════════════════════════
// 🔍 DIAGNOSE: Try multiple constituency URL patterns
// Open: https://wb-election-api.onrender.com/api/urltest
// ══════════════════════════════════════════
app.get('/api/urltest', async (req, res) => {
  const urlsToTry = [
    BASE + 'statewiseS25001.htm',
    BASE + 'statewiseS25-1.htm',
    BASE + 'constituencyS25001.htm',
    BASE + 'constS25001.htm',
    BASE + 'acwiseS25001.htm',
    BASE + 'AcS25001.htm',
    BASE + 'candidateS25001.htm',
    BASE + 'ResultAcS25001.htm',
    'https://results.eci.gov.in/ResultAcGenMay2026/statewiseS25001.htm',
    'https://results.eci.gov.in/statewiseS25001.htm',
  ];

  const results = [];
  for (const url of urlsToTry) {
    const r = await fetchPage(url, 1);
    results.push({
      url,
      status: r.status,
      len: r.text.length,
      preview: r.text.slice(0, 150).replace(/\s+/g, ' ')
    });
  }

  res.setHeader('Content-Type', 'application/json');
  res.json(results);
});

// ✅ SINGLE CONSTITUENCY RAW
app.get('/api/raw/:id', async (req, res) => {
  const id = req.params.id.padStart(3, '0');
  const r = await fetchPage(BASE + `statewiseS25${id}.htm`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (r.ok) res.send(`=== SEAT ${id} | len=${r.text.length} ===\n\n${r.text}`);
  else res.status(500).send(`Error: status=${r.status} len=${r.text.length}\nTry /api/urltest to find correct URL`);
});

// ══════════════════════════════════════════
// 🔥 PARTY DETECTION
// ══════════════════════════════════════════
function detectParty(html) {
  const t = html.toUpperCase();
  const patterns = [
    ['BHARATIYA JANATA PARTY',            'BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS',      'AITC'],
    ['TRINAMOOL CONGRESS',                'AITC'],
    ['ALL INDIA SECULAR FRONT',           'AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK',     'BGPM'],
    ['GORKHA NATIONAL LIBERATION FRONT',  'GNLF'],
    ['AAM JANATA UNNAYAN PARTY',          'AJUP'],
    ['BAHUJAN SAMAJ PARTY',              'BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY',    'RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)', 'CPI(M)'],
    ['CPIM',                             'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA',         'CPI'],
    ['INDIAN NATIONAL CONGRESS',         'INC'],
    [' BJP ',  'BJP'], ['>BJP<',  'BJP'], ['(BJP)',  'BJP'],
    [' AITC ', 'AITC'],['>AITC<', 'AITC'],['(AITC)', 'AITC'],
    [' INC ',  'INC'], ['>INC<',  'INC'], ['(INC)',  'INC'],
    [' BSP ',  'BSP'], [' RSP ',  'RSP'], [' CPI ',  'CPI'],
    [' AISF ', 'AISF'],[' AJUP ', 'AJUP'],[' BGPM ', 'BGPM'],
  ];
  for (const kw of ['LEADING', 'WON']) {
    let pos = 0;
    while (true) {
      const idx = t.indexOf(kw, pos);
      if (idx === -1) break;
      const before = t.substring(Math.max(0, idx - 800), idx);
      for (const [pat, abbr] of patterns) if (before.includes(pat)) return abbr;
      pos = idx + 1;
    }
  }
  for (const [pat, abbr] of patterns) if (t.includes(pat)) return abbr;
  return 'OTH';
}

// ✅ DEBUG JSON
app.get('/api/debug/:id', async (req, res) => {
  const id = req.params.id.padStart(3, '0');
  const r = await fetchPage(BASE + `statewiseS25${id}.htm`);
  if (!r.ok) return res.status(500).json({ error: 'fetch failed', status: r.status });
  const party = detectParty(r.text);
  const t = r.text.toUpperCase();
  const leadPos = t.indexOf('LEADING');
  const wonPos  = t.indexOf('WON');
  const statusPos = Math.min(leadPos > -1 ? leadPos : Infinity, wonPos > -1 ? wonPos : Infinity);
  const snippet = statusPos !== Infinity
    ? r.text.substring(Math.max(0, statusPos - 800), statusPos + 400)
    : r.text.substring(0, 1000);
  res.json({ id, party, htmlLength: r.text.length, leadingAt: leadPos, wonAt: wonPos, snippet });
});

// ✅ SEATMAP
let seatmapCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 180_000) {
    return res.json(seatmapCache.data);
  }
  const seatMap = {}, failed = [], othList = [];
  const ids = Array.from({ length: 294 }, (_, i) => (i + 1).toString().padStart(3, '0'));
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async id => {
      const r = await fetchPage(BASE + `statewiseS25${id}.htm`, 2);
      if (r.ok) {
        const party = detectParty(r.text);
        seatMap[id] = party;
        if (party === 'OTH') othList.push(id);
      } else failed.push(id);
    }));
    await new Promise(r => setTimeout(r, 400));
  }
  const out = { seatMap, count: Object.keys(seatMap).length, errors: failed.length, othCount: othList.length, othSample: othList.slice(0, 10), failSample: failed.slice(0, 10) };
  seatmapCache = { data: out, ts: Date.now() };
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
