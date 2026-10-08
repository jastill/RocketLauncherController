// Settings and calibration, persisted to config.json in the project root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

export const DEFAULTS = {
  port: 8080,

  // 'mounted': camera rides on the launcher -> closed loop, centre target on the aim point.
  // 'fixed':   camera is stationary (e.g. the Mac's own camera) -> open loop using calibration.
  mode: 'fixed',

  // Approximate full travel time of each axis, used for homing and clamping.
  panRangeMs: 6000,
  tiltRangeMs: 1000,

  // Mounted mode: where in the frame (0..1) the darts actually land.
  aim: { x: 0.5, y: 0.5 },
  deadband: 0.05, // normalised frame units
  panGainMs: 600, // ms of motor time per full-frame-width of error
  tiltGainMs: 250,
  minPulseMs: 40,
  maxPulseMs: 400,
  settleMs: 250, // wait after moving before trusting new detections
  invertPan: false,
  invertTilt: false,

  // Fixed mode: (image x,y) <-> (pan,tilt ms) pairs recorded by the user.
  calibration: [],
  fixedDeadbandMs: 60,

  autoFire: false, // fire automatically when locked on (requires armed)
  lockFrames: 5, // consecutive on-target updates before considered locked
};

export function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
