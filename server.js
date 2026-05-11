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
        'Accept-Language': 'en-IN,en;q=0.9',
        'Referer': 'https://results.eci.gov.in/',
      },
    });
    const text = await res.text();
    console.log(`[${res.status}] ${path} len=${text.length}`);
    if (res.status === 200 && text.length > 200 && !text.includes('Access Denied')) return text;
    return null;
  } catch (e) {
    console.warn('fetchECI:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════
// ROBUST ECI PARSER
// Works row-by-row, no DOM needed
// ══════════════════════════════════════════
function parseECI(html) {
  const parties = [];

  // Extract all <tr> blocks
  const trBlocks = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) trBlocks.push(m[1]);

  let headerIdx = -1;
  for (let i = 0; i < trBlocks.length; i++) {
    const t = trBlocks[i].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (t.includes('won') && t.includes('leading') && t.includes('total')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.warn('Table header not found in ECI HTML');
    console.log('HTML snippet:', html.slice(0, 1000));
    return null;
  }

  for (let i = headerIdx + 1; i < trBlocks.length; i++) {
    // Extract <td> cells
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = tdRe.exec(trBlocks[i])) !== null) {
      const val = cm[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(val);
    }

    if (cells.length < 4) continue;
    const name = cells[0];
    if (!name || name.toLowerCase() === 'total' || name.toLowerCase() === 'party') continue;

    const won     = parseInt(cells[1].replace(/\D/g, '')) || 0;
    const leading = parseInt(cells[2].replace(/\D/g, '')) || 0;
    const total   = parseInt(cells[3].replace(/\D/g, '')) || 0;

    if (total > 0 || won > 0) {
      parties.push({ name, won, leading, total: total || won + leading });
    }
  }

  if (parties.length === 0) return null;

  parties.sort((a, b) => b.total - a.total);

  // Extract timestamp
  const tsMatch = html.match(/Last Updated(?:\s+at)?\s*[:\-]?\s*([^<\n]{5,50})/i);
  const last_updated = tsMatch ? tsMatch[1].trim().replace(/\s+/g, ' ') : '';

  const total_declared = parties.reduce((s, p) => s + p.total, 0);

  console.log(`Parsed ${parties.length} parties. Leader: ${parties[0]?.name} ${parties[0]?.total}`);
  return { parties, total_declared, last_updated };
}

// ══════════════════════════════════════════
// CACHE — persists across ECI blocks
// ══════════════════════════════════════════
let cache = { data: null, html: null, ts: 0 };

async function refresh() {
  console.log('Refreshing from ECI...');
  const html = await fetchECI('partywiseresult-S25.htm');
  if (!html) { console.warn('ECI fetch failed'); return false; }

  const parsed = parseECI(html);
  if (parsed && parsed.parties.length > 0) {
    cache = { data: parsed, html, ts: Date.now() };
    console.log(`✅ Cached: ${parsed.parties[0]?.name} ${parsed.parties[0]?.total}, total_declared=${parsed.total_declared}`);
    return true;
  }
  console.warn('Parse failed');
  return false;
}

// Refresh every 2 min in background
setInterval(refresh, 120_000);
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

// Status check
app.get('/api/status', (req, res) => {
  res.json({
    cached: !!cache.data,
    age_sec: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) : null,
    leader: cache.data?.parties?.[0]?.name || null,
    leader_total: cache.data?.parties?.[0]?.total || null,
    total_declared: cache.data?.total_declared || null,
    last_updated: cache.data?.last_updated || null,
    parties_count: cache.data?.parties?.length || 0,
  });
});

// Raw HTML dump for debugging
app.get('/api/raw', async (req, res) => {
  const html = await fetchECI('partywiseresult-S25.htm');
  res.setHeader('Content-Type', 'text/plain');
  res.send(html ? `OK len=${html.length}\n\n${html.slice(0, 8000)}` : 'FAILED');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🔥 API on port ${PORT}`); refresh(); });
