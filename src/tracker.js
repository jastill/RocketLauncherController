// Turns detections from the browser into launcher movements.
//
// Detections arrive as normalised frame coordinates (0..1, origin top-left).
// Two strategies, chosen by config.mode:
//   mounted - camera moves with the launcher; pulse the motors to drive the
//             target towards the aim point, re-measuring after each pulse.
//   fixed   - camera is stationary; map the target's image position to an
//             absolute pan/tilt using a linear fit of calibration points, and
//             move there by dead reckoning.

const STALE_MS = 500;
const TICK_MS = 50;

export class Tracker {
  constructor(launcher, config, { onChange = () => {}, log = console.log } = {}) {
    this.launcher = launcher;
    this.config = config;
    this.onChange = onChange;
    this.log = log;
    this.enabled = false;
    this.armed = false;
    this.target = null; // { x, y, t }
    this.locked = false;
    this.lockCount = 0;
    this.lastMoveEnd = 0;
    this.moving = false;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose() {
    clearInterval(this.timer);
  }

  setTarget(target) {
    this.target = target ? { ...target, receivedAt: Date.now() } : null;
  }

  setEnabled(on) {
    this.enabled = on;
    this.#setLocked(false);
    if (on && this.config.mode === 'fixed' && !this.launcher.homed) {
      this.log('[tracker] fixed mode needs a known position - homing first');
      this.#move(() => this.launcher.home());
    }
  }

  async fire() {
    if (!this.armed) throw new Error('Launcher is not armed');
    await this.launcher.fire();
    this.onChange();
  }

  tick() {
    if (!this.enabled || this.moving || this.launcher.busy) return;

    const t = this.target;
    const fresh = t && Date.now() - t.receivedAt < STALE_MS;
    // Ignore frames that were captured while (or just after) the launcher was moving.
    const settled = t && t.t >= this.lastMoveEnd + this.config.settleMs;
    if (!fresh) return this.#setLocked(false);
    if (!settled) return;

    const step = this.config.mode === 'mounted' ? this.#mountedStep(t) : this.#fixedStep(t);
    if (step) {
      this.lockCount = 0;
      this.#setLocked(false);
      this.#move(() => this.launcher.pulse(step.dir, step.ms));
    } else {
      this.lockCount++;
      if (this.lockCount >= this.config.lockFrames) this.#setLocked(true);
    }
  }

  #mountedStep(t) {
    const c = this.config;
    let ex = t.x - c.aim.x; // +ve: target is right of the aim point
    let ey = t.y - c.aim.y; // +ve: target is below the aim point
    if (c.invertPan) ex = -ex;
    if (c.invertTilt) ey = -ey;
    if (Math.abs(ex) < c.deadband && Math.abs(ey) < c.deadband) return null;

    // The launcher can only reliably drive one axis at a time; fix the worse one first.
    const clampMs = (ms) => Math.round(Math.min(Math.max(ms, c.minPulseMs), c.maxPulseMs));
    if (Math.abs(ex) >= Math.abs(ey)) {
      return { dir: ex > 0 ? 'right' : 'left', ms: clampMs(Math.abs(ex) * c.panGainMs) };
    }
    return { dir: ey > 0 ? 'down' : 'up', ms: clampMs(Math.abs(ey) * c.tiltGainMs) };
  }

  #fixedStep(t) {
    const fit = fitCalibration(this.config.calibration);
    if (!fit) return null;
    const pos = this.launcher.pos;
    const dPan = fit.pan ? fit.pan.a * t.x + fit.pan.b - pos.pan : 0;
    const dTilt = fit.tilt ? fit.tilt.a * t.y + fit.tilt.b - pos.tilt : 0;
    const db = this.config.fixedDeadbandMs;
    if (Math.abs(dPan) < db && Math.abs(dTilt) < db) return null;

    if (Math.abs(dPan) >= db) {
      return { dir: dPan > 0 ? 'right' : 'left', ms: Math.round(Math.abs(dPan)) };
    }
    return { dir: dTilt > 0 ? 'up' : 'down', ms: Math.round(Math.abs(dTilt)) };
  }

  #move(fn) {
    this.moving = true;
    this.onChange();
    fn()
      .catch((err) => this.log('[tracker]', err.message))
      .finally(() => {
        this.moving = false;
        this.lastMoveEnd = Date.now();
        this.onChange();
      });
  }

  #setLocked(locked) {
    if (!locked) this.lockCount = 0;
    if (locked === this.locked) return;
    this.locked = locked;
    this.onChange();
    if (locked && this.armed && this.config.autoFire) {
      this.log('[tracker] locked on - auto fire');
      this.fire().catch((err) => this.log('[tracker]', err.message));
    }
  }
}

// Least-squares fit of pan = a*x + b and tilt = a*y + b over the calibration
// points. An axis is null until there are two points spread apart on it.
export function fitCalibration(points) {
  if (!points || points.length < 2) return null;
  const fit = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx / n < 0.0025) return null; // points too close together on this axis
    const a = sxy / sxx;
    return { a, b: my - a * mx };
  };
  const pan = fit(points.map((p) => p.x), points.map((p) => p.pan));
  const tilt = fit(points.map((p) => p.y), points.map((p) => p.tilt));
  if (!pan && !tilt) return null;
  return { pan, tilt };
}
