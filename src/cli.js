#!/usr/bin/env node
// Manual control of the launcher from the terminal, handy for testing the USB link.
//
//   node src/cli.js list
//   node src/cli.js led on|off
//   node src/cli.js left|right|up|down [ms]
//   node src/cli.js home
//   node src/cli.js fire

import HID from 'node-hid';
import { Launcher, VENDOR_ID, PRODUCT_ID, DIRECTIONS } from './launcher.js';
import { loadConfig } from './config.js';

const [cmd, arg] = process.argv.slice(2);

if (!cmd || cmd === 'help') {
  console.log('usage: cli.js list | led on|off | left|right|up|down [ms] | stop | home | fire');
  process.exit(0);
}

if (cmd === 'list') {
  const found = HID.devices(VENDOR_ID, PRODUCT_ID);
  console.log(found.length ? found : 'No missile launcher found.');
  process.exit(0);
}

const config = loadConfig();
const launcher = new Launcher({ panRangeMs: config.panRangeMs, tiltRangeMs: config.tiltRangeMs });

try {
  launcher.open();
  if (DIRECTIONS.includes(cmd)) await launcher.pulse(cmd, Number(arg) || 300);
  else if (cmd === 'stop') await launcher.stop();
  else if (cmd === 'led') await launcher.led(arg !== 'off');
  else if (cmd === 'home') await launcher.home();
  else if (cmd === 'fire') await launcher.fire();
  else throw new Error(`Unknown command: ${cmd}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  launcher.close();
}
