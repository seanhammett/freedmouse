#!/usr/bin/env node
// Analyze a "Cal motion" diagnostic capture: fit the real HID→velocity curve
// and estimate loop dead time.
//
// Usage: node tools/analyze_cal.js diagnostics/usb-freed-diag-<id>.json
//
// Inputs inside the capture:
//   serial.log      — receiver "CAL,<deviceMs>,..." markers (host-timestamped
//                     by the extension when the line arrived)
//   serial.targetTx — extension ground truth: [hostMs, seq, qw, qx, qy, qz]
//                     (during cal these are 20 Hz heartbeats + render frames)
//
// For each staircase phase (axis, signed HID value) we compute the view's
// angular velocity over the stable middle of the hold window. Dead time is
// estimated per phase as the lag between the CAL marker and the first
// sustained motion onset.

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/analyze_cal.js <diag.json>');
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
const log = (d.serial && (d.serial.log || d.serial.serialLog)) || [];
const tx = (d.serial && d.serial.targetTx) || [];

if (!tx.length) {
  console.error('capture has no targetTx ground truth — was the diag recording during the cal run?');
  process.exit(1);
}

// ---- parse CAL markers ----
// serial.log entries are [hostMs, line]. Drive markers: "CAL,<deviceMs>,<axis>,<value>"
// Other markers: start / zero / done / abort.
const phases = [];
let calSeen = false;
for (const [hostMs, line] of log) {
  if (!line.startsWith('CAL,')) continue;
  calSeen = true;
  const p = line.split(',');
  if (p.length === 4 && (p[2] === 'x' || p[2] === 'y' || p[2] === 'z')) {
    phases.push({ hostMs, axis: p[2], value: parseInt(p[3], 10) });
  } else if (p.length === 3 && p[2] === 'zero' && phases.length) {
    const ph = phases[phases.length - 1];
    if (ph.zeroHostMs === undefined) ph.zeroHostMs = hostMs;
  }
}
if (!calSeen) {
  console.error('no CAL markers in serial.log — receiver CDC output still not reaching the extension.');
  process.exit(1);
}
if (!phases.length) {
  console.error('CAL markers present but no drive phases parsed.');
  process.exit(1);
}

// ---- angular velocity samples from targetTx ----
// Instantaneous |ω| between consecutive ground-truth quats, tagged with time.
function quatAngleDeg(a, b) {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}
const vel = []; // {t, degPerS}
for (let i = 1; i < tx.length; i++) {
  const dt = tx[i][0] - tx[i - 1][0];
  if (dt <= 0 || dt > 300) continue;
  const a = [tx[i - 1][2], tx[i - 1][3], tx[i - 1][4], tx[i - 1][5]];
  const b = [tx[i][2], tx[i][3], tx[i][4], tx[i][5]];
  vel.push({ t: tx[i][0], v: quatAngleDeg(a, b) / (dt / 1000) });
}

function velIn(t0, t1) {
  return vel.filter((s) => s.t >= t0 && s.t < t1).map((s) => s.v);
}
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// ---- per-phase measurement ----
const HOLD_MS = 1200; // must match receiver CAL_HOLD_MS
const results = [];
for (const ph of phases) {
  const end = ph.zeroHostMs !== undefined ? ph.zeroHostMs : ph.hostMs + HOLD_MS;
  // stable window: skip the first 400ms (dead time + spin-up), use the rest
  const stable = velIn(ph.hostMs + 400, end);
  const speed = median(stable);

  // dead time: first of 2 consecutive samples above half the stable speed
  let onset = NaN;
  if (speed > 1) {
    const win = vel.filter((s) => s.t >= ph.hostMs - 50 && s.t < end);
    for (let i = 0; i + 1 < win.length; i++) {
      if (win[i].v > speed / 2 && win[i + 1].v > speed / 2) {
        onset = win[i].t - ph.hostMs;
        break;
      }
    }
  }
  results.push({ axis: ph.axis, value: ph.value, degPerS: speed, deadMs: onset, n: stable.length });
}

// ---- report ----
console.log('phase results (median |ω| over stable window):');
console.log('axis  hid     °/s     dead ms  samples');
for (const r of results) {
  console.log(
    r.axis.padEnd(4),
    String(r.value).padStart(5),
    isNaN(r.degPerS) ? '     --' : r.degPerS.toFixed(1).padStart(8),
    isNaN(r.deadMs) ? '     --' : String(Math.round(r.deadMs)).padStart(8),
    String(r.n).padStart(8)
  );
}

// curve per |hid| averaged across axes+signs — the driver is assumed symmetric
const byMag = new Map();
for (const r of results) {
  if (isNaN(r.degPerS)) continue;
  const k = Math.abs(r.value);
  if (!byMag.has(k)) byMag.set(k, []);
  byMag.get(k).push(r.degPerS);
}
console.log('\nHID→velocity curve (all axes/signs pooled):');
console.log('|hid|   °/s      °/s per hid unit');
for (const k of [...byMag.keys()].sort((a, b) => a - b)) {
  const m = median(byMag.get(k));
  console.log(String(k).padStart(5), m.toFixed(1).padStart(8), (m / k).toFixed(3).padStart(10));
}

const deads = results.map((r) => r.deadMs).filter((x) => !isNaN(x));
if (deads.length) {
  console.log('\ndead time: median', Math.round(median(deads)), 'ms over', deads.length, 'phases');
}
console.log('\n(linear model would predict °/s per hid unit to be constant; a rising or');
console.log('falling trend is the driver response curve the receiver must invert.)');
