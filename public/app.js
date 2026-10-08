// Browser side: camera capture, COCO-SSD object detection, overlay drawing and
// UI controls. Detections are sent to the Node server, which drives the launcher.

const TARGET_CLASSES = [
  'person', 'cat', 'dog', 'bird', 'teddy bear', 'sports ball', 'bottle', 'cup',
  'cell phone', 'chair', 'backpack', 'any',
];
// WebGPU first: Safari's WebGL compiles the model's shaders synchronously and
// freezes the page for ~30 s on load. WASM is a fast-starting fallback.
const BACKENDS = ['webgpu', 'wasm', 'webgl'];
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/';
const MODE_HELP = {
  fixed: 'The camera stays still. Home the launcher, then calibrate so image positions map to launcher positions.',
  mounted: 'The camera moves with the launcher. Click the video to set where the darts land (the aim point).',
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const ctx = overlay.getContext('2d');

let ws;
let state = null;
let model = null;
let currentTarget = null; // last chosen detection, normalised { x, y, w, h, score, cls }
let detections = [];

// ---------- server connection ----------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setPill($('conn'), 'connected', 'ok');
  ws.onclose = () => {
    setPill($('conn'), 'disconnected', 'danger');
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') render((state = msg));
    else if (msg.type === 'error') toast(msg.message);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- camera ----------

async function startCamera(deviceId) {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, width: 1280, height: 720 } : { width: 1280, height: 720 },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  localStorage.setItem('cameraId', stream.getVideoTracks()[0].getSettings().deviceId ?? '');
  await listCameras();
}

async function listCameras() {
  const select = $('camera');
  const current = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  select.replaceChildren(
    ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === current)),
  );
}

// ---------- detection ----------

async function pickBackend() {
  tf.wasm.setWasmPaths(WASM_PATH);
  for (const name of BACKENDS) {
    try {
      if (await tf.setBackend(name)) return name;
    } catch {
      // backend not supported in this browser, try the next one
    }
  }
  throw new Error('No TensorFlow.js backend available');
}

async function detectLoop() {
  try {
    await detectOnce();
  } catch (err) {
    console.error(err);
    $('hint').textContent = `Detection error: ${err.message}`;
  }
  draw();
  requestAnimationFrame(detectLoop);
}

async function detectOnce() {
  if (model && video.readyState >= 2) {
    const t = Date.now();
    const minScore = Number($('minScore').value);
    const raw = await model.detect(video, 20, minScore);
    const W = video.videoWidth;
    const H = video.videoHeight;
    detections = raw.map((d) => ({
      cls: d.class,
      score: d.score,
      x: (d.bbox[0] + d.bbox[2] / 2) / W,
      y: (d.bbox[1] + d.bbox[3] / 2) / H,
      w: d.bbox[2] / W,
      h: d.bbox[3] / H,
    }));
    currentTarget = chooseTarget(detections, $('targetClass').value);
    send({ type: 'detection', t, target: currentTarget });
  }
}

// Stick with the object we were already following if it is still there,
// otherwise pick the biggest (usually nearest) one.
function chooseTarget(dets, cls) {
  const candidates = dets.filter((d) => cls === 'any' || d.cls === cls);
  if (!candidates.length) return null;
  if (currentTarget) {
    const dist = (d) => Math.hypot(d.x - currentTarget.x, d.y - currentTarget.y);
    const nearest = candidates.reduce((a, b) => (dist(a) < dist(b) ? a : b));
    if (dist(nearest) < 0.2) return nearest;
  }
  return candidates.reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b));
}

// ---------- overlay ----------

function draw() {
  const W = overlay.width;
  const H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 400);
  ctx.font = `${Math.round(W / 60)}px -apple-system, sans-serif`;

  for (const d of detections) {
    const isTarget = d === currentTarget;
    const color = isTarget ? (state?.locked ? '#ef4444' : '#facc15') : 'rgba(255,255,255,0.6)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.strokeRect((d.x - d.w / 2) * W, (d.y - d.h / 2) * H, d.w * W, d.h * H);
    ctx.fillText(`${d.cls} ${(d.score * 100).toFixed(0)}%`, (d.x - d.w / 2) * W + 4, (d.y - d.h / 2) * H - 6);
    if (isTarget) crosshair(d.x * W, d.y * H, W / 60, color);
  }

  if (!state) return;
  const cfg = state.config;
  if (cfg.mode === 'mounted') {
    crosshair(cfg.aim.x * W, cfg.aim.y * H, W / 30, '#22d3ee');
    ctx.strokeStyle = 'rgba(34,211,238,0.5)';
    ctx.strokeRect((cfg.aim.x - cfg.deadband) * W, (cfg.aim.y - cfg.deadband) * H, cfg.deadband * 2 * W, cfg.deadband * 2 * H);
  } else {
    ctx.fillStyle = '#a78bfa';
    for (const p of cfg.calibration) {
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, W / 150, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function crosshair(x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r * 1.5, y); ctx.lineTo(x + r * 1.5, y);
  ctx.moveTo(x, y - r * 1.5); ctx.lineTo(x, y + r * 1.5);
  ctx.stroke();
}

// ---------- state -> UI ----------

function render(s) {
  const cfg = s.config;
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === cfg.mode));
  $('modeHelp').textContent = MODE_HELP[cfg.mode];
  $('calibration').hidden = cfg.mode !== 'fixed';
  $('autoFire').checked = cfg.autoFire;

  $('track').classList.toggle('on', s.tracking);
  $('track').firstChild.textContent = s.tracking ? 'Stop tracking ' : 'Start tracking ';
  $('arm').classList.toggle('on', s.armed);
  $('arm').textContent = s.armed ? 'Armed - click to disarm' : 'Arm';
  $('fire').disabled = !s.armed || s.firing;

  $('pan').textContent = s.homed ? s.pos.pan : '?';
  $('tilt').textContent = s.homed ? s.pos.tilt : '?';
  $('calCount').textContent = cfg.calibration.length;
  $('calPan').textContent = s.calibrated.pan ? '✓' : '✗';
  $('calTilt').textContent = s.calibrated.tilt ? '✓' : '✗';

  const status = $('status');
  if (s.firing) setPill(status, 'FIRING', 'danger');
  else if (s.locked) setPill(status, 'LOCKED ON', 'danger');
  else if (s.tracking) setPill(status, s.moving ? 'tracking · moving' : 'tracking', 'warn');
  else if (s.dryRun) setPill(status, 'dry run (no launcher)', '');
  else setPill(status, 'idle', '');
}

function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `pill ${kind}`;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- controls ----------

function setConfig(values) {
  send({ type: 'setConfig', values });
}

function fire() {
  if (state?.armed) send({ type: 'fire' });
}

function wireControls() {
  $('targetClass').replaceChildren(...TARGET_CLASSES.map((c) => new Option(c, c)));
  $('targetClass').value = localStorage.getItem('targetClass') ?? 'person';
  $('targetClass').onchange = (e) => {
    localStorage.setItem('targetClass', e.target.value);
    currentTarget = null;
  };
  $('minScore').oninput = (e) => ($('minScoreOut').value = Number(e.target.value).toFixed(2));
  $('camera').onchange = (e) => startCamera(e.target.value).catch((err) => toast(err.message));

  document.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = () => setConfig({ mode: r.value })));
  $('autoFire').onchange = (e) => setConfig({ autoFire: e.target.checked });
  $('track').onclick = () => send({ type: 'track', value: !state?.tracking });
  $('arm').onclick = () => send({ type: 'arm', value: !state?.armed });
  $('fire').onclick = fire;
  $('home').onclick = () => send({ type: 'home' });
  $('calReset').onclick = () => confirm('Clear all calibration points?') && send({ type: 'resetCalibration' });

  // Press-and-hold on the direction pad.
  document.querySelectorAll('.pad button').forEach((b) => {
    b.onpointerdown = () => send({ type: 'move', dir: b.dataset.dir });
    b.onpointerup = b.onpointerleave = () => send({ type: 'stop' });
  });

  // Click: set aim point (mounted). Shift-click: add a calibration point (fixed).
  overlay.onclick = (e) => {
    if (!state) return;
    const r = overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (state.config.mode === 'mounted' && !e.shiftKey) setConfig({ aim: { x, y } });
    else if (state.config.mode === 'fixed' && e.shiftKey) send({ type: 'calibrate', x, y });
  };

  const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select')) return;
    if (KEY_DIRS[e.key]) {
      e.preventDefault();
      if (!e.repeat) send({ type: 'move', dir: KEY_DIRS[e.key] });
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) fire();
    } else if (e.key === 't' || e.key === 'T') {
      send({ type: 'track', value: !state?.tracking });
    }
  });
  window.addEventListener('keyup', (e) => {
    if (KEY_DIRS[e.key]) send({ type: 'stop' });
  });
}

// ---------- boot ----------

async function main() {
  wireControls();
  connect();
  try {
    await startCamera(localStorage.getItem('cameraId') || undefined).catch(() => startCamera());
  } catch (err) {
    $('hint').textContent = `Camera error: ${err.message}. Allow camera access for this site and reload.`;
    return;
  }
  try {
    const backend = await pickBackend();
    $('hint').textContent = `Loading detection model (${backend})…`;
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    $('hint').textContent = `Model loaded (${backend}). Arrow keys jog, T toggles tracking, Space fires when armed.`;
  } catch (err) {
    $('hint').textContent = `Could not load detection model: ${err.message}`;
    return;
  }
  detectLoop();
}

main();
