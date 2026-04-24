from __future__ import annotations

import argparse
import json
import socket


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Debug listener for SpaceMouse report UDP stream")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9998)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))

    print("=== SpaceMouse report debug listener ===")
    print(f"Listening on {args.host}:{args.port}")

    while True:
        data, _addr = sock.recvfrom(4096)
        try:
            msg = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue

        if msg.get("type") != "spacemouse_report":
            continue

        rid = msg.get("reportId")
        payload_hex = msg.get("payloadHex", "")
        print(f"reportId={rid} payload={payload_hex}")


if __name__ == "__main__":
    main()
