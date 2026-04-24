# iPhone IMU Gateway (Phase 1)

This toolchain lets an iPhone act as the IMU sender while keeping existing firmware files unchanged.

- No changes were made to `src/sender.cpp` or `src/receiver.cpp`.
- The gateway ports the quaternion control loop from `src/receiver.cpp`.
- Output backends included now:
  - `console`: prints SpaceMouse-style rotation commands (`rx`, `ry`, `rz`) in the same `[-350, 350]` range.
  - `udp`: sends legacy rotation JSON packets (`rotation`/`zero`) to a local UDP port.
  - `spacemouse-udp`: sends 3Dconnexion-formatted HID report packets (`reportId` + payload hex) over UDP.

## What this milestone includes

1. iPhone Safari page that captures orientation and streams quaternions over WebSocket.
2. Host gateway that receives IMU packets, performs home-reset/deadzone/smoothing/clamp logic, and emits rotation commands.
3. Stale-timeout safety (zero output if packets stop).
4. Telemetry (`hz`, dropped/reordered packet counters, current command) back to connected clients.

## Files

- `gateway.py`: WebSocket server + control loop runtime
- `quat_control.py`: quaternion control behavior ported from receiver logic
- `hid_backends.py`: output backend interface (`console`, `udp`)
- `spacemouse_protocol.py`: report ID constants and exact SpaceMouse report packing
- `web/iphone_sender.html`: iPhone sender UI
- `config.example.json`: sample settings

## Run

1. Install dependencies:

```powershell
pip install -r tools/iphone_hid_gateway/requirements.txt
```

2. Optional config:

```powershell
copy tools/iphone_hid_gateway/config.example.json tools/iphone_hid_gateway/config.json
```

3. Start gateway:

```powershell
python tools/iphone_hid_gateway/gateway.py --config tools/iphone_hid_gateway/config.json
```

4. On iPhone (same LAN), open:

```text
http://<PC-LAN-IP>:8765
```

5. Tap:
- `Connect`
- `Enable Motion` (accept iOS permission)
- `Start Stream`

## iPhone Motion Permission with HTTPS Tunnel

Some iOS versions require a secure origin for motion sensors. If motion permission is denied on LAN HTTP, use an HTTPS tunnel.

### Option A: Cloudflare Quick Tunnel (no account)

1. Keep the gateway running locally on port 8765.
2. Install cloudflared (Windows):

```powershell
winget install Cloudflare.cloudflared
```

3. Start tunnel:

```powershell
cloudflared tunnel --url http://localhost:8765
```

4. Copy the `https://<random>.trycloudflare.com` URL shown in the terminal.
5. Open that HTTPS URL in Safari on iPhone.
6. Tap `Connect` then `Enable Motion`.

Notes:
- The sender page now auto-selects `wss://` when served over HTTPS.
- Keep the tunnel terminal open while testing.

### Option B: ngrok (account/token required)

1. Install ngrok.
2. Set auth token once:

```powershell
ngrok config add-authtoken <YOUR_TOKEN>
```

3. Start tunnel:

```powershell
ngrok http 8765
```

4. Open the generated `https://...ngrok-free.app` URL on iPhone.

## IMU packet format (phone -> gateway)

```json
{
  "type": "imu",
  "seq": 42,
  "quat": { "w": 0.99, "x": 0.01, "y": -0.12, "z": 0.03 },
  "flags": 0
}
```

Notes:
- `seq` is treated as uint8 (`0..255` wrap).
- `home` message triggers reset semantics equivalent to tap/home reset in firmware.

## UDP backend payload (gateway -> feeder)

Rotation update:

```json
{ "type": "rotation", "rx": 123, "ry": -45, "rz": 12 }
```

Idle/timeout stop:

```json
{ "type": "zero" }
```

## SpaceMouse UDP report payload (gateway -> feeder)

When backend is `spacemouse-udp`, gateway emits exact SpaceMouse report packets as JSON envelopes:

```json
{
  "type": "spacemouse_report",
  "vendorId": 9583,
  "productId": 50737,
  "manufacturer": "3Dconnexion",
  "product": "SpaceMouse Pro Wireless",
  "reportId": 2,
  "payloadHex": "2c00d4ff0800"
}
```

Report IDs:
- `1`: Translation (`x,y,z` as int16 little-endian)
- `2`: Rotation (`rx,ry,rz` as int16 little-endian)
- `3`: Buttons (`uint32` bitmask)

## Next step for direct Onshape control

Implement a Windows virtual HID feeder that consumes UDP payloads and emits a multi-axis HID device profile compatible with your target CAD input stack.

This repository now provides the transport and control-loop half of that path.

This repo now also provides a SpaceMouse HID report transport contract for the final virtual HID endpoint.

## SpaceMouse report mode (recommended for HID work)

Use this mode to emit exact SpaceMouse HID report bytes from the gateway:

```powershell
python tools/iphone_hid_gateway/gateway.py --config tools/iphone_hid_gateway/config.json --backend spacemouse-udp --udp-host 127.0.0.1 --udp-port 9998
```

### Debug listener for report bytes

```powershell
python tools/iphone_hid_gateway/spacemouse_report_debug.py --host 127.0.0.1 --port 9998
```

### Named-pipe feeder for virtual HID endpoint service

If you have a virtual HID endpoint service exposing `\\.\pipe\usb_freed_spacemouse`, feed reports into it:

```powershell
python tools/iphone_hid_gateway/spacemouse_pipe_feeder.py --host 127.0.0.1 --port 9998 --pipe "\\.\pipe\usb_freed_spacemouse"
```

Optional framing flag if the endpoint expects length-prefixed frames:

```powershell
python tools/iphone_hid_gateway/spacemouse_pipe_feeder.py --host 127.0.0.1 --port 9998 --pipe "\\.\pipe\usb_freed_spacemouse" --frame-with-length
```

## Specific virtual HID stack: VHidMini2

This repo now includes an explicit driver contract and feeder for a modified Microsoft VHidMini2 stack.

Summary:

1. Gateway emits SpaceMouse report envelopes (`spacemouse-udp`).
2. `vhidmini2_ioctl_feeder.py` converts envelopes into fixed binary IOCTL frames.
3. Modified VHidMini2 driver injects HID input reports to Windows.

Detailed contract and driver requirements are in:

- `VHIDMINI2_STACK.md`

### Run sequence (VHidMini2 path)

1. Gateway:

```powershell
python tools/iphone_hid_gateway/gateway.py --config tools/iphone_hid_gateway/config.json --backend spacemouse-udp --udp-host 127.0.0.1 --udp-port 9998
```

2. Feeder to driver IOCTL endpoint:

```powershell
python tools/iphone_hid_gateway/vhidmini2_ioctl_feeder.py --host 127.0.0.1 --port 9998 --device-path "\\.\USBFreeDSpaceMouse"
```

3. ngrok:

```powershell
ngrok http 8765
```

4. Open ngrok HTTPS URL on iPhone and stream as usual.

## Next step now: UDP to vJoy bridge

This repo now includes a quick bridge for Windows virtual controller testing:

- `vjoy_bridge.py` listens for gateway UDP payloads and maps rotation to vJoy axes.
  It now supports both legacy `rotation` packets and `spacemouse_report` packets (report ID 2).

### Prerequisites

1. Install vJoy driver (v2.1.x) and configure one enabled virtual device.
2. Install Python deps:

```powershell
python -m pip install -r tools/iphone_hid_gateway/requirements.txt
```

### Run sequence (3 terminals)

1. Terminal A - Gateway with UDP backend:

```powershell
python tools/iphone_hid_gateway/gateway.py --config tools/iphone_hid_gateway/config.json --backend udp --udp-host 127.0.0.1 --udp-port 9999
```

2. Terminal B - vJoy bridge:

```powershell
python tools/iphone_hid_gateway/vjoy_bridge.py --host 127.0.0.1 --port 9999 --device-id 1
```

3. Terminal C - ngrok tunnel:

```powershell
ngrok http 8765
```

Then open the ngrok HTTPS URL on iPhone and start streaming.

### Notes

- This bridge targets rapid validation and maps to vJoy axes (`RX`, `RY`, `RZ`).
- It is not yet a native 3Dconnexion-identifying HID device.
- For strict SpaceMouse identity, a dedicated virtual HID driver path is still needed.
