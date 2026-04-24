from __future__ import annotations

import struct

FILE_DEVICE_UNKNOWN = 0x00000022
METHOD_BUFFERED = 0
FILE_WRITE_DATA = 0x0002

MAX_REPORT_PAYLOAD = 8


def ctl_code(device_type: int, function: int, method: int, access: int) -> int:
    return ((device_type << 16) | (access << 14) | (function << 2) | method)


# Must match the custom IOCTL implemented in the modified VHidMini2 driver.
IOCTL_USBFREED_WRITE_REPORT = ctl_code(
    FILE_DEVICE_UNKNOWN,
    0x801,
    METHOD_BUFFERED,
    FILE_WRITE_DATA,
)


def pack_report_frame(report_id: int, payload: bytes) -> bytes:
    """
    Frame format (exact):
      uint8 report_id
      uint8 payload_len
      uint8 payload[8]  // zero-padded
    """
    if report_id < 0 or report_id > 0xFF:
        raise ValueError("report_id must fit in uint8")

    if len(payload) > MAX_REPORT_PAYLOAD:
        raise ValueError(f"payload too large ({len(payload)}), max {MAX_REPORT_PAYLOAD}")

    padded = payload.ljust(MAX_REPORT_PAYLOAD, b"\x00")
    return struct.pack("<BB8s", report_id, len(payload), padded)
