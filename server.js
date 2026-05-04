import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

app.get('/', (req, res) => res.send('API is running 🚀'));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://results.eci.gov.in/",
  "Connection": "keep-alive"
};

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      if (text.includes("Access Denied") || text.length < 200) {
        throw new Error(`Bad response: len=${text.length}`);
      }
      return text;
    } catch (err) {
      console.log(`Retry ${i + 1}/${retries} failed for ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("All retries failed");
}

// ✅ PARTY DATA
app.get('/api/party', async (req, res) => {
  try {
    const html = await fetchWithRetry(BASE + 'partywiseresult-S25.htm');
    res.send(html);
  } catch (e) {
    res.status(500).send('Failed: ' + e.message);
  }
});

// ✅ SINGLE CONSTITUENCY RAW HTML — debug tool
// Open in browser: https://wb-election-api.onrender.com/api/raw/001
app.get('/api/raw/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');
    const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`);
    // Return as plain text so browser shows it clearly
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(`=== SEAT ${id} | len=${html.length} ===\n\n${html}`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ══════════════════════════════════════════
// 🔥 PARTY DETECTION — handles ALL ECI formats
// ECI pages use full names AND abbreviations
// ══════════════════════════════════════════
function detectParty(html) {
  const t = html.toUpperCase();

  // Each entry: [match_string, return_abbr]
  // Order matters — specific first, generic last
  const patterns = [
    // Full names
    ['BHARATIYA JANATA PARTY',            'BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS',      'AITC'],
    ['TRINAMOOL CONGRESS',                'AITC'],
    ['ALL INDIA SECULAR FRONT',           'AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK',     'BGPM'],
    ['GORKHA NATIONAL LIBERATION FRONT',  'GNLF'],
    ['AAM JANATA UNNAYAN PARTY',          'AJUP'],
    ['BAHUJAN SAMAJ PARTY',              'BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY',    'RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)','CPI(M)'],
    ['COMMUNIST PARTY OF INDIA  (MARXIST)','CPI(M)'],
    ['CPIM',                             'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA',         'CPI'],
    ['INDIAN NATIONAL CONGRESS',         'INC'],
    // Abbreviations (ECI pages sometimes show these)
    [' BJP ',   'BJP'],
    ['>BJP<',   'BJP'],
    ['(BJP)',    'BJP'],
    [' AITC ',  'AITC'],
    ['>AITC<',  'AITC'],
    ['(AITC)',   'AITC'],
    [' INC ',   'INC'],
    ['>INC<',   'INC'],
    ['(INC)',    'INC'],
    [' BSP ',   'BSP'],
    [' RSP ',   'RSP'],
    [' CPI ',   'CPI'],
    [' AISF ',  'AISF'],
    [' AJUP ',  'AJUP'],
    [' BGPM ',  'BGPM'],
  ];

  // Strategy 1: Find LEADING/WON row and check nearby text
  // ECI page has: <td>Candidate</td><td>Party</td><td>Votes</td><td>Status</td>
  // Status "LEADING" or "WON" appears AFTER party name in same row
  for (const keyword of ['LEADING', 'WON']) {
    let pos = 0;
    while (true) {
      const idx = t.indexOf(keyword, pos);
      if (idx === -1) break;
      // Check 800 chars before this keyword (covers the whole table row)
      const before = t.substring(Math.max(0, idx - 800), idx);
      for (const [pat, abbr] of patterns) {
        if (before.includes(pat)) return abbr;
      }
      pos = idx + 1;
    }
  }

  // Strategy 2: Full page scan (fallback)
  for (const [pat, abbr] of patterns) {
    if (t.includes(pat)) return abbr;
  }

  return 'OTH';
}

// ✅ SINGLE CONSTITUENCY (JSON)
app.get('/api/const/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');
    const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`);
    const party = detectParty(html);
    res.send(html);
  } catch (e) {
    res.status(500).send('Failed: ' + e.message);
  }
});

// ✅ DEBUG — shows detected party + relevant snippet
app.get('/api/debug/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');
    const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`);
    const party = detectParty(html);
    const t = html.toUpperCase();

    // Find LEADING/WON position
    const leadPos = t.indexOf('LEADING');
    const wonPos  = t.indexOf('WON');
    const statusPos = Math.min(
      leadPos > -1 ? leadPos : Infinity,
      wonPos  > -1 ? wonPos  : Infinity
    );

    const snippetStart = statusPos !== Infinity
      ? Math.max(0, statusPos - 800) : 0;
    const snippet = html.substring(snippetStart, snippetStart + 1200);

    res.json({
      id,
      party,
      htmlLength: html.length,
      leadingAt: leadPos,
      wonAt: wonPos,
      snippet
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ✅ SEATMAP — all 294, cached 3 min
// ══════════════════════════════════════════
let seatmapCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 180_000) {
    console.log(`✅ Cache — ${seatmapCache.data.count} seats`);
    return res.json(seatmapCache.data);
  }

  console.log('🔄 Fetching 294 seats...');
  const seatMap = {};
  const failed  = [];
  const othList = []; // log OTH seats for debugging

  const ids = Array.from({ length: 294 }, (_, i) =>
    (i + 1).toString().padStart(3, '0')
  );

  const BATCH = 10; // smaller batch = less ECI rate-limit risk

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    await Promise.all(batch.map(async id => {
      try {
        const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`, 2);
        const party = detectParty(html);
        seatMap[id] = party;
        if (party === 'OTH') othList.push(id);
      } catch {
        failed.push(id);
      }
    }));

    const done = Math.min(i + BATCH, 294);
    console.log(`${done}/294 | mapped:${Object.keys(seatMap).length} | oth:${othList.length} | fail:${failed.length}`);
    await new Promise(r => setTimeout(r, 400)); // breathing room
  }

  console.log('OTH seats:', othList.slice(0, 20));
  console.log('Failed:', failed.slice(0, 20));

  const out = {
    seatMap,
    count:   Object.keys(seatMap).length,
    errors:  failed.length,
    othCount: othList.length,
    othSample: othList.slice(0, 10),
    generated: new Date().toISOString()
  };

  seatmapCache = { data: out, ts: Date.now() };
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
