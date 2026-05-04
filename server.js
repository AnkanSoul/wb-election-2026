import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());

// 🔥 Use proxy instead of direct ECI
const PROXY = "https://api.allorigins.win/raw?url=";
const BASE = "https://results.eci.gov.in/ResultAcGenMay2026/";

// ✅ Health check
app.get('/', (req, res) => {
  res.send('API is running 🚀');
});

// ✅ PARTY DATA
app.get('/api/party', async (req, res) => {
  try {
    const url = PROXY + encodeURIComponent(BASE + "partywiseresult-S25.htm");

    const r = await fetch(url);
    const html = await r.text();

    res.send(html);

  } catch (e) {
    console.error("Party API error:", e);
    res.status(500).send('error');
  }
});

// ✅ CONSTITUENCY DATA
app.get('/api/const/:id', async (req, res) => {
  try {
    const id = req.params.id.padStart(3, '0');

    const url = PROXY + encodeURIComponent(BASE + `statewiseS25${id}.htm`);

    const r = await fetch(url);
    const html = await r.text();

    res.send(html);

  } catch (e) {
    console.error("Const API error:", e);
    res.status(500).send('error');
  }
});

// 🔥 PORT FIX
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 API running on port ${PORT}`);
});
