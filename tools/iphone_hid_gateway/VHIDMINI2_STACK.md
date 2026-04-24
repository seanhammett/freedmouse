# VHidMini2 Stack Integration (Specific Driver Target)

This integration targets a modified Microsoft VHidMini2 virtual HID driver.

## Stack

1. iPhone sender page -> gateway WebSocket input
2. gateway backend `spacemouse-udp` -> SpaceMouse report envelopes on UDP
3. `vhidmini2_ioctl_feeder.py` -> sends binary frames to driver IOCTL
4. Modified VHidMini2 driver -> injects HID input reports to Windows
5. 3DxWare / Onshape receives HID reports from virtual SpaceMouse device

## Driver-side contract (exact)

### Device identity

- VID: `0x256F`
- PID: `0xC631`
- Product: `SpaceMouse Pro Wireless`
- Manufacturer: `3Dconnexion`

### Report descriptor

Use the same report layout as `src/receiver.cpp`:

- Report ID 1: Translation (`X, Y, Z`) as 3 x int16
- Report ID 2: Rotation (`Rx, Ry, Rz`) as 3 x int16
- Report ID 3: Buttons as uint32 bitmask
- Axis logical range: `-350..350`

### Custom IOCTL

Define in driver (must match feeder):

- Name: `IOCTL_USBFREED_WRITE_REPORT`
- Value: `CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_WRITE_DATA)`
- Symbolic link path: `\\.\USBFreeDSpaceMouse`

### IOCTL input frame (exact binary format)

- `uint8 report_id`
- `uint8 payload_len`
- `uint8 payload[8]` (zero-padded)

Notes:

- For report ID 1 or 2, payload_len is `6` and payload is `<hhh` little-endian.
- For report ID 3, payload_len is `4` and payload is `<I` little-endian.
- Driver should reject payload_len > 8.

## Runtime commands

From `tools/iphone_hid_gateway`:

1. Start gateway in report mode:

```powershell
python gateway.py --config config.json --backend spacemouse-udp --udp-host 127.0.0.1 --udp-port 9998
```

2. Start feeder to VHidMini2:

```powershell
python vhidmini2_ioctl_feeder.py --host 127.0.0.1 --port 9998 --device-path "\\.\USBFreeDSpaceMouse"
```

3. Start ngrok for iPhone HTTPS:

```powershell
ngrok http 8765
```

## Validation

1. Start `spacemouse_report_debug.py` on port 9998 to confirm report envelopes.
2. Run `vhidmini2_ioctl_feeder.py`; verify it prints connected + sent counts.
3. In Device Manager / HID tools, confirm virtual device VID/PID is `256F:C631`.
4. In 3DxWare test panel, verify rotation axes move when phone rotates.

## Why this stack

- Specific, deterministic contract from Python feeder to driver.
- Preserves true SpaceMouse report IDs and payload sizes.
- Lets you keep current gateway and iPhone flow unchanged.
