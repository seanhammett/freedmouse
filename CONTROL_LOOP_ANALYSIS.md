# USB freeD — Closed-Loop Control Flow Analysis

## System Components

| Component | Hardware | Role |
|---|---|---|
| **Sender** | CodeCell C6 + BNO085 | Physical device. Reads absolute orientation quaternion, broadcasts over ESP-NOW at 100 Hz |
| **Receiver** | Arduino Nano ESP32 (S3) | Receives ESP-NOW quaternion, computes error, sends SpaceMouse HID rotation commands to PC |
| **Extension** | Chrome content script | Hooks WebGL in Onshape tab, reads viewport orientation, streams it back to receiver over USB-CDC serial at ~30 Hz |
| **3DxWare Driver** | Windows driver | Receives HID rotation reports, translates to Onshape camera rotation commands |
| **Onshape** | Browser app | Rotates the 3D viewport in response to SpaceMouse input |

---

## Signal Flow Diagram

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  PHYSICAL WORLD                                                  │
  │                                                                  │
  │  [User tilts device]                                             │
  │         │                                                        │
  │         ▼                                                        │
  │  BNO085 IMU → qDevice (absolute quat, 100 Hz)                   │
  └──────────────────────┬───────────────────────────────────────────┘
                         │ ESP-NOW 2.4GHz, ~10ms latency
                         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  RECEIVER (runs every ~10ms)                                     │
  │                                                                  │
  │  1. processSerialInput()   ← USB-CDC serial from Extension       │
  │     └─ if valid packet: slerp qView toward serialQuat            │
  │                                                                  │
  │  2. qTarget = qDevice * conj(qHome)   [rel. to home tap]        │
  │                                                                  │
  │  3. qError  = qTarget * conj(qView)   [how far off Onshape is]  │
  │                                                                  │
  │  4. angVel  = deltaToAngVel(qError)   [rad/frame]               │
  │                                                                  │
  │  5. EMA smooth angVel                                            │
  │                                                                  │
  │  6. HID report: smRx/Y/Z = angVel * ABS_ROT_SCALE (clamped ±350)│
  │                                                                  │
  │  7. qView += drScale * HID_command    [partial dead-reckoning]  │
  └──────────────────────┬───────────────────────────────────────────┘
                         │ USB HID (SpaceMouse report), <1ms
                         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  3DxWare DRIVER (Windows)                                        │
  │  Translates HID rotation report → mouse-like camera input        │
  └──────────────────────┬───────────────────────────────────────────┘
                         │ Windows input event
                         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  ONSHAPE (browser, ~16ms render frame)                           │
  │  Applies camera rotation, updates WebGL viewport matrix          │
  │  Total latency from HID report to rendered frame: ~100–200ms     │
  └──────────────────────┬───────────────────────────────────────────┘
                         │ WebGL uniformMatrix4fv hook
                         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  EXTENSION (Chrome content script, tick every 30ms)              │
  │  Reads viewport matrix, extracts quaternion, sends over serial   │
  │  Total latency from render to serial packet: ~30–60ms            │
  └──────────────────────┬───────────────────────────────────────────┘
                         │ USB-CDC serial, 115200 baud, ~1ms tx
                         ▼
                  [back to Receiver step 1]
```

---

## Timing Budget (one full loop iteration)

| Segment | Nominal latency |
|---|---|
| IMU → ESP-NOW → receiver | ~10 ms |
| Receiver loop (loop()) | ~1 ms |
| Receiver → HID report → 3DxWare | < 1 ms |
| 3DxWare → Onshape input event | ~5–20 ms (driver polling) |
| Onshape renders updated frame | ~16–50 ms (browser frame rate) |
| WebGL hook → extension reads matrix | ~0 ms (synchronous in same frame) |
| Extension tick cadence | 30 ms |
| Extension → serial packet → receiver | ~1 ms tx + up to 30 ms wait for next tick |
| **Total round-trip** | **~63–112 ms** |

---

## Where the Oscillation Comes From

### The fundamental problem: `qView` is guessed, not measured

`qView` is the receiver's model of "where Onshape currently is". The closed-loop correction is:

```
qError = qTarget * conj(qView)
```

If `qView` is wrong, `qError` is wrong, and the HID command is wrong.

The system has **two sources of `qView`** that fight each other:

1. **Dead-reckoning** (receiver): `qView += fraction * HID_command` — integrates each command forward, predicting where Onshape will end up.
2. **Serial feedback** (extension): `qView = slerp(qView, serialQuat, alpha)` — corrects qView toward what Onshape actually shows.

The loop gain must be critically assessed:

### Loop gain analysis

```
qError(t)   →   HID(t) = qError(t) * ABS_ROT_SCALE
            →   Onshape moves by HID(t) * (Onshape_gain) after ~100ms
            →   Extension reads new qView(t + 100ms)
            →   Receiver gets serial update
            →   qView jumps toward actual position
            →   qError(t + 100ms) = qTarget * conj(newQView)
```

If the HID command moved Onshape **past** the target during the 100ms blind window, `qError` reverses sign. This is a classic **proportional controller overshoot** in a time-delayed system. The criterion for oscillation:

```
loop_gain * round_trip_delay > ~0.5 (Nyquist-like)
```

The round-trip is 63–112ms. At 100ms, a system oscillates when the controller is fast enough to reverse direction within one period. The observed ~0.5–1s period corresponds exactly to a system with ~100–200ms round-trip delay and gain > 1.

### Specific mechanisms

**A. `VIEW_DEADRECK_SCALE` is unvalidated**  
The 4% figure assumes Onshape applies ~4% of a command per 10ms step (~100ms total latency). If the actual Onshape gain is different (higher or lower), dead-reckoning either overshoots or undershoots, and the serial correction each 30ms will always see a residual error — possibly phase-inverted.

**B. `SERIAL_BLEND_ALPHA = 0.78` is not rate-corrected**  
This blends 78% toward the serial ground truth per serial packet. At 30ms serial rate, that is a very aggressive correction. If the serial reading itself is slightly behind (captured before Onshape rendered the last command), the correction is toward the pre-command position, not the post-command one — driving oscillation.

**C. The HID command is velocity, not position**  
3DxWare treats the SpaceMouse as a velocity input (rotation rate). Onshape integrates it. The receiver is computing `qError` as if it were a position error and scaling it directly into a velocity command — this is proportional-only control with no integral windup protection and no velocity feedforward.

**D. Open-loop HID vs. closed-loop qView**  
Every 10ms, the receiver fires a HID velocity command. Onshape starts moving. But for the next 100ms, the extension can't tell the receiver how fast Onshape is actually responding, only where it ended up. During that window the receiver continues commanding the same velocity, overshooting the target.

---

## Proposed Architecture for Stable Control

### Option 1: Velocity damping (simplest fix, no structural change)

Replace the proportional gain with a **P+D** approach computed entirely inside the receiver:

```
smoothed_error = EMA(qError)          // P term
d_error = qError - prev_qError        // D term (error rate of change)
command = Kp * smoothed_error - Kd * d_error
```

The derivative term damps overshoot without needing the serial feedback for stability. Serial feedback provides drift correction only.

### Option 2: Decouple qView from dead-reckoning entirely

When serial is active:
- **Never** integrate HID commands into `qView`
- Accept that `qView` updates only at 30Hz from serial
- Lower `ABS_ROT_SCALE` so each command is small enough that Onshape moves only a fraction of the error per 100ms

This makes the loop gain-limited-stable at the cost of slower response.

### Option 3: Rate-limit correction mode (recommended)

The core insight is: **when the device is stationary, the target is fixed, so qError is constant — any oscillation is purely controller-induced**.

At rest, send **zero HID** if `qError` angle < threshold AND `qError` has been decreasing for the last N updates.

During motion, limit the HID command to a maximum angular velocity so Onshape cannot overshoot in the delay window.

```
max_step_rad = MAX_VEL_RAD_PER_SEC * 0.010  // per 10ms IMU frame
command = clamp(qError_angvel, -max_step_rad, max_step_rad)
```

### Option 4: Use qView = serialQuat directly, no dead-reckoning, and delay-compensate

At each serial update, note the timestamp. Assume Onshape will apply the last N HID commands over the next 100ms. Predict where `qView` will be when the next serial update arrives, and use that as the error reference.

This requires logging the last ~100ms of HID commands and integrating them as a trajectory — more complex but eliminates the phase error.

---

## Current Parameter Values (for reference)

```cpp
ABS_ROT_SCALE      = 800.0f    // HID command scale (rad → ±350 units)
DEADZONE_RAD       = 0.030f    // ~1.7° dead band
SMOOTH_ALPHA       = 0.28f     // EMA damping on error velocity
SERIAL_BLEND_ALPHA = 0.78f     // slerp fraction per serial update
VIEW_DEADRECK_SCALE = 0.04f    // fraction of HID command applied to qView per step
```

```js
// Extension
tick interval:             30 ms
serial send interval:      30 ms (rate-limited in publishOrientation)
fast scan interval:        25 ms (locked WebGL source)
```

---

## Key Questions to Answer Before Fixing

1. What is the actual Onshape camera response gain? (How many degrees does Onshape rotate per SpaceMouse unit per second?)
2. What is the actual driver polling rate (3DxWare)? Is it 30Hz, 60Hz, or 125Hz?
3. Does the oscillation disappear completely if serial is disconnected? (If yes, the dead-reckoning-only loop is stable and the problem is purely the serial feedback path.)
4. Does the oscillation disappear if `VIEW_DEADRECK_SCALE = 0` (serial only, no dead-reckoning)? (If yes, dead-reckoning overshoot is the cause.)
