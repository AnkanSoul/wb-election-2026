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
      console.log(`Retry ${i + 1} failed...`);
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

// ✅ CONSTITUENCY DATA
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});
