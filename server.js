import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI = 'https://results.eci.gov.in/ResultAcGenMay2026/';

async function get(url, extraHdrs = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': '*/*',
        'Referer': 'https://results.eci.gov.in/',
        ...extraHdrs,
      },
    });
    const text = await res.text();
    console.log(`[${res.status}] ${url.slice(-70)} len=${text.length}`);
    return { ok: res.status === 200 && text.length > 100, status: res.status, text };
  } catch (e) {
    console.warn(`GET fail ${url.slice(-50)}: ${e.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// ══════════════════════════════════════════
// PARSE PARTY PAGE — fixed deduplication
// ══════════════════════════════════════════
function parseParties(html) {
  if (!html) return null;
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const rows = clean.split(/<tr[^>]*>/i).slice(1);
  const parties = [];
  const seen = new Set();
  let headerFound = false;

  for (const row of rows) {
    const cells = row.replace(/<[^>]+>/g, '\t').split('\t')
      .map(s => s.replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim()).filter(Boolean);
    if (!headerFound) {
      const joined = cells.join(' ').toLowerCase();
      if (joined.includes('won') && (joined.includes('leading') || joined.includes('trend'))) { headerFound = true; }
      continue;
    }
    if (cells.length < 3) continue;
    const name = cells[0];
    if (!name || name.toLowerCase() === 'total' || name.toLowerCase() === 'party' || name.length < 3) continue;
    // Dedup by name
    const key = name.toLowerCase().replace(/\s+/g,'');
    if (seen.has(key)) continue;
    seen.add(key);
    const nums = cells.slice(1).map(c => parseInt(c.replace(/\D/g,''))).filter(n => !isNaN(n) && n <= 294);
    if (!nums.length) continue;
    const won = nums[0]||0, leading = nums[1]||0, total = nums[2]||(won+leading);
    if (total > 0 || won > 0) parties.push({ name, won, leading, total: Math.max(total, won+leading) });
    if (parties.length > 25) break;
  }
  if (!parties.length) return null;
  parties.sort((a,b) => b.total - a.total);
  const ts = (html.match(/Last Updated[^<]{0,15}:?\s*([^<\n]{5,60})/i)||[])[1]||'';
  return { parties, total_declared: parties.reduce((s,p)=>s+p.total,0), last_updated: ts.trim() };
}

// ══════════════════════════════════════════
// EXTRACT CONSTITUENCY→PARTY FROM ECI JS
// ══════════════════════════════════════════
function normParty(s) {
  const t = (s||'').toUpperCase().trim();
  if (t.includes('BJP')||t.includes('BHARATIYA JANATA')) return 'BJP';
  if (t.includes('AITC')||t.includes('TRINAMOOL')||t.includes('TMC')) return 'AITC';
  if (t.includes('AISF')||t.includes('SECULAR FRONT')) return 'AISF';
  if (t.includes('BGPM')||t.includes('GORKHA PRAJATANTRIK')) return 'BGPM';
  if (t.includes('AJUP')||t.includes('UNNAYAN')) return 'AJUP';
  if (t.includes('CPI(M)')||t.includes('CPIM')||t.includes('MARXIST')) return 'CPI(M)';
  if (t.match(/\bCPI\b/)||t.includes('COMMUNIST PARTY')) return 'CPI';
  if (t.includes('INC')||t.includes('NATIONAL CONGRESS')) return 'INC';
  if (t.includes('BSP')||t.includes('BAHUJAN')) return 'BSP';
  if (t.includes('RSP')||t.includes('REVOLUTIONARY')) return 'RSP';
  return null;
}

async function fetchSeatMap() {
  console.log('Fetching ECI page for constituency data...');
  const r = await get(ECI + 'partywiseresult-S25.htm');
  if (!r.ok) return null;

  const html = r.text;

  // Method 1: Find JSON arrays with AC_NO + party info
  const seatMap = {};
  const jsonPat = /\[\s*\{[^\[\]]{30,}\}\s*\]/g;
  let m;
  while ((m = jsonPat.exec(html)) !== null) {
    try {
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length < 5) continue;
      const first = arr[0];
      const hasAC = Object.keys(first).some(k => k.toLowerCase().includes('ac') || k.toLowerCase().includes('seat'));
      const hasParty = Object.keys(first).some(k => k.toLowerCase().includes('party'));
      if (hasAC && hasParty) {
        arr.forEach(it => {
          const id = String(it.AC_NO || it.ac_no || it.AcNo || it.sno || '').padStart(3,'0');
          const rawParty = it.PARTY || it.party || it.Party || it.winner_party || '';
          const p = normParty(rawParty);
          if (id !== '000' && p) seatMap[id] = p;
        });
        if (Object.keys(seatMap).length > 20) { console.log('Found seatmap in page JSON:', Object.keys(seatMap).length); return seatMap; }
      }
    } catch {}
  }

  // Method 2: Find script files referenced in the page
  const scriptSrcs = [...html.matchAll(/src=["']([^"']+\.js[^"']*)["']/gi)].map(m => m[1]);
  console.log('Script files:', scriptSrcs.slice(0, 10));

  for (const src of scriptSrcs.slice(0, 8)) {
    const url = src.startsWith('http') ? src : (src.startsWith('/') ? 'https://results.eci.gov.in' + src : ECI + src);
    const jr = await get(url);
    if (!jr.ok || jr.text.length < 500) continue;

    // Look for constituency data in JS
    let jm;
    const jpat = /\[\s*\{[^\[\]]{30,}\}\s*\]/g;
    while ((jm = jpat.exec(jr.text)) !== null) {
      try {
        const arr = JSON.parse(jm[0]);
        if (!Array.isArray(arr) || arr.length < 10) continue;
        const first = arr[0];
        const hasAC = Object.keys(first).some(k => k.toLowerCase().match(/ac|seat|const/));
        const hasParty = Object.keys(first).some(k => k.toLowerCase().includes('party'));
        if (hasAC && hasParty) {
          arr.forEach(it => {
            const id = String(it.AC_NO || it.ac_no || it.AcNo || '').padStart(3,'0');
            const p = normParty(it.PARTY || it.party || it.winner || '');
            if (id !== '000' && p) seatMap[id] = p;
          });
          if (Object.keys(seatMap).length > 20) {
            console.log('Found seatmap in JS file:', src, Object.keys(seatMap).length);
            return seatMap;
          }
        }
      } catch {}
    }

    // Look for inline data like: ac_no:1, party:"BJP"
    const inlinePat = /ac_no['":\s]+(\d{1,3})['":\s\w,]+party['":\s]+"?([A-Z()]+)"?/gi;
    while ((jm = inlinePat.exec(jr.text)) !== null) {
      const id = jm[1].padStart(3,'0');
      const p = normParty(jm[2]);
      if (p) seatMap[id] = p;
    }
    if (Object.keys(seatMap).length > 20) return seatMap;
  }

  // Method 3: Try common ECI data JSON URLs
  const jsonUrls = [
    'data/S25/statewise.json', 'json/S25.json', 'data/WB_results.json',
    'data/statewiseS25.json', 'S25data.json', 'acresult_S25.json',
    'ResultS25.json', 'data/ac_result_S25.json',
  ];
  for (const u of jsonUrls) {
    const jr = await get(ECI + u);
    if (!jr.ok) continue;
    try {
      const json = JSON.parse(jr.text);
      const arr = Array.isArray(json) ? json : (json.data || json.results || []);
      if (arr.length > 10) {
        arr.forEach(it => {
          const id = String(it.AC_NO || it.ac_no || it.id || '').padStart(3,'0');
          const p = normParty(it.party || it.PARTY || it.winner || '');
          if (id !== '000' && p) seatMap[id] = p;
        });
        if (Object.keys(seatMap).length > 10) { console.log('Found at:', u); return seatMap; }
      }
    } catch {}
  }

  console.log('No constituency data found. seatMap:', Object.keys(seatMap).length);
  return Object.keys(seatMap).length > 10 ? seatMap : null;
}

// ══════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════
let cache = { data: null, html: null, seatMap: null, ts: 0 };

async function refresh() {
  const r = await get(ECI + 'partywiseresult-S25.htm');
  if (!r.ok) { console.warn('ECI fetch failed'); return false; }
  const parsed = parseParties(r.text);
  if (parsed?.parties?.length > 0) {
    cache.data = parsed;
    cache.html = r.text;
    cache.ts = Date.now();
    console.log(`✅ ${parsed.parties[0]?.name} ${parsed.parties[0]?.total}`);
    return true;
  }
  console.warn('Parse failed. snippet:', r.text.slice(0, 300));
  return false;
}

async function refreshSeatMap() {
  const sm = await fetchSeatMap();
  if (sm) { cache.seatMap = sm; console.log('SeatMap cached:', Object.keys(sm).length); }
}

setInterval(refresh, 90_000);
setTimeout(refreshSeatMap, 5000); // Fetch seat map 5s after startup
refresh();

// ── Endpoints ──────────────────────────────
app.get('/api/results', async (req, res) => {
  if (!cache.data || Date.now() - cache.ts > 90_000) await refresh();
  if (cache.data) return res.json(cache.data);
  res.status(500).json({ error: 'ECI unavailable' });
});

app.get('/api/party', async (req, res) => {
  if (!cache.html || Date.now() - cache.ts > 90_000) await refresh();
  if (cache.html) return res.send(cache.html);
  res.status(500).send('ECI unavailable');
});

app.get('/api/seatmap', async (req, res) => {
  if (!cache.seatMap) await refreshSeatMap();
  res.json({ seatMap: cache.seatMap || {}, count: Object.keys(cache.seatMap||{}).length });
});

app.get('/api/status', (req, res) => res.json({
  cached: !!cache.data, age_sec: cache.ts ? Math.round((Date.now()-cache.ts)/1000) : null,
  leader: cache.data?.parties?.[0]?.name, leader_total: cache.data?.parties?.[0]?.total,
  total_declared: cache.data?.total_declared, parties_count: cache.data?.parties?.length||0,
  seatmap_count: Object.keys(cache.seatMap||{}).length,
}));

app.get('/api/raw', async (req, res) => {
  const r = await get(ECI + 'partywiseresult-S25.htm');
  res.setHeader('Content-Type','text/plain');
  res.send(r.ok ? `OK len=${r.text.length}\n\n${r.text.slice(0,8000)}` : 'FAILED');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🔥 API on port ${PORT}`); refresh(); });
