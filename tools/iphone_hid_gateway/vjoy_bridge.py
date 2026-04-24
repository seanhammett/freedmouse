from __future__ import annotations

import argparse
import json
import socket
import struct
import time


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="USB_freeD UDP to vJoy bridge")
    parser.add_argument("--host", default="127.0.0.1", help="UDP listen host")
    parser.add_argument("--port", type=int, default=9999, help="UDP listen port")
    parser.add_argument("--device-id", type=int, default=1, help="vJoy device id")
    parser.add_argument(
        "--source-max",
        type=float,
        default=350.0,
        help="Absolute max input magnitude from gateway",
    )
    parser.add_argument("--invert-rx", action="store_true")
    parser.add_argument("--invert-ry", action="store_true")
    parser.add_argument("--invert-rz", action="store_true")
    return parser.parse_args()


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _to_vjoy_axis(value: float, src_abs_max: float) -> int:
    # vJoy axis range is [1, 32768], center ~16384.
    ratio = _clamp(value / src_abs_max, -1.0, 1.0)
    return int(round(((ratio + 1.0) * 0.5) * 32767.0 + 1.0))


def main() -> None:
    try:
        import pyvjoy
    except ImportError as exc:
        raise SystemExit(
            "pyvjoy is not installed. Run: python -m pip install -r tools/iphone_hid_gateway/requirements.txt"
        ) from exc

    args = _parse_args()

    vj = pyvjoy.VJoyDevice(args.device_id)

    axis_map = {
        "rx": pyvjoy.HID_USAGE_RX,
        "ry": pyvjoy.HID_USAGE_RY,
        "rz": pyvjoy.HID_USAGE_RZ,
    }

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((args.host, args.port))
    sock.settimeout(1.0)

    print("=== USB_freeD vJoy Bridge ===")
    print(f"Listening UDP on {args.host}:{args.port}")
    print(f"vJoy device id: {args.device_id}")
    print("Waiting for gateway rotation packets...")

    last_print = 0.0

    def send_center() -> None:
        center = _to_vjoy_axis(0.0, args.source_max)
        vj.set_axis(axis_map["rx"], center)
        vj.set_axis(axis_map["ry"], center)
        vj.set_axis(axis_map["rz"], center)

    send_center()

    while True:
        try:
            raw, _addr = sock.recvfrom(4096)
        except socket.timeout:
            continue

        try:
            msg = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue

        msg_type = msg.get("type")
        if msg_type == "spacemouse_report":
            try:
                report_id = int(msg.get("reportId", 0))
                payload = bytes.fromhex(msg.get("payloadHex", ""))
            except (TypeError, ValueError):
                continue

            # Rotation report: ID 2, 3 x int16 little-endian.
            if report_id != 0x02 or len(payload) != 6:
                continue

            rx, ry, rz = struct.unpack("<hhh", payload)
        else:
            if msg_type == "zero":
                send_center()
                continue
            if msg_type != "rotation":
                continue

            rx = float(msg.get("rx", 0.0))
            ry = float(msg.get("ry", 0.0))
            rz = float(msg.get("rz", 0.0))

        if args.invert_rx:
            rx = -rx
        if args.invert_ry:
            ry = -ry
        if args.invert_rz:
            rz = -rz

        vj.set_axis(axis_map["rx"], _to_vjoy_axis(rx, args.source_max))
        vj.set_axis(axis_map["ry"], _to_vjoy_axis(ry, args.source_max))
        vj.set_axis(axis_map["rz"], _to_vjoy_axis(rz, args.source_max))

        now = time.time()
        if now - last_print > 0.25:
            print(f"rx={rx:7.1f} ry={ry:7.1f} rz={rz:7.1f}")
            last_print = now


if __name__ == "__main__":
    main()
