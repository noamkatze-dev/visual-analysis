'use strict';

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── recordings directory ── */
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: recordingsDir,
  filename: (_req, file, cb) => {
    cb(null, path.basename(file.originalname));
  }
});
const upload = multer({ storage });

/* ── in-memory state ── */
const sessions         = new Map();
const disconnectTimers = new Map();

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

/* ── upload recording ── */
app.post('/upload', upload.single('video'), (req, res) => {
  try {
    const name = req.body.name || path.basename(req.file.originalname, '.webm');
    res.json({ ok: true });
    broadcast({ type: 'recording_ready', name });
  } catch (_) {
    res.status(500).json({ ok: false });
  }
});

/* ── serve recording ── */
app.get('/recording/:name', (req, res) => {
  const name     = path.basename(req.params.name);
  const filePath = path.join(recordingsDir, `${name}.webm`);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'video/webm');
  res.sendFile(filePath);
});

/* ── WebSocket ── */
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'gaze' && typeof msg.name === 'string' && msg.name) {
        ws.username = msg.name;

        if (disconnectTimers.has(msg.name)) {
          clearTimeout(disconnectTimers.get(msg.name));
          disconnectTimers.delete(msg.name);
        }

        sessions.set(msg.name, { x: +msg.x || 0, y: +msg.y || 0, ts: Date.now() });
        broadcastSessions();
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (!ws.username) return;
    const name = ws.username;
    const t = setTimeout(() => {
      sessions.delete(name);
      disconnectTimers.delete(name);
      broadcastSessions();
    }, 5000);
    disconnectTimers.set(name, t);
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`gaze-gallery listening on :${PORT}`));
