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

// 🔥 Common headers (VERY IMPORTANT)
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
      if (text.includes("Access Denied")) {
        throw new Error("Blocked");
      }
      return text;
    } catch (err) {
      console.log(`Retry ${i + 1} failed for ${url}`);
      await new Promise(r => setTimeout(r, 1000));
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
// ✅ SEATMAP API — server fetches all 294
//    constituencies & returns { seatMap, count }
//    Cached for 2 minutes to avoid hammering ECI
// ══════════════════════════════════════════

let seatmapCache = { data: null, ts: 0 };

function detectParty(html) {
  const t = html.toUpperCase();
  if (t.includes('BHARATIYA JANATA'))                                      return 'BJP';
  if (t.includes('TRINAMOOL'))                                             return 'AITC';
  if (t.includes('MARXIST'))                                               return 'CPI(M)';
  if (t.includes('UNNAYAN'))                                               return 'AJUP';
  if (t.includes('GORKHA'))                                                return 'BGPM';
  if (t.includes('ALL INDIA SECULAR FRONT'))                               return 'AISF';
  if (t.includes('BAHUJAN'))                                               return 'BSP';
  if (t.includes('REVOLUTIONARY SOCIALIST'))                               return 'RSP';
  if (t.includes('INDIAN NATIONAL CONGRESS') || / INC /.test(t))         return 'INC';
  if (t.includes('COMMUNIST PARTY OF INDIA'))                              return 'CPI';
  return 'OTH';
}

app.get('/api/seatmap', async (req, res) => {
  // Serve from cache if < 2 minutes old
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 120_000) {
    console.log('✅ Seatmap served from cache');
    return res.json(seatmapCache.data);
  }

  console.log('🔄 Fetching all 294 constituencies...');
  const seatMap = {};

  const ids = Array.from({ length: 294 }, (_, i) =>
    (i + 1).toString().padStart(3, '0')
  );

  const BATCH_SIZE = 20; // parallel requests per batch

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async id => {
      try {
        const html = await fetchWithRetry(BASE + `statewiseS25${id}.htm`, 2);
        if (html && html.length > 300) {
          seatMap[id] = detectParty(html);
        }
      } catch {
        console.log(`❌ Failed: seat ${id}`);
      }
    }));

    console.log(`✅ Batch done: ${Math.min(i + BATCH_SIZE, 294)} / 294`);
  }

  const out = { seatMap, count: Object.keys(seatMap).length };
  seatmapCache = { data: out, ts: Date.now() };

  console.log(`🗺️ Seatmap ready: ${out.count} seats`);
  res.json(out);
});

// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});
