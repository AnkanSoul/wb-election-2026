import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

app.get('/', (req, res) => res.send('API is running 🚀'));

// Rotate User-Agents to avoid ECI blocking
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
let uaIdx = 0;
function nextUA() { return UAS[uaIdx++ % UAS.length]; }

async function fetchECI(path, retries = 3) {
  const url = BASE + path;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': nextUA(),
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Referer': 'https://results.eci.gov.in/',
          'Cache-Control': 'no-cache',
        }
      });
      const text = await res.text();
      console.log(`[${path}] status=${res.status} len=${text.length}`);
      if (res.status === 200 && text.length > 300) return text;
      throw new Error(`status=${res.status} len=${text.length}`);
    } catch (e) {
      console.warn(`  retry ${i+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return null;
}

// ✅ Party data (cached 90s)
let partyCache = { html: null, ts: 0 };
app.get('/api/party', async (req, res) => {
  if (partyCache.html && Date.now() - partyCache.ts < 90_000) {
    return res.send(partyCache.html);
  }
  const html = await fetchECI('partywiseresult-S25.htm');
  if (html) {
    partyCache = { html, ts: Date.now() };
    res.send(html);
  } else {
    // Return cached if available, else 500
    if (partyCache.html) res.send(partyCache.html);
    else res.status(500).send('ECI temporarily unavailable');
  }
});

// ✅ Single constituency (for browser fallback)
app.get('/api/const/:id', async (req, res) => {
  const id = req.params.id.padStart(3, '0');
  const html = await fetchECI(`statewiseS25${id}.htm`);
  if (html) res.send(html);
  else res.status(503).send('unavailable');
});

// ✅ Seatmap - fetch slowly, one at a time to avoid IP block
let seatmapCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 300_000) {
    return res.json(seatmapCache.data);
  }

  const seatMap = {}, failed = [];
  const ids = Array.from({ length: 294 }, (_, i) => (i + 1).toString().padStart(3, '0'));

  // Sequential with delay — avoids IP block
  for (const id of ids) {
    const html = await fetchECI(`statewiseS25${id}.htm`, 1);
    if (html) {
      seatMap[id] = detectParty(html);
    } else {
      failed.push(id);
    }
    await new Promise(r => setTimeout(r, 200)); // 200ms between requests
  }

  const out = { seatMap, count: Object.keys(seatMap).length, errors: failed.length };
  if (out.count > 0) seatmapCache = { data: out, ts: Date.now() };
  res.json(out);
});

function detectParty(html) {
  const t = html.toUpperCase();
  const patterns = [
    ['BHARATIYA JANATA PARTY', 'BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS', 'AITC'],
    ['TRINAMOOL CONGRESS', 'AITC'],
    ['ALL INDIA SECULAR FRONT', 'AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK', 'BGPM'],
    ['AAM JANATA UNNAYAN PARTY', 'AJUP'],
    ['BAHUJAN SAMAJ PARTY', 'BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY', 'RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)', 'CPI(M)'],
    ['CPIM', 'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA', 'CPI'],
    ['INDIAN NATIONAL CONGRESS', 'INC'],
    [' BJP ', 'BJP'], ['>BJP<', 'BJP'],
    [' AITC ', 'AITC'], ['>AITC<', 'AITC'],
    [' INC ', 'INC'], [' BSP ', 'BSP'],
    [' AISF ', 'AISF'], [' AJUP ', 'AJUP'],
  ];
  for (const kw of ['LEADING', 'WON']) {
    let pos = 0;
    while (pos < t.length) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
