import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI = 'https://results.eci.gov.in/ResultAcGenMay2026/';

async function get(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': '*/*',
        'Referer': 'https://results.eci.gov.in/',
        'Origin': 'https://results.eci.gov.in',
      },
    });
    const text = await res.text();
    console.log(`[${res.status}] ${url.slice(-60)} len=${text.length}`);
    return { ok: res.status === 200 && text.length > 50, status: res.status, text };
  } catch (e) {
    console.warn(`FAIL ${url.slice(-50)}: ${e.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// ══════════════════════════════════════════
// PARSE PARTY TABLE
// ══════════════════════════════════════════
function parseParties(html) {
  if (!html) return null;
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const rows = clean.split(/<tr[^>]*>/i).slice(1);
  const parties = [], seen = new Set();
  let headerFound = false;

  for (const row of rows) {
    const cells = row.replace(/<[^>]+>/g, '\t').split('\t')
      .map(s => s.replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim()).filter(Boolean);
    if (!headerFound) {
      const j = cells.join(' ').toLowerCase();
      if (j.includes('won') && j.includes('leading')) { headerFound = true; }
      continue;
    }
    if (cells.length < 3) continue;
    const name = cells[0];
    if (!name || name.toLowerCase()==='total' || name.toLowerCase()==='party' || name.length < 3) continue;
    const key = name.toLowerCase().replace(/\s+/g,'');
    if (seen.has(key)) continue;
    seen.add(key);
    const nums = cells.slice(1).map(c => parseInt(c.replace(/\D/g,''))).filter(n => !isNaN(n) && n <= 294);
    if (!nums.length) continue;
    const won = nums[0]||0, leading = nums[1]||0, total = nums[2]||(won+leading);
    if (total > 0 || won > 0) parties.push({ name, won, leading, total: Math.max(total, won+leading) });
    if (parties.length > 20) break;
  }
  if (!parties.length) return null;
  parties.sort((a,b) => b.total-a.total);
  const ts = (html.match(/Last Updated[^<]{0,15}:?\s*([^<\n]{5,60})/i)||[])[1]||'';
  return { parties, total_declared: parties.reduce((s,p)=>s+p.total,0), last_updated: ts.trim() };
}

// ══════════════════════════════════════════
// SEATMAP FROM ECI JSON
// election-json-S25-live.json
// chartData format: [party, stateCode, ac_no, candidate, color]
// ══════════════════════════════════════════
async function fetchSeatMap() {
  const r = await get(ECI + 'election-json-S25-live.json');
  if (!r.ok) {
    console.warn('election-json-S25-live.json failed, status=', r.status);
    return null;
  }
  try {
    const data = JSON.parse(r.text);
    const chartData = data?.S25?.chartData;
    if (!chartData || !Array.isArray(chartData)) {
      console.warn('chartData not found. Keys:', Object.keys(data));
      return null;
    }
    const seatMap = {}, colorMap = {};
    chartData.forEach(entry => {
      // [party_name, state_code, ac_no, candidate_name, color_hex]
      const [partyName, , acNo, , color] = entry;
      const id = String(acNo).padStart(3, '0');
      seatMap[id] = partyName;
      colorMap[id] = color;
    });
    console.log(`✅ SeatMap: ${Object.keys(seatMap).length} constituencies`);
    return { seatMap, colorMap };
  } catch (e) {
    console.error('Parse error:', e.message);
    console.log('Raw snippet:', r.text.slice(0, 300));
    return null;
  }
}

// ══════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════
let cache = { data: null, html: null, seatMapData: null, ts: 0, smTs: 0 };

async function refresh() {
  const r = await get(ECI + 'partywiseresult-S25.htm');
  if (!r.ok) { console.warn('ECI party page failed'); return false; }
  const parsed = parseParties(r.text);
  if (parsed?.parties?.length > 0) {
    cache.data = parsed; cache.html = r.text; cache.ts = Date.now();
    console.log(`✅ Parties: ${parsed.parties[0]?.name} ${parsed.parties[0]?.total}`);
    return true;
  }
  return false;
}

async function refreshSeatMap() {
  const sm = await fetchSeatMap();
  if (sm) { cache.seatMapData = sm; cache.smTs = Date.now(); }
}

setInterval(refresh, 90_000);
setInterval(refreshSeatMap, 300_000); // refresh seatmap every 5 min
refresh();
setTimeout(refreshSeatMap, 3000);

// ── Endpoints ──────────────────────────────
// Hardcoded final results (shown when ECI server is unavailable)
const FINAL_RESULTS = {
  parties: [
    { name: 'Bharatiya Janata Party - BJP',          won: 207, leading: 0, total: 207 },
    { name: 'All India Trinamool Congress - AITC',    won: 80,  leading: 0, total: 80  },
    { name: 'Indian National Congress - INC',         won: 2,   leading: 0, total: 2   },
    { name: 'Aam Janata Unnayan party - AJUP',        won: 2,   leading: 0, total: 2   },
    { name: 'Communist Party of India (Marxist) - CPI(M)', won: 1, leading: 0, total: 1 },
    { name: 'All India Secular Front - AISF',         won: 1,   leading: 0, total: 1   },
  ],
  total_declared: 293,
  last_updated: '04:18 PM On 05/05/2026'
};

app.get('/api/results', async (req, res) => {
  if (!cache.data || Date.now() - cache.ts > 90_000) await refresh();
  // Return live data if available, else hardcoded final results (never 500)
  res.json(cache.data || FINAL_RESULTS);
});

app.get('/api/party', async (req, res) => {
  if (!cache.html || Date.now() - cache.ts > 90_000) await refresh();
  if (cache.html) return res.send(cache.html);
  res.status(500).send('ECI unavailable');
});

app.get('/api/seatmap', async (req, res) => {
  if (!cache.seatMapData) await refreshSeatMap();
  const sm = cache.seatMapData;
  res.json({
    seatMap: sm?.seatMap || {},
    colorMap: sm?.colorMap || {},
    count: Object.keys(sm?.seatMap || {}).length,
  });
});

app.get('/api/status', (req, res) => res.json({
  cached: !!cache.data,
  age_sec: cache.ts ? Math.round((Date.now()-cache.ts)/1000) : null,
  leader: cache.data?.parties?.[0]?.name,
  leader_total: cache.data?.parties?.[0]?.total,
  total_declared: cache.data?.total_declared,
  seatmap_count: Object.keys(cache.seatMapData?.seatMap||{}).length,
  seatmap_age_sec: cache.smTs ? Math.round((Date.now()-cache.smTs)/1000) : null,
}));

app.get('/api/raw', async (req, res) => {
  const path = req.query.path || 'partywiseresult-S25.htm';
  const r = await get(ECI + path);
  res.setHeader('Content-Type','text/plain');
  res.send(r.ok ? `OK len=${r.text.length}\n\n${r.text.slice(0,5000)}` : `FAILED status=${r.status}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🔥 API on port ${PORT}`); refresh(); });
