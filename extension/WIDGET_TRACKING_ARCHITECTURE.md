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

Instead, use WebGL matrix/uniform updates as the primary source of truth.
Use DOM transform data from the cube element hierarchy as a secondary path when it is actually exposed.


## Recommended System Design

### 1. Source Discovery Layer

Create a dedicated discovery module that determines which orientation source is available in the current Onshape session.

Recommended approach:

1. Start from the known anchor region near the top-right corner.
2. Probe DOM/SVG descendants for transform-bearing nodes (css matrix3d(...) or SVG transform attributes).
3. Probe WebGL uniformMatrix4fv updates and keep rotation-like 4x4 candidates.
4. Keep only candidates correlated with the cube region and view interaction.
5. Rank candidates by:
   - Proximity to anchor center.
   - Transform persistence across frames.
   - Rotation-like matrix characteristics (orthonormal 3x3 block).
   - Correlation with camera orbit/snap actions.

Result: a locked Orientation Source object with:

- source type (webgl-uniform, css-matrix3d, semantic-dom)
- handle (uniform id/context or element reference)
- extraction method
- confidence
- last-valid timestamp


### 2. Orientation Extraction Layer (Primary)

Primary extraction should be WebGL matrix-based:

1. Intercept WebGL/WebGL2 uniformMatrix4fv uploads.
2. Identify rotation-like 4x4 matrices and lock to the best candidate by temporal stability and motion.
3. Extract the rotation block.
4. Re-orthonormalize basis vectors to remove numerical drift.
5. Convert matrix to quaternion.
6. Normalize quaternion each frame.
7. Apply optional inversion/convention mapping once and keep it fixed for the session.

Secondary extraction path (when available):

1. Read computed style transform.
2. Parse matrix3d into 4x4.
3. Apply the same rotation -> quaternion pipeline.

This is independent of color and hover because orientation data comes from scene transforms, not rendered pixel values.


### 3. Fallback Strategy (No Pixel Tracking)

If both WebGL and DOM matrix data are unavailable, use semantic DOM fallback only:

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
   "strategy": "webgl-uniform-matrix4fv",
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

Orientation extraction is based on WebGL/transform matrices, not color values. Overlaying the cube over any viewport color does not affect orientation readout.

### Hover Independence

Hover changes fill, highlights, and visible labels, but does not alter the camera/view rotation state used by the matrix source. Matrix tracking remains stable through hover transitions.


## Validated Finding In Current Onshape Session

Observed behavior from live inspection:

- The cube bounds container and ancestor chain did not expose CSS/SVG transform matrices.
- The cube region overlapped the main `canvas#canvas`.
- WebGL uniform probes showed high-frequency rotation-like matrix updates correlated with orbit motion.

Conclusion:

- For this environment, WebGL matrix/uniform extraction is the reliable primary orientation source.
- DOM matrix extraction remains useful as an optional path for builds that expose cube transforms in DOM.


## Implementation Plan

### Phase 1 - Stabilize Orientation Source

1. Split current content script into modules:
   - source discovery
   - webgl matrix extraction
   - optional DOM matrix extraction
   - quaternion math
   - panel and preview
2. Promote WebGL extraction to strict primary strategy.
3. Keep DOM matrix extraction as automatic secondary path.
4. Disable pixel fallback behind a debug flag.

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
   - WebGL-rendered cube sessions and DOM-exposed cube sessions


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
- Add/keep: WebGL uniform matrix capture and source locking.
- Keep: css matrix extraction path as secondary.
- Reduce or remove in production: legacy pixel probe path.
- Treat label-based methods as temporary degraded fallback only.


## Practical Recommendation

Best long-term architecture for this extension:

- WebGL-matrix-first orientation tracking.
- DOM-matrix secondary path when available.
- Semantic fallback only.
- No pixel dependency in production.
- Explicit confidence and stale-state model.
- Quaternion as the canonical output for both telemetry and preview rendering.

This approach directly addresses the issues shown in your screenshots and is the most robust path for a production widget tracker.
