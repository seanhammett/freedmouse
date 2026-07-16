# Widget Tracking Chrome Extension - Recommended Architecture

## Goal

Build a Chrome extension that reliably tracks the Onshape view cube orientation and exposes:

- Stable orientation tracking that does not depend on viewport background color.
- Stable orientation tracking that does not break when hover highlights change cube appearance.
- Quaternion output for external consumers.
- A simple reconstructed 3D orientation preview.

The key design choice is to stop treating this as an image-recognition problem.


## Core Principle

Track geometry and transforms, not pixels.

Pixel sampling is inherently fragile because it depends on:

- Scene colors behind the cube.
- Hover highlight overlays.
- Anti-aliasing and GPU rendering differences.
- Zoom and DPI scaling.

Instead, use DOM transform data from the cube element hierarchy as the primary source of truth.


## Recommended System Design

### 1. Source Discovery Layer

Create a dedicated discovery module that finds the cube root and transform-bearing descendants.

Recommended approach:

1. Start from the known anchor region near the top-right corner.
2. Search for elements whose computed transform is matrix3d(...).
3. Keep only candidates within the cube bounds neighborhood.
4. Rank candidates by:
   - Proximity to anchor center.
   - Transform persistence across frames.
   - Rotation-like matrix characteristics (orthonormal 3x3 block).

Result: a locked Orientation Source object with:

- element reference
- extraction method
- confidence
- last-valid timestamp


### 2. Orientation Extraction Layer (Primary)

Primary extraction should be matrix-based:

1. Read computed style transform.
2. Parse matrix3d into 4x4.
3. Extract the rotation block.
4. Re-orthonormalize basis vectors to remove numerical drift.
5. Convert matrix to quaternion.
6. Normalize quaternion each frame.

This is independent of color and hover because transforms stay valid when visual styling changes.


### 3. Fallback Strategy (No Pixel Tracking)

If matrix data disappears, use semantic DOM fallback only:

- SVG or HTML label geometry (X, Y, Z or face labels) for temporary recovery.
- Keep this as lower confidence and short-lived.

Do not use canvas RGB probing as a fallback in production mode.

Reason: it directly violates the requirement to be independent of background and hover appearance.


### 4. Temporal Filtering and State

Use a state machine with explicit validity windows.

States:

- searching
- tracking
- stale
- degraded
- lost

Per-frame data model:

- timestamp
- raw quaternion
- filtered quaternion
- strategy id
- confidence
- stale age ms

Filtering:

- Use shortest-arc quaternion blending.
- Keep smoothing configurable.
- Clamp outlier jumps with angular velocity thresholds.


### 5. Quaternion API and Telemetry Output

Publish orientation through a clear interface:

- Internal bus event: orientation:update
- Window debug hook for manual inspection
- Optional external bridge for native serial forwarding

Suggested payload:

```json
{
  "timestamp": 1713870000000,
  "quat": { "w": 0.9921, "x": 0.0152, "y": -0.1214, "z": 0.0201 },
  "eulerDeg": { "yaw": -13.9, "pitch": -1.8, "roll": 1.6 },
  "strategy": "css-matrix3d",
  "confidence": 0.97,
  "stale": false
}
```


### 6. Reconstructed 3D View

Render a simple orientation preview from the quaternion only.

Implementation notes:

- Use a small canvas in the extension panel.
- Build a unit cube and XYZ axes in model space.
- Rotate points by quaternion-derived matrix.
- Project with fixed perspective.
- Draw faces back-to-front, then edges and axis lines.

Critical requirement: this preview must never read pixels from Onshape. It should be a pure reconstruction from tracked orientation data.


## Why This Solves the Current Failure Modes

### Background Independence

Transform extraction is based on DOM geometry and CSS transforms, not color values. Overlaying the cube over any viewport color does not affect orientation readout.

### Hover Independence

Hover changes fill, highlights, and visible labels, but does not typically alter the cube's underlying 3D orientation transform. Matrix tracking remains stable through hover transitions.


## Implementation Plan

### Phase 1 - Stabilize Orientation Source

1. Split current content script into modules:
   - source discovery
   - matrix extraction
   - quaternion math
   - panel and preview
2. Promote matrix extraction to strict primary strategy.
3. Disable pixel fallback behind a debug flag.

### Phase 2 - State and Output Contract

1. Introduce explicit tracker state machine.
2. Define one canonical orientation payload schema.
3. Add watchdog timers for stale and lost transitions.

### Phase 3 - Preview and Validation

1. Keep preview fully quaternion-driven.
2. Add diagnostic overlay (strategy, confidence, age).
3. Run stress tests:
   - hover sweep over all cube faces
   - light and dark model backgrounds
   - fast orbit and snap-to-face actions


## Acceptance Criteria

The implementation is done when all are true:

1. Orientation remains stable while hovering over any cube face.
2. Orientation remains stable across different model and viewport colors.
3. Quaternion updates continuously during orbit and view snaps.
4. Preview orientation matches the Onshape cube orientation directionally.
5. No production path depends on canvas pixel sampling.


## Suggested Refactor Targets In This Project

Current script already has strong quaternion math and preview drawing. Keep those.

Refactor emphasis:

- Keep: quaternion normalization, lerp, matrix conversion, preview renderer.
- Keep: css matrix extraction path.
- Reduce or remove in production: legacy pixel probe path.
- Treat label-based methods as temporary degraded fallback only.


## Practical Recommendation

Best long-term architecture for this extension:

- Matrix-first orientation tracking.
- Semantic fallback only.
- No pixel dependency in production.
- Explicit confidence and stale-state model.
- Quaternion as the canonical output for both telemetry and preview rendering.

This approach directly addresses the issues shown in your screenshots and is the most robust path for a production widget tracker.


## WebGL Source Selection (2026-07 revision)

The WebGL uniform-matrix path is the high-rate primary source. Selection is
deliberately **sticky and activity-scored**; CSS cross-checking exists only as
passive telemetry.

### Hard-won field lessons (do not regress these)

1. **The CSS view-cube `matrix3d` is NOT reliable ground truth.** On at least
   one machine it stays frozen during an orbit and only updates when the view
   settles. A 31s field capture on that machine recorded **zero** CSS samples.
   Any logic that *gates or unlocks* the WebGL stream based on CSS agreement
   will fight the correct stream during motion (constant unlock →
   CSS-fallback → frozen output). CSS-derived metrics are telemetry only.
2. **A live locked stream must never be second-guessed by external
   references.** The 50ms fast path reads the locked matrix and publishes —
   no DOM work, no arbitration. Any periodic full scan while locked causes
   visible jank (document-wide selectors + hundreds of getComputedStyle calls
   force layout). The one exception is the *intrinsic* motion-signature check
   (below): a stream that carries identity writes or per-object jumps is
   definitionally not the camera, and is evicted by the in-memory
   housekeeping pass.
3. **locIds are machine-specific AND session-specific.** They're assigned by
   WebGL-call encounter order; hard-coded hints (the old `u_6`/`u_7`) lock
   the wrong stream on other platforms, and a persisted `locHint` points at a
   random stream on the next reload. Never match a saved fingerprint by
   locId.
4. **Uniform names cannot disambiguate on Onshape.** The field capture showed
   ALL 21 rotation streams named `uMVMatrix` (plus `uPMatrix` projections).
   Name nudges are at best a cross-app tiebreak; selection must work with
   every candidate sharing one name.

### Field capture 2026-07-15 (tests/fixtures/diag-mac-2026-07-15.json)

The in-extension diagnostic recorder ("Record diag" button /
`usbFreeDWidgetWatcher.startDiagnostic()`) captured every stream during a
scripted protocol (idle → orbit → idle → snap Front → snap Top). Three stream
classes emerged, separated by orders of magnitude:

| class | example | changes/frame | step size | identity writes |
|---|---|---|---|---|
| **camera cluster** (7 streams, identical histories) | `u_3,u_5,u_6,u_7,u_f,u_g,u_h` | ~1 | ~3°, smooth | **zero** |
| per-object model-view multiplex | `u_4,u_8,u_9,u_a` | up to 286/bin | ~65° jumps | thousands |
| settle-only overlays | `u_1,u_m..u_r` | 4–5 per *minute* | ~90° snaps | zero |

The camera's **motion signature** is machine-independent physics: a real
camera changes once per frame, in small smooth steps, and is never the
identity (the camera can't sit at the model origin). This is the selection
principle — no CSS, no names, no machine hints.

### Motion-signature gates (selector v2)

Per candidate, the uniform hook accumulates `idCalls` (identity uploads),
`stepCount`/`jumpCount` (per-change rotation steps, jump = >20°). Hard
disqualifiers (never auto-locked, `-Infinity` score):

- `identity-writes`: >5% of uploads are the identity → overlay-multiplexed.
- `jumpy`: >30% of steps exceed 20° → per-object stream hopping between poses.

A qualified smooth stream (≥20 steps, zero identity, <5% jumps) gets a score
bonus. A locked stream that later reveals a bad signature is evicted by the
900ms housekeeping pass as soon as a qualified candidate exists — frame-final
publishing can make a multiplexed stream *look* right (the camera-linked
object happens to be drawn last), but that is draw-order luck, not identity.
An explicit dropdown pin still bypasses all gates (user override).

Both gates identify their class within a couple of frames of interaction, so
a wrong first lock at drag-start is corrected in under a second (verified in
the replay below: wrong for 0.8s, then camera cluster for the rest of the
session).

**Frozen-lock takeover** covers the class the gates can't: settle-only
overlay streams (`u_1`-class) change too rarely to trip the jump gate, and
they keep RECEIVING repeat uploads, so they are never "dead" — locked to one,
the widget updates only on drag release. This trap is reachable via
mid-session relocks: idle >8s prunes unlocked candidates (stats and all), and
if the camera stream goes quiet >5.2s while an overlay stream stays alive,
dead-lock recovery can land on the overlay. The takeover rule: if the locked
stream hasn't *changed* for >1.2s while another qualified stream is changing
at render rate (≥8 changes in its 1s window, last change <400ms old), the
moving stream takes the lock. It cannot flap — at rest nothing changes at
high rate, and a correctly locked camera never freezes while something else
moves. Pins bypass this like every other gate.

### Regression workflow — never hand-tune selection again

`node extension/tests/replay_diag.js` re-synthesizes every stream from the
field capture's binned stats and asserts: camera cluster locked during the
first orbit, never left afterwards, all multiplexed streams disqualified,
output tracks the locked stream. Any selector change must keep this replay
green. To cover a new machine or a new Onshape rendering path: run "Record
diag" there, drop the JSON into `tests/fixtures/`, identify the camera
cluster offline (identical rotation histories + 1 change/frame + zero
identity), and point the replay at it.

### How a source gets locked

1. `uniformMatrix4fv` is hooked on both WebGL prototypes. All upload forms are
   recorded: plain 16-float uploads, WebGL2 `srcOffset`/`srcLength` views into
   larger arrays, mat4[] batches (first matrix taken), and `transpose: true`
   uploads (transposed back before storage). Matrices whose 3x3 block is not
   near-orthonormal are rejected.
2. While unlocked, full scans (220ms) score candidates by activity (changes,
   calls, ortho quality, anchor overlap, continuity) after applying the
   motion-signature gates above, and lock the best. Streams that fail the
   gates can never win, no matter their traffic.
3. A persisted fingerprint (uniform name + canvas size, saved when the user
   pins a source) is tried before scoring on every relock. Note its limits on
   Onshape: names are shared and canvas size changes with the window, so
   auto-selection via the signature gates is the primary path; the
   fingerprint never matches by locId (session-specific).
4. A dropdown pin (session-exact locId) bypasses all scoring and all gates.

### While locked

- **Push mode (real-time path)**: a change on the locked stream schedules an
  end-of-frame microtask that publishes the settled frame-final matrix,
  capped at `PUSH_MIN_INTERVAL_MS` (~66 Hz). Output therefore tracks the
  page's own render rate during a drag — this is the path closed-loop
  feedback rides. The publish MUST be deferred to end-of-frame, never done
  synchronously per write: a uniform location is multiplexed across draw
  passes within one frame (Onshape writes identity for overlay passes and
  the camera matrix for the model pass to the SAME uniform), so per-write
  publishing flickers between identity and the real orientation. The panel
  shows the live publish rate in Hz; ~0 Hz during a drag means the locked
  stream is not actually live (wrong stream, or a stale pin/saved
  preference — both are flagged in the panel note).
- The 50ms fast-path tick remains as a heartbeat/fallback: read matrix,
  convert, smooth, publish.
- Every `WEBGL_LOCK_RECHECK_MS`, cheap housekeeping runs alongside it:
  - **Telemetry**: one getComputedStyle on the cached CSS reference element
    updates per-candidate `trk` (co-rotation: did the stream rotate by the
    same angle as the reference — offset-invariant) and `fit` (absolute
    |quat dot|) EMAs, shown in the dropdown and `dumpWebglSources()`. Samples
    only accrue while the reference moves, so static streams can't fake it.
  - **Dead-stream recovery**: if the locked uniform stopped being uploaded
    for > 2×TTL while other streams are active, relock to the best live one
    (in-memory stats only). A pinned source is re-grabbed when it returns.
    This replaces the old build's minutes-long wait on dead streams.

### Diagnosing a wrong auto-pick

Orbit for a few seconds, then run `usbFreeDWidgetWatcher.dumpWebglSources()`:
the stream with `coRot ≈ 1` is camera-linked; `agree ≈ 1` marks the pure view
matrix. Pin it from the dropdown — the fingerprint makes it permanent.
