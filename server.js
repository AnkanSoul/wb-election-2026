import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

app.get('/', (req, res) => res.send('API is running 🚀'));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://results.eci.gov.in/ResultAcGenMay2026/index.htm",
  "Connection": "keep-alive"
};

async function fetchPage(url, hdrs = HEADERS, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: hdrs });
      const text = await res.text();
      console.log(`[FETCH] ${url.slice(-50)} → ${res.status} len=${text.length}`);
      if (res.status === 200 && text.length > 100) return { ok: true, text, status: res.status };
      throw new Error(`bad response: status=${res.status} len=${text.length}`);
    } catch (e) {
      console.log(`  retry ${i+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  return { ok: false, text: '', status: 0 };
}

// ✅ PARTY DATA
app.get('/api/party', async (req, res) => {
  const r = await fetchPage(BASE + 'partywiseresult-S25.htm');
  if (r.ok) res.send(r.text);
  else res.status(500).send('Failed');
});

// ══════════════════════════════════════════
// 🔍 ANALYZE PARTY PAGE
// Extracts: all JS content, all links, all data-* attrs
// → Find where constituency data comes from
// Open: /api/analyze
// ══════════════════════════════════════════
app.get('/api/analyze', async (req, res) => {
  const r = await fetchPage(BASE + 'partywiseresult-S25.htm');
  if (!r.ok) return res.status(500).send('Cannot fetch party page');

  const html = r.text;

  // 1. All hrefs
  const hrefs = [...html.matchAll(/href=["']([^"'#]{3,})["']/gi)].map(m => m[1]);

  // 2. All script src
  const scripts = [...html.matchAll(/src=["']([^"']+)["']/gi)].map(m => m[1]);

  // 3. All fetch/ajax/json URLs in inline scripts
  const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const apiUrls = [];
  for (const s of inlineScripts) {
    const matches = [...s.matchAll(/["'`](https?:\/\/[^"'`\s]+|\/[^"'`\s]+\.(?:json|htm|html|php|asp|js))["'`]/g)];
    matches.forEach(m => apiUrls.push(m[1]));
  }

  // 4. JSON-like data in scripts (look for arrays with seat data)
  const jsonChunks = [];
  for (const s of inlineScripts) {
    if (s.includes('var ') || s.includes('const ') || s.includes('let ') || s.includes('[{')) {
      jsonChunks.push(s.slice(0, 500));
    }
  }

  // 5. All form actions
  const forms = [...html.matchAll(/action=["']([^"']+)["']/gi)].map(m => m[1]);

  // 6. Look for constituency number patterns
  const constNums = [...new Set([...html.matchAll(/S25(\d{3})/g)].map(m => m[1]))];

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(
    `=== PARTY PAGE ANALYSIS (html len=${html.length}) ===\n\n` +
    `--- HREFS (${hrefs.length}) ---\n` + hrefs.join('\n') +
    `\n\n--- SCRIPT SRCS (${scripts.length}) ---\n` + scripts.join('\n') +
    `\n\n--- API URLS IN SCRIPTS (${apiUrls.length}) ---\n` + apiUrls.join('\n') +
    `\n\n--- FORM ACTIONS ---\n` + forms.join('\n') +
    `\n\n--- CONSTITUENCY NUMBERS IN HTML ---\n` + constNums.join(', ') +
    `\n\n--- INLINE SCRIPT CHUNKS (${jsonChunks.length}) ---\n` + jsonChunks.join('\n---\n') +
    `\n\n=== FULL HTML ===\n` + html
  );
});

// ══════════════════════════════════════════
// 🔥 PARTY DETECTION
// ══════════════════════════════════════════
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
    [' BJP ',  'BJP'], ['>BJP<',  'BJP'],
    [' AITC ', 'AITC'],['>AITC<', 'AITC'],
    [' INC ',  'INC'], ['>INC<',  'INC'],
    [' BSP ',  'BSP'], [' AISF ', 'AISF'],
    [' AJUP ', 'AJUP'],[' BGPM ', 'BGPM'],
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

// ✅ SEATMAP
let seatmapCache = { data: null, ts: 0 };

app.get('/api/seatmap', async (req, res) => {
  if (seatmapCache.data && Date.now() - seatmapCache.ts < 180_000) {
    return res.json(seatmapCache.data);
  }
  const seatMap = {}, failed = [], othList = [];
  const ids = Array.from({ length: 294 }, (_, i) => (i + 1).toString().padStart(3, '0'));
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async id => {
      const r = await fetchPage(BASE + `statewiseS25${id}.htm`, HEADERS, 2);
      if (r.ok) {
        const party = detectParty(r.text);
        seatMap[id] = party;
        if (party === 'OTH') othList.push(id);
      } else failed.push(id);
    }));
    await new Promise(r => setTimeout(r, 400));
  }
  const out = { seatMap, count: Object.keys(seatMap).length, errors: failed.length, othCount: othList.length, failSample: failed.slice(0, 10) };
  seatmapCache = { data: out, ts: Date.now() };
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
