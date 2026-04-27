'use strict';
const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── in-memory state ── */
const sessions         = new Map();
const disconnectTimers = new Map();

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

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
