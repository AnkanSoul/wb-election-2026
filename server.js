import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';   // 👈 IMPORTANT

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

// Party data
app.get('/api/party', async (req, res) => {
  try {
    const r = await fetch(BASE + 'partywiseresult-S25.htm');
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
    const r = await fetch(BASE + `statewiseS25${req.params.id}.htm`);
    const html = await r.text();
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

// 🔥 FIXED PORT (IMPORTANT)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});

app.get('/', (req, res) => {
  res.send('API is running 🚀');
});
