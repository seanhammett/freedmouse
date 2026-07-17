#!/usr/bin/env python
# Monitor raw HID input reports from the USB_freeD receiver (spoofed
# SpaceMouse Pro Wireless). Proves whether rotation/translation reports are
# reaching the host, independent of the 3Dconnexion driver and viewer.
#
# Run with PlatformIO's python (hidapi installed there):
#   ~/.platformio/penv/bin/python tools/hid_monitor.py
#
# Expected while rotating the sender: "rot rx=... ry=... rz=..." lines.
# Silence while the sender moves = reports are not being generated (check the
# receiver's [RX] serial stats to see whether ESP-NOW packets arrive at all).
import struct
import sys
import time

try:
    import hid
except ImportError:
    sys.exit("hidapi not installed — run: ~/.platformio/penv/bin/pip install hidapi")

VID, PID = 0x256F, 0xC631

path = None
for d in hid.enumerate(VID, PID):
    if d["usage_page"] == 1 and d["usage"] == 8:  # Multi-axis Controller
        path = d["path"]
        break
if path is None:
    sys.exit("receiver not found (VID 0x256F PID 0xC631, usage 8) — is it plugged in?")

dev = hid.device()
dev.open_path(path)
dev.set_nonblocking(False)
print("listening on", path.decode(), "— rotate the sender; Ctrl-C to stop")

count = 0
t0 = time.time()
try:
    while True:
        r = dev.read(16, timeout_ms=1000)
        if not r:
            continue
        count += 1
        kind = {1: "tra", 2: "rot", 3: "btn"}.get(r[0], "?%d" % r[0])
        if r[0] in (1, 2) and len(r) >= 7:
            x, y, z = struct.unpack_from("<hhh", bytes(r), 1)
            print("%7.2fs %s x=%+4d y=%+4d z=%+4d  (#%d)" % (time.time() - t0, kind, x, y, z, count))
        else:
            print("%7.2fs %s %s  (#%d)" % (time.time() - t0, kind, bytes(r[1:]).hex(), count))
except KeyboardInterrupt:
    pass
print("total reports:", count)
