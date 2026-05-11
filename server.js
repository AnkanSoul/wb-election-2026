import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI = 'https://results.eci.gov.in/ResultAcGenMay2026/';

async function fetchECI(path) {
  try {
    const res = await fetch(ECI + path, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://results.eci.gov.in/',
      },
    });
    const text = await res.text();
    console.log(`[${res.status}] ${path} len=${text.length}`);
    if (res.status === 200 && text.length > 200 && !text.includes('Access Denied')) return text;
    return null;
  } catch (e) { console.warn('fetchECI:', e.message); return null; }
}

// ══════════════════════════════════════════
// PARSE PARTY PAGE — multiple strategies
// ══════════════════════════════════════════
function parseECI(html) {
  if (!html) return null;

  // Remove scripts/styles to clean the HTML
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const parties = [];

  // Strategy 1: Find Won/Leading/Total table
  const rows = clean.split(/<tr[^>]*>/i).slice(1);
  let headerFound = false;

  for (const row of rows) {
    const cellText = row
      .replace(/<[^>]+>/g, '\t')
      .split('\t')
      .map(s => s.replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim())
      .filter(Boolean);

    if (!headerFound) {
      const joined = cellText.join(' ').toLowerCase();
      if (joined.includes('won') && (joined.includes('leading') || joined.includes('trend'))) {
        headerFound = true;
      }
      continue;
    }

    if (cellText.length < 3) continue;
    const name = cellText[0];
    if (!name || name.toLowerCase() === 'total' || name.toLowerCase() === 'party') continue;
    if (name.length < 3) continue;

    // Find numeric cells
    const nums = cellText.slice(1).map(c => parseInt(c.replace(/\D/g,''))).filter(n => !isNaN(n));
    if (nums.length < 1) continue;

    const won     = nums[0] || 0;
    const leading = nums[1] || 0;
    const total   = nums[2] || (won + leading);

    if (total > 0 || won > 0) {
      parties.push({ name, won, leading, total: Math.max(total, won + leading) });
    }
    if (parties.length > 20) break; // Safety stop
  }

  if (parties.length === 0) {
    // Strategy 2: Look for party name + number pattern in the visual cards
    // ECI uses colored div cards: <b>BJP</b>...<b>207</b>
    const cardPat = /(?:BJP|AITC|INC|CPI\(M\)|AJUP|AISF|BSP|RSP|BGPM)[^\d]{0,100}?(\d{1,3})/gi;
    let m;
    while ((m = cardPat.exec(html)) !== null) {
      const abbr = m[0].match(/^[A-Z()]+/)[0];
      const num = parseInt(m[1]);
      if (num > 0 && num <= 294) {
        const existing = parties.find(p => p.name.includes(abbr));
        if (!existing) parties.push({ name: abbr, won: num, leading: 0, total: num });
      }
    }
  }

  if (parties.length === 0) return null;

  parties.sort((a, b) => b.total - a.total);

  const tsMatch = html.match(/Last Updated[^<]{0,10}:?\s*([^<\n]{5,60})/i);
  const last_updated = tsMatch ? tsMatch[1].trim().replace(/\s+/g, ' ') : '';

  return {
    parties,
    total_declared: parties.reduce((s, p) => s + p.total, 0),
    last_updated
  };
}

// Try to extract constituency→party map from ECI page JS
function extractSeatMap(html) {
  const seatMap = {};
  // Look for JSON arrays like [{ac:1,party:"BJP",...}] or similar
  const jsonPat = /\[\s*\{[^[\]]{20,5000}\}\s*\]/g;
  let m;
  while ((m = jsonPat.exec(html)) !== null) {
    try {
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const first = arr[0];
      const hasAC = 'ac_no' in first || 'AC_NO' in first || 'id' in first;
      const hasParty = 'party' in first || 'PARTY' in first;
      if (hasAC && hasParty) {
        arr.forEach(item => {
          const id = String(item.ac_no || item.AC_NO || item.id || '').padStart(3, '0');
          const p = (item.party || item.PARTY || '').toUpperCase();
          if (id !== '000' && p) seatMap[id] = p;
        });
        if (Object.keys(seatMap).length > 10) break;
      }
    } catch {}
  }
  return Object.keys(seatMap).length > 10 ? seatMap : null;
}

// ══════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════
let cache = { data: null, html: null, ts: 0 };

async function refresh() {
  const html = await fetchECI('partywiseresult-S25.htm');
  if (!html) { console.warn('ECI fetch failed'); return false; }

  const parsed = parseECI(html);
  if (parsed && parsed.parties.length > 0) {
    cache = { data: parsed, html, ts: Date.now() };
    console.log(`✅ ${parsed.parties[0]?.name} ${parsed.parties[0]?.total}, declared=${parsed.total_declared}`);
    return true;
  }
  console.warn('Parse failed. Snippet:', html.slice(0, 500));
  return false;
}

setInterval(refresh, 90_000);
refresh();

// ══════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════
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

app.get('/api/status', (req, res) => res.json({
  cached: !!cache.data, age_sec: cache.ts ? Math.round((Date.now()-cache.ts)/1000) : null,
  leader: cache.data?.parties?.[0]?.name, leader_total: cache.data?.parties?.[0]?.total,
  total_declared: cache.data?.total_declared, parties_count: cache.data?.parties?.length||0,
}));

app.get('/api/raw', async (req, res) => {
  const html = await fetchECI('partywiseresult-S25.htm');
  res.setHeader('Content-Type','text/plain');
  res.send(html ? `OK len=${html.length}\n\n${html.slice(0,8000)}` : 'FAILED');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🔥 API on port ${PORT}`); refresh(); });
