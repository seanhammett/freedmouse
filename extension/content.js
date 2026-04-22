// USB freeD - Onshape View Widget Watcher
// Chrome Extension Content Script (MAIN world)
// Tracks the viewport orientation from the upper-right view widget.

(function () {
  'use strict';

  const STORAGE_KEY = 'usbFreeDWidgetWatcherConfig';
  const SCAN_INTERVAL_MS = 220;
  const STALE_MS = 1600;

  let config = loadConfig();

  let observerQuat = null;
  let observerStrategy = 'none';
  let observerConfidence = 0;
  let observerDebug = 'idle';
  let observerLastUpdateMs = 0;
  let observerLastScanMs = 0;

  let panel = null;
  let statusEl = null;
  let dataEl = null;
  let noteEl = null;
  let toggleBtn = null;
  let fallbackBtn = null;
  let smoothSlider = null;
  let smoothVal = null;
  let previewCanvas = null;
  let previewCtx = null;

  function defaultConfig() {
    return {
      watcherEnabled: true,
      fallbackMode: 'auto',
      smoothing: 0.3,
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...defaultConfig(), ...JSON.parse(raw) };
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

  function quatNormalize(q) {
    const n = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (n < 1e-9 || !Number.isFinite(n)) return null;
    return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
  }

  function quatDot(a, b) {
    return a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function quatLerp(a, b, t) {
    let bb = b;
    if (quatDot(a, b) < 0) {
      bb = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
    }
    return quatNormalize({
      w: a.w + (bb.w - a.w) * t,
      x: a.x + (bb.x - a.x) * t,
      y: a.y + (bb.y - a.y) * t,
      z: a.z + (bb.z - a.z) * t,
    });
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

  function observerIsStale(nowMs = performance.now()) {
    return !observerQuat || (nowMs - observerLastUpdateMs) > STALE_MS;
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

  function extractFromCssMatrix(candidates) {
    for (const el of candidates) {
      let node = el;
      for (let depth = 0; depth < 5 && node; depth++) {
        const style = window.getComputedStyle(node);
        const q = parseMatrix3d(style.transform) || parseMatrix3d(style.webkitTransform);
        if (q) {
          return {
            quat: q,
            confidence: 0.97,
            strategy: 'css-matrix3d',
            debug: 'orientation from DOM transform matrix',
          };
        }
        node = node.parentElement;
      }
    }
    return null;
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

  function extractFromHtmlAxisLabels(candidates, anchor) {
    if (!anchor) return null;

    const anchorRect = anchor.getBoundingClientRect();
    const searchRect = expandRect(anchorRect, 35);
    const bins = { x: [], y: [], z: [] };

    for (const el of candidates) {
      if (!el || !el.textContent) continue;
      const text = el.textContent.trim().toLowerCase();
      if (text !== 'x' && text !== 'y' && text !== 'z') continue;

      const rect = el.getBoundingClientRect();
      if (!rectIntersects(rect, searchRect)) continue;
      if (rect.width > 50 || rect.height > 50) continue;

      const c = centerOfRect(rect);
      const ac = centerOfRect(anchorRect);
      const dist = Math.hypot(c.x - ac.x, c.y - ac.y);
      if (dist < 8) continue;

      bins[text].push({ center: c, dist });
    }

    if (!bins.x.length || !bins.y.length || !bins.z.length) return null;

    const pickFarthest = (arr) => arr.sort((a, b) => b.dist - a.dist)[0].center;
    const px = pickFarthest(bins.x);
    const py = pickFarthest(bins.y);
    const pz = pickFarthest(bins.z);

    const origin = {
      x: (px.x + py.x + pz.x) / 3,
      y: (px.y + py.y + pz.y) / 3,
    };

    const vx = [px.x - origin.x, px.y - origin.y];
    const vy = [py.x - origin.x, py.y - origin.y];
    const vz = [pz.x - origin.x, pz.y - origin.y];
    const maxLen = Math.max(Math.hypot(vx[0], vx[1]), Math.hypot(vy[0], vy[1]), Math.hypot(vz[0], vz[1]));
    if (maxLen < 8) return null;

    const toAxis = (v) => {
      const sx = Math.max(-0.98, Math.min(0.98, v[0] / maxLen));
      const sy = Math.max(-0.98, Math.min(0.98, -v[1] / maxLen));
      const szAbs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      return [sx, sy, szAbs];
    };

    const xBase = toAxis(vx);
    const yBase = toAxis(vy);
    const zBase = toAxis(vz);

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
          if (!best || score > best.score) best = { quat: q, score };
        }
      }
    }

    if (!best) return null;

    return {
      quat: best.quat,
      confidence: 0.74,
      strategy: 'html-axis-labels',
      debug: 'orientation inferred from HTML X/Y/Z label positions',
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
    let sample = extractFromCssMatrix(candidates);
    let unresolvedReason = '';

    if (!sample && config.fallbackMode === 'auto') {
      sample = extractFromSvgLabels(candidates);
    }

    if (!sample && config.fallbackMode === 'auto') {
      sample = extractFromHtmlAxisLabels(candidates, info.anchor);
    }

    if (!sample && config.fallbackMode === 'auto') {
      const pixel = extractFromCanvasPixels(candidates, info.anchor);
      if (pixel.sample) {
        sample = pixel.sample;
      } else if (pixel.diagnostics && pixel.diagnostics.reason) {
        unresolvedReason = 'pixel probe: ' + pixel.diagnostics.reason;
      }
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

    if (!observerQuat) {
      observerQuat = q;
    } else {
      const blend = Math.max(0.01, Math.min(0.9, config.smoothing));
      observerQuat = quatLerp(observerQuat, q, blend) || q;
    }

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
        observerQuat = null;
        observerConfidence = 0;
        observerStrategy = 'disabled';
      }
      saveConfig();
      updatePanel();
    });

    fallbackBtn.addEventListener('click', () => {
      config.fallbackMode = config.fallbackMode === 'auto' ? 'matrix' : 'auto';
      saveConfig();
      updatePanel();
    });

    smoothSlider.addEventListener('input', () => {
      config.smoothing = parseInt(smoothSlider.value, 10) / 100;
      smoothVal.textContent = Math.round(config.smoothing * 100) + '%';
      saveConfig();
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
    fallbackBtn.textContent = config.fallbackMode === 'auto' ? 'Fallback: Auto' : 'Fallback: Matrix';

    const nowMs = performance.now();
    if (!config.watcherEnabled) {
      statusEl.textContent = 'Watcher disabled';
      statusEl.style.color = '#f9c97a';
      dataEl.textContent = 'No orientation sample yet.';
      noteEl.textContent = 'Enable watcher to resume sampling.';
      drawOrientationPreview(null, true);
      return;
    }

    const stale = observerIsStale(nowMs);
    const ageMs = observerLastUpdateMs > 0 ? Math.round(nowMs - observerLastUpdateMs) : 0;

    if (!observerQuat || stale) {
      statusEl.textContent = 'Searching for view widget...';
      statusEl.style.color = '#f9c97a';
      dataEl.textContent =
        'Strategy: ' + observerStrategy + '\n' +
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

    statusEl.textContent = 'Widget tracked (' + observerStrategy + ')';
    statusEl.style.color = observerConfidence >= 0.75 ? '#4ade80' : '#f9c97a';

    dataEl.textContent =
      'Strategy: ' + observerStrategy + '\n' +
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
    const nowMs = performance.now();
    scanWidgetOrientation(nowMs);
    updatePanel();
  }

  function init() {
    createPanel();
    window.usbFreeDWidgetWatcher = {
      getState: () => ({
        strategy: observerStrategy,
        confidence: observerConfidence,
        stale: observerIsStale(),
        lastUpdateMs: observerLastUpdateMs,
        quat: observerQuat,
      }),
      dumpCandidates: () => debugDumpCandidates(),
      dumpNeighborhood: () => debugDumpNeighborhood(),
      dumpPixelProbe: () => debugDumpPixelProbe(),
    };
    window.setInterval(tick, 80);
    tick();
    console.log('[USB_freeD] Widget watcher loaded on', window.location.hostname);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
