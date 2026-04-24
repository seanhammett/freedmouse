from __future__ import annotations

import json
import socket
from abc import ABC, abstractmethod
from dataclasses import dataclass

from spacemouse_protocol import (
    MANUFACTURER_NAME,
    PRODUCT_ID_SPACEMOUSE_PRO_WIRELESS,
    PRODUCT_NAME,
    VENDOR_ID_3DCONNEXION,
    make_rotation_report,
    make_translation_report,
)


class HidBackend(ABC):
    @abstractmethod
    def send_rotation(self, rx: int, ry: int, rz: int) -> None:
        raise NotImplementedError

    @abstractmethod
    def send_zero(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        return


class ConsoleBackend(HidBackend):
    def __init__(self) -> None:
        self._last = (None, None, None)

    def send_rotation(self, rx: int, ry: int, rz: int) -> None:
        curr = (rx, ry, rz)
        if curr != self._last:
            print(f"[HID] rot rx={rx:4d} ry={ry:4d} rz={rz:4d}")
            self._last = curr

    def send_zero(self) -> None:
        self.send_rotation(0, 0, 0)


@dataclass
class UdpBackend(HidBackend):
    host: str
    port: int

    def __post_init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send_rotation(self, rx: int, ry: int, rz: int) -> None:
        payload = {
            "type": "rotation",
            "rx": rx,
            "ry": ry,
            "rz": rz,
        }
        self._sock.sendto(json.dumps(payload).encode("utf-8"), (self.host, self.port))

    def send_zero(self) -> None:
        payload = {
            "type": "zero",
        }
        self._sock.sendto(json.dumps(payload).encode("utf-8"), (self.host, self.port))

    def close(self) -> None:
        self._sock.close()


@dataclass
class SpaceMouseReportUdpBackend(HidBackend):
    host: str
    port: int
    send_translation_zero: bool = True

    def __post_init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def _send_report(self, report_id: int, payload: bytes) -> None:
        msg = {
            "type": "spacemouse_report",
            "vendorId": VENDOR_ID_3DCONNEXION,
            "productId": PRODUCT_ID_SPACEMOUSE_PRO_WIRELESS,
            "manufacturer": MANUFACTURER_NAME,
            "product": PRODUCT_NAME,
            "reportId": report_id,
            "payloadHex": payload.hex(),
        }
        self._sock.sendto(json.dumps(msg).encode("utf-8"), (self.host, self.port))

    def send_rotation(self, rx: int, ry: int, rz: int) -> None:
        if self.send_translation_zero:
            t = make_translation_report(0, 0, 0)
            self._send_report(t.report_id, t.payload)

        r = make_rotation_report(rx, ry, rz)
        self._send_report(r.report_id, r.payload)

    def send_zero(self) -> None:
        t = make_translation_report(0, 0, 0)
        r = make_rotation_report(0, 0, 0)
        self._send_report(t.report_id, t.payload)
        self._send_report(r.report_id, r.payload)

    def close(self) -> None:
        self._sock.close()
