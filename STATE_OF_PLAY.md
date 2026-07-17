# USB_freeD — State of Play

_Updated 2026-07-17_

## What this is

A closed-loop 3D mouse for Onshape. A CodeCell C6 (ESP32-C6 + BNO085) **sender**
streams absolute orientation over ESP-NOW to an ESP32-S3-DevKitC **receiver**,
which spoofs a 3Dconnexion SpaceMouse Pro Wireless over USB HID. A Chrome
extension (`extension/`) reads Onshape's true camera orientation by hooking
WebGL uniforms and streams it to the receiver over Web Serial as ground truth.
The receiver runs a proportional controller: point the device, the model
follows, absolutely (not rate control).

Goal feature: physical device orientation maps 1:1 to model orientation.

## Architecture

```
sender (C6+BNO085) --ESP-NOW ch1, 100Hz, 20B quat pkt--> receiver (S3)
                                                          |  USB composite:
                                                          |  HID (VID 256F/PID C631) -> 3DxWare -> Onshape
                                                          |  CDC serial <-> Chrome extension
extension: WebGL hook -> camera quat --19B target pkt--> receiver (closed loop)
           receiver "TL,..." telemetry + "CAL,..." markers --> extension diag recorder
```

Key files: `src/sender.cpp`, `src/receiver.cpp`, `src/espnow_packet.h`,
`src/target_packet.h`, `extension/content.js`, `tools/analyze_cal.js`,
`extension/tests/` (sim_watcher.js + replay_diag.js regression suites).
Captures live in `diagnostics/` (JSON from the panel's "Record diag").

## What works (verified)

- **Extension stream lock**: motion-signature classification picks the right
  WebGL camera stream, survives multiplexed/settle-only decoys. 34+9
  regression checks. Panel shows live orientation + `loop✓` when receiver
  telemetry is flowing.
- **RF link**: ESP-NOW at ~100Hz, per-boot ID lets the receiver detect sender
  reboots and re-anchor home (no view swing). `[RX]` stats at 1Hz on both CDC
  and UART0 (second USB connector = independent debug console).
- **USB robustness**: task watchdog (4s, panic+backtrace to UART0), USB
  detach pulse on crash reboots so the Mac re-enumerates, CDC output through
  a 4KB software ring (see gotchas). Receiver survived USB stalls in the
  last soak without crashing.
- **Telemetry loop**: extension→receiver targets (~34Hz = Onshape render
  rate, 20Hz heartbeat when static) and receiver→extension `TL` telemetry
  both flow; one diag JSON captures the whole system for offline analysis.
- **Plant calibration**: panel "Cal motion" button runs a ~41s open-loop HID
  staircase on the receiver (auto-records 55s); `node tools/analyze_cal.js
  diagnostics/<file>.json` fits the HID→velocity curve, dead time, and
  rotation axes.

## Measured facts (cal runs 2026-07-17, two reproducible captures)

- **Axis map** (the big one): HID x → view +x, HID y → view **+z**,
  HID z → view **−y**. Constant at every orientation (coherence 1.00, all 24
  phases). The old feel-tuned INVERT constants fought this permutation —
  that cross-coupling was the 2–5Hz oscillation.
- **Gain**: ~0.48°/s per HID unit (linear to ~200 units, ~0.7 at 350;
  350 units ≈ 240°/s).
- **Dead time**: ~58ms command→motion (+ ~45ms EMA smoothing lag).
- **Driver deadband**: below ~150 HID units (~7°/s) the response is erratic,
  sometimes zero. Solid at 200+.

## Current firmware state (built, FLASHED BUT NOT YET FIELD-TESTED)

`src/receiver.cpp` as of 2026-07-17: measured axis map `(hidX,hidY,hidZ) =
(rx, rz, −ry)`, ABS_ROT_SCALE ≈ 119 units per rad/s, **Kp = 5.0**
(stability product ≈ 0.5), hysteresis deadzone 1.5°/0.6°, EMA α 0.40.

## Next steps

1. **Test tracking with the fixed axis map + Kp=5.** Expect: no oscillation
   at any orientation, ~3× faster response. If oscillation returns, capture
   a diag — TL telemetry now records everything needed to diagnose offline.
2. **Device→screen alignment.** The physical axes may feel permuted now
   (the old INVERTs partially compensated the bad map). Fix = one constant
   alignment quaternion between BNO085 frame and view frame. To measure:
   record a ~20s diag slowly rotating the device one axis at a time; fit
   from TL's simultaneous qDev/qView.
3. **Small-error settling.** The <150-unit driver deadband may make final
   approach ratchet or stall ~2–8° short. If so: pulse-burst small
   corrections (short 200-unit bursts instead of sustained 50s).
4. **Drift**: pitch/roll are gravity-anchored (no drift); yaw is
   magnetometer-anchored and wanders indoors — physical limit of the BNO085.
   Tap-to-rehome is the mitigation (tap detector already wired).
5. **Top speed**: capped by 3DxWare's per-app Speed slider; raise it in the
   Onshape profile and re-run Cal motion to remeasure the curve.

## Hardware/bring-up gotchas (hard-won, don't rediscover)

- **Receiver flashing**: 1200-baud CDC touch does NOT reset this S3 board.
  Hold BOOT + press RESET, and disconnect the extension's Web Serial first
  (Chrome holds the port; auto-reconnect grabs it back aggressively).
- **CDC TX FIFO is 64 bytes** (prebuilt Arduino libs). Never print directly
  to USBSerial from loop code — a full line never fits (silently dropped)
  and `USBCDC::write()` spins forever on a full FIFO if the host stalls
  (`setTxTimeoutMs(0)` does NOT prevent this). Always use
  `cdcPrintf()`/`cdcPump()` in receiver.cpp.
- **Panic reboots don't reset the USB PHY** — host won't re-enumerate.
  receiver.cpp pulses D+/D− (GPIO 19/20) low at boot after a crash reset.
- **ESP-NOW packet is 20 bytes** (incl. per-boot ID). Sender and receiver
  must be flashed from the same tree or the receiver rejects everything
  (`pkts=0`).
- Receiver CDC port = `/dev/cu.usbmodem90E5B1CE1CD42`; UART0 debug console
  is the board's second USB connector (`/dev/cu.usbserial-*`).
- 3DxWare wedges after screen lock sometimes (Onshape unresponsive while the
  3Dconnexion Viewer works): `killall 3DconnexionHelper`, relaunch, reload
  the Onshape tab.
- Sender boot-looping (3–7s gaps, `sboot` climbing in `[RX]` stats) is a
  power problem (battery low / flaky USB), not firmware.

## Workflow reminders

- Build/flash: `pio run -e receiver -t upload` / `-e sender -t upload`.
- Extension tests: `cd extension && node tests/sim_watcher.js &&
  node tests/replay_diag.js`.
- Extension build tag shows in the panel and in every capture
  (`watcher-2026-07-17c-cal-heartbeat` current).
- Capture workflow: connect Serial (`loop✓`), click "Record diag" (or "Cal
  motion" which records automatically), save JSON into `diagnostics/`.
