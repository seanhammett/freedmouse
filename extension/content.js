// USB freeD - Onshape View Widget Watcher
// Chrome Extension Content Script (MAIN world)
// Tracks the viewport orientation from the upper-right view widget.

(function () {
  'use strict';

  const STORAGE_KEY = 'usbFreeDWidgetWatcherConfig';
  const SCAN_INTERVAL_MS = 220;
  const STALE_MS = 1600;
  const BUILD_TAG = 'watcher-2026-04-22-safe-3';

  let config = loadConfig();

  let observerRawQuat = null;
  let observerQuat = null;
  let observerStrategy = 'none';
  let observerConfidence = 0;
  let observerDebug = 'idle';
  let observerLastUpdateMs = 0;
  let observerLastScanMs = 0;
  let observerLastError = null;

  let panel = null;
  let statusEl = null;
  let dataEl = null;
  let noteEl = null;
  let toggleBtn = null;
  let fallbackBtn = null;
  let smoothSlider = null;
  let smoothVal = null;
  let calibrateBtn = null;
  let clearCalBtn = null;
  let previewCanvas = null;
  let previewCtx = null;

  function setLastError(kind, err, extra) {
    const msg = String(err && err.message ? err.message : err);
    observerLastError = {
      at: Date.now(),
      kind,
      message: msg,
      stack: err && err.stack ? String(err.stack) : '',
      extra: extra || null,
    };
  }

  function installGlobalErrorHooks() {
    window.addEventListener('error', (ev) => {
      const err = ev && ev.error ? ev.error : new Error(ev && ev.message ? ev.message : 'unknown window error');
      const info = {
        source: ev && ev.filename ? ev.filename : '',
        line: ev && Number.isFinite(ev.lineno) ? ev.lineno : 0,
        column: ev && Number.isFinite(ev.colno) ? ev.colno : 0,
      };
      setLastError('window.error', err, info);
      console.error('[USB_freeD] window error (' + BUILD_TAG + ')', info, err);
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev ? ev.reason : null;
      const err = reason instanceof Error ? reason : new Error(String(reason));
      setLastError('window.unhandledrejection', err, null);
      console.error('[USB_freeD] unhandled rejection (' + BUILD_TAG + ')', err);
    });
  }

  function defaultConfig() {
    return {
      watcherEnabled: true,
      fallbackMode: 'labels',
      smoothing: 0.3,
      frameCalibration: null,
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const cfg = { ...defaultConfig(), ...JSON.parse(raw) };
        cfg.fallbackMode = normalizeFallbackMode(cfg.fallbackMode);
        return cfg;
      }
    } catch (e) {
      // ignore malformed config
    }
    return defaultConfig();
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      // ignore quota/write issues
    }
  }

  function sanitizeStoredQuat(q) {
    if (!q || typeof q !== 'object') return null;
    const qq = {
      w: Number(q.w),
      x: Number(q.x),
      y: Number(q.y),
      z: Number(q.z),
    };
    return quatNormalize(qq);
  }

  function quatNormalize(q) {
    if (!q || typeof q !== 'object') return null;
    if (!Number.isFinite(q.w) || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z)) return null;
    const n = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (n < 1e-9 || !Number.isFinite(n)) return null;
    return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
  }

  function quatDot(a, b) {
    const aa = quatNormalize(a);
    const bb = quatNormalize(b);
    if (!aa || !bb) return 0;
    return aa.w * bb.w + aa.x * bb.x + aa.y * bb.y + aa.z * bb.z;
  }

  function quatLerp(a, b, t) {
    const aa = quatNormalize(a);
    let bb = quatNormalize(b);
    if (!aa && !bb) return null;
    if (!aa) return bb;
    if (!bb) return aa;

    if (quatDot(aa, bb) < 0) {
      bb = { w: -bb.w, x: -bb.x, y: -bb.y, z: -bb.z };
    }
    return quatNormalize({
      w: aa.w + (bb.w - aa.w) * t,
      x: aa.x + (bb.x - aa.x) * t,
      y: aa.y + (bb.y - aa.y) * t,
      z: aa.z + (bb.z - aa.z) * t,
    });
  }

  function quatConjugate(q) {
    const qq = quatNormalize(q);
    if (!qq) return null;
    return { w: qq.w, x: -qq.x, y: -qq.y, z: -qq.z };
  }

  function quatMultiply(a, b) {
    const aa = quatNormalize(a);
    const bb = quatNormalize(b);
    if (!aa || !bb) return null;
    return {
      w: aa.w * bb.w - aa.x * bb.x - aa.y * bb.y - aa.z * bb.z,
      x: aa.w * bb.x + aa.x * bb.w + aa.y * bb.z - aa.z * bb.y,
      y: aa.w * bb.y - aa.x * bb.z + aa.y * bb.w + aa.z * bb.x,
      z: aa.w * bb.z + aa.x * bb.y - aa.y * bb.x + aa.z * bb.w,
    };
  }

  function quatInverse(q) {
    const qq = quatNormalize(q);
    if (!qq) return null;
    const n2 = qq.w * qq.w + qq.x * qq.x + qq.y * qq.y + qq.z * qq.z;
    if (n2 < 1e-9 || !Number.isFinite(n2)) return null;
    const c = quatConjugate(qq);
    if (!c) return null;
    return { w: c.w / n2, x: c.x / n2, y: c.y / n2, z: c.z / n2 };
  }

  function getCalibrationQuat() {
    return sanitizeStoredQuat(config.frameCalibration);
  }

  function applyFrameCalibration(rawQuat) {
    const q = quatNormalize(rawQuat);
    if (!q) return null;

    const fix = getCalibrationQuat();
    if (!fix) return q;

    const corrected = quatMultiply(fix, q);
    return quatNormalize(corrected);
  }

  function calibrationEnabled() {
    return !!getCalibrationQuat();
  }

  function setCalibrationQuat(q) {
    config.frameCalibration = q ? { w: q.w, x: q.x, y: q.y, z: q.z } : null;
    saveConfig();
  }

  function calibrateCurrentAsFront() {
    if (!observerRawQuat || observerIsStale()) return false;
    const inv = quatInverse(observerRawQuat);
    if (!inv) return false;
    setCalibrationQuat(inv);
    observerQuat = applyFrameCalibration(observerRawQuat);
    observerDebug = 'frame aligned: current orientation mapped to Front';
    return true;
  }

  function clearCalibration() {
    setCalibrationQuat(null);
    observerQuat = applyFrameCalibration(observerRawQuat);
    observerDebug = 'frame alignment cleared';
  }

  function quatToEuler(q) {
    const sinr = 2 * (q.w * q.x + q.y * q.z);
    const cosr = 1 - 2 * (q.x * q.x + q.y * q.y);
    const roll = Math.atan2(sinr, cosr);

    const sinp = 2 * (q.w * q.y - q.z * q.x);
    const pitch = Math.asin(Math.max(-1, Math.min(1, sinp)));

    const siny = 2 * (q.w * q.z + q.x * q.y);
    const cosy = 1 - 2 * (q.y * q.y + q.z * q.z);
    const yaw = Math.atan2(siny, cosy);

    return { roll, pitch, yaw };
  }

  function quatToMatrix3(q) {
    const ww = q.w * q.w;
    const xx = q.x * q.x;
    const yy = q.y * q.y;
    const zz = q.z * q.z;

    return [
      [ww + xx - yy - zz, 2 * (q.x * q.y - q.w * q.z), 2 * (q.x * q.z + q.w * q.y)],
      [2 * (q.x * q.y + q.w * q.z), ww - xx + yy - zz, 2 * (q.y * q.z - q.w * q.x)],
      [2 * (q.x * q.z - q.w * q.y), 2 * (q.y * q.z + q.w * q.x), ww - xx - yy + zz],
    ];
  }

  function rotateWithMatrix(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
  }

  function projectPoint3(v, width, height, scale, distance) {
    const z = v[2] + distance;
    return {
      x: width * 0.5 + (v[0] * scale) / z,
      y: height * 0.56 - (v[1] * scale) / z,
      z,
    };
  }

  function drawOrientationPreview(quat, isStale) {
    if (!previewCtx || !previewCanvas) return;

    const ctx = previewCtx;
    const w = previewCanvas.width;
    const h = previewCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#161a29');
    grad.addColorStop(1, '#0f1220');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const q = quat || { w: 1, x: 0, y: 0, z: 0 };
    const m = quatToMatrix3(q);
    const scale = Math.min(w, h) * 0.82;
    const distance = 3.2;

    const cubeVerts = [
      [-0.58, -0.58, -0.58], [0.58, -0.58, -0.58], [0.58, 0.58, -0.58], [-0.58, 0.58, -0.58],
      [-0.58, -0.58, 0.58], [0.58, -0.58, 0.58], [0.58, 0.58, 0.58], [-0.58, 0.58, 0.58],
    ];
    const rotated = cubeVerts.map((v) => rotateWithMatrix(m, v));
    const proj = rotated.map((v) => projectPoint3(v, w, h, scale, distance));

    const faces = [
      { idx: [0, 1, 2, 3], color: 'rgba(126, 142, 183, 0.18)' },
      { idx: [4, 5, 6, 7], color: 'rgba(166, 192, 233, 0.17)' },
      { idx: [0, 1, 5, 4], color: 'rgba(141, 155, 197, 0.14)' },
      { idx: [1, 2, 6, 5], color: 'rgba(123, 138, 177, 0.12)' },
      { idx: [2, 3, 7, 6], color: 'rgba(150, 166, 207, 0.12)' },
      { idx: [3, 0, 4, 7], color: 'rgba(135, 151, 195, 0.12)' },
    ].map((f) => ({ ...f, depth: f.idx.reduce((s, i) => s + rotated[i][2], 0) / f.idx.length }))
      .sort((a, b) => a.depth - b.depth);

    for (const f of faces) {
      ctx.beginPath();
      const p0 = proj[f.idx[0]];
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < f.idx.length; i++) {
        const p = proj[f.idx[i]];
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = f.color;
      ctx.fill();
    }

    const edgePairs = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const edgeAlpha = isStale ? 0.45 : 0.8;
    ctx.strokeStyle = 'rgba(223, 232, 255, ' + edgeAlpha + ')';
    ctx.lineWidth = 1.35;
    for (const [a, b] of edgePairs) {
      ctx.beginPath();
      ctx.moveTo(proj[a].x, proj[a].y);
      ctx.lineTo(proj[b].x, proj[b].y);
      ctx.stroke();
    }

    const axisLen = 1.45;
    const o = projectPoint3([0, 0, 0], w, h, scale, distance);
    const xAxis = projectPoint3(rotateWithMatrix(m, [axisLen, 0, 0]), w, h, scale, distance);
    const yAxis = projectPoint3(rotateWithMatrix(m, [0, axisLen, 0]), w, h, scale, distance);
    const zAxis = projectPoint3(rotateWithMatrix(m, [0, 0, axisLen]), w, h, scale, distance);

    const drawAxis = (p, color, label) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '10px Segoe UI';
      ctx.fillText(label, p.x + 4, p.y - 3);
    };

    drawAxis(xAxis, isStale ? '#c88995' : '#ff8fa2', 'X');
    drawAxis(yAxis, isStale ? '#97c39a' : '#9fe6a7', 'Y');
    drawAxis(zAxis, isStale ? '#8fb7d1' : '#8ecbff', 'Z');

    if (!quat) {
      ctx.fillStyle = 'rgba(180, 190, 215, 0.8)';
      ctx.font = '11px Segoe UI';
      ctx.fillText('Awaiting orientation', 10, h - 10);
    }
  }

  function hueFromRgb(r, g, b) {
    const rf = r / 255;
    const gf = g / 255;
    const bf = b / 255;
    const mx = Math.max(rf, gf, bf);
    const mn = Math.min(rf, gf, bf);
    const d = mx - mn;
    if (d < 1e-6) return null;

    let h;
    if (mx === rf) {
      h = ((gf - bf) / d) % 6;
    } else if (mx === gf) {
      h = (bf - rf) / d + 2;
    } else {
      h = (rf - gf) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
    return h;
  }

  function vecDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function vecCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function vecLen(v) {
    return Math.sqrt(vecDot(v, v));
  }

  function vecNorm(v) {
    const n = vecLen(v);
    if (n < 1e-9 || !Number.isFinite(n)) return null;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  function vecScale(v, s) {
    return [v[0] * s, v[1] * s, v[2] * s];
  }

  function vecSub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function orthonormalizeColumns(c0, c1, c2) {
    const x = vecNorm(c0);
    if (!x) return null;

    const yRaw = vecSub(c1, vecScale(x, vecDot(c1, x)));
    const y = vecNorm(yRaw);
    if (!y) return null;

    let z = vecNorm(vecCross(x, y));
    if (!z) return null;

    if (vecDot(z, c2) < 0) z = vecScale(z, -1);

    return [x, y, z];
  }

  function quatFromMatrix3(m) {
    const trace = m[0][0] + m[1][1] + m[2][2];
    let w; let x; let y; let z;

    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      w = 0.25 * s;
      x = (m[2][1] - m[1][2]) / s;
      y = (m[0][2] - m[2][0]) / s;
      z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
      w = (m[2][1] - m[1][2]) / s;
      x = 0.25 * s;
      y = (m[0][1] + m[1][0]) / s;
      z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
      const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
      w = (m[0][2] - m[2][0]) / s;
      x = (m[0][1] + m[1][0]) / s;
      y = 0.25 * s;
      z = (m[1][2] + m[2][1]) / s;
    } else {
      const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
      w = (m[1][0] - m[0][1]) / s;
      x = (m[0][2] + m[2][0]) / s;
      y = (m[1][2] + m[2][1]) / s;
      z = 0.25 * s;
    }

    return quatNormalize({ w, x, y, z });
  }

  function basisColumnsToQuat(xCol, yCol, zCol) {
    const basis = orthonormalizeColumns(xCol, yCol, zCol);
    if (!basis) return null;

    const x = basis[0];
    const y = basis[1];
    const z = basis[2];

    return quatFromMatrix3([
      [x[0], y[0], z[0]],
      [x[1], y[1], z[1]],
      [x[2], y[2], z[2]],
    ]);
  }

  function parseMatrix3d(transformText) {
    if (!transformText || transformText === 'none') return null;
    const match = /matrix3d\(([^)]+)\)/.exec(transformText);
    if (!match) return null;

    const values = match[1].split(',').map((v) => parseFloat(v.trim()));
    if (values.length !== 16 || values.some((v) => !Number.isFinite(v))) return null;

    const xCol = [values[0], values[1], values[2]];
    const yCol = [values[4], values[5], values[6]];
    const zCol = [values[8], values[9], values[10]];

    return basisColumnsToQuat(xCol, yCol, zCol);
  }

  function normalizeFallbackMode(mode) {
    if (mode === 'matrix' || mode === 'labels' || mode === 'legacy-pixels') return mode;
    return mode === 'auto' ? 'labels' : 'labels';
  }

  function fallbackModeLabel(mode) {
    const m = normalizeFallbackMode(mode);
    if (m === 'matrix') return 'Mode: Matrix';
    if (m === 'legacy-pixels') return 'Mode: Legacy Pixels';
    return 'Mode: Labels';
  }

  function observerIsStale(nowMs = performance.now()) {
    return !observerRawQuat || (nowMs - observerLastUpdateMs) > STALE_MS;
  }

  function inWidgetZone(rect) {
    if (rect.width < 48 || rect.height < 48 || rect.width > 320 || rect.height > 320) return false;
    if (rect.right < window.innerWidth * 0.7) return false;
    if (rect.top > window.innerHeight * 0.5) return false;
    return true;
  }

  function expandRect(rect, pad) {
    return {
      left: rect.left - pad,
      top: rect.top - pad,
      right: rect.right + pad,
      bottom: rect.bottom + pad,
    };
  }

  function rectIntersects(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function addCandidate(out, seen, el) {
    if (!el || seen.has(el)) return;
    const rect = el.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
    if (rect.width <= 0 || rect.height <= 0) return;
    seen.add(el);
    out.push(el);
  }

  function findWidgetAnchor() {
    const anchors = Array.from(document.querySelectorAll('.os-view-cube-bounds'));
    let best = null;
    for (const el of anchors) {
      const rect = el.getBoundingClientRect();
      if (!inWidgetZone(rect)) continue;
      const score = rect.right * 2 - rect.top;
      if (!best || score > best.score) best = { el, score };
    }
    return best ? best.el : null;
  }

  function collectWidgetCandidates() {
    const anchor = findWidgetAnchor();
    const selectors = [
      '.os-view-cube-bounds',
      '[class*="os-view-cube"]',
      '[class*="os-view"]',
      '[class*="viewcube"]',
      '[class*="view-cube"]',
      '[class*="gizmo"]',
      '[class*="triad"]',
      '[class*="axis"]',
      '[class*="cube"]',
      '[title*="view"]',
      'svg',
      'canvas',
    ];

    const out = [];
    const seen = new Set();

    if (anchor) {
      addCandidate(out, seen, anchor);
      const anchorRect = anchor.getBoundingClientRect();
      const searchRect = expandRect(anchorRect, 40);

      if (anchor.parentElement) {
        addCandidate(out, seen, anchor.parentElement);
        for (const sib of anchor.parentElement.children) {
          const sr = sib.getBoundingClientRect();
          if (rectIntersects(sr, searchRect)) addCandidate(out, seen, sib);
        }
      }

      // Probe point stack around the center and corners of the known bounds.
      const points = [
        { x: anchorRect.left + anchorRect.width * 0.5, y: anchorRect.top + anchorRect.height * 0.5 },
        { x: anchorRect.left + 8, y: anchorRect.top + 8 },
        { x: anchorRect.right - 8, y: anchorRect.top + 8 },
        { x: anchorRect.left + 8, y: anchorRect.bottom - 8 },
        { x: anchorRect.right - 8, y: anchorRect.bottom - 8 },
      ];
      for (const p of points) {
        for (const hit of document.elementsFromPoint(p.x, p.y)) {
          const hr = hit.getBoundingClientRect();
          if (rectIntersects(hr, searchRect)) addCandidate(out, seen, hit);
        }
      }
    }

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (!inWidgetZone(rect)) continue;
        addCandidate(out, seen, el);
      }
    }
    return { anchor, candidates: out };
  }

  function elementSummary(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || '',
      className: (el.className && typeof el.className === 'string') ? el.className : '',
      title: el.getAttribute && el.getAttribute('title') || '',
      ariaLabel: el.getAttribute && el.getAttribute('aria-label') || '',
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      transform: style.transform || 'none',
      webkitTransform: style.webkitTransform || 'none',
    };
  }

  function debugDumpCandidates() {
    const info = collectWidgetCandidates();
    const dump = info.candidates.slice(0, 60).map((el) => elementSummary(el));
    return {
      count: info.candidates.length,
      anchor: info.anchor ? elementSummary(info.anchor) : null,
      fallbackMode: config.fallbackMode,
      items: dump,
    };
  }

  function debugDumpNeighborhood() {
    const anchor = findWidgetAnchor();
    if (!anchor) {
      return {
        anchor: null,
        message: 'os-view-cube-bounds not found in expected zone',
      };
    }

    const anchorRect = anchor.getBoundingClientRect();
    const searchRect = expandRect(anchorRect, 60);
    const seen = new Set();
    const nodes = [];

    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!rectIntersects(r, searchRect)) continue;
      if (r.width > 1200 || r.height > 1200) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      nodes.push(el);
      if (nodes.length >= 120) break;
    }

    const center = centerOfRect(anchorRect);
    const pointHits = document.elementsFromPoint(center.x, center.y).slice(0, 20).map((el) => elementSummary(el));

    return {
      anchor: elementSummary(anchor),
      parent: anchor.parentElement ? elementSummary(anchor.parentElement) : null,
      centerHits: pointHits,
      neighbors: nodes.map((el) => elementSummary(el)),
    };
  }

  function debugDumpPixelProbe() {
    const info = collectWidgetCandidates();
    const pixel = extractFromCanvasPixels(info.candidates, info.anchor);
    return {
      anchor: info.anchor ? elementSummary(info.anchor) : null,
      diagnostics: pixel.diagnostics || null,
      sample: pixel.sample
        ? {
          strategy: pixel.sample.strategy,
          confidence: pixel.sample.confidence,
          debug: pixel.sample.debug,
          quat: pixel.sample.quat,
        }
        : null,
    };
  }

  function collectWidgetLabels(candidates, anchor) {
    const out = {
      axis: { x: [], y: [], z: [] },
      faces: { front: [], back: [], left: [], right: [], top: [], bottom: [] },
      counts: { scanned: 0, accepted: 0 },
      samples: [],
    };

    if (!anchor) return out;

    const anchorRect = anchor.getBoundingClientRect();
    const searchRect = expandRect(anchorRect, 55);
    const anchorCenter = centerOfRect(anchorRect);
    const pool = new Set();

    const addNode = (el) => {
      if (!el || pool.has(el)) return;
      const r = el.getBoundingClientRect();
      if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return;
      if (r.width <= 0 || r.height <= 0) return;
      if (!rectIntersects(r, searchRect)) return;
      pool.add(el);
    };

    for (const el of candidates) addNode(el);

    if (anchor.parentElement && anchor.parentElement.querySelectorAll) {
      addNode(anchor.parentElement);
      let inspected = 0;
      for (const el of anchor.parentElement.querySelectorAll('*')) {
        addNode(el);
        inspected++;
        if (inspected >= 400) break;
      }
    }

    const x0 = Math.max(0, anchorRect.left - 10);
    const y0 = Math.max(0, anchorRect.top - 10);
    const x1 = Math.min(window.innerWidth - 1, anchorRect.right + 10);
    const y1 = Math.min(window.innerHeight - 1, anchorRect.bottom + 10);
    const cols = 5;
    const rows = 5;
    for (let yi = 0; yi < rows; yi++) {
      for (let xi = 0; xi < cols; xi++) {
        const px = x0 + (x1 - x0) * ((xi + 0.5) / cols);
        const py = y0 + (y1 - y0) * ((yi + 0.5) / rows);
        for (const hit of document.elementsFromPoint(px, py).slice(0, 16)) {
          let node = hit;
          for (let depth = 0; depth < 4 && node; depth++) {
            addNode(node);
            node = node.parentElement;
          }
        }
      }
    }

    const faceWords = new Set(['front', 'back', 'left', 'right', 'top', 'bottom']);
    const hasTransformInChain = (el, maxDepth = 3) => {
      let node = el;
      for (let depth = 0; depth <= maxDepth && node; depth++) {
        const style = window.getComputedStyle(node);
        const t = style.transform || style.webkitTransform || 'none';
        if (t && t !== 'none') return true;
        node = node.parentElement;
      }
      return false;
    };
    const pushSample = (source, raw) => {
      if (!raw) return;
      const t = String(raw).trim();
      if (!t) return;
      if (out.samples.length >= 36) return;
      out.samples.push({ source, raw: t.slice(0, 48) });
    };

    const tokenize = (raw) => {
      if (!raw) return [];
      const normalized = String(raw).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
      if (!normalized) return [];
      return normalized.split(/\s+/);
    };

    const addToken = (token, el, source) => {
      if (!token) return;
      const t = token.toLowerCase();
      if (t !== 'x' && t !== 'y' && t !== 'z' && !faceWords.has(t)) return;

      const r = el.getBoundingClientRect();
      const c = centerOfRect(r);
      const dist = Math.hypot(c.x - anchorCenter.x, c.y - anchorCenter.y);
      const entry = {
        token: t,
        center: c,
        dist,
        area: r.width * r.height,
        source,
        moving: hasTransformInChain(el, 3),
        tag: (el.tagName || '').toLowerCase(),
      };

      if (t === 'x' || t === 'y' || t === 'z') out.axis[t].push(entry);
      else out.faces[t].push(entry);
      out.counts.accepted++;
    };

    for (const el of pool) {
      out.counts.scanned++;
      const r = el.getBoundingClientRect();
      if (r.width > 140 || r.height > 140) continue;

      const rawTexts = [];
      const tc = (el.textContent || '').trim();
      if (tc && tc.length <= 24) rawTexts.push({ raw: tc, source: 'textContent', tokenizable: true });

      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria && aria.trim().length <= 24) rawTexts.push({ raw: aria.trim(), source: 'aria-label', tokenizable: true });

      const title = el.getAttribute && el.getAttribute('title');
      if (title && title.trim().length <= 24) rawTexts.push({ raw: title.trim(), source: 'title', tokenizable: true });

      if (el.id && el.id.length <= 48) rawTexts.push({ raw: el.id, source: 'id', tokenizable: false });
      if (typeof el.className === 'string' && el.className.trim() && el.className.length <= 120) {
        rawTexts.push({ raw: el.className, source: 'className', tokenizable: false });
      }

      if (el.attributes && el.attributes.length) {
        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          if (!attr) continue;
          const attrName = (attr.name || '').toLowerCase();
          const isLabelAttr = attrName === 'aria-label' || attrName === 'title' || attrName === 'data-label' || attrName === 'data-face' || attrName === 'data-axis';
          if (attr.name && attr.name.length <= 40) rawTexts.push({ raw: attr.name, source: 'attrName', tokenizable: false });
          if (attr.value && attr.value.length <= 64) {
            rawTexts.push({ raw: attr.value, source: 'attrValue', tokenizable: isLabelAttr });
          }
        }
      }

      const before = window.getComputedStyle(el, '::before').content;
      const after = window.getComputedStyle(el, '::after').content;
      if (before && before !== 'none') rawTexts.push({ raw: before.replace(/^['"]|['"]$/g, ''), source: 'pseudo', tokenizable: true });
      if (after && after !== 'none') rawTexts.push({ raw: after.replace(/^['"]|['"]$/g, ''), source: 'pseudo', tokenizable: true });

      for (const item of rawTexts) {
        pushSample(item.source, item.raw);
        if (item.tokenizable === false) continue;
        const tokens = tokenize(item.raw);
        for (const token of tokens) {
          addToken(token, el, item.source);
        }
      }
    }

    return out;
  }

  function isVisualLabelSource(source) {
    return source === 'textContent' || source === 'aria-label' || source === 'title' || source === 'pseudo';
  }

  function isTrustedLabelEntry(entry) {
    if (!entry) return false;
    if (isVisualLabelSource(entry.source)) return true;
    if (!entry.moving) return false;
    return entry.source === 'className' || entry.source === 'id' || entry.source === 'attrValue';
  }

  function pickBestLabel(entries, predicate) {
    if (!entries || !entries.length) return null;
    let best = null;
    for (const e of entries) {
      if (predicate && !predicate(e)) continue;
      const sourceBonus = isVisualLabelSource(e.source) ? 26 : (e.moving ? 8 : -18);
      const movingBonus = e.moving ? 8 : 0;
      const proximityScore = Math.max(0, 220 - e.dist) * 1.1;
      const sizeScore = Math.min(16, Math.sqrt(Math.max(0, e.area)) * 0.4);
      const score = proximityScore + sizeScore + sourceBonus + movingBonus;
      if (!best || score > best.score) best = { entry: e, score };
    }
    return best ? best.entry : null;
  }

  function debugDumpLabels() {
    const info = collectWidgetCandidates();
    const labels = collectWidgetLabels(info.candidates, info.anchor);
    const summarize = (obj) => {
      const out = {};
      for (const key of Object.keys(obj)) {
        out[key] = obj[key].slice(0, 4).map((e) => ({
          dist: Math.round(e.dist * 10) / 10,
          x: Math.round(e.center.x),
          y: Math.round(e.center.y),
          tag: e.tag,
          source: e.source,
          moving: !!e.moving,
        }));
      }
      return out;
    };

    return {
      anchor: info.anchor ? elementSummary(info.anchor) : null,
      counts: labels.counts,
      axis: summarize(labels.axis),
      faces: summarize(labels.faces),
      samples: labels.samples,
    };
  }

  function extractFromCssMatrix(candidates, anchor) {
    const roots = [];
    const rootSeen = new Set();

    const addRoot = (el) => {
      if (!el || rootSeen.has(el)) return;
      rootSeen.add(el);
      roots.push(el);
    };

    for (const el of candidates) addRoot(el);
    if (anchor) {
      let node = anchor;
      for (let depth = 0; depth < 5 && node; depth++) {
        addRoot(node);
        node = node.parentElement;
      }
    }

    const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
    const anchorCenter = anchorRect ? centerOfRect(anchorRect) : null;
    const evalSeen = new Set();
    let best = null;

    const scoreNode = (rect) => {
      let score = Math.min(90, Math.sqrt(Math.max(0, rect.width * rect.height)) * 0.9);
      if (anchorCenter) {
        const c = centerOfRect(rect);
        const dist = Math.hypot(c.x - anchorCenter.x, c.y - anchorCenter.y);
        score += Math.max(0, 260 - dist);
      }
      return score;
    };

    const considerNode = (el, strategy) => {
      if (!el || evalSeen.has(el)) return;
      evalSeen.add(el);

      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
      if (rect.width <= 1 || rect.height <= 1 || rect.width > 900 || rect.height > 900) return;

      const style = window.getComputedStyle(el);
      const q = parseMatrix3d(style.transform) || parseMatrix3d(style.webkitTransform);
      if (!q) return;

      const score = scoreNode(rect);
      if (!best || score > best.score) {
        best = { quat: q, score, strategy };
      }
    };

    for (const root of roots) {
      let node = root;
      for (let depth = 0; depth < 5 && node; depth++) {
        considerNode(node, 'css-matrix3d');
        node = node.parentElement;
      }
    }

    let inspectedDescendants = 0;
    for (const root of roots) {
      if (!root || !root.querySelectorAll) continue;
      let localCount = 0;
      for (const el of root.querySelectorAll('*')) {
        considerNode(el, 'css-matrix3d-desc');
        localCount++;
        inspectedDescendants++;
        if (localCount >= 140 || inspectedDescendants >= 360) break;
      }
      if (inspectedDescendants >= 360) break;
    }

    if (!best) return null;

    return {
      quat: best.quat,
      confidence: best.strategy === 'css-matrix3d' ? 0.97 : 0.95,
      strategy: best.strategy,
      debug: best.strategy === 'css-matrix3d'
        ? 'orientation from DOM transform matrix'
        : 'orientation from descendant DOM transform matrix',
    };
  }

  function centerOfRect(rect) {
    return {
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
    };
  }

  function extractFromSvgLabels(candidates) {
    const faceWords = ['front', 'back', 'left', 'right', 'top', 'bottom'];

    for (const el of candidates) {
      const svg = el.tagName && el.tagName.toLowerCase() === 'svg' ? el : el.querySelector && el.querySelector('svg');
      if (!svg) continue;

      const rect = svg.getBoundingClientRect();
      if (!inWidgetZone(rect)) continue;

      const labels = { x: null, y: null, z: null };
      let faceWordCount = 0;

      for (const textNode of svg.querySelectorAll('text')) {
        const t = (textNode.textContent || '').trim().toLowerCase();
        if (!t) continue;

        if (t === 'x' || t === 'y' || t === 'z') {
          labels[t] = centerOfRect(textNode.getBoundingClientRect());
        }
        if (faceWords.includes(t)) faceWordCount++;
      }

      if (!labels.x || !labels.y || !labels.z) continue;

      const origin = {
        x: (labels.x.x + labels.y.x + labels.z.x) / 3,
        y: (labels.x.y + labels.y.y + labels.z.y) / 3,
      };

      const vx2 = [labels.x.x - origin.x, labels.x.y - origin.y];
      const vy2 = [labels.y.x - origin.x, labels.y.y - origin.y];
      const vz2 = [labels.z.x - origin.x, labels.z.y - origin.y];

      const lx = Math.hypot(vx2[0], vx2[1]);
      const ly = Math.hypot(vy2[0], vy2[1]);
      const lz = Math.hypot(vz2[0], vz2[1]);
      const maxLen = Math.max(lx, ly, lz);
      if (maxLen < 8) continue;

      const toAxis = (v) => {
        const sx = Math.max(-0.98, Math.min(0.98, v[0] / maxLen));
        const sy = Math.max(-0.98, Math.min(0.98, -v[1] / maxLen));
        const szAbs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
        return [sx, sy, szAbs];
      };

      const xBase = toAxis(vx2);
      const yBase = toAxis(vy2);
      const zBase = toAxis(vz2);

      let best = null;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const cx = [xBase[0], xBase[1], xBase[2] * sx];
            const cy = [yBase[0], yBase[1], yBase[2] * sy];
            const cz = [zBase[0], zBase[1], zBase[2] * sz];

            const q = basisColumnsToQuat(cx, cy, cz);
            if (!q) continue;

            const hand = vecDot(vecCross(cx, cy), cz);
            const score = hand > 0 ? hand : hand - 3;
            if (!best || score > best.score) {
              best = { quat: q, score };
            }
          }
        }
      }

      if (best) {
        const confidence = faceWordCount > 0 ? 0.82 : 0.7;
        return {
          quat: best.quat,
          confidence,
          strategy: faceWordCount > 0 ? 'svg-labels+faces' : 'svg-labels',
          debug: 'orientation inferred from X/Y/Z label geometry',
        };
      }
    }

    return null;
  }

  function extractFromHtmlAxisLabels(labels, anchor) {
    if (!anchor || !labels) return null;

    const anchorRect = anchor.getBoundingClientRect();
    const origin = centerOfRect(anchorRect);
    const selected = {
      x: pickBestLabel(labels.axis.x, isTrustedLabelEntry),
      y: pickBestLabel(labels.axis.y, isTrustedLabelEntry),
      z: pickBestLabel(labels.axis.z, isTrustedLabelEntry),
    };
    const selectedEntries = Object.values(selected).filter(Boolean);
    const strongEvidenceCount = selectedEntries.filter((e) => isVisualLabelSource(e.source) || e.moving).length;
    if (strongEvidenceCount < 2) return null;

    const axisData = {};
    const presentAxes = [];
    for (const key of ['x', 'y', 'z']) {
      const pick = selected[key];
      if (!pick) continue;
      const v2 = [pick.center.x - origin.x, pick.center.y - origin.y];
      const len = Math.hypot(v2[0], v2[1]);
      if (len < 3.8) continue;
      axisData[key] = { v2, len };
      presentAxes.push(key);
    }

    if (presentAxes.length < 2) return null;

    const maxLen = Math.max(...presentAxes.map((k) => axisData[k].len));
    if (!Number.isFinite(maxLen) || maxLen < 4.2) return null;

    const toAxis = (v) => {
      const sx = Math.max(-0.98, Math.min(0.98, v[0] / maxLen));
      const sy = Math.max(-0.98, Math.min(0.98, -v[1] / maxLen));
      const szAbs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      return [sx, sy, szAbs];
    };

    const base = {};
    for (const key of presentAxes) base[key] = toAxis(axisData[key].v2);

    let best = null;
    const combos = 1 << presentAxes.length;
    for (let mask = 0; mask < combos; mask++) {
      const cols = { x: null, y: null, z: null };
      for (let i = 0; i < presentAxes.length; i++) {
        const key = presentAxes[i];
        const s = ((mask >> i) & 1) ? -1 : 1;
        const b = base[key];
        cols[key] = [b[0], b[1], b[2] * s];
      }

      if (!cols.x && cols.y && cols.z) cols.x = vecNorm(vecCross(cols.y, cols.z));
      if (!cols.y && cols.z && cols.x) cols.y = vecNorm(vecCross(cols.z, cols.x));
      if (!cols.z && cols.x && cols.y) cols.z = vecNorm(vecCross(cols.x, cols.y));
      if (!cols.x || !cols.y || !cols.z) continue;

      const q = basisColumnsToQuat(cols.x, cols.y, cols.z);
      if (!q) continue;

      const hand = vecDot(vecCross(cols.x, cols.y), cols.z);
      const continuity = observerRawQuat ? Math.abs(quatDot(q, observerRawQuat)) : 0.5;

      let projectionFit = 0;
      for (const key of presentAxes) {
        const v = axisData[key].v2;
        const n = Math.hypot(v[0], v[1]);
        if (n < 1e-6) continue;
        const measured = [v[0] / n, v[1] / n];
        const c = cols[key];
        const projected = [c[0], -c[1]];
        const pn = Math.hypot(projected[0], projected[1]);
        if (pn < 1e-6) continue;
        projectionFit += (projected[0] / pn) * measured[0] + (projected[1] / pn) * measured[1];
      }

      const score = hand * 0.85 + continuity * 0.7 + projectionFit * 0.35;
      if (!best || score > best.score) best = { quat: q, score };
    }

    if (!best) return null;

    const confidence = presentAxes.length === 3 ? 0.82 : 0.73;
    return {
      quat: best.quat,
      confidence,
      strategy: presentAxes.length === 3 ? 'html-axis-labels' : 'html-axis-labels-partial',
      debug: 'orientation inferred from HTML X/Y/Z labels (' + presentAxes.join(',') + ')',
    };
  }

  function extractFromFaceLabels(labels, anchor) {
    if (!anchor || !labels) return null;

    const faceMap = {
      right: { axis: 'x', sign: 1 },
      left: { axis: 'x', sign: -1 },
      top: { axis: 'y', sign: 1 },
      bottom: { axis: 'y', sign: -1 },
      front: { axis: 'z', sign: 1 },
      back: { axis: 'z', sign: -1 },
    };

    const axisChoice = { x: null, y: null, z: null };
    for (const face of Object.keys(faceMap)) {
      const picked = pickBestLabel(labels.faces[face], isTrustedLabelEntry);
      if (!picked) continue;
      const info = faceMap[face];
      const existing = axisChoice[info.axis];
      if (!existing || picked.dist > existing.entry.dist) {
        axisChoice[info.axis] = { face, sign: info.sign, entry: picked };
      }
    }
    const chosenEntries = Object.values(axisChoice).filter(Boolean).map((v) => v.entry);
    const strongEvidenceCount = chosenEntries.filter((e) => isVisualLabelSource(e.source) || e.moving).length;
    if (strongEvidenceCount < 2) return null;

    const origin = centerOfRect(anchor.getBoundingClientRect());
    const presentAxes = [];
    const axisData = {};

    for (const axis of ['x', 'y', 'z']) {
      const c = axisChoice[axis];
      if (!c) continue;
      const v2 = [c.entry.center.x - origin.x, c.entry.center.y - origin.y];
      const len = Math.hypot(v2[0], v2[1]);
      if (len < 3.6) continue;
      axisData[axis] = { v2, len, sign: c.sign, face: c.face };
      presentAxes.push(axis);
    }

    if (presentAxes.length < 2) return null;

    const maxLen = Math.max(...presentAxes.map((k) => axisData[k].len));
    if (!Number.isFinite(maxLen) || maxLen < 4.0) return null;

    const toAxis = (v) => {
      const sx = Math.max(-0.98, Math.min(0.98, v[0] / maxLen));
      const sy = Math.max(-0.98, Math.min(0.98, -v[1] / maxLen));
      const szAbs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      return [sx, sy, szAbs];
    };

    const base = {};
    for (const axis of presentAxes) base[axis] = toAxis(axisData[axis].v2);

    let best = null;
    const combos = 1 << presentAxes.length;
    for (let mask = 0; mask < combos; mask++) {
      const cols = { x: null, y: null, z: null };

      for (let i = 0; i < presentAxes.length; i++) {
        const axis = presentAxes[i];
        const s = ((mask >> i) & 1) ? -1 : 1;
        const b = base[axis];
        const faceDir = [b[0], b[1], b[2] * s];
        cols[axis] = vecScale(faceDir, axisData[axis].sign);
      }

      if (!cols.x && cols.y && cols.z) cols.x = vecNorm(vecCross(cols.y, cols.z));
      if (!cols.y && cols.z && cols.x) cols.y = vecNorm(vecCross(cols.z, cols.x));
      if (!cols.z && cols.x && cols.y) cols.z = vecNorm(vecCross(cols.x, cols.y));
      if (!cols.x || !cols.y || !cols.z) continue;

      const q = basisColumnsToQuat(cols.x, cols.y, cols.z);
      if (!q) continue;

      const hand = vecDot(vecCross(cols.x, cols.y), cols.z);
      const continuity = observerRawQuat ? Math.abs(quatDot(q, observerRawQuat)) : 0.5;

      let projectionFit = 0;
      for (const axis of presentAxes) {
        const c = cols[axis];
        const faceDir = vecScale(c, axisData[axis].sign);
        const projected = [faceDir[0], -faceDir[1]];
        const pn = Math.hypot(projected[0], projected[1]);
        if (pn < 1e-6) continue;

        const v = axisData[axis].v2;
        const vn = Math.hypot(v[0], v[1]);
        if (vn < 1e-6) continue;

        projectionFit += (projected[0] / pn) * (v[0] / vn) + (projected[1] / pn) * (v[1] / vn);
      }

      const score = hand * 0.9 + continuity * 0.6 + projectionFit * 0.5;
      if (!best || score > best.score) best = { quat: q, score };
    }

    if (!best) return null;

    const confidence = presentAxes.length === 3 ? 0.79 : 0.69;
    return {
      quat: best.quat,
      confidence,
      strategy: presentAxes.length === 3 ? 'html-face-labels' : 'html-face-labels-partial',
      debug: 'orientation inferred from face labels (' + presentAxes.map((a) => axisData[a].face).join(',') + ')',
    };
  }

  function getPrimaryCanvas(candidates, anchor) {
    const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
    let best = null;

    for (const el of candidates) {
      if (!el || !el.tagName || el.tagName.toLowerCase() !== 'canvas') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;

      const containsAnchor = anchorRect
        ? (anchorRect.left >= rect.left && anchorRect.right <= rect.right &&
           anchorRect.top >= rect.top && anchorRect.bottom <= rect.bottom)
        : true;
      if (!containsAnchor) continue;

      const area = rect.width * rect.height;
      if (!best || area > best.area) best = { el, area };
    }

    if (best) return best.el;

    // Fallback to known Onshape viewer canvas id.
    const byId = document.getElementById('canvas');
    if (byId && byId.tagName && byId.tagName.toLowerCase() === 'canvas') return byId;
    return null;
  }

  function extractFromCanvasPixels(candidates, anchor) {
    if (!anchor) {
      return { sample: null, diagnostics: { reason: 'no-anchor' } };
    }

    const canvas = getPrimaryCanvas(candidates, anchor);
    if (!canvas) {
      return { sample: null, diagnostics: { reason: 'no-canvas' } };
    }

    const canvasRect = canvas.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    if (canvasRect.width <= 1 || canvasRect.height <= 1) {
      return { sample: null, diagnostics: { reason: 'canvas-rect-invalid' } };
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const padPx = 18;

    let sx = Math.floor((anchorRect.left - padPx - canvasRect.left) * scaleX);
    let sy = Math.floor((anchorRect.top - padPx - canvasRect.top) * scaleY);
    let sw = Math.ceil((anchorRect.width + padPx * 2) * scaleX);
    let sh = Math.ceil((anchorRect.height + padPx * 2) * scaleY);

    sx = Math.max(0, Math.min(canvas.width - 1, sx));
    sy = Math.max(0, Math.min(canvas.height - 1, sy));
    sw = Math.max(1, Math.min(canvas.width - sx, sw));
    sh = Math.max(1, Math.min(canvas.height - sy, sh));

    if (sw < 8 || sh < 8) {
      return { sample: null, diagnostics: { reason: 'sample-region-too-small', sw, sh } };
    }

    const sampleSize = 144;
    const probe = document.createElement('canvas');
    probe.width = sampleSize;
    probe.height = sampleSize;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return { sample: null, diagnostics: { reason: 'probe-context-null' } };
    }

    try {
      ctx.clearRect(0, 0, sampleSize, sampleSize);
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sampleSize, sampleSize);
    } catch (e) {
      return { sample: null, diagnostics: { reason: 'drawImage-failed', error: String(e) } };
    }

    let img;
    try {
      img = ctx.getImageData(0, 0, sampleSize, sampleSize);
    } catch (e) {
      return { sample: null, diagnostics: { reason: 'getImageData-failed', error: String(e) } };
    }

    const data = img.data;
    const acc = {
      x: { w: 0, sx: 0, sy: 0, count: 0 },
      y: { w: 0, sx: 0, sy: 0, count: 0 },
      z: { w: 0, sx: 0, sy: 0, count: 0 },
    };

    const hueCounts = { x: 0, y: 0, z: 0 };

    for (let y = 0; y < sampleSize; y++) {
      for (let x = 0; x < sampleSize; x++) {
        const i = (y * sampleSize + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a < 20) continue;

        // Bias toward the center of the cube zone to reduce background/model bleed.
        const nx = (x + 0.5) / sampleSize * 2 - 1;
        const ny = (y + 0.5) / sampleSize * 2 - 1;
        const r2 = nx * nx + ny * ny;
        if (r2 > 1.35) continue;

        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const value = mx / 255;
        if (value < 0.08 || sat < 0.08) continue;

        const hue = hueFromRgb(r, g, b);

        let key = null;
        if (hue !== null) {
          if (hue <= 26 || hue >= 332) key = 'x';
          else if (hue >= 68 && hue <= 178) key = 'y';
          else if (hue >= 188 && hue <= 286) key = 'z';
        }

        // Soft channel fallback when hue is ambiguous but a color still dominates.
        if (!key) {
          if (r > g * 1.06 && r > b * 1.04 && r - Math.max(g, b) >= 8) key = 'x';
          else if (g > r * 1.05 && g > b * 1.03 && g - Math.max(r, b) >= 6) key = 'y';
          else if (b > r * 1.04 && b > g * 1.03 && b - Math.max(r, g) >= 6) key = 'z';
        }
        if (!key) continue;

        const centerBoost = Math.max(0.1, 1.15 - r2 * 0.45);
        const w = Math.max(0.001, ((mx - mn) / 255) * centerBoost);
        acc[key].w += w;
        acc[key].sx += x * w;
        acc[key].sy += y * w;
        acc[key].count++;
        hueCounts[key]++;
      }
    }

    // Anchor center projected into the probe space.
    const anchorCenterSrcX = (anchorRect.left + anchorRect.width * 0.5 - canvasRect.left) * scaleX;
    const anchorCenterSrcY = (anchorRect.top + anchorRect.height * 0.5 - canvasRect.top) * scaleY;
    const originAnchor = {
      x: (anchorCenterSrcX - sx) * (sampleSize / sw),
      y: (anchorCenterSrcY - sy) * (sampleSize / sh),
    };

    const centroid = {
      x: acc.x.w > 0 ? acc.x.sx / acc.x.w : originAnchor.x,
      y: acc.x.w > 0 ? acc.x.sy / acc.x.w : originAnchor.y,
    };
    const centroidY = {
      x: acc.y.w > 0 ? acc.y.sx / acc.y.w : originAnchor.x,
      y: acc.y.w > 0 ? acc.y.sy / acc.y.w : originAnchor.y,
    };
    const centroidZ = {
      x: acc.z.w > 0 ? acc.z.sx / acc.z.w : originAnchor.x,
      y: acc.z.w > 0 ? acc.z.sy / acc.z.w : originAnchor.y,
    };

    // If all three are visible, lightly blend centroid origin to reduce bias.
    let origin = { ...originAnchor };
    if (acc.x.w > 0.9 && acc.y.w > 0.9 && acc.z.w > 0.9) {
      const centroidOrigin = {
        x: (centroid.x + centroidY.x + centroidZ.x) / 3,
        y: (centroid.y + centroidY.y + centroidZ.y) / 3,
      };
      origin = {
        x: originAnchor.x * 0.7 + centroidOrigin.x * 0.3,
        y: originAnchor.y * 0.7 + centroidOrigin.y * 0.3,
      };
    }

    const axisData = {
      x: { c: centroid, w: acc.x.w, count: acc.x.count },
      y: { c: centroidY, w: acc.y.w, count: acc.y.count },
      z: { c: centroidZ, w: acc.z.w, count: acc.z.count },
    };

    for (const key of ['x', 'y', 'z']) {
      axisData[key].v2 = [axisData[key].c.x - origin.x, axisData[key].c.y - origin.y];
      axisData[key].len = Math.hypot(axisData[key].v2[0], axisData[key].v2[1]);
    }

    const minWeight = 0.35;
    const minLen = 2.4;
    const presentAxes = ['x', 'y', 'z'].filter((k) => axisData[k].w >= minWeight && axisData[k].len >= minLen);

    if (presentAxes.length < 2) {
      return {
        sample: null,
        diagnostics: {
          reason: 'insufficient-visible-axes',
          weights: { x: acc.x.w, y: acc.y.w, z: acc.z.w },
          hueCounts,
          lengths: { x: axisData.x.len, y: axisData.y.len, z: axisData.z.len },
          presentAxes,
        },
      };
    }

    const maxLen = Math.max(...presentAxes.map((k) => axisData[k].len));
    if (maxLen < 2.8) {
      return { sample: null, diagnostics: { reason: 'axis-separation-too-small', maxLen } };
    }

    const toAxis = (v) => {
      const sx2 = Math.max(-0.98, Math.min(0.98, v[0] / maxLen));
      const sy2 = Math.max(-0.98, Math.min(0.98, -v[1] / maxLen));
      const szAbs = Math.sqrt(Math.max(0, 1 - sx2 * sx2 - sy2 * sy2));
      return [sx2, sy2, szAbs];
    };

    const base = {};
    for (const key of presentAxes) {
      base[key] = toAxis(axisData[key].v2);
    }

    let best = null;
    const signAxes = [...presentAxes];
    const combos = 1 << signAxes.length;
    for (let mask = 0; mask < combos; mask++) {
      const cols = { x: null, y: null, z: null };
      for (let i = 0; i < signAxes.length; i++) {
        const key = signAxes[i];
        const s = ((mask >> i) & 1) ? -1 : 1;
        const b = base[key];
        cols[key] = [b[0], b[1], b[2] * s];
      }

      // Reconstruct one missing axis from cross-product ordering.
      if (!cols.x && cols.y && cols.z) cols.x = vecNorm(vecCross(cols.y, cols.z));
      if (!cols.y && cols.z && cols.x) cols.y = vecNorm(vecCross(cols.z, cols.x));
      if (!cols.z && cols.x && cols.y) cols.z = vecNorm(vecCross(cols.x, cols.y));
      if (!cols.x || !cols.y || !cols.z) continue;

      const q = basisColumnsToQuat(cols.x, cols.y, cols.z);
      if (!q) continue;

      const hand = vecDot(vecCross(cols.x, cols.y), cols.z);
      const continuity = observerQuat ? Math.abs(quatDot(q, observerQuat)) : 0.5;

      let projectionFit = 0;
      for (const key of presentAxes) {
        const v = axisData[key].v2;
        const n = Math.hypot(v[0], v[1]);
        if (n < 1e-6) continue;
        const measured = [v[0] / n, v[1] / n];
        const c = cols[key];
        const projected = [c[0], -c[1]];
        const pn = Math.hypot(projected[0], projected[1]);
        if (pn < 1e-6) continue;
        projectionFit += (projected[0] / pn) * measured[0] + (projected[1] / pn) * measured[1];
      }

      const score = hand * 0.85 + continuity * 0.7 + projectionFit * 0.35;
      if (!best || score > best.score) {
        best = { quat: q, score };
      }
    }

    if (!best) {
      return { sample: null, diagnostics: { reason: 'sign-solve-failed' } };
    }

    let minW = Number.POSITIVE_INFINITY;
    for (const key of presentAxes) {
      minW = Math.min(minW, axisData[key].w);
    }
    if (!Number.isFinite(minW)) minW = 0;

    let confidence = 0.5 + Math.min(0.28, minW / 80);
    if (presentAxes.length === 2) confidence *= 0.9;
    confidence = Math.max(0.42, Math.min(0.9, confidence));

    return {
      sample: {
        quat: best.quat,
        confidence,
        strategy: 'canvas-rgb-pixels',
        debug: 'orientation inferred from RGB axis pixels in view-cube region',
      },
      diagnostics: {
        reason: 'ok',
        weights: { x: acc.x.w, y: acc.y.w, z: acc.z.w },
        hueCounts,
        counts: { x: acc.x.count, y: acc.y.count, z: acc.z.count },
        lengths: { x: axisData.x.len, y: axisData.y.len, z: axisData.z.len },
        presentAxes,
        sampleRect: { sx, sy, sw, sh },
        canvasRect: {
          left: canvasRect.left,
          top: canvasRect.top,
          width: canvasRect.width,
          height: canvasRect.height,
        }
      },
    };
  }

  function scanWidgetOrientation(nowMs) {
    if (!config.watcherEnabled) {
      observerStrategy = 'disabled';
      observerConfidence = 0;
      observerDebug = 'watcher disabled';
      return;
    }
    if (nowMs - observerLastScanMs < SCAN_INTERVAL_MS) return;

    observerLastScanMs = nowMs;

    const info = collectWidgetCandidates();
    const candidates = info.candidates;
    let sample = extractFromCssMatrix(candidates, info.anchor);
    const mode = normalizeFallbackMode(config.fallbackMode);
    const labels = collectWidgetLabels(candidates, info.anchor);
    const axisVisible = ['x', 'y', 'z'].filter((k) => labels.axis[k].length > 0).length;
    const faceVisible = ['front', 'back', 'left', 'right', 'top', 'bottom'].filter((k) => labels.faces[k].length > 0).length;
    const axisTrusted = ['x', 'y', 'z'].filter((k) => labels.axis[k].some((e) => isTrustedLabelEntry(e))).length;
    const faceTrusted = ['front', 'back', 'left', 'right', 'top', 'bottom'].filter((k) => labels.faces[k].some((e) => isTrustedLabelEntry(e))).length;
    let unresolvedReason = '';

    if (!sample && mode !== 'matrix') {
      sample = extractFromSvgLabels(candidates);
    }

    if (!sample && mode !== 'matrix') {
      sample = extractFromHtmlAxisLabels(labels, info.anchor);
    }

    if (!sample && mode !== 'matrix') {
      sample = extractFromFaceLabels(labels, info.anchor);
    }

    if (!sample && mode === 'legacy-pixels') {
      const pixel = extractFromCanvasPixels(candidates, info.anchor);
      if (pixel.sample) {
        sample = pixel.sample;
      } else if (pixel.diagnostics && pixel.diagnostics.reason) {
        unresolvedReason = 'pixel probe: ' + pixel.diagnostics.reason;
      }
    }

    if (!sample && !unresolvedReason && mode !== 'matrix') {
      unresolvedReason =
        'labels unresolved: axis=' + axisVisible + ', face=' + faceVisible +
        ' | trusted axis=' + axisTrusted + ', trusted face=' + faceTrusted;
    }

    if (!sample || !sample.quat) {
      observerStrategy = 'none';
      observerConfidence = 0;
      if (unresolvedReason) {
        observerDebug = unresolvedReason;
      } else {
        observerDebug = info.anchor ? 'widget anchor found but orientation unresolved' : 'widget anchor not found';
      }
      return;
    }

    const q = quatNormalize(sample.quat);
    if (!q) return;

    if (!observerRawQuat) {
      observerRawQuat = q;
    } else {
      const blend = Math.max(0.01, Math.min(0.9, config.smoothing));
      observerRawQuat = quatLerp(observerRawQuat, q, blend) || q;
    }

    observerQuat = applyFrameCalibration(observerRawQuat);

    observerStrategy = sample.strategy;
    observerConfidence = sample.confidence;
    observerDebug = sample.debug;
    observerLastUpdateMs = nowMs;
  }

  function makeDraggable(el, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      offsetX = e.clientX - el.offsetLeft;
      offsetY = e.clientY - el.offsetTop;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
    });

    handle.addEventListener('pointerup', () => {
      dragging = false;
    });
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'usb-freed-panel';
    panel.innerHTML = `
      <div class="usb-freed-header">
        <span class="usb-freed-title">USB freeD Widget Watcher</span>
        <button class="usb-freed-minimize" title="Minimize">-</button>
      </div>
      <div class="usb-freed-body">
        <div class="usb-freed-row">
          <button id="usb-freed-watch-toggle" class="usb-freed-btn usb-freed-btn-sm">Watcher ON</button>
          <button id="usb-freed-watch-fallback" class="usb-freed-btn usb-freed-btn-sm">Fallback: Auto</button>
        </div>

        <div class="usb-freed-row">
          <label class="usb-freed-label">Smooth</label>
          <input id="usb-freed-watch-smooth" type="range" min="5" max="95" value="${Math.round(config.smoothing * 100)}" class="usb-freed-slider">
          <span id="usb-freed-watch-smooth-val" class="usb-freed-label">${Math.round(config.smoothing * 100)}%</span>
        </div>

        <div class="usb-freed-preview-wrap">
          <canvas id="usb-freed-preview" class="usb-freed-preview" width="248" height="156"></canvas>
        </div>

        <div class="usb-freed-row">
          <button id="usb-freed-cal-front" class="usb-freed-btn usb-freed-btn-sm">Set Current = Front</button>
          <button id="usb-freed-cal-reset" class="usb-freed-btn usb-freed-btn-sm">Clear Align</button>
        </div>

        <div id="usb-freed-watch-status" class="usb-freed-status">Searching widget...</div>
        <div id="usb-freed-watch-data" class="usb-freed-data">No orientation sample yet.</div>
        <div id="usb-freed-watch-note" class="usb-freed-hint">Upper-right view widget watcher is active.</div>
      </div>
    `;

    document.body.appendChild(panel);

    toggleBtn = panel.querySelector('#usb-freed-watch-toggle');
    fallbackBtn = panel.querySelector('#usb-freed-watch-fallback');
    smoothSlider = panel.querySelector('#usb-freed-watch-smooth');
    smoothVal = panel.querySelector('#usb-freed-watch-smooth-val');
    calibrateBtn = panel.querySelector('#usb-freed-cal-front');
    clearCalBtn = panel.querySelector('#usb-freed-cal-reset');
    previewCanvas = panel.querySelector('#usb-freed-preview');
    previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;
    statusEl = panel.querySelector('#usb-freed-watch-status');
    dataEl = panel.querySelector('#usb-freed-watch-data');
    noteEl = panel.querySelector('#usb-freed-watch-note');

    const minimizeBtn = panel.querySelector('.usb-freed-minimize');
    const body = panel.querySelector('.usb-freed-body');

    toggleBtn.addEventListener('click', () => {
      config.watcherEnabled = !config.watcherEnabled;
      if (!config.watcherEnabled) {
        observerRawQuat = null;
        observerQuat = null;
        observerConfidence = 0;
        observerStrategy = 'disabled';
      }
      saveConfig();
      updatePanel();
    });

    fallbackBtn.addEventListener('click', () => {
      const mode = normalizeFallbackMode(config.fallbackMode);
      if (mode === 'labels') config.fallbackMode = 'matrix';
      else if (mode === 'matrix') config.fallbackMode = 'legacy-pixels';
      else config.fallbackMode = 'labels';
      saveConfig();
      updatePanel();
    });

    smoothSlider.addEventListener('input', () => {
      config.smoothing = parseInt(smoothSlider.value, 10) / 100;
      smoothVal.textContent = Math.round(config.smoothing * 100) + '%';
      saveConfig();
    });

    calibrateBtn.addEventListener('click', () => {
      if (calibrateCurrentAsFront()) {
        updatePanel();
      }
    });

    clearCalBtn.addEventListener('click', () => {
      clearCalibration();
      updatePanel();
    });

    minimizeBtn.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minimizeBtn.textContent = hidden ? '-' : '+';
    });

    makeDraggable(panel, panel.querySelector('.usb-freed-header'));
    drawOrientationPreview(null, true);
    updatePanel();
  }

  function updatePanel() {
    if (!panel) return;

    toggleBtn.textContent = config.watcherEnabled ? 'Watcher ON' : 'Watcher OFF';
    toggleBtn.classList.toggle('usb-freed-btn-active', config.watcherEnabled);
    fallbackBtn.textContent = fallbackModeLabel(config.fallbackMode);
    const calOn = calibrationEnabled();
    clearCalBtn.classList.toggle('usb-freed-btn-active', calOn);

    const nowMs = performance.now();
    if (!config.watcherEnabled) {
      statusEl.textContent = 'Watcher disabled';
      statusEl.style.color = '#f9c97a';
      dataEl.textContent = 'No orientation sample yet.';
      noteEl.textContent = 'Enable watcher to resume sampling.';
      calibrateBtn.disabled = true;
      clearCalBtn.disabled = !calOn;
      drawOrientationPreview(null, true);
      return;
    }

    const stale = observerIsStale(nowMs);
    const ageMs = observerLastUpdateMs > 0 ? Math.round(nowMs - observerLastUpdateMs) : 0;

    if (!observerQuat || stale) {
      statusEl.textContent = 'Searching for view widget...';
      statusEl.style.color = '#f9c97a';
      calibrateBtn.disabled = true;
      clearCalBtn.disabled = !calOn;
      dataEl.textContent =
        'Strategy: ' + observerStrategy + '\n' +
        'Align: ' + (calOn ? 'ON' : 'OFF') + '\n' +
        'Confidence: ' + Math.round(observerConfidence * 100) + '%\n' +
        'Yaw/Pitch/Roll: -- / -- / --\n' +
        'Quat: --';
      noteEl.textContent = observerDebug + (observerLastUpdateMs ? (' | last sample ' + ageMs + 'ms ago') : '');
      drawOrientationPreview(observerQuat, true);
      return;
    }

    const e = quatToEuler(observerQuat);
    const yawDeg = e.yaw * 180 / Math.PI;
    const pitchDeg = e.pitch * 180 / Math.PI;
    const rollDeg = e.roll * 180 / Math.PI;

    calibrateBtn.disabled = false;
    clearCalBtn.disabled = !calOn;

    statusEl.textContent = 'Widget tracked (' + observerStrategy + ')';
    statusEl.style.color = observerConfidence >= 0.75 ? '#4ade80' : '#f9c97a';

    dataEl.textContent =
      'Strategy: ' + observerStrategy + '\n' +
      'Align: ' + (calOn ? 'ON' : 'OFF') + '\n' +
      'Confidence: ' + Math.round(observerConfidence * 100) + '%\n' +
      'Yaw/Pitch/Roll: ' +
      yawDeg.toFixed(1) + ' / ' + pitchDeg.toFixed(1) + ' / ' + rollDeg.toFixed(1) + ' deg\n' +
      'Quat: ' +
      observerQuat.w.toFixed(4) + ' ' +
      observerQuat.x.toFixed(4) + ' ' +
      observerQuat.y.toFixed(4) + ' ' +
      observerQuat.z.toFixed(4);

    noteEl.textContent = observerDebug + ' | sample age ' + ageMs + 'ms';
    drawOrientationPreview(observerQuat, false);
  }

  function tick() {
    try {
      const nowMs = performance.now();
      scanWidgetOrientation(nowMs);
      updatePanel();
    } catch (err) {
      observerStrategy = 'error';
      observerConfidence = 0;
      observerDebug = 'runtime error: ' + String(err && err.message ? err.message : err);
      setLastError('tick', err, null);
      console.error('[USB_freeD] tick error (' + BUILD_TAG + ')', err);
      try {
        updatePanel();
      } catch (_) {
        // keep timer alive even if panel update also fails
      }
    }
  }

  function init() {
    installGlobalErrorHooks();
    createPanel();
    window.usbFreeDWidgetWatcher = {
      buildTag: BUILD_TAG,
      getState: () => ({
        buildTag: BUILD_TAG,
        strategy: observerStrategy,
        confidence: observerConfidence,
        stale: observerIsStale(),
        lastUpdateMs: observerLastUpdateMs,
        rawQuat: observerRawQuat,
        quat: observerQuat,
        calibration: getCalibrationQuat(),
        lastError: observerLastError,
      }),
      dumpCandidates: () => debugDumpCandidates(),
      dumpNeighborhood: () => debugDumpNeighborhood(),
      dumpLabels: () => debugDumpLabels(),
      dumpPixelProbe: () => debugDumpPixelProbe(),
      calibrateCurrentAsFront: () => calibrateCurrentAsFront(),
      clearCalibration: () => clearCalibration(),
    };
    window.setInterval(tick, 80);
    tick();
    console.log('[USB_freeD] Widget watcher loaded (' + BUILD_TAG + ') on', window.location.hostname);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
