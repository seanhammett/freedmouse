from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import deque
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from hid_backends import ConsoleBackend, HidBackend, SpaceMouseReportUdpBackend, UdpBackend
from quat_control import FLAG_HOME_RESET, FLAG_TAP, ImuSample, RotationCommand, SpaceMouseControlLoop


class GatewayState:
    def __init__(self, backend: HidBackend, stale_timeout_ms: int, control_rate_hz: int) -> None:
        self.backend = backend
        self.stale_timeout_ms = stale_timeout_ms
        self.control_rate_hz = control_rate_hz

        self.controller = SpaceMouseControlLoop()

        self.clients: set[web.WebSocketResponse] = set()
        self.last_recv_ms = 0.0
        self.last_output_nonzero = False
        self.last_cmd = RotationCommand(0, 0, 0)
        self.sample_times_ms: deque[float] = deque()
        self.pending_home_reset = False

    def dispatch_rotation(self, cmd: RotationCommand) -> None:
        nonzero = (cmd.rx != 0) or (cmd.ry != 0) or (cmd.rz != 0)
        if nonzero:
            self.backend.send_rotation(cmd.rx, cmd.ry, cmd.rz)
            self.last_output_nonzero = True
        elif self.last_output_nonzero:
            self.backend.send_zero()
            self.last_output_nonzero = False

        self.last_cmd = cmd

    def force_zero(self) -> None:
        if self.last_output_nonzero:
            self.backend.send_zero()
            self.last_output_nonzero = False
            self.last_cmd = RotationCommand(0, 0, 0)

    def note_sample_time(self, now_ms: float) -> None:
        self.sample_times_ms.append(now_ms)
        cutoff = now_ms - 1000.0
        while self.sample_times_ms and self.sample_times_ms[0] < cutoff:
            self.sample_times_ms.popleft()

    def hz(self) -> int:
        return len(self.sample_times_ms)

    def telemetry(self) -> dict[str, Any]:
        return {
            "type": "telemetry",
            "hz": self.hz(),
            "lastCmd": {
                "rx": self.last_cmd.rx,
                "ry": self.last_cmd.ry,
                "rz": self.last_cmd.rz,
            },
            "droppedPackets": self.controller.dropped_packet_count,
            "outOfOrderPackets": self.controller.out_of_order_packet_count,
            "lastRecvMsAgo": round(max(0.0, time.perf_counter() * 1000.0 - self.last_recv_ms), 2)
            if self.last_recv_ms > 0
            else None,
        }


def _load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}

    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="USB_freeD iPhone IMU gateway")
    parser.add_argument("--config", default="config.json", help="Path to JSON config file")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--backend", choices=["console", "udp", "spacemouse-udp"], default=None)
    parser.add_argument("--udp-host", default=None)
    parser.add_argument("--udp-port", type=int, default=None)
    parser.add_argument("--stale-timeout-ms", type=int, default=None)
    parser.add_argument("--control-rate-hz", type=int, default=None)
    return parser.parse_args()


def _resolve_settings(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.config)
    cfg = _load_config(config_path)

    def pick(arg_name: str, cfg_name: str, default: Any) -> Any:
        arg_val = getattr(args, arg_name)
        if arg_val is not None:
            return arg_val
        if cfg_name in cfg:
            return cfg[cfg_name]
        return default

    return {
        "host": pick("host", "host", "0.0.0.0"),
        "port": int(pick("port", "port", 8765)),
        "backend": pick("backend", "backend", "console"),
        "udp_target_host": pick("udp_host", "udpTargetHost", "127.0.0.1"),
        "udp_target_port": int(pick("udp_port", "udpTargetPort", 9999)),
        "stale_timeout_ms": int(pick("stale_timeout_ms", "staleTimeoutMs", 80)),
        "control_rate_hz": int(pick("control_rate_hz", "controlRateHz", 100)),
    }


def _make_backend(settings: dict[str, Any]) -> HidBackend:
    if settings["backend"] == "spacemouse-udp":
        return SpaceMouseReportUdpBackend(settings["udp_target_host"], settings["udp_target_port"])
    if settings["backend"] == "udp":
        return UdpBackend(settings["udp_target_host"], settings["udp_target_port"])
    return ConsoleBackend()


def _extract_quat(payload: dict[str, Any]) -> tuple[float, float, float, float]:
    quat = payload.get("quat")
    if isinstance(quat, dict):
        return (
            float(quat["w"]),
            float(quat["x"]),
            float(quat["y"]),
            float(quat["z"]),
        )

    return (
        float(payload["qw"]),
        float(payload["qx"]),
        float(payload["qy"]),
        float(payload["qz"]),
    )


async def _broadcast_telemetry(state: GatewayState) -> None:
    if not state.clients:
        return

    msg = json.dumps(state.telemetry())
    dead_clients: list[web.WebSocketResponse] = []
    for ws in state.clients:
        try:
            await ws.send_str(msg)
        except Exception:
            dead_clients.append(ws)

    for ws in dead_clients:
        state.clients.discard(ws)


async def _ws_handler(request: web.Request) -> web.WebSocketResponse:
    state: GatewayState = request.app["state"]

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    state.clients.add(ws)

    await ws.send_json({
        "type": "hello",
        "message": "Connected to USB_freeD iPhone gateway",
    })

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue

            try:
                payload = json.loads(msg.data)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = payload.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong", "t": time.time()})
                continue

            if msg_type == "home":
                state.pending_home_reset = True
                await ws.send_json({"type": "ack", "message": "Home reset queued"})
                await _broadcast_telemetry(state)
                continue

            if msg_type != "imu":
                await ws.send_json({"type": "error", "message": f"Unknown message type: {msg_type}"})
                continue

            try:
                qw, qx, qy, qz = _extract_quat(payload)
            except (KeyError, TypeError, ValueError):
                await ws.send_json({"type": "error", "message": "Missing quaternion fields"})
                continue

            flags = int(payload.get("flags", 0)) & 0xFF
            if payload.get("homeReset"):
                flags |= FLAG_HOME_RESET | FLAG_TAP
            if state.pending_home_reset:
                flags |= FLAG_HOME_RESET | FLAG_TAP
                state.pending_home_reset = False

            seq = int(payload.get("seq", 0)) & 0xFF
            now_ms = time.perf_counter() * 1000.0

            sample = ImuSample(
                qw=qw,
                qx=qx,
                qy=qy,
                qz=qz,
                flags=flags,
                seq=seq,
                recv_ms=now_ms,
            )

            cmd = state.controller.process_sample(sample)
            state.dispatch_rotation(cmd)
            state.last_recv_ms = now_ms
            state.note_sample_time(now_ms)

    finally:
        state.clients.discard(ws)

    return ws


async def _index_handler(request: web.Request) -> web.FileResponse:
    web_dir = Path(__file__).resolve().parent / "web"
    return web.FileResponse(web_dir / "iphone_sender.html")


async def _health_handler(request: web.Request) -> web.Response:
    state: GatewayState = request.app["state"]
    return web.json_response(state.telemetry())


async def _watchdog_task(app: web.Application) -> None:
    state: GatewayState = app["state"]
    telemetry_period_ms = 1000.0 / max(1, min(30, state.control_rate_hz))
    last_telemetry_ms = 0.0

    while True:
        await asyncio.sleep(1.0 / max(1, state.control_rate_hz))
        now_ms = time.perf_counter() * 1000.0

        if state.last_recv_ms > 0 and (now_ms - state.last_recv_ms) > state.stale_timeout_ms:
            state.force_zero()

        if (now_ms - last_telemetry_ms) >= telemetry_period_ms:
            await _broadcast_telemetry(state)
            last_telemetry_ms = now_ms


async def _on_startup(app: web.Application) -> None:
    app["watchdog"] = asyncio.create_task(_watchdog_task(app))


async def _on_cleanup(app: web.Application) -> None:
    watchdog = app.get("watchdog")
    if watchdog is not None:
        watchdog.cancel()
        try:
            await watchdog
        except asyncio.CancelledError:
            pass

    state: GatewayState = app["state"]
    state.force_zero()
    state.backend.close()


def main() -> None:
    args = _parse_args()
    settings = _resolve_settings(args)

    backend = _make_backend(settings)
    state = GatewayState(
        backend=backend,
        stale_timeout_ms=settings["stale_timeout_ms"],
        control_rate_hz=settings["control_rate_hz"],
    )

    app = web.Application()
    app["state"] = state

    app.router.add_get("/", _index_handler)
    app.router.add_get("/health", _health_handler)
    app.router.add_get("/ws", _ws_handler)

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    print("=== USB_freeD iPhone IMU Gateway ===")
    print(f"Listen: http://{settings['host']}:{settings['port']}")
    print(f"Backend: {settings['backend']}")
    if settings["backend"] in {"udp", "spacemouse-udp"}:
        print(f"UDP target: {settings['udp_target_host']}:{settings['udp_target_port']}")

    web.run_app(app, host=settings["host"], port=settings["port"])


if __name__ == "__main__":
    main()
