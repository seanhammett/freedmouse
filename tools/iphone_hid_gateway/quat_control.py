from __future__ import annotations

import math
from dataclasses import dataclass

FLAG_HOME_RESET = 0x01
FLAG_TAP = 0x02


@dataclass
class ImuSample:
    qw: float
    qx: float
    qy: float
    qz: float
    flags: int
    seq: int
    recv_ms: float


@dataclass
class RotationCommand:
    rx: int
    ry: int
    rz: int


class SpaceMouseControlLoop:
    """Port of src/receiver.cpp quaternion control behavior for host-side use."""

    def __init__(
        self,
        abs_rot_scale: float = 8000.0,
        deadzone_rad: float = 0.005,
        smooth_alpha: float = 0.75,
        invert_roll: float = -1.0,
        invert_pitch: float = 1.0,
        invert_yaw: float = -1.0,
    ) -> None:
        self.abs_rot_scale = abs_rot_scale
        self.deadzone_rad = deadzone_rad
        self.smooth_alpha = smooth_alpha
        self.invert_roll = invert_roll
        self.invert_pitch = invert_pitch
        self.invert_yaw = invert_yaw

        self.q_home = (1.0, 0.0, 0.0, 0.0)
        self.q_view = (1.0, 0.0, 0.0, 0.0)
        self.has_home = False
        self.motion_active = False

        self.smooth_rx = 0.0
        self.smooth_ry = 0.0
        self.smooth_rz = 0.0

        self.has_last_seq = False
        self.last_seq = 0
        self.dropped_packet_count = 0
        self.out_of_order_packet_count = 0

    @staticmethod
    def _quat_norm(q: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        w, x, y, z = q
        n = math.sqrt(w * w + x * x + y * y + z * z)
        if n > 1e-9:
            return (w / n, x / n, y / n, z / n)
        return q

    @staticmethod
    def _quat_mul(
        a: tuple[float, float, float, float],
        b: tuple[float, float, float, float],
    ) -> tuple[float, float, float, float]:
        aw, ax, ay, az = a
        bw, bx, by, bz = b
        return (
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        )

    @staticmethod
    def _quat_delta(
        current: tuple[float, float, float, float],
        prev: tuple[float, float, float, float],
    ) -> tuple[float, float, float, float]:
        # q_delta = current * conj(prev)
        cw, cx, cy, cz = current
        pw, px, py, pz = prev
        return (
            cw * pw + cx * px + cy * py + cz * pz,
            -cw * px + cx * pw - cy * pz + cz * py,
            -cw * py + cx * pz + cy * pw - cz * px,
            -cw * pz - cx * py + cy * px + cz * pw,
        )

    @staticmethod
    def _delta_to_ang_vel(
        d: tuple[float, float, float, float],
    ) -> tuple[float, float, float]:
        dw, dx, dy, dz = d
        if dw < 0:
            dw = -dw
            dx = -dx
            dy = -dy
            dz = -dz

        sin_half = math.sqrt(dx * dx + dy * dy + dz * dz)
        if sin_half < 1e-7:
            return (0.0, 0.0, 0.0)

        angle = 2.0 * math.atan2(sin_half, dw)
        scale = angle / sin_half
        return (dx * scale, dy * scale, dz * scale)

    @staticmethod
    def _ang_vel_to_quat(rx: float, ry: float, rz: float) -> tuple[float, float, float, float]:
        angle = math.sqrt(rx * rx + ry * ry + rz * rz)
        if angle < 1e-9:
            return (1.0, 0.0, 0.0, 0.0)

        sin_half = math.sin(angle * 0.5)
        return (
            math.cos(angle * 0.5),
            rx / angle * sin_half,
            ry / angle * sin_half,
            rz / angle * sin_half,
        )

    def _to_sm(self, value: float) -> int:
        v = value * self.abs_rot_scale
        if v > 350.0:
            v = 350.0
        if v < -350.0:
            v = -350.0
        return int(v)

    def _sequence_is_stale(self, seq: int) -> bool:
        stale = False
        if self.has_last_seq:
            expected = (self.last_seq + 1) & 0xFF
            delta = ((seq - expected + 128) & 0xFF) - 128
            if delta > 0:
                self.dropped_packet_count += delta
            elif delta < 0:
                self.out_of_order_packet_count += 1
                stale = True

        self.has_last_seq = True
        self.last_seq = seq
        return stale

    def process_sample(self, sample: ImuSample) -> RotationCommand:
        if self._sequence_is_stale(sample.seq):
            return RotationCommand(0, 0, 0)

        q_device = self._quat_norm((sample.qw, sample.qx, sample.qy, sample.qz))

        # Match receiver semantics: tap (or first sample) resets home and view.
        if (sample.flags & FLAG_TAP) or (not self.has_home):
            self.q_home = q_device
            self.q_view = (1.0, 0.0, 0.0, 0.0)
            self.smooth_rx = 0.0
            self.smooth_ry = 0.0
            self.smooth_rz = 0.0
            self.has_home = True
            self.motion_active = False
            return RotationCommand(0, 0, 0)

        q_target = self._quat_norm(self._quat_delta(q_device, self.q_home))
        q_error = self._quat_norm(self._quat_delta(q_target, self.q_view))

        rx, ry, rz = self._delta_to_ang_vel(q_error)

        ang_mag = math.sqrt(rx * rx + ry * ry + rz * rz)
        if ang_mag < self.deadzone_rad:
            rx, ry, rz = 0.0, 0.0, 0.0

        self.smooth_rx = self.smooth_alpha * rx + (1.0 - self.smooth_alpha) * self.smooth_rx
        self.smooth_ry = self.smooth_alpha * ry + (1.0 - self.smooth_alpha) * self.smooth_ry
        self.smooth_rz = self.smooth_alpha * rz + (1.0 - self.smooth_alpha) * self.smooth_rz

        sm_rx = self._to_sm(self.invert_roll * self.smooth_rx)
        sm_ry = self._to_sm(self.invert_pitch * self.smooth_ry)
        sm_rz = self._to_sm(self.invert_yaw * self.smooth_rz)

        cmd_rx = self.invert_roll * (float(sm_rx) / self.abs_rot_scale)
        cmd_ry = self.invert_pitch * (float(sm_ry) / self.abs_rot_scale)
        cmd_rz = self.invert_yaw * (float(sm_rz) / self.abs_rot_scale)

        q_step = self._ang_vel_to_quat(cmd_rx, cmd_ry, cmd_rz)
        self.q_view = self._quat_norm(self._quat_mul(q_step, self.q_view))

        self.motion_active = (sm_rx != 0) or (sm_ry != 0) or (sm_rz != 0)
        return RotationCommand(sm_rx, sm_ry, sm_rz)
