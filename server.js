import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

// ✅ Health check
app.get('/', (req, res) => {
  res.send('API is running 🚀');
});

// 🔥 Common headers
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://results.eci.gov.in/",
  "Origin": "https://results.eci.gov.in",
  "Connection": "keep-alive"
};

// 🔁 Retry function
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      if (text.includes("Access Denied")) throw new Error("Blocked");
      return text;
    } catch (err) {
      console.log(`Retry ${i + 1} failed for ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 800));
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
    console.error(e);
    res.status(500).send('Failed to fetch party data');
  }
});

// ✅ CONSTITUENCY DATA (single)
app.get('/api/const/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');
    const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`);
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to fetch constituency');
  }
});

// ══════════════════════════════════════════
// 🔥 BETTER PARTY DETECTION
// ECI page mein "LEADING"/"WON" ke paas party name hoti hai
// ══════════════════════════════════════════
function detectParty(html) {
  const t = html.toUpperCase();

  const patterns = [
    ['BHARATIYA JANATA PARTY', 'BJP'],
    ['ALL INDIA TRINAMOOL CONGRESS', 'AITC'],
    ['TRINAMOOL CONGRESS', 'AITC'],
    ['ALL INDIA SECULAR FRONT', 'AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK MORCHA', 'BGPM'],
    ['GORKHA NATIONAL LIBERATION FRONT', 'GNLF'],
    ['AAM JANATA UNNAYAN PARTY', 'AJUP'],
    ['BAHUJAN SAMAJ PARTY', 'BSP'],
    ['REVOLUTIONARY SOCIALIST PARTY', 'RSP'],
    ['COMMUNIST PARTY OF INDIA  (MARXIST)', 'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)', 'CPI(M)'],
    ['CPI(M)', 'CPI(M)'],
    ['CPIM', 'CPI(M)'],
    ['COMMUNIST PARTY OF INDIA', 'CPI'],
    ['INDIAN NATIONAL CONGRESS', 'INC'],
  ];

  // "LEADING" / "WON" ke 500 chars pehle party name dhundho
  const leadingIdx = t.indexOf('LEADING');
  const wonIdx = t.indexOf('WON');
  const statusIdx = Math.min(
    leadingIdx > -1 ? leadingIdx : Infinity,
    wonIdx > -1 ? wonIdx : Infinity
  );

  if (statusIdx !== Infinity) {
    const nearText = t.substring(Math.max(0, statusIdx - 500), statusIdx + 100);
    for (const [pattern, abbr] of patterns) {
      if (nearText.includes(pattern)) return abbr;
    }
  }

  // Fallback: full page scan
  for (const [pattern, abbr] of patterns) {
    if (t.includes(pattern)) return abbr;
  }

  return 'OTH';
}

// ✅ DEBUG endpoint — single seat check karo
// Browser mein kholo: https://wb-election-api.onrender.com/api/debug/001
app.get('/api/debug/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');
    const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`);
    const party = detectParty(html);

    const t = html.toUpperCase();
    const idx = Math.max(0, t.indexOf('LEADING') - 600);
    const snippet = html.substring(idx, idx + 1000);

    res.json({ id, party, htmlLength: html.length, snippet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ✅ SEATMAP — all 294 seats, cached 3 min
// ══════════════════════════════════════════
let seatmapCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 180_000) {
    console.log(`✅ Cache hit — ${seatmapCache.data.count} seats`);
    return res.json(seatmapCache.data);
  }

  console.log('🔄 Fetching all 294 constituencies...');
  const seatMap = {};
  const errors = [];

  const ids = Array.from({ length: 294 }, (_, i) =>
    (i + 1).toString().padStart(3, '0')
  );

  const BATCH_SIZE = 15;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async id => {
      try {
        const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`, 2);
        if (html && html.length > 300) {
          const party = detectParty(html);
          seatMap[id] = party;
          if (party === 'OTH') console.log(`⚠️  OTH seat ${id} (len:${html.length})`);
        }
      } catch {
        errors.push(id);
        console.log(`❌ Failed: seat ${id}`);
      }
    }));

    console.log(`✅ ${Math.min(i + BATCH_SIZE, 294)}/294 — mapped: ${Object.keys(seatMap).length}`);

    if (i + BATCH_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const out = { seatMap, count: Object.keys(seatMap).length, errors: errors.length };
  seatmapCache = { data: out, ts: Date.now() };
  console.log(`🗺️  Done: ${out.count} seats, ${out.errors} errors`);

  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});
