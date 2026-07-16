// Simulation harness for extension/content.js
// Stubs enough DOM/WebGL to load the real content script in Node, then feeds
// it competing uniformMatrix4fv streams + a CSS matrix3d view-cube reference
// and checks which stream the watcher locks.
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- controllable clock ----------
let fakeNow = 0;
global.performance = { now: () => fakeNow };

// ---------- quaternion / matrix helpers (harness-local) ----------
function qAxisAngle(ax, ay, az, angleRad) {
  const n = Math.hypot(ax, ay, az);
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
// column-major 4x4 from quaternion rotation
function quatToMat16(q) {
  const { w, x, y, z } = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const r = [
    [w * w + xx - yy - zz, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - xx + yy - zz, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - xx - yy + zz],
  ];
  // column-major: m[col*4+row]
  return [
    r[0][0], r[1][0], r[2][0], 0,
    r[0][1], r[1][1], r[2][1], 0,
    r[0][2], r[1][2], r[2][2], 0,
    0, 0, 0, 1,
  ];
}
function matToCss(m) { return 'matrix3d(' + m.join(',') + ')'; }

// ---------- DOM stubs ----------
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

// panel with persistent named sub-elements
function makePanel() {
  const panel = makeEl('div');
  const named = new Map();
  panel.querySelector = (sel) => {
    if (!named.has(sel)) {
      const tag = sel.includes('preview') ? 'canvas' : (sel.includes('select') ? 'select' : 'button');
      const child = makeEl(tag);
      if (tag === 'canvas') { child.width = 248; child.height = 156; }
      if (tag === 'select') {
        // select needs textContent-clears-children semantics
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

// the Onshape view-cube anchor (upper right, inside widget zone)
const anchorEl = makeEl('div');
anchorEl.className = 'os-view-cube-bounds';
anchorEl._rect = { left: 1420, top: 40, right: 1520, bottom: 140, width: 100, height: 100 };

let intervalCb = null;

global.window = {
  innerWidth: 1600,
  innerHeight: 900,
  location: { hostname: 'cad.onshape.com' },
  addEventListener: noop,
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
  querySelectorAll: (sel) => (sel === '.os-view-cube-bounds' ? [anchorEl] : []),
};
global.document.body.appendChild = function (c) { this.children.push(c); return c; };

const fakeLocalStorage = { getItem: () => null, setItem: noop };
const FakeCustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
const fakeNavigator = {};
global.getComputedStyle = global.window.getComputedStyle;

// fake WebGL prototypes for the script to hook
function GL1() {} function GL2() {}
GL1.prototype.uniformMatrix4fv = function () {};
GL1.prototype.getUniformLocation = function (_p, _n) { return {}; };
GL2.prototype.uniformMatrix4fv = function () {};
GL2.prototype.getUniformLocation = function (_p, _n) { return {}; };
global.window.WebGLRenderingContext = GL1;
global.window.WebGL2RenderingContext = GL2;

// ---------- load the real content script ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
// evaluate with window/document in scope (script references bare `document`, `window`, etc.)
new Function('window', 'document', 'localStorage', 'navigator', 'CustomEvent', 'performance', 'getComputedStyle', src)(
  global.window, global.document, fakeLocalStorage, fakeNavigator, FakeCustomEvent, global.performance, global.getComputedStyle
);

const api = global.window.usbFreeDWidgetWatcher;
if (!api) { console.error('FAIL: watcher API not installed'); process.exit(1); }

// ---------- simulated GL streams ----------
const glFake = Object.create(GL2.prototype);
glFake.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }) };

// register uniform names via the hooked getUniformLocation so locMeta is set
const progA = {}, progB = {}, progC = {};
const locA = GL2.prototype.getUniformLocation.call(glFake, progA, 'viewMatrix');       // correct: tracks the view
const locB = GL2.prototype.getUniformLocation.call(glFake, progB, 'modelMatrix');      // wrong: rotates differently, very active
const locC = GL2.prototype.getUniformLocation.call(glFake, progC, 'shadowMatrix');     // wrong: static

const upload = (loc, m) => GL2.prototype.uniformMatrix4fv.call(glFake, loc, false, new Float32Array(m));

// ---------- simulation ----------
// ground-truth view orientation: orbit about a tilted axis at ~40°/s
const viewQuatAt = (tMs) => qAxisAngle(0.3, 1, 0.15, (tMs / 1000) * (40 * Math.PI / 180));
const wrongQuatAt = (tMs) => qAxisAngle(1, 0.1, 0.8, (tMs / 1000) * (95 * Math.PI / 180));
const staticMat = quatToMat16(qAxisAngle(0, 0, 1, 0.4));

let cssEnabled = false;
function step(dtMs) {
  fakeNow += dtMs;
  const vq = viewQuatAt(fakeNow);
  // WebGL "view matrix" stream: inverse of the camera orientation is typical,
  // but here upload the rotation directly; raw-vs-inverse is the watcher's job.
  upload(locA, quatToMat16(vq));
  // wrong stream gets double the traffic to tempt activity-based scoring
  upload(locB, quatToMat16(wrongQuatAt(fakeNow)));
  upload(locB, quatToMat16(wrongQuatAt(fakeNow + 1)));
  upload(locC, staticMat);
  anchorEl._style = cssEnabled
    ? { transform: matToCss(quatToMat16(vq)), webkitTransform: 'none', content: 'none' }
    : { transform: 'none', webkitTransform: 'none', content: 'none' };
  if (intervalCb) intervalCb();
}

let pass = true;
function check(cond, msg) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg);
  if (!cond) pass = false;
}
const groundTruthFit = () => {
  const out = api.getState().rawQuat;
  const vq = viewQuatAt(fakeNow);
  return out ? Math.max(qDotAbs(out, vq), qDotAbs(qConj(out), vq)) : 0;
};

// --- phase 1: CSS present, streams active — a lock is acquired by activity scoring ---
console.log('--- phase 1: initial lock (3s) ---');
cssEnabled = true;
for (let i = 0; i < 100; i++) step(30);
const s1 = api.getState();
console.log('phase1 lock:', s1.lockedWebglSourceId, 'strategy:', s1.strategy);
check(!!s1.lockedWebglSourceId, 'a WebGL source gets locked quickly');
check(s1.strategy === 'webgl-uniform-matrix4fv', 'output rides the WebGL fast path');

// --- phase 2: stickiness + passive telemetry (5s) ---
// A live locked stream must never be second-guessed (no flapping), while
// telemetry passively identifies which stream actually tracks the view cube.
console.log('--- phase 2: stickiness + telemetry (5s) ---');
const lockAtStart = api.getState().lockedWebglSourceId;
let lockChanges = 0;
let nonWebglTicks = 0;
for (let i = 0; i < 166; i++) {
  step(30);
  const st = api.getState();
  if (st.lockedWebglSourceId !== lockAtStart) lockChanges++;
  if (st.strategy !== 'webgl-uniform-matrix4fv') nonWebglTicks++;
}
const dump2 = api.dumpWebglSources();
for (const it of dump2.items) {
  console.log(`  ${(it.uniformName || it.id).padEnd(14)} trk=${it.coRot} fit=${it.agree} validated=${it.validated} changes=${it.changes} locked=${it.locked}`);
}
check(lockChanges === 0, 'lock never changes while its stream is alive (no flapping)');
check(nonWebglTicks === 0, 'output stays on the WebGL fast path the whole time (smooth)');
const viewItem2 = dump2.items.find((it) => it.uniformName === 'viewMatrix');
const modelItem2 = dump2.items.find((it) => it.uniformName === 'modelMatrix');
check(viewItem2 && viewItem2.validated && viewItem2.agree > 0.99, 'telemetry identifies viewMatrix as tracking the cube');
check(modelItem2 && !modelItem2.validated, 'telemetry does not flag the wrong high-traffic stream');

// --- phase 3: user pins the right stream from the dropdown ---
console.log('--- phase 3: pin viewMatrix (2s) ---');
const viewSource = api.listWebglSources().find((it) => it.uniformName === 'viewMatrix');
check(!!viewSource, 'viewMatrix appears in the source list');
api.pinWebglSourceById(viewSource.id);
api.relockWebglSource();
for (let i = 0; i < 66; i++) step(30);
const s3 = api.getState();
const locked3 = api.dumpWebglSources().items.find((it) => it.locked);
console.log('phase3 locked uniform:', locked3 && locked3.uniformName, 'fit vs truth:', groundTruthFit().toFixed(5));
check(locked3 && locked3.uniformName === 'viewMatrix', 'pin locks the chosen stream');
check(groundTruthFit() > 0.995, 'pinned output matches ground truth');
check(s3.preferredWebglSource && s3.preferredWebglSource.uniformName === 'viewMatrix',
  'pin persists a uniform-name fingerprint for future page loads');

// --- phase 4: WebGL2 srcOffset + transpose upload form still recorded ---
console.log('--- phase 4: srcOffset/transpose upload form (6s) ---');
const locD = GL2.prototype.getUniformLocation.call(glFake, {}, 'offsetViewMatrix');
const transpose16 = (m) => {
  const t = m.slice();
  for (let r = 0; r < 4; r++) for (let c = r + 1; c < 4; c++) { const a = r * 4 + c, b = c * 4 + r; const tmp = t[a]; t[a] = t[b]; t[b] = tmp; }
  return t;
};
for (let i = 0; i < 200; i++) {
  step(30);
  const packed = new Float32Array(8 + 16);
  packed.set(transpose16(quatToMat16(viewQuatAt(fakeNow))), 8);
  GL2.prototype.uniformMatrix4fv.call(glFake, locD, true, packed, 8, 16);
}
const dump4 = api.dumpWebglSources();
const offsetItem = dump4.items.find((it) => it.uniformName === 'offsetViewMatrix');
const locked4 = dump4.items.find((it) => it.locked);
console.log('offsetViewMatrix:', offsetItem && { trk: offsetItem.coRot, validated: offsetItem.validated, convention: offsetItem.convention });
check(!!offsetItem, 'srcOffset/transpose upload form is recorded as a candidate');
check(offsetItem && offsetItem.validated, 'telemetry validates the offset/transposed stream');
check(offsetItem && offsetItem.convention === 'raw', 'transpose flag is un-transposed before storage');
check(locked4 && locked4.uniformName === 'viewMatrix', 'pin is respected while other streams churn');

// --- phase 5: pinned stream dies — recover to a live stream, re-grab on return ---
console.log('--- phase 5: dead-stream recovery (8s dead, 3s resumed) ---');
const stepWithoutView = (dtMs) => {
  fakeNow += dtMs;
  upload(locB, quatToMat16(wrongQuatAt(fakeNow)));
  anchorEl._style = { transform: matToCss(quatToMat16(viewQuatAt(fakeNow))), webkitTransform: 'none', content: 'none' };
  if (intervalCb) intervalCb();
};
for (let i = 0; i < 266; i++) stepWithoutView(30);
const locked5a = api.dumpWebglSources().items.find((it) => it.locked);
console.log('phase5 after death, locked uniform:', locked5a && locked5a.uniformName);
check(locked5a && locked5a.uniformName === 'modelMatrix',
  'dead locked stream is abandoned for a live one within seconds (old build waited minutes)');
for (let i = 0; i < 100; i++) step(30);
const locked5b = api.dumpWebglSources().items.find((it) => it.locked);
console.log('phase5 after resume, locked uniform:', locked5b && locked5b.uniformName, 'fit vs truth:', groundTruthFit().toFixed(5));
check(locked5b && locked5b.uniformName === 'viewMatrix', 'pinned stream is re-grabbed when it comes back');
check(groundTruthFit() > 0.99, 'output matches ground truth again after re-grab');

// --- phase 6: clearing the pin does not disturb a live lock ---
console.log('--- phase 6: clear pin, lock stays (2s) ---');
api.clearPinnedWebglSource();
for (let i = 0; i < 66; i++) step(30);
const locked6 = api.dumpWebglSources().items.find((it) => it.locked);
check(locked6 && locked6.uniformName === 'viewMatrix', 'lock is sticky after the pin is cleared');

// Push publishing is deferred to an end-of-frame microtask, so the remaining
// phases run in an async context and `await null` marks each frame boundary.
(async () => {
  // --- phase 7: render-rate push publishing (real-time capture) ---
  // Uploads to the locked stream must update the published orientation at
  // each frame boundary, WITHOUT any watcher tick running — this is the
  // closed-loop real-time path (hook-driven, not poll-driven).
  console.log('--- phase 7: render-rate push publishing ---');
  let pushUpdates = 0;
  let prevQ = api.getState().rawQuat;
  for (let i = 0; i < 30; i++) {
    fakeNow += 16; // ~60fps render, no intervalCb tick
    upload(locA, quatToMat16(viewQuatAt(fakeNow)));
    await null; // end of frame → deferred push publish runs
    const q = api.getState().rawQuat;
    if (q && prevQ && qDotAbs(q, prevQ) < 0.9999999) pushUpdates++;
    prevQ = q;
  }
  console.log('phase7 push updates without ticks:', pushUpdates, '/ 30 uploads');
  check(pushUpdates >= 25, 'locked stream uploads publish orientation at render rate (no tick needed)');
  check(groundTruthFit() > 0.995, 'push-published orientation matches ground truth');

  // --- phase 8: uniform multiplexed across draw passes ---
  // Onshape writes identity to the SAME uniform for overlay passes and the
  // real camera matrix for the model pass, every frame. Publishing must use
  // the settled frame-final value — never flicker to the mid-frame identity.
  // Identity writes disqualify a stream from AUTO selection (motion-signature
  // gate), so this scenario runs pinned — the explicit-user-choice path that
  // bypasses the gates and relies on frame-final publishing to stay usable.
  console.log('--- phase 8: interleaved identity writes (multi-pass frames, pinned) ---');
  api.pinLockedWebglSource();
  const identMat = quatToMat16({ w: 1, x: 0, y: 0, z: 0 });
  let glitches = 0;
  for (let i = 0; i < 30; i++) {
    fakeNow += 16;
    upload(locA, identMat);                          // overlay pass
    upload(locA, quatToMat16(viewQuatAt(fakeNow)));  // model pass (frame-final)
    await null; // end of frame
    const q = api.getState().rawQuat;
    const vq = viewQuatAt(fakeNow);
    if (!q || Math.max(qDotAbs(q, vq), qDotAbs(qConj(q), vq)) < 0.99) glitches++;
  }
  console.log('phase8 identity glitches:', glitches, '/ 30 frames');
  check(glitches === 0, 'mid-frame identity writes never reach the output (frame-final publish)');
  check(groundTruthFit() > 0.995, 'orientation still matches ground truth with multiplexed uniform');

  // --- phase 9: diagnostic recorder ---
  // The recorder must capture every stream's binned rotation activity and
  // produce a dump after the window closes, without disturbing the lock.
  console.log('--- phase 9: diagnostic recorder ---');
  const lockedBeforeDiag = api.getState().lockedWebglSourceId;
  api.startDiagnostic(5);
  for (let i = 0; i < 180; i++) step(30); // 5.4s simulated → recording auto-finishes
  const diag = api.getDiagnostic();
  check(!!diag, 'diagnostic dump is produced after the recording window');
  const dStreams = diag ? diag.streams : [];
  const dView = dStreams.find((s) => s.uniformName === 'viewMatrix');
  const dStatic = dStreams.find((s) => s.uniformName === 'shadowMatrix');
  console.log('phase9 streams:', dStreams.map((s) => `${s.uniformName}:rot=${s.totals.rotDeg}`).join(' '));
  check(dView && dView.totals.rotDeg > 30, 'rotating view stream shows rotation activity in the dump');
  check(dStatic && dStatic.totals.rotDeg === 0, 'static stream shows zero rotation in the dump');
  check(diag && diag.locks.length >= 1, 'lock timeline is recorded');
  check(api.getState().lockedWebglSourceId === lockedBeforeDiag, 'recording does not disturb the lock');

  // --- phase 10: motion-signature eviction ---
  // viewMatrix accumulated identity writes in phase 8, so it is disqualified
  // for AUTO selection. Once the pin (which bypasses the gates) is cleared,
  // housekeeping must evict it in favor of a qualified smooth stream.
  console.log('--- phase 10: identity-carrying stream evicted once unpinned ---');
  const dqBefore = api.dumpWebglSources().items.find((it) => it.uniformName === 'viewMatrix');
  check(dqBefore && dqBefore.disqualified === 'identity-writes', 'identity writes disqualify the stream in the dump');
  api.clearPinnedWebglSource();
  for (let i = 0; i < 100; i++) step(30); // ~3s: housekeeping runs and relocks
  const locked10 = api.dumpWebglSources().items.find((it) => it.locked);
  console.log('phase10 locked uniform:', locked10 && locked10.uniformName, 'dq:', locked10 && locked10.disqualified);
  check(locked10 && locked10.uniformName === 'modelMatrix', 'lock evicted to a qualified stream (auto never rides identity-carrying uniforms)');
  check(locked10 && !locked10.disqualified, 'evicted-to stream passes the motion-signature gates');

  // --- phase 11: settle-only overlay trap (frozen-lock takeover) ---
  // A settle-only stream keeps uploading repeats (alive) but only changes
  // when the view settles. Locked to one, the widget updates only on drag
  // release. During a "drag" (another qualified stream changing at render
  // rate while the locked one is frozen), the lock must migrate within ~2s.
  console.log('--- phase 11: frozen lock taken over by the moving stream ---');
  const locE = GL2.prototype.getUniformLocation.call(glFake, {}, 'hudMatrix');
  let hudQ = qAxisAngle(0.5, 0.5, 1, 0.2);
  for (let i = 0; i < 30; i++) { // give it a lockable, qualified history
    fakeNow += 30;
    hudQ = qMul(qAxisAngle(0.5, 0.5, 1, 0.02), hudQ);
    upload(locE, quatToMat16(hudQ));
    upload(locB, quatToMat16(viewQuatAt(fakeNow)));
    if (intervalCb) intervalCb();
  }
  const hudItem = api.listWebglSources().find((it) => it.uniformName === 'hudMatrix');
  check(!!hudItem, 'settle-only stream is a candidate');
  api.pinWebglSourceById(hudItem.id);
  api.relockWebglSource();
  for (let i = 0; i < 20; i++) { fakeNow += 30; upload(locE, quatToMat16(hudQ)); if (intervalCb) intervalCb(); }
  api.clearPinnedWebglSource();
  const locked11a = api.dumpWebglSources().items.find((it) => it.locked);
  check(locked11a && locked11a.uniformName === 'hudMatrix', 'settle-only stream is locked (sticky, alive with repeat uploads)');
  // drag: modelMatrix changes at 60Hz; hudMatrix uploads repeats only
  for (let t = 0; t < 3000; t += 16) {
    fakeNow += 16;
    upload(locB, quatToMat16(viewQuatAt(fakeNow)));
    if (t % 32 < 16) upload(locE, quatToMat16(hudQ)); // alive but frozen
    if (Math.floor(fakeNow / 30) !== Math.floor((fakeNow - 16) / 30) && intervalCb) intervalCb();
  }
  const locked11b = api.dumpWebglSources().items.find((it) => it.locked);
  console.log('phase11 locked after drag:', locked11b && locked11b.uniformName);
  check(locked11b && locked11b.uniformName === 'modelMatrix', 'frozen lock is taken over by the stream moving at render rate');
  // anti-flap: once everything is idle (repeats only), the lock must not move
  for (let i = 0; i < 100; i++) {
    fakeNow += 30;
    upload(locB, quatToMat16(viewQuatAt(fakeNow - 16))); // frozen repeat
    upload(locE, quatToMat16(hudQ));
    if (intervalCb) intervalCb();
  }
  const locked11c = api.dumpWebglSources().items.find((it) => it.locked);
  check(locked11c && locked11c.uniformName === 'modelMatrix', 'lock does not flap once everything is idle');

  console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exit(pass ? 0 : 1);
})();
