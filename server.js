require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fns = require('./src/functions');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // ลายเซ็น/รูปเป็น base64 อาจมีขนาดใหญ่กว่า default

// อนุญาตเฉพาะฟังก์ชันที่ตั้งใจ export ไว้ใน src/functions.js เท่านั้น (whitelist)
const ALLOWED = new Set(Object.keys(fns));

app.post('/api/rpc', async (req, res) => {
  const { fn, args } = req.body || {};
  if (!fn || !ALLOWED.has(fn)) {
    return res.status(400).json({ error: 'ไม่รู้จักฟังก์ชันนี้' });
  }
  try {
    const result = await fns[fn](...(Array.isArray(args) ? args : []));
    res.json({ result });
  } catch (err) {
    console.error(`[rpc:${fn}]`, err);
    res.status(400).json({ error: err.message || 'เกิดข้อผิดพลาด' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`F-WWT-28 server running on port ${PORT}`));
