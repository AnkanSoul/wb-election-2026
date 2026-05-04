import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const BASE = 'https://results.eci.gov.in/ResultAcGenMay2026/';

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

app.listen(3000, () => {
  console.log('🔥 API running on http://localhost:3000');
});