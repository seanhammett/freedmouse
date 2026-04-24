from __future__ import annotations

import struct
from dataclasses import dataclass

VENDOR_ID_3DCONNEXION = 0x256F
PRODUCT_ID_SPACEMOUSE_PRO_WIRELESS = 0xC631
PRODUCT_NAME = "SpaceMouse Pro Wireless"
MANUFACTURER_NAME = "3Dconnexion"

REPORT_ID_TRANSLATION = 0x01
REPORT_ID_ROTATION = 0x02
REPORT_ID_BUTTONS = 0x03


@dataclass(frozen=True)
class SpaceMouseReport:
    report_id: int
    payload: bytes


def _clamp_axis(v: int) -> int:
    if v > 350:
        return 350
    if v < -350:
        return -350
    return v


def make_translation_report(x: int, y: int, z: int) -> SpaceMouseReport:
    payload = struct.pack("<hhh", _clamp_axis(x), _clamp_axis(y), _clamp_axis(z))
    return SpaceMouseReport(REPORT_ID_TRANSLATION, payload)


def make_rotation_report(rx: int, ry: int, rz: int) -> SpaceMouseReport:
    payload = struct.pack("<hhh", _clamp_axis(rx), _clamp_axis(ry), _clamp_axis(rz))
    return SpaceMouseReport(REPORT_ID_ROTATION, payload)


def make_buttons_report(button_mask: int) -> SpaceMouseReport:
    payload = struct.pack("<I", button_mask & 0xFFFFFFFF)
    return SpaceMouseReport(REPORT_ID_BUTTONS, payload)
