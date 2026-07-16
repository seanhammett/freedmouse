// Replay harness: drives extension/content.js with the REAL per-stream
// activity captured by the in-extension diagnostic recorder (Record diag),
// and asserts the selector locks a camera-cluster stream.
//
// The fixture (tests/fixtures/diag-*.json) holds, for every mat4 uniform
// stream on a live Onshape session, 200ms bins of [uploads, changes,
// rotationDeg, identityWrites]. Each stream is re-synthesized from its own
// bins: `changes` rotations of rotationDeg/changes each around a
// stream-specific axis, `identityWrites` identity uploads, and repeat uploads
// for the rest. That reproduces the exact statistical signatures the selector
// scores on — so a selection regression against this machine fails here, in
// CI, instead of in the field.
//
// Ground truth for the 2026-07-15 Mac capture: the camera is the 7-stream
// consensus cluster (identical rotation histories, ~1 change/frame, ~3° smooth
// steps, zero identity writes). The high-traffic streams are per-object
// model-view multiplexes (65°+ jumps, thousands of identity writes) and must
// never be auto-locked; the sparse streams are settle-only overlays.
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURE = process.argv[2] || path.join(__dirname, 'fixtures', 'diag-mac-2026-07-15.json');
// Camera cluster in the fixture, identified offline by identical rotation
// histories + 1-change-per-frame + zero identity writes.
const CAMERA_CLUSTER = new Set(['gl_1:u_3', 'gl_1:u_5', 'gl_1:u_6', 'gl_1:u_7', 'gl_1:u_f', 'gl_1:u_g', 'gl_1:u_h']);
// Per-object multiplexed streams: must always be disqualified.
const MULTIPLEXED = new Set(['gl_1:u_4', 'gl_1:u_8', 'gl_1:u_9', 'gl_1:u_a']);

// ---------- controllable clock ----------
let fakeNow = 0;
global.performance = { now: () => fakeNow };

// ---------- quaternion helpers ----------
function qAxisAngle(ax, ay, az, angleRad) {
  const n = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(angleRad / 2);
  return { w: Math.cos(angleRad / 2), x: (ax / n) * s, y: (ay / n) * s, z: (az / n) * s };
}
function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function qConj(q) { return { w: q.w, x: -q.x, y: -q.y, z: -q.z }; }
function qDotAbs(a, b) { return Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z); }
function quatToMat16(q) {
  const { w, x, y, z } = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const r = [
    [w * w + xx - yy - zz, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - xx + yy - zz, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - xx - yy + zz],
  ];
  return [
    r[0][0], r[1][0], r[2][0], 0,
    r[0][1], r[1][1], r[2][1], 0,
    r[0][2], r[1][2], r[2][2], 0,
    0, 0, 0, 1,
  ];
}
const IDENTITY16 = quatToMat16({ w: 1, x: 0, y: 0, z: 0 });

// ---------- DOM stubs (same shape as sim_watcher.js) ----------
const noop = () => {};
function makeCtx2d() {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof p === 'string') return t[p] !== undefined ? t[p] : noop;
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    className: '',
    isConnected: true,
    style: {},
    children: [],
    attributes: [],
    disabled: false,
    textContent: '',
    value: '',
    _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    _style: { transform: 'none', webkitTransform: 'none', content: 'none' },
    parentElement: null,
    classList: { toggle: noop, add: noop, remove: noop },
    addEventListener: noop,
    setPointerCapture: noop,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    getBoundingClientRect() { return { ...this._rect }; },
    getContext() { return makeCtx2d(); },
    getAttribute() { return null; },
    querySelector() { return makeEl('button'); },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'options', { get() { return this.children; } });
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set(_v) {} });
  return el;
}
function makePanel() {
  const panel = makeEl('div');
  const named = new Map();
  panel.querySelector = (sel) => {
    if (!named.has(sel)) {
      const tag = sel.includes('preview') ? 'canvas' : (sel.includes('select') ? 'select' : 'button');
      const child = makeEl(tag);
      if (tag === 'canvas') { child.width = 248; child.height = 156; }
      if (tag === 'select') {
        Object.defineProperty(child, 'textContent', {
          get() { return ''; },
          set(_v) { child.children.length = 0; },
        });
      }
      named.set(sel, child);
    }
    return named.get(sel);
  };
  return panel;
}

let intervalCb = null;
global.window = {
  innerWidth: 1920,
  innerHeight: 963,
  location: { hostname: 'cad.onshape.com' },
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: noop,
  setInterval: (cb, _ms) => { intervalCb = cb; return 1; },
  getComputedStyle: (el, _pseudo) => (el && el._style) ? el._style : { transform: 'none', webkitTransform: 'none', content: 'none' },
};
global.document = {
  readyState: 'complete',
  addEventListener: noop,
  body: makeEl('body'),
  createElement: (tag) => (tag === 'div' ? makePanel() : makeEl(tag)),
  getElementById: () => null,
  elementsFromPoint: () => [],
  // No CSS view-cube reference at all: the real capture recorded ZERO CSS
  // samples in 31s, so the replay gives the selector nothing to lean on.
  querySelectorAll: () => [],
};
global.document.body.appendChild = function (c) { this.children.push(c); return c; };

const fakeLocalStorage = { getItem: () => null, setItem: noop };
const FakeCustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
const fakeNavigator = {};
global.getComputedStyle = global.window.getComputedStyle;

function GL1() {} function GL2() {}
GL1.prototype.uniformMatrix4fv = function () {};
GL1.prototype.getUniformLocation = function (_p, _n) { return {}; };
GL2.prototype.uniformMatrix4fv = function () {};
GL2.prototype.getUniformLocation = function (_p, _n) { return {}; };
global.window.WebGLRenderingContext = GL1;
global.window.WebGL2RenderingContext = GL2;

// ---------- load the real content script ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
new Function('window', 'document', 'localStorage', 'navigator', 'CustomEvent', 'performance', 'getComputedStyle', src)(
  global.window, global.document, fakeLocalStorage, fakeNavigator, FakeCustomEvent, global.performance, global.getComputedStyle
);
const api = global.window.usbFreeDWidgetWatcher;
if (!api) { console.error('FAIL: watcher API not installed'); process.exit(1); }

// ---------- replay ----------
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
console.log('replaying', path.basename(FIXTURE), '—', fixture.streams.length, 'streams,',
  Math.round(fixture.durationMs / 1000) + 's, recorded', fixture.recordedAt, 'on', fixture.buildTag);

const glFake = Object.create(GL2.prototype);
glFake.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1674, bottom: 857, width: 1674, height: 857 }) };
const upload = (loc, m) => GL2.prototype.uniformMatrix4fv.call(glFake, loc, false, new Float32Array(m));

// One synthesized stream per fixture stream. The uniform name is the fixture
// id (keyword-neutral), which lets assertions map session candidates back to
// fixture streams via the dump.
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const streams = fixture.streams.map((s) => {
  const name = 's' + s.id.replace(/[^A-Za-z0-9]/g, '_');
  const h = hash32(s.id);
  const axis = [0.2 + ((h & 0xff) / 255), 0.2 + (((h >> 8) & 0xff) / 255), 0.2 + (((h >> 16) & 0xff) / 255)];
  const bins = new Map(s.bins.map((b) => [b[0], b]));
  return {
    fixtureId: s.id,
    name,
    loc: GL2.prototype.getUniformLocation.call(glFake, { fixtureId: s.id }, name),
    axis,
    quat: qAxisAngle(axis[0], axis[1], axis[2], ((h >> 24) & 0xff) / 100),
    lastMat: null,
    bins,
  };
});
const nameToFixtureId = new Map(streams.map((st) => [st.name, st.fixtureId]));

const binMs = fixture.binMs;
const totalBins = Math.ceil(fixture.durationMs / binMs);
const TICK_MS = 30;
let nextTickAt = TICK_MS;
function advanceTo(t) {
  fakeNow = t;
  while (fakeNow >= nextTickAt) {
    if (intervalCb) intervalCb();
    nextTickAt += TICK_MS;
  }
}

const lockHistory = [];
let lastLockSeen;
function noteLock() {
  const id = api.getState().lockedWebglSourceId;
  if (id !== lastLockSeen) {
    lastLockSeen = id;
    const item = api.dumpWebglSources().items.find((it) => it.locked);
    const fixtureId = item ? (nameToFixtureId.get(item.uniformName) || item.uniformName) : null;
    lockHistory.push({ tMs: Math.round(fakeNow), fixtureId });
  }
}

for (let bi = 0; bi < totalBins; bi++) {
  const t0 = bi * binMs;
  // Collect this bin's uploads across all streams, each tagged with an
  // in-bin timestamp, then emit in time order (streams interleave in reality).
  const events = [];
  for (const st of streams) {
    const b = st.bins.get(bi);
    if (!b) continue;
    const [, u, ch, rot, idc] = b;
    const stepDeg = ch > 0 ? rot / ch : 0;
    const repeats = Math.max(0, u - ch - idc);
    // Order within each slot group: repeats and identity writes happen in
    // earlier draw passes, the changed (real) value lands last per frame.
    let k = 0;
    for (let i = 0; i < repeats; i++, k++) events.push({ st, kind: 'repeat', at: t0 + ((k + 0.5) / u) * binMs });
    for (let i = 0; i < idc; i++, k++) events.push({ st, kind: 'identity', at: t0 + ((k + 0.5) / u) * binMs });
    for (let i = 0; i < ch; i++, k++) events.push({ st, kind: 'change', stepDeg, at: t0 + ((k + 0.5) / u) * binMs });
  }
  events.sort((a, b) => a.at - b.at);
  for (const ev of events) {
    advanceTo(ev.at);
    if (ev.kind === 'identity') {
      upload(ev.st.loc, IDENTITY16);
    } else if (ev.kind === 'change') {
      ev.st.quat = qMul(qAxisAngle(ev.st.axis[0], ev.st.axis[1], ev.st.axis[2], (ev.stepDeg * Math.PI) / 180), ev.st.quat);
      ev.st.lastMat = quatToMat16(ev.st.quat);
      upload(ev.st.loc, ev.st.lastMat);
    } else if (ev.st.lastMat) {
      upload(ev.st.loc, ev.st.lastMat);
    }
  }
  advanceTo(t0 + binMs);
  noteLock();
}

// ---------- assertions ----------
let pass = true;
function check(cond, msg) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg);
  if (!cond) pass = false;
}

console.log('lock history:', lockHistory.map((l) => (l.tMs / 1000).toFixed(1) + 's→' + (l.fixtureId || 'none')).join('  '));

const dump = api.dumpWebglSources();
const lockedItem = dump.items.find((it) => it.locked);
const lockedFixtureId = lockedItem ? nameToFixtureId.get(lockedItem.uniformName) : null;
console.log('final lock:', lockedFixtureId, lockedItem && { idFrac: lockedItem.idFrac, jumpFrac: lockedItem.jumpFrac, changes: lockedItem.changes });

check(CAMERA_CLUSTER.has(lockedFixtureId), 'final lock is a camera-cluster stream');

// The lock must reach the camera cluster during the first orbit (drag ran
// ~5.8s–19.2s in the capture) and never leave it afterwards.
const firstCameraLock = lockHistory.find((l) => CAMERA_CLUSTER.has(l.fixtureId));
check(!!firstCameraLock && firstCameraLock.tMs <= 12000, 'camera cluster locked during the first orbit (<=12s)');
const locksAfterCamera = firstCameraLock
  ? lockHistory.filter((l) => l.tMs > firstCameraLock.tMs && !CAMERA_CLUSTER.has(l.fixtureId))
  : [{}];
check(locksAfterCamera.length === 0, 'lock never leaves the camera cluster once acquired');

for (const id of MULTIPLEXED) {
  const item = dump.items.find((it) => nameToFixtureId.get(it.uniformName) === id);
  check(!!item && item.disqualified, 'multiplexed stream ' + id + ' is disqualified (' + (item && item.disqualified) + ')');
}

// Output must track the locked stream's synthesized orientation.
const lockedStream = streams.find((st) => st.fixtureId === lockedFixtureId);
const out = api.getState().rawQuat;
const fit = out && lockedStream
  ? Math.max(qDotAbs(out, lockedStream.quat), qDotAbs(qConj(out), lockedStream.quat))
  : 0;
console.log('output vs locked-stream truth |dot| =', fit.toFixed(5));
check(fit > 0.99, 'published orientation matches the locked stream');

console.log(pass ? '\nREPLAY CHECKS PASSED' : '\nREPLAY CHECKS FAILED');
process.exit(pass ? 0 : 1);
