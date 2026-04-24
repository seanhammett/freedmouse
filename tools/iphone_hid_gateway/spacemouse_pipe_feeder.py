from __future__ import annotations

import argparse
import json
import socket


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Feed SpaceMouse UDP reports into a Windows named pipe endpoint")
    parser.add_argument("--host", default="127.0.0.1", help="UDP listen host")
    parser.add_argument("--port", type=int, default=9998, help="UDP listen port")
    parser.add_argument(
        "--pipe",
        default=r"\\.\pipe\usb_freed_spacemouse",
        help="Named pipe path exposed by a virtual HID endpoint service",
    )
    parser.add_argument(
        "--frame-with-length",
        action="store_true",
        help="Prefix each frame with uint16 little-endian payload length",
    )
    return parser.parse_args()


def _frame(report_id: int, payload: bytes, with_length: bool) -> bytes:
    body = bytes([report_id]) + payload
    if not with_length:
        return body

    length = len(body)
    if length > 0xFFFF:
        raise ValueError("Report frame too large")
    return length.to_bytes(2, "little") + body


def main() -> None:
    args = _parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))

    print("=== SpaceMouse named-pipe feeder ===")
    print(f"UDP listen: {args.host}:{args.port}")
    print(f"Pipe path: {args.pipe}")

    # For named pipes in Python on Windows, open as a file path in binary mode.
    # The server side must already have created the pipe instance.
    while True:
        with open(args.pipe, "wb", buffering=0) as pipe:
            print("[INFO] Connected to named pipe endpoint")
            while True:
                data, _addr = sock.recvfrom(4096)
                try:
                    msg = json.loads(data.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue

                if msg.get("type") != "spacemouse_report":
                    continue

                try:
                    report_id = int(msg["reportId"]) & 0xFF
                    payload = bytes.fromhex(msg["payloadHex"])
                except (KeyError, TypeError, ValueError):
                    continue

                framed = _frame(report_id, payload, args.frame_with_length)
                pipe.write(framed)


if __name__ == "__main__":
    main()
