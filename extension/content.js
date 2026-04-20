// USB freeD — 3D IMU Mouse for Onshape
// Chrome Extension Content Script (MAIN world)
// Reads quaternions from CodeCell C6 via Web Serial, controls Onshape viewport.

(function () {
  'use strict';

  // ======================== CONSTANTS ========================
  const HEADER = 0xAA;
  const PACKET_SIZE = 20;
  const BAUD_RATE = 115200;
  const ESPRESSIF_VID = 0x303A;
  const FLAG_HOME_RESET = 0x01;
  const FLAG_TAP = 0x02;
  const DEFAULT_PPR = 30;            // pixels-per-radian default (calibratable)
  const DEFAULT_DEADZONE = 0.012;    // radians (~0.7°)
  const STORAGE_KEY = 'usbFreeDConfig';

  // ======================== STATE ========================
  let port = null;
  let reader = null;
  let reading = false;
  let buffer = new Uint8Array(0);

  let prevQuat = null;
  let homeQuat = null;
  let mode = 'orbit';
  let enabled = true;

  // Config (persisted to localStorage)
  let config = loadConfig();

  // Frame-batched viewport deltas
  let pendingDx = 0;
  let pendingDy = 0;
  let frameRequested = false;

  // Stats
  let packetCount = 0;
  let errorCount = 0;
  let hz = 0;
  const hzWindow = [];

  // Live axis display values (degrees, relative to home)
  let liveYaw = 0, livePitch = 0, liveRoll = 0;

  // UI elements
  let panel, statusEl, dataEl, connectBtn, modeBtn, enableBtn;
  let axisYawBar, axisPitchBar, axisRollBar;
  let calibSlider, calibVal;

  // ======================== CONFIG PERSISTENCE ========================

  function defaultConfig() {
    return {
      ppr: DEFAULT_PPR,
      deadzone: DEFAULT_DEADZONE,
      invertYaw: false,
      invertPitch: false,
      swapAxes: false,
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...defaultConfig(), ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    return defaultConfig();
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) { /* ignore */ }
  }

  // ======================== QUATERNION MATH ========================

  function quatInverse(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  }

  function quatMultiply(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
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

  // ======================== PACKET PARSER ========================

  function concatBuffers(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
  }

  function parsePackets(incoming) {
    buffer = concatBuffers(buffer, incoming);
    const packets = [];

    while (buffer.length >= PACKET_SIZE) {
      const idx = buffer.indexOf(HEADER);
      if (idx < 0) {
        buffer = new Uint8Array(0);
        break;
      }
      if (idx > 0) buffer = buffer.slice(idx);
      if (buffer.length < PACKET_SIZE) break;

      const raw = buffer.slice(0, PACKET_SIZE);
      buffer = buffer.slice(PACKET_SIZE);

      // XOR checksum over bytes 1..18
      let cs = 0;
      for (let i = 1; i < 19; i++) cs ^= raw[i];
      if (cs !== raw[19]) {
        errorCount++;
        continue;
      }

      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      packets.push({
        qw: view.getFloat32(1, true),
        qx: view.getFloat32(5, true),
        qy: view.getFloat32(9, true),
        qz: view.getFloat32(13, true),
        flags: raw[17],
        battery: raw[18],
      });
    }

    return packets;
  }

  // ======================== VIEWPORT CONTROL ========================

  // Only suppress context menu for our own synthetic right-clicks.
  // Real right-clicks from the user pass through normally.
  function suppressContextMenu() {
    window.addEventListener('contextmenu', (e) => {
      if (!e.isTrusted) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function getCanvas() {
    let best = null;
    let bestArea = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const rect = c.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && rect.width > 100 && rect.height > 100) {
        bestArea = area;
        best = c;
      }
    }
    return best;
  }

  // Continuous drag state — Onshape requires a real multi-frame drag session.
  // We hold the button down, stream pointermove each frame, and release
  // after a short idle period so the user's real mouse can work between bursts.
  let dragActive = false;
  let dragMode = null;
  let dragCx = 0, dragCy = 0;
  let dragIdleTimer = null;
  const DRAG_IDLE_MS = 60; // release drag quickly when no IMU movement

  function startDrag(isPan) {
    const canvas = getCanvas();
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    dragCx = rect.left + rect.width / 2;
    dragCy = rect.top + rect.height / 2;
    dragMode = isPan ? 'pan' : 'orbit';

    const btn = isPan
      ? { button: 1, buttons: 4 }
      : { button: 2, buttons: 2 };

    const shared = {
      bubbles: true, cancelable: true, view: window,
      ...btn, shiftKey: false,
    };

    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      ...shared, clientX: dragCx, clientY: dragCy,
      pointerId: 99, pointerType: 'mouse',
    }));
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      ...shared, clientX: dragCx, clientY: dragCy,
    }));

    dragActive = true;
  }

  function moveDrag(dx, dy) {
    const canvas = getCanvas();
    if (!canvas) return;

    dragCx += dx;
    dragCy += dy;

    const isPan = dragMode === 'pan';
    const btn = isPan
      ? { button: 1, buttons: 4 }
      : { button: 2, buttons: 2 };

    const shared = {
      bubbles: true, cancelable: true, view: window,
      ...btn, shiftKey: false,
    };

    canvas.dispatchEvent(new PointerEvent('pointermove', {
      ...shared, clientX: dragCx, clientY: dragCy,
      pointerId: 99, pointerType: 'mouse',
    }));
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      ...shared, clientX: dragCx, clientY: dragCy,
    }));
  }

  function endDrag() {
    if (!dragActive) return;
    const canvas = getCanvas();
    if (!canvas) return;

    const shared_up = {
      bubbles: true, cancelable: true, view: window,
      button: dragMode === 'pan' ? 1 : 2, buttons: 0, shiftKey: false,
    };

    canvas.dispatchEvent(new PointerEvent('pointerup', {
      ...shared_up, clientX: dragCx, clientY: dragCy,
      pointerId: 99, pointerType: 'mouse',
    }));
    canvas.dispatchEvent(new MouseEvent('mouseup', {
      ...shared_up, clientX: dragCx, clientY: dragCy,
    }));

    dragActive = false;
    dragMode = null;
  }

  // Also used for calibration test drags (one-shot)
  function dispatchAtomicDrag(dx, dy, isPan) {
    const canvas = getCanvas();
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const btn = isPan
      ? { button: 1, buttons: 4 }
      : { button: 2, buttons: 2 };

    const shared = {
      bubbles: true, cancelable: true, view: window,
      ...btn, shiftKey: false,
    };

    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      ...shared, clientX: cx, clientY: cy,
      pointerId: 99, pointerType: 'mouse',
    }));
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      ...shared, clientX: cx, clientY: cy,
    }));

    setTimeout(() => {
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        ...shared, clientX: cx + dx, clientY: cy + dy,
        pointerId: 99, pointerType: 'mouse',
      }));
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        ...shared, clientX: cx + dx, clientY: cy + dy,
      }));

      setTimeout(() => {
        canvas.dispatchEvent(new PointerEvent('pointerup', {
          ...shared, clientX: cx + dx, clientY: cy + dy, buttons: 0,
          pointerId: 99, pointerType: 'mouse',
        }));
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          ...shared, clientX: cx + dx, clientY: cy + dy, buttons: 0,
        }));
      }, 16);
    }, 16);
  }

  // Flush accumulated deltas once per animation frame
  function flushViewport() {
    frameRequested = false;
    if (Math.abs(pendingDx) < 0.5 && Math.abs(pendingDy) < 0.5) return;

    const isPan = mode === 'pan';

    // If drag mode changed, end and restart
    if (dragActive && dragMode !== (isPan ? 'pan' : 'orbit')) {
      endDrag();
    }

    if (!dragActive) {
      startDrag(isPan);
    }

    moveDrag(pendingDx, pendingDy);
    pendingDx = 0;
    pendingDy = 0;

    // Release drag quickly when device stops moving
    clearTimeout(dragIdleTimer);
    dragIdleTimer = setTimeout(endDrag, DRAG_IDLE_MS);
  }

  function queueViewportUpdate(dx, dy) {
    pendingDx += dx;
    pendingDy += dy;
    if (!frameRequested) {
      frameRequested = true;
      requestAnimationFrame(flushViewport);
    }
  }

  // ======================== CALIBRATION ========================

  function injectCalibrationDrag(pixels) {
    dispatchAtomicDrag(pixels, 0, false);
  }

  // ======================== PACKET PROCESSING ========================

  function processPacket(pkt) {
    const curr = { w: pkt.qw, x: pkt.qx, y: pkt.qy, z: pkt.qz };

    // Home reset (tap gesture)
    if (pkt.flags & FLAG_HOME_RESET) {
      homeQuat = { ...curr };
      prevQuat = null;
      liveYaw = 0; livePitch = 0; liveRoll = 0;
      return;
    }

    if (!homeQuat) homeQuat = { ...curr };

    // Compute absolute orientation relative to home (for axis overlay)
    const relQuat = quatMultiply(curr, quatInverse(homeQuat));
    const absEuler = quatToEuler(relQuat);
    liveYaw = absEuler.yaw * (180 / Math.PI);
    livePitch = absEuler.pitch * (180 / Math.PI);
    liveRoll = absEuler.roll * (180 / Math.PI);
    updateAxisOverlay();

    if (!prevQuat) {
      prevQuat = { ...curr };
      return;
    }
    if (!enabled) {
      prevQuat = { ...curr };
      return;
    }

    // Delta rotation since last frame
    const delta = quatMultiply(curr, quatInverse(prevQuat));
    const euler = quatToEuler(delta);

    // Deadzone
    if (Math.abs(euler.yaw) < config.deadzone && Math.abs(euler.pitch) < config.deadzone) {
      return;
    }

    // Apply axis config
    let dyaw = euler.yaw;
    let dpitch = euler.pitch;

    if (config.invertYaw) dyaw = -dyaw;
    if (config.invertPitch) dpitch = -dpitch;
    if (config.swapAxes) { const t = dyaw; dyaw = dpitch; dpitch = t; }

    // Map to pixel deltas
    const dx = -dyaw * config.ppr;
    const dy = dpitch * config.ppr;

    queueViewportUpdate(dx, dy);
    prevQuat = { ...curr };
  }

  // ======================== SERIAL ========================

  async function connect() {
    try {
      port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: ESPRESSIF_VID }],
      });
      await port.open({ baudRate: BAUD_RATE });

      reading = true;
      buffer = new Uint8Array(0);
      prevQuat = null;
      homeQuat = null;
      packetCount = 0;
      errorCount = 0;
      hzWindow.length = 0;
      liveYaw = 0; livePitch = 0; liveRoll = 0;

      updateUI('connected');
      readLoop();
    } catch (err) {
      console.error('[USB_freeD] Connect error:', err);
      setStatus('Error: ' + err.message);
    }
  }

  async function disconnect() {
    reading = false;
    endDrag();
    try {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
        reader = null;
      }
      if (port) {
        await port.close();
        port = null;
      }
    } catch (err) {
      console.error('[USB_freeD] Disconnect error:', err);
    }
    updateUI('disconnected');
  }

  async function readLoop() {
    reader = port.readable.getReader();
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;

        const packets = parsePackets(value);
        const now = performance.now();
        for (const pkt of packets) {
          packetCount++;
          hzWindow.push(now);
          processPacket(pkt);
        }

        // Trim Hz window to last 1 second
        while (hzWindow.length > 0 && hzWindow[0] < now - 1000) {
          hzWindow.shift();
        }
        hz = hzWindow.length;

        // Update display with latest packet
        if (packets.length > 0) {
          updateDataDisplay(packets[packets.length - 1]);
        }
      }
    } catch (err) {
      if (reading) {
        console.error('[USB_freeD] Read error:', err);
        setStatus('Read error: ' + err.message);
      }
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = null;
      }
    }
  }

  // ======================== UI ========================

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'usb-freed-panel';
    panel.innerHTML = `
      <div class="usb-freed-header">
        <span class="usb-freed-title">\u{1F3AE} USB freeD</span>
        <button class="usb-freed-minimize" title="Minimize">\u2212</button>
      </div>
      <div class="usb-freed-body">
        <div class="usb-freed-row">
          <button id="usb-freed-connect" class="usb-freed-btn usb-freed-btn-connect">Connect</button>
          <button id="usb-freed-enable" class="usb-freed-btn usb-freed-btn-active" title="Toggle control">ON</button>
        </div>
        <div class="usb-freed-row">
          <button id="usb-freed-mode" class="usb-freed-btn">Orbit</button>
          <button id="usb-freed-home" class="usb-freed-btn" title="Reset home orientation">Home</button>
        </div>

        <div class="usb-freed-section-label">Axis Debug</div>
        <div class="usb-freed-axis-container">
          <div class="usb-freed-axis-row">
            <span class="usb-freed-axis-label usb-freed-yaw">Yaw</span>
            <div class="usb-freed-axis-track">
              <div id="usb-freed-axis-yaw" class="usb-freed-axis-bar usb-freed-bar-yaw"></div>
            </div>
            <span id="usb-freed-yaw-val" class="usb-freed-axis-val">0\u00b0</span>
          </div>
          <div class="usb-freed-axis-row">
            <span class="usb-freed-axis-label usb-freed-pitch">Pitch</span>
            <div class="usb-freed-axis-track">
              <div id="usb-freed-axis-pitch" class="usb-freed-axis-bar usb-freed-bar-pitch"></div>
            </div>
            <span id="usb-freed-pitch-val" class="usb-freed-axis-val">0\u00b0</span>
          </div>
          <div class="usb-freed-axis-row">
            <span class="usb-freed-axis-label usb-freed-roll">Roll</span>
            <div class="usb-freed-axis-track">
              <div id="usb-freed-axis-roll" class="usb-freed-axis-bar usb-freed-bar-roll"></div>
            </div>
            <span id="usb-freed-roll-val" class="usb-freed-axis-val">0\u00b0</span>
          </div>
        </div>
        <div class="usb-freed-row usb-freed-axis-btns">
          <button id="usb-freed-inv-yaw" class="usb-freed-btn usb-freed-btn-sm">Inv Yaw</button>
          <button id="usb-freed-inv-pitch" class="usb-freed-btn usb-freed-btn-sm">Inv Pitch</button>
          <button id="usb-freed-swap" class="usb-freed-btn usb-freed-btn-sm">Swap</button>
        </div>

        <div class="usb-freed-section-label">Calibration</div>
        <div class="usb-freed-row">
          <label class="usb-freed-label">PPR</label>
          <input id="usb-freed-calib" type="range" min="10" max="200" step="1" value="${config.ppr}" class="usb-freed-slider">
          <span id="usb-freed-calib-val">${config.ppr}</span>
        </div>
        <div class="usb-freed-row">
          <button id="usb-freed-calib-test" class="usb-freed-btn usb-freed-btn-sm">Test 45\u00b0</button>
          <button id="usb-freed-calib-undo" class="usb-freed-btn usb-freed-btn-sm">Undo</button>
        </div>
        <div class="usb-freed-hint" id="usb-freed-calib-hint">
          Click "Test 45\u00b0" to inject a rotation. Adjust PPR until the model rotates exactly 45\u00b0.
        </div>

        <div class="usb-freed-section-label">Deadzone</div>
        <div class="usb-freed-row">
          <label class="usb-freed-label">Dead</label>
          <input id="usb-freed-deadzone" type="range" min="0" max="80" value="${Math.round(config.deadzone * 1000)}" class="usb-freed-slider">
          <span id="usb-freed-dz-val">${(config.deadzone * 180 / Math.PI).toFixed(1)}\u00b0</span>
        </div>

        <div id="usb-freed-data" class="usb-freed-data">No data</div>
        <div id="usb-freed-status" class="usb-freed-status">Disconnected</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Query elements
    connectBtn = panel.querySelector('#usb-freed-connect');
    enableBtn = panel.querySelector('#usb-freed-enable');
    modeBtn = panel.querySelector('#usb-freed-mode');
    const homeBtn = panel.querySelector('#usb-freed-home');
    axisYawBar = panel.querySelector('#usb-freed-axis-yaw');
    axisPitchBar = panel.querySelector('#usb-freed-axis-pitch');
    axisRollBar = panel.querySelector('#usb-freed-axis-roll');
    calibSlider = panel.querySelector('#usb-freed-calib');
    calibVal = panel.querySelector('#usb-freed-calib-val');
    const calibTestBtn = panel.querySelector('#usb-freed-calib-test');
    const calibUndoBtn = panel.querySelector('#usb-freed-calib-undo');
    const dzSlider = panel.querySelector('#usb-freed-deadzone');
    const dzVal = panel.querySelector('#usb-freed-dz-val');
    const invYawBtn = panel.querySelector('#usb-freed-inv-yaw');
    const invPitchBtn = panel.querySelector('#usb-freed-inv-pitch');
    const swapBtn = panel.querySelector('#usb-freed-swap');
    dataEl = panel.querySelector('#usb-freed-data');
    statusEl = panel.querySelector('#usb-freed-status');
    const minimizeBtn = panel.querySelector('.usb-freed-minimize');
    const body = panel.querySelector('.usb-freed-body');

    // Event handlers
    connectBtn.addEventListener('click', () => {
      if (port) disconnect(); else connect();
    });

    enableBtn.addEventListener('click', () => {
      enabled = !enabled;
      enableBtn.textContent = enabled ? 'ON' : 'OFF';
      enableBtn.classList.toggle('usb-freed-btn-active', enabled);
    });

    modeBtn.addEventListener('click', () => {
      mode = mode === 'orbit' ? 'pan' : 'orbit';
      modeBtn.textContent = mode === 'orbit' ? 'Orbit' : 'Pan';
    });

    homeBtn.addEventListener('click', () => {
      if (prevQuat) homeQuat = { ...prevQuat };
      prevQuat = null;
      liveYaw = 0; livePitch = 0; liveRoll = 0;
      updateAxisOverlay();
    });

    // Axis config buttons
    invYawBtn.addEventListener('click', () => {
      config.invertYaw = !config.invertYaw;
      invYawBtn.classList.toggle('usb-freed-btn-active', config.invertYaw);
      saveConfig();
    });
    invPitchBtn.addEventListener('click', () => {
      config.invertPitch = !config.invertPitch;
      invPitchBtn.classList.toggle('usb-freed-btn-active', config.invertPitch);
      saveConfig();
    });
    swapBtn.addEventListener('click', () => {
      config.swapAxes = !config.swapAxes;
      swapBtn.classList.toggle('usb-freed-btn-active', config.swapAxes);
      saveConfig();
    });

    // Restore button states from config
    invYawBtn.classList.toggle('usb-freed-btn-active', config.invertYaw);
    invPitchBtn.classList.toggle('usb-freed-btn-active', config.invertPitch);
    swapBtn.classList.toggle('usb-freed-btn-active', config.swapAxes);

    // Calibration
    calibSlider.addEventListener('input', () => {
      config.ppr = parseInt(calibSlider.value, 10);
      calibVal.textContent = config.ppr;
      saveConfig();
    });

    calibTestBtn.addEventListener('click', () => {
      const pixels = config.ppr * (Math.PI / 4);
      injectCalibrationDrag(Math.round(pixels));
      panel.querySelector('#usb-freed-calib-hint').textContent =
        'Injected ' + Math.round(pixels) + 'px drag. If model didn\u2019t rotate 45\u00b0, adjust PPR.';
    });

    calibUndoBtn.addEventListener('click', () => {
      const pixels = config.ppr * (Math.PI / 4);
      injectCalibrationDrag(-Math.round(pixels));
      panel.querySelector('#usb-freed-calib-hint').textContent =
        'Undone. Adjust PPR and test again.';
    });

    // Deadzone
    dzSlider.addEventListener('input', () => {
      config.deadzone = parseInt(dzSlider.value, 10) / 1000;
      dzVal.textContent = (config.deadzone * 180 / Math.PI).toFixed(1) + '\u00b0';
      saveConfig();
    });

    // Minimize
    minimizeBtn.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minimizeBtn.textContent = hidden ? '\u2212' : '+';
    });

    makeDraggable(panel, panel.querySelector('.usb-freed-header'));
  }

  function makeDraggable(el, handle) {
    let offsetX, offsetY, dragging = false;
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
    handle.addEventListener('pointerup', () => { dragging = false; });
  }

  // ======================== AXIS OVERLAY ========================

  function updateAxisOverlay() {
    if (!axisYawBar) return;

    const maxDeg = 90;
    const clamp = (v) => Math.max(-maxDeg, Math.min(maxDeg, v));

    const yawPct = (clamp(liveYaw) / maxDeg) * 50;
    const pitchPct = (clamp(livePitch) / maxDeg) * 50;
    const rollPct = (clamp(liveRoll) / maxDeg) * 50;

    setBarPosition(axisYawBar, yawPct);
    setBarPosition(axisPitchBar, pitchPct);
    setBarPosition(axisRollBar, rollPct);

    const yawValEl = panel.querySelector('#usb-freed-yaw-val');
    const pitchValEl = panel.querySelector('#usb-freed-pitch-val');
    const rollValEl = panel.querySelector('#usb-freed-roll-val');
    if (yawValEl) yawValEl.textContent = liveYaw.toFixed(0) + '\u00b0';
    if (pitchValEl) pitchValEl.textContent = livePitch.toFixed(0) + '\u00b0';
    if (rollValEl) rollValEl.textContent = liveRoll.toFixed(0) + '\u00b0';
  }

  function setBarPosition(bar, pct) {
    if (pct >= 0) {
      bar.style.left = '50%';
      bar.style.width = pct + '%';
    } else {
      bar.style.left = (50 + pct) + '%';
      bar.style.width = (-pct) + '%';
    }
  }

  // ======================== UI UPDATES ========================

  function updateUI(state) {
    if (state === 'connected') {
      connectBtn.textContent = 'Disconnect';
      connectBtn.classList.add('usb-freed-btn-danger');
      connectBtn.classList.remove('usb-freed-btn-connect');
      setStatus('Connected', '#4ade80');
    } else {
      connectBtn.textContent = 'Connect';
      connectBtn.classList.remove('usb-freed-btn-danger');
      connectBtn.classList.add('usb-freed-btn-connect');
      setStatus('Disconnected', '#f87171');
      if (dataEl) dataEl.textContent = 'No data';
    }
  }

  function setStatus(msg, color) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    if (color) statusEl.style.color = color;
  }

  function updateDataDisplay(pkt) {
    if (!dataEl) return;
    const batt =
      pkt.battery === 101 ? 'CHRG' :
      pkt.battery === 102 ? 'USB' :
      pkt.battery + '%';
    const flags = [];
    if (pkt.flags & FLAG_HOME_RESET) flags.push('HOME');
    if (pkt.flags & FLAG_TAP) flags.push('TAP');

    dataEl.textContent =
      'Q: ' + pkt.qw.toFixed(3) + ' ' + pkt.qx.toFixed(3) + ' ' + pkt.qy.toFixed(3) + ' ' + pkt.qz.toFixed(3) + '\n' +
      hz + 'Hz | Batt: ' + batt + ' | Err: ' + errorCount +
      (flags.length ? ' | ' + flags.join(' ') : '');

    setStatus('Connected \u2014 ' + mode + ' mode', '#4ade80');
  }

  // ======================== INIT ========================

  if (!navigator.serial) {
    console.warn('[USB_freeD] Web Serial API not available. Use Chrome or Edge.');
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { createPanel(); suppressContextMenu(); });
  } else {
    createPanel();
    suppressContextMenu();
  }

  console.log('[USB_freeD] Extension loaded on', window.location.hostname);
})();
