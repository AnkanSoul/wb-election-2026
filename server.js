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

// Party data
app.get('/api/party', async (req, res) => {
  try {
    const r = await fetch(BASE + 'partywiseresult-S25.htm', {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://results.eci.gov.in/",
        "Origin": "https://results.eci.gov.in"
      }
    });
    const html = await r.text();
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

// Constituency data
app.get('/api/const/:id', async (req, res) => {
  try {
    const r = await fetch(BASE + `statewiseS25${req.params.id}.htm`, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html",
        "Referer": "https://results.eci.gov.in/",
        "Origin": "https://results.eci.gov.in"
      }
    });
    const html = await r.text();
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});
