import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const db = new Database(path.join(__dirname, 'sessions.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_name TEXT,
    concept INTEGER,
    started_at INTEGER,
    duration_seconds INTEGER,
    labels_revealed TEXT,
    analysis TEXT,
    video_path TEXT
  )
`);

const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

const framesMap = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/recordings', express.static(recordingsDir));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/sessions', (req, res) => {
  const { concept } = req.query;
  let rows;
  if (concept !== undefined) {
    rows = db.prepare('SELECT * FROM sessions WHERE concept = ? ORDER BY started_at DESC').all(Number(concept));
  } else {
    rows = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
  }
  rows = rows.map(r => ({
    ...r,
    labels_revealed: JSON.parse(r.labels_revealed || '[]'),
    analysis: JSON.parse(r.analysis || '[]'),
  }));
  res.json(rows);
});

function broadcastGalleryUpdate() {
  const msg = JSON.stringify({ type: 'gallery_update' });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

async function assembleVideo(sessionId, frames) {
  const sessionFramesDir = path.join(recordingsDir, `frames_${sessionId}`);
  if (!fs.existsSync(sessionFramesDir)) fs.mkdirSync(sessionFramesDir, { recursive: true });

  for (let i = 0; i < frames.length; i++) {
    const base64 = frames[i].replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(path.join(sessionFramesDir, `frame_${String(i).padStart(5, '0')}.png`), buf);
  }

  const outputPath = path.join(recordingsDir, `${sessionId}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(sessionFramesDir, 'frame_%05d.png'))
      .inputOptions(['-framerate 0.33'])
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-vf scale=1280:720',
        '-r 30',
      ])
      .output(outputPath)
      .on('end', () => {
        fs.rmSync(sessionFramesDir, { recursive: true, force: true });
        resolve(outputPath);
      })
      .on('error', (err) => {
        fs.rmSync(sessionFramesDir, { recursive: true, force: true });
        reject(err);
      })
      .run();
  });
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'frame') {
      const { session, data } = msg;
      if (!framesMap.has(session)) framesMap.set(session, []);
      framesMap.get(session).push(data);
    }

    if (msg.type === 'end') {
      const { session, user_name, concept, duration, labels, analysis } = msg;
      const frames = framesMap.get(session) || [];
      framesMap.delete(session);

      let videoPath = null;
      if (frames.length > 0) {
        try {
          videoPath = await assembleVideo(session, frames);
          videoPath = `/recordings/${session}.mp4`;
        } catch (err) {
          console.error('ffmpeg error:', err.message);
        }
      }

      db.prepare(`
        INSERT OR REPLACE INTO sessions (id, user_name, concept, started_at, duration_seconds, labels_revealed, analysis, video_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session,
        user_name,
        concept,
        Date.now(),
        duration,
        JSON.stringify(labels || []),
        JSON.stringify(analysis || []),
        videoPath
      );

      broadcastGalleryUpdate();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Visual Analysis running at http://localhost:${PORT}`);
});
