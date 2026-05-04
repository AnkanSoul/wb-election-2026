import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('API is running 🚀'));

const ECI_BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Referer': 'https://results.eci.gov.in/',
};

async function get(url, hdrs = HDR, ms = 12000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { headers: hdrs, signal: ctrl.signal });
    clearTimeout(t);
    const text = await res.text();
    console.log(`GET ${url.slice(-60)} → ${res.status} len=${text.length}`);
    return { ok: res.status === 200 && text.length > 200, status: res.status, text };
  } catch (e) {
    console.warn(`GET failed ${url.slice(-40)}: ${e.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// ══════════════════════════════════════════
// ✅ PARTY TOTALS  (cached 90s)
// ══════════════════════════════════════════
let partyCache = { html: null, ts: 0 };
app.get('/api/party', async (req, res) => {
  if (partyCache.html && Date.now() - partyCache.ts < 90_000)
    return res.send(partyCache.html);
  const r = await get(ECI_BASE + 'partywiseresult-S25.htm');
  if (r.ok) { partyCache = { html: r.text, ts: Date.now() }; }
  if (partyCache.html) res.send(partyCache.html);
  else res.status(500).send('ECI unavailable');
});

// ══════════════════════════════════════════
// 🔍 SEATMAP — Wikipedia → ECI fallback
// ══════════════════════════════════════════
let smCache = { data: null, ts: 0 };

// Normalize party name → abbreviation
function normParty(raw) {
  const t = (raw || '').toUpperCase().trim();
  if (t.includes('BJP') || t.includes('BHARATIYA JANATA')) return 'BJP';
  if (t.includes('AITC') || t.includes('TRINAMOOL') || t.includes('TMC')) return 'AITC';
  if (t.includes('AISF') || t.includes('SECULAR FRONT')) return 'AISF';
  if (t.includes('BGPM') || t.includes('GORKHA PRAJATANTRIK')) return 'BGPM';
  if (t.includes('GNLF') || t.includes('GORKHA NATIONAL')) return 'GNLF';
  if (t.includes('AJUP') || t.includes('UNNAYAN')) return 'AJUP';
  if (t.includes('BSP') || t.includes('BAHUJAN')) return 'BSP';
  if (t.includes('RSP') || t.includes('REVOLUTIONARY SOCIALIST')) return 'RSP';
  if (t.includes('CPI(M)') || t.includes('CPIM') || t.includes('MARXIST')) return 'CPI(M)';
  if (t.includes('CPI') || t.includes('COMMUNIST PARTY OF INDIA')) return 'CPI';
  if (t.includes('INC') || t.includes('INDIAN NATIONAL CONGRESS') || t.includes('CONGRESS')) return 'INC';
  return null;
}

// ── Wikipedia ────────────────────────────
async function fromWikipedia() {
  console.log('Trying Wikipedia...');
  // Wikipedia API — get the page as JSON
  const apiUrl = 'https://en.wikipedia.org/w/api.php?action=parse&page=2026_West_Bengal_legislative_assembly_election&prop=wikitext&format=json&disabletoc=1';
  const r = await get(apiUrl, {
    'User-Agent': 'WBElectionBot/1.0 (election results scraper; contact@example.com)',
    'Accept': 'application/json',
  }, 15000);

  if (!r.ok) {
    console.log('Wikipedia API failed, trying raw page...');
    // Try raw Wikipedia page
    const r2 = await get('https://en.wikipedia.org/wiki/2026_West_Bengal_legislative_assembly_election', {
      'User-Agent': 'Mozilla/5.0 (compatible; bot)',
      'Accept': 'text/html',
    }, 15000);
    if (!r2.ok) return null;
    return parseWikiHTML(r2.text);
  }

  try {
    const json = JSON.parse(r.text);
    const wikitext = json?.parse?.wikitext?.['*'] || '';
    if (wikitext.length < 100) return null;
    console.log('Wikipedia wikitext len:', wikitext.length);
    return parseWikitext(wikitext);
  } catch (e) {
    console.warn('Wikipedia JSON parse error:', e.message);
    return null;
  }
}

function parseWikitext(wikitext) {
  const seatMap = {};
  // Match rows like: | 1 || Constituency Name || ... || BJP || ...
  // Or: {{wp|Constituency}} || BJP
  const lines = wikitext.split('\n');
  let acNo = null;

  for (const line of lines) {
    // Look for AC number pattern: | 1 | or | 001 |
    const numMatch = line.match(/^\|\s*(\d{1,3})\s*\|/);
    if (numMatch) {
      acNo = parseInt(numMatch[1]);
    }

    // Look for party in same or nearby line
    if (acNo) {
      const party = normParty(line);
      if (party) {
        seatMap[acNo.toString().padStart(3, '0')] = party;
        acNo = null;
      }
    }
  }

  console.log('Wikitext parse:', Object.keys(seatMap).length, 'seats');
  return Object.keys(seatMap).length > 10 ? seatMap : null;
}

function parseWikiHTML(html) {
  const seatMap = {};
  // Find tables with constituency data
  const rows = html.split(/<tr[^>]*>/i).slice(1);
  for (const row of rows) {
    const cells = row.split(/<td[^>]*>/i)
      .map(c => c.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim())
      .filter(Boolean);
    if (cells.length < 3) continue;
    // Find AC number
    for (let i = 0; i < Math.min(3, cells.length); i++) {
      const num = parseInt(cells[i]);
      if (num >= 1 && num <= 294) {
        const rowText = cells.join(' ');
        const party = normParty(rowText);
        if (party) {
          seatMap[num.toString().padStart(3,'0')] = party;
          break;
        }
      }
    }
  }
  console.log('Wiki HTML parse:', Object.keys(seatMap).length, 'seats');
  return Object.keys(seatMap).length > 10 ? seatMap : null;
}

// ── ECI individual pages (last resort) ──
async function fromECIIndividual() {
  console.log('Trying ECI individual pages...');
  const seatMap = {};
  const ids = Array.from({length:294}, (_,i) => (i+1).toString().padStart(3,'0'));
  const P = [
    ['BHARATIYA JANATA PARTY','BJP'],['ALL INDIA TRINAMOOL CONGRESS','AITC'],
    ['TRINAMOOL CONGRESS','AITC'],['ALL INDIA SECULAR FRONT','AISF'],
    ['BHARATIYA GORKHA PRAJATANTRIK','BGPM'],['AAM JANATA UNNAYAN PARTY','AJUP'],
    ['BAHUJAN SAMAJ PARTY','BSP'],['REVOLUTIONARY SOCIALIST PARTY','RSP'],
    ['COMMUNIST PARTY OF INDIA (MARXIST)','CPI(M)'],['CPIM','CPI(M)'],
    ['COMMUNIST PARTY OF INDIA','CPI'],['INDIAN NATIONAL CONGRESS','INC'],
    [' BJP ','BJP'],[' AITC ','AITC'],[' INC ','INC'],
  ];
  function dp(text) {
    const t = text.toUpperCase();
    for (const kw of ['LEADING','WON']) {
      let pos=0;
      while(pos<t.length){const i=t.indexOf(kw,pos);if(i===-1)break;const b=t.substring(Math.max(0,i-800),i);for(const[p,a]of P)if(b.includes(p))return a;pos=i+1;}
    }
    for(const[p,a]of P)if(t.includes(p))return a;
    return null;
  }
  let found=0;
  for(const id of ids){
    const r=await get(ECI_BASE+`statewiseS25${id}.htm`,HDR,5000);
    if(r.ok){const p=dp(r.text);if(p){seatMap[id]=p;found++;}}
    await new Promise(r=>setTimeout(r,150));
  }
  console.log(`ECI individual: ${found} found`);
  return found > 0 ? seatMap : null;
}

app.get('/api/seatmap', async (req, res) => {
  if (smCache.data && Date.now() - smCache.ts < 300_000) {
    console.log('Cache hit:', smCache.data.count);
    return res.json(smCache.data);
  }

  // Strategy 1: Wikipedia
  let seatMap = await fromWikipedia();
  let source = 'wikipedia';

  // Strategy 2: ECI individual pages
  if (!seatMap) {
    seatMap = await fromECIIndividual();
    source = 'eci-individual';
  }

  const out = {
    seatMap: seatMap || {},
    count: Object.keys(seatMap || {}).length,
    source,
  };

  if (out.count > 0) smCache = { data: out, ts: Date.now() };
  res.json(out);
});

// Debug: test any URL
app.get('/api/try', async (req, res) => {
  const url = req.query.url || (req.query.path ? `${ECI_BASE}${req.query.path}` : null);
  if (!url) return res.status(400).send('?url= or ?path= required');
  const r = await get(url, HDR, 10000);
  res.setHeader('Content-Type','text/plain');
  res.send(`${r.ok?'✅':'❌'} ${url}\nstatus=${r.status} len=${r.text.length}\n\n${r.text.substring(0,3000)}`);
});

// Wikipedia raw test
app.get('/api/wiki', async (req, res) => {
  const r = await get(
    'https://en.wikipedia.org/w/api.php?action=parse&page=2026_West_Bengal_legislative_assembly_election&prop=wikitext&format=json',
    {'User-Agent':'WBElectionBot/1.0','Accept':'application/json'},
    15000
  );
  res.setHeader('Content-Type','text/plain');
  res.send(`status=${r.status} len=${r.text.length}\n\n${r.text.substring(0,5000)}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 API running on port ${PORT}`));
