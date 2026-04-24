from __future__ import annotations

import argparse
import ctypes
import json
import socket
from ctypes import wintypes

from vhidmini2_contract import IOCTL_USBFREED_WRITE_REPORT, pack_report_frame

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x00000080
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Feed SpaceMouse UDP reports into a VHidMini2 virtual HID device")
    parser.add_argument("--host", default="127.0.0.1", help="UDP listen host")
    parser.add_argument("--port", type=int, default=9998, help="UDP listen port")
    parser.add_argument(
        "--device-path",
        default=r"\\.\USBFreeDSpaceMouse",
        help="Driver symbolic link path exposed by VHidMini2",
    )
    parser.add_argument(
        "--print-every",
        type=int,
        default=40,
        help="Print one status line every N accepted reports",
    )
    return parser.parse_args()


def _open_device(kernel32: ctypes.WinDLL, device_path: str) -> wintypes.HANDLE:
    handle = kernel32.CreateFileW(
        device_path,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )
    return handle


def _device_io_control(kernel32: ctypes.WinDLL, handle: wintypes.HANDLE, frame: bytes) -> None:
    bytes_returned = wintypes.DWORD(0)
    ok = kernel32.DeviceIoControl(
        handle,
        IOCTL_USBFREED_WRITE_REPORT,
        frame,
        len(frame),
        None,
        0,
        ctypes.byref(bytes_returned),
        None,
    )
    if not ok:
        err = ctypes.get_last_error()
        raise OSError(err, f"DeviceIoControl failed ({err})")


def main() -> None:
    args = _parse_args()

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))

    print("=== USB_freeD VHidMini2 IOCTL feeder ===")
    print(f"UDP listen: {args.host}:{args.port}")
    print(f"Device path: {args.device_path}")

    sent = 0

    while True:
        handle = _open_device(kernel32, args.device_path)
        if handle == INVALID_HANDLE_VALUE:
            err = ctypes.get_last_error()
            print(f"[WARN] Could not open device ({err}); retrying...")
            sock.settimeout(1.0)
            try:
                sock.recvfrom(4096)
            except socket.timeout:
                pass
            continue

        try:
            print("[INFO] Connected to VHidMini2 device")
            while True:
                raw, _addr = sock.recvfrom(4096)
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue

                if msg.get("type") != "spacemouse_report":
                    continue

                try:
                    report_id = int(msg["reportId"]) & 0xFF
                    payload = bytes.fromhex(msg["payloadHex"])
                except (KeyError, TypeError, ValueError):
                    continue

                try:
                    frame = pack_report_frame(report_id, payload)
                except ValueError:
                    continue

                try:
                    _device_io_control(kernel32, handle, frame)
                except OSError as exc:
                    print(f"[WARN] {exc}; reconnecting...")
                    break

                sent += 1
                if args.print_every > 0 and sent % args.print_every == 0:
                    print(f"[OK] Sent {sent} reports")
        finally:
            kernel32.CloseHandle(handle)


if __name__ == "__main__":
    main()
