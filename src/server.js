// HTTP + WebSocket server. Serves the browser UI (camera + object detection)
// and relays its detections and commands to the tracker / launcher.
//
//   node src/server.js [--dry-run]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Launcher, DIRECTIONS } from './launcher.js';
import { Tracker, fitCalibration } from './tracker.js';
import { loadConfig, saveConfig } from './config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const config = loadConfig();
const dryRun = process.argv.includes('--dry-run');

const launcher = new Launcher({
  dryRun,
  panRangeMs: config.panRangeMs,
  tiltRangeMs: config.tiltRangeMs,
});
try {
  launcher.open();
} catch (err) {
  console.error(err.message);
  console.error('Start with --dry-run to use the UI without the launcher.');
  process.exit(1);
}

const tracker = new Tracker(launcher, config, { onChange: () => broadcastState() });

// ---- HTTP: static files from public/ ----

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket: detections in, state out ----

const wss = new WebSocketServer({ server, path: '/ws' });

function state() {
  const fit = fitCalibration(config.calibration);
  return {
    type: 'state',
    dryRun,
    tracking: tracker.enabled,
    armed: tracker.armed,
    locked: tracker.locked,
    moving: tracker.moving || launcher.motion !== null,
    firing: launcher.firing,
    homed: launcher.homed,
    pos: roundPos(launcher.currentPos()),
    calibrated: { pan: !!fit?.pan, tilt: !!fit?.tilt },
    config,
  };
}

function roundPos({ pan, tilt }) {
  return { pan: Math.round(pan), tilt: Math.round(tilt) };
}

function broadcastState() {
  const msg = JSON.stringify(state());
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
}

function persist() {
  saveConfig(config);
  broadcastState();
}

const handlers = {
  detection(msg) {
    tracker.setTarget(msg.target ? { x: msg.target.x, y: msg.target.y, t: msg.t } : null);
  },
  track(msg) {
    tracker.setEnabled(!!msg.value);
  },
  arm(msg) {
    tracker.armed = !!msg.value;
    launcher.led(tracker.armed);
  },
  async fire() {
    await tracker.fire();
  },
  // Manual control always takes over from the tracker.
  move(msg) {
    if (!DIRECTIONS.includes(msg.dir)) return;
    tracker.setEnabled(false);
    launcher.startMove(msg.dir);
  },
  stop() {
    launcher.stop();
  },
  async jog(msg) {
    if (!DIRECTIONS.includes(msg.dir)) return;
    tracker.setEnabled(false);
    await launcher.pulse(msg.dir, Math.min(Number(msg.ms) || 100, 2000));
  },
  async home() {
    tracker.setEnabled(false);
    await launcher.home();
  },
  setConfig(msg) {
    const allowed = Object.keys(config).filter((k) => !['calibration', 'port'].includes(k));
    for (const [key, value] of Object.entries(msg.values ?? {})) {
      if (allowed.includes(key)) config[key] = value;
    }
    persist();
  },
  // Fixed mode: "the launcher is currently pointing at this spot in the image".
  calibrate(msg) {
    if (!launcher.homed) throw new Error('Home the launcher before calibrating');
    if (launcher.busy) throw new Error('Wait for the launcher to stop moving');
    config.calibration.push({ x: msg.x, y: msg.y, ...roundPos(launcher.pos) });
    persist();
  },
  resetCalibration() {
    config.calibration = [];
    persist();
  },
};

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(state()));
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
      const handler = handlers[msg.type];
      if (!handler) throw new Error(`Unknown message type: ${msg.type}`);
      await handler(msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
    if (msg?.type !== 'detection') broadcastState();
  });
});

// Keep the UI's position readout current while the launcher moves.
setInterval(() => {
  if (launcher.busy) broadcastState();
}, 200);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Open http://localhost:${config.port} in Chrome or Safari`);
});

function shutdown() {
  tracker.dispose();
  launcher.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
