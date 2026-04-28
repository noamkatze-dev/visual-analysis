'use strict';

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── in-memory state ── */
const sessions         = new Map(); // name → { x, y, ts, fixationCount, ... }
const disconnectTimers = new Map(); // name → timer id

function broadcastSessions() {
  const msg = JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

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

        sessions.set(msg.name, {
          x:               +msg.x || 0,
          y:               +msg.y || 0,
          ts:              Date.now(),
          fixationCount:   msg.fixationCount  || 0,
          saccadeCount:    msg.saccadeCount   || 0,
          firstFixTs:      msg.firstFixTs     || null,
          sessionDuration: msg.sessionDuration || 0
        });
        broadcastSessions();
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    const name = ws.username;
    if (!name) return;
    const timer = setTimeout(() => {
      sessions.delete(name);
      disconnectTimers.delete(name);
      broadcastSessions();
    }, 5000);
    disconnectTimers.set(name, timer);
  });

  // Send current state to new connection
  ws.send(JSON.stringify({ type: 'sessions', data: Object.fromEntries(sessions) }));
});

/* ── REST: save session ── */
app.post('/api/save-session', (req, res) => {
  try {
    const { user, data } = req.body;
    if (!user || !data) return res.status(400).json({ error: 'missing user or data' });

    const dir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const ts       = Date.now();
    const filename = `${user.replace(/[^a-z0-9_-]/gi, '_')}_${ts}.json`;
    const filepath = path.join(dir, filename);

    fs.writeFileSync(filepath, JSON.stringify({ user, ts, ...data }, null, 2));
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('[save-session]', e);
    res.status(500).json({ error: 'write failed' });
  }
});

/* ── REST: list sessions ── */
app.get('/api/sessions', (_req, res) => {
  try {
    const dir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(dir)) return res.json([]);

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(dir, f);
        const stat     = fs.statSync(filepath);
        try {
          const raw  = fs.readFileSync(filepath, 'utf8');
          const data = JSON.parse(raw);
          return {
            filename:        f,
            user:            data.user,
            ts:              data.ts,
            sessionDuration: data.sessionDuration,
            fixationCount:   data.fixations ? data.fixations.length : 0,
            saccadeCount:    data.saccades  ? data.saccades.length  : 0,
            firstFix:        data.firstFix  || null,
            size:            stat.size
          };
        } catch (_) {
          return { filename: f, ts: stat.mtimeMs };
        }
      })
      .sort((a, b) => b.ts - a.ts);

    res.json(files);
  } catch (e) {
    console.error('[sessions]', e);
    res.status(500).json({ error: 'read failed' });
  }
});

/* ── start ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`listening on :${PORT}`));
