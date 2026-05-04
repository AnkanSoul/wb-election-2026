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
    return res.status === 200 && text.length > 200 ? text : null;
  } catch (e) {
    console.warn('fetchECI failed:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════
// Parse ECI party page HTML → clean array
// ══════════════════════════════════════════
function parseECI(html) {
  // Method 1: Find table with Won/Leading headers
  const doc = html;
  const tableMatch = doc.match(/<table[^>]*>([\s\S]*?)<\/table>/gi) || [];

  for (const table of tableMatch) {
    const rows = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    if (!rows.length) continue;

    const headerRow = rows[0].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (!headerRow.includes('won') || !headerRow.includes('leading')) continue;

    const parties = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = (rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(c => c.replace(/<[^>]+>/g, '').trim().replace(/&amp;/g, '&'));
      if (cells.length < 4) continue;
      const name = cells[0];
      if (!name || name.toLowerCase() === 'total' || name.toLowerCase() === 'party') continue;
      const won     = parseInt(cells[1]) || 0;
      const leading = parseInt(cells[2]) || 0;
      const total   = parseInt(cells[3].replace(/\D/g, '')) || 0;
      if (total > 0) parties.push({ name, won, leading, total });
    }
    if (parties.length > 0) {
      parties.sort((a, b) => b.total - a.total);
      const ts = (html.match(/Last Updated at\s+([^\n<]+)/i) || [])[1] || '';
      return {
        parties,
        total_declared: parties.reduce((s, p) => s + p.total, 0),
        last_updated: ts.trim(),
      };
    }
  }

  // Method 2: Parse the visual bar format (ECI uses divs with party/count)
  // Pattern: <b>BJP</b>...<b>204</b> or similar
  const parties = [];
  const partyBlocks = html.match(/class="[^"]*party[^"]*"[\s\S]{0,500}?class="[^"]*count[^"]*"/gi) || [];

  // Method 3: Direct regex on full HTML
  // ECI format: PartyName\n\nNumber (in sequential blocks)
  const knownParties = [
    ['BJP', 'Bharatiya Janata Party'],
    ['AITC', 'All India Trinamool Congress'],
    ['INC', 'Indian National Congress'],
    ['AJUP', 'Aam Janata Unnayan party'],
    ['CPI(M)', 'Communist Party of India'],
    ['AISF', 'All India Secular Front'],
    ['BGPM', 'Bharatiya Gorkha Prajatantrik'],
    ['BSP', 'Bahujan Samaj Party'],
    ['RSP', 'Revolutionary Socialist'],
  ];

  for (const [abbr, nameKey] of knownParties) {
    // Find the number after the party abbreviation in the HTML
    const re = new RegExp(abbr + '[\\s\\S]{0,200}?<[^>]*>(\\d+)<\\/[^>]*>', 'i');
    const m = html.match(re);
    if (m) {
      const total = parseInt(m[1]);
      if (total > 0 && total < 294) parties.push({ name: nameKey + ' - ' + abbr, won: 0, leading: total, total });
    }
  }

  if (parties.length > 0) {
    parties.sort((a, b) => b.total - a.total);
    return { parties, total_declared: parties.reduce((s, p) => s + p.total, 0), last_updated: '' };
  }

  return null;
}

// ══════════════════════════════════════════
// ✅ /api/results — clean JSON (main endpoint)
// ══════════════════════════════════════════
let resultsCache = { data: null, ts: 0 };

app.get('/api/results', async (req, res) => {
  if (resultsCache.data && Date.now() - resultsCache.ts < 60_000) {
    return res.json(resultsCache.data);
  }

  const html = await fetchECI('partywiseresult-S25.htm');
  if (html) {
    const parsed = parseECI(html);
    if (parsed && parsed.parties.length > 0) {
      resultsCache = { data: parsed, ts: Date.now() };
      return res.json(parsed);
    }
    // Return raw HTML snippet for debugging
    console.log('Parse failed, HTML snippet:', html.slice(0, 500));
  }

  // Return cached if available
  if (resultsCache.data) return res.json(resultsCache.data);
  res.status(500).json({ error: 'ECI unavailable' });
});

// Legacy endpoint (keeps existing frontend working)
app.get('/api/party', async (req, res) => {
  const html = await fetchECI('partywiseresult-S25.htm');
  if (html) res.send(html);
  else res.status(500).send('ECI unavailable');
});

// Raw HTML for debugging
app.get('/api/raw', async (req, res) => {
  const html = await fetchECI('partywiseresult-S25.htm');
  res.setHeader('Content-Type', 'text/plain');
  res.send(html ? `len=${html.length}\n\n${html.slice(0, 5000)}` : 'failed');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API on port ${PORT}`));
