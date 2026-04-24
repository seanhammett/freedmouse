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
