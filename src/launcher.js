// Driver for the Dream Cheeky "Thunder" USB missile launcher (VID 0x2123, PID 0x1010).
//
// The device is a plain HID device. Every command is an 8-byte output report
// sent as a SET_REPORT control transfer:
//   [0x02, cmd, 0, 0, 0, 0, 0, 0]  - motion / fire
//   [0x03, on,  0, 0, 0, 0, 0, 0]  - LED
// Motors keep running until a STOP is sent, so motion is done as timed pulses.
// There is no position feedback, so pan/tilt is estimated by dead reckoning
// (milliseconds of travel from the left/bottom limit switches).

import HID from 'node-hid';

export const VENDOR_ID = 0x2123;
export const PRODUCT_ID = 0x1010;

const CMD = { down: 0x01, up: 0x02, left: 0x04, right: 0x08, fire: 0x10, stop: 0x20 };
const FIRE_CYCLE_MS = 4500;
export const DIRECTIONS = ['left', 'right', 'up', 'down'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Launcher {
  constructor({ dryRun = false, panRangeMs = 6000, tiltRangeMs = 1000, log = console.log } = {}) {
    this.dryRun = dryRun;
    this.panRangeMs = panRangeMs;
    this.tiltRangeMs = tiltRangeMs;
    this.log = log;
    this.device = null;
    this.queue = Promise.resolve();
    this.motion = null; // { dir, startedAt } while a motor is running
    this.firing = false;
    this.homed = false;
    this.pos = { pan: panRangeMs / 2, tilt: tiltRangeMs / 2 };
  }

  open() {
    if (this.dryRun) {
      this.log('[launcher] dry run - no USB device will be used');
      return;
    }
    const info = HID.devices(VENDOR_ID, PRODUCT_ID)[0];
    if (!info) {
      throw new Error(
        `Missile launcher (${hex(VENDOR_ID)}:${hex(PRODUCT_ID)}) not found. Is it plugged in?`,
      );
    }
    this.device = new HID.HID(info.path);
    this.device.on('error', (err) => this.log('[launcher] USB error:', err.message));
    this.log(`[launcher] connected to ${info.manufacturer} ${info.product}`);
  }

  close() {
    if (!this.device) return;
    try {
      this.write(0x02, CMD.stop);
      this.device.close();
    } catch {
      // device may already be gone
    }
    this.device = null;
  }

  get busy() {
    return this.firing || this.motion !== null;
  }

  // Dead-reckoned position including any move still in progress.
  currentPos() {
    const pos = { ...this.pos };
    if (!this.motion) return pos;
    const elapsed = Date.now() - this.motion.startedAt;
    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    const sign = { left: -1, right: 1, down: -1, up: 1 }[this.motion.dir];
    if (this.motion.dir === 'left' || this.motion.dir === 'right') {
      pos.pan = clamp(pos.pan + sign * elapsed, this.panRangeMs);
    } else {
      pos.tilt = clamp(pos.tilt + sign * elapsed, this.tiltRangeMs);
    }
    return pos;
  }

  // Raw report. node-hid needs a leading report-ID byte (0) for devices without report IDs.
  write(prefix, value) {
    if (this.dryRun) return;
    if (!this.device) throw new Error('Launcher not open');
    this.device.write([0x00, prefix, value, 0, 0, 0, 0, 0, 0]);
  }

  // All device operations are serialised so pulses never overlap.
  enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch((err) => this.log('[launcher]', err.message));
    return run;
  }

  startMove(dir) {
    if (!CMD[dir] || !DIRECTIONS.includes(dir)) throw new Error(`Unknown direction: ${dir}`);
    return this.enqueue(() => {
      if (this.firing) return;
      this.#accumulate();
      this.write(0x02, CMD[dir]);
      this.motion = { dir, startedAt: Date.now() };
    });
  }

  stop() {
    return this.enqueue(() => {
      this.#accumulate();
      this.write(0x02, CMD.stop);
    });
  }

  pulse(dir, ms) {
    if (!DIRECTIONS.includes(dir)) throw new Error(`Unknown direction: ${dir}`);
    return this.enqueue(async () => {
      if (this.firing) return;
      this.#accumulate();
      this.write(0x02, CMD[dir]);
      this.motion = { dir, startedAt: Date.now() };
      await sleep(ms);
      this.#accumulate();
      this.write(0x02, CMD.stop);
    });
  }

  fire() {
    return this.enqueue(async () => {
      this.#accumulate();
      this.firing = true;
      this.log('[launcher] FIRE');
      try {
        this.write(0x02, CMD.fire);
        await sleep(FIRE_CYCLE_MS);
        this.write(0x02, CMD.stop);
      } finally {
        this.firing = false;
      }
    });
  }

  led(on) {
    return this.enqueue(() => this.write(0x03, on ? 0x01 : 0x00));
  }

  // Drive into the left and bottom limit switches to get a known reference
  // position, then return to the middle of the travel range.
  home() {
    return this.enqueue(async () => {
      this.log('[launcher] homing');
      this.homed = false;
      this.motion = { dir: 'left', startedAt: Date.now() };
      this.write(0x02, CMD.left);
      await sleep(this.panRangeMs + 500);
      this.motion = { dir: 'down', startedAt: Date.now() };
      this.write(0x02, CMD.down);
      await sleep(this.tiltRangeMs + 300);
      this.write(0x02, CMD.stop);
      this.motion = null;
      this.pos = { pan: 0, tilt: 0 };
      this.homed = true;
    }).then(() =>
      Promise.all([
        this.pulse('right', this.panRangeMs / 2),
        this.pulse('up', this.tiltRangeMs / 2),
      ]),
    );
  }

  // Fold elapsed motor time into the dead-reckoned position.
  #accumulate() {
    if (!this.motion) return;
    const elapsed = Date.now() - this.motion.startedAt;
    const clamp = (v, max) => Math.min(Math.max(v, 0), max);
    switch (this.motion.dir) {
      case 'left': this.pos.pan = clamp(this.pos.pan - elapsed, this.panRangeMs); break;
      case 'right': this.pos.pan = clamp(this.pos.pan + elapsed, this.panRangeMs); break;
      case 'down': this.pos.tilt = clamp(this.pos.tilt - elapsed, this.tiltRangeMs); break;
      case 'up': this.pos.tilt = clamp(this.pos.tilt + elapsed, this.tiltRangeMs); break;
    }
    this.motion = null;
  }
}

function hex(n) {
  return '0x' + n.toString(16).padStart(4, '0');
}
