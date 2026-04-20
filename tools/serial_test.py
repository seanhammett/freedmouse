"""
USB_freeD Serial Test Tool
Connects to the CodeCell C6 3D IMU Mouse and displays real-time orientation.

Usage:
  python serial_test.py              # auto-detect port
  python serial_test.py COM5         # specify port
  python serial_test.py /dev/ttyACM0 # Linux/macOS

Requirements:
  pip install pyserial numpy
"""

import sys
import struct
import time
import math
import serial
import serial.tools.list_ports

HEADER = 0xAA
PACKET_SIZE = 20
BAUD = 115200

def find_codecell_port():
    """Auto-detect CodeCell C6 serial port (Espressif VID 0x303A)."""
    ports = serial.tools.list_ports.comports()
    for p in ports:
        if p.vid == 0x303A:
            return p.device
        if p.description and "USB" in p.description.upper():
            return p.device
    if ports:
        return ports[0].device
    return None

def verify_checksum(data):
    """XOR checksum of bytes 1..18."""
    cs = 0
    for b in data[1:19]:
        cs ^= b
    return cs == data[19]

def decode_packet(data):
    """Decode 20-byte binary packet → (qw, qx, qy, qz, flags, battery)."""
    qw, qx, qy, qz = struct.unpack_from('<ffff', data, 1)
    flags = data[17]
    battery = data[18]
    return qw, qx, qy, qz, flags, battery

def quat_to_euler(w, x, y, z):
    """Convert quaternion to Euler angles (roll, pitch, yaw) in degrees."""
    # Roll (X)
    sinr = 2.0 * (w * x + y * z)
    cosr = 1.0 - 2.0 * (x * x + y * y)
    roll = math.atan2(sinr, cosr)

    # Pitch (Y)
    sinp = 2.0 * (w * y - z * x)
    sinp = max(-1.0, min(1.0, sinp))
    pitch = math.asin(sinp)

    # Yaw (Z)
    siny = 2.0 * (w * z + x * y)
    cosy = 1.0 - 2.0 * (y * y + z * z)
    yaw = math.atan2(siny, cosy)

    return math.degrees(roll), math.degrees(pitch), math.degrees(yaw)

def main():
    port = sys.argv[1] if len(sys.argv) > 1 else find_codecell_port()
    if not port:
        print("No serial port found. Specify one: python serial_test.py COM5")
        sys.exit(1)

    print(f"Connecting to {port} at {BAUD} baud...")
    ser = serial.Serial(port, BAUD, timeout=1)
    time.sleep(2)  # Wait for CodeCell boot
    ser.reset_input_buffer()
    print("Connected. Waiting for packets...\n")

    packet_count = 0
    error_count = 0
    start_time = time.time()
    buf = bytearray()

    try:
        while True:
            # Read available bytes
            incoming = ser.read(max(1, ser.in_waiting))
            buf.extend(incoming)

            # Scan for packets
            while len(buf) >= PACKET_SIZE:
                # Find header
                idx = buf.find(HEADER)
                if idx < 0:
                    buf.clear()
                    break
                if idx > 0:
                    buf = buf[idx:]  # discard bytes before header
                if len(buf) < PACKET_SIZE:
                    break

                raw = bytes(buf[:PACKET_SIZE])
                buf = buf[PACKET_SIZE:]

                if not verify_checksum(raw):
                    error_count += 1
                    continue

                qw, qx, qy, qz, flags, battery = decode_packet(raw)
                roll, pitch, yaw = quat_to_euler(qw, qx, qy, qz)
                packet_count += 1

                # Flag indicators
                flag_str = ""
                if flags & 0x01:
                    flag_str += " [HOME RESET]"
                if flags & 0x02:
                    flag_str += " [TAP]"

                # Battery display
                if battery == 101:
                    batt_str = "CHRG"
                elif battery == 102:
                    batt_str = "USB"
                else:
                    batt_str = f"{battery}%"

                elapsed = time.time() - start_time
                rate = packet_count / elapsed if elapsed > 0 else 0

                print(f"\rQ:[{qw:+.3f} {qx:+.3f} {qy:+.3f} {qz:+.3f}]  "
                      f"R:{roll:+6.1f}° P:{pitch:+6.1f}° Y:{yaw:+6.1f}°  "
                      f"Batt:{batt_str}  {rate:.0f}Hz  err:{error_count}{flag_str}    ",
                      end="", flush=True)

    except KeyboardInterrupt:
        print(f"\n\nStopped. {packet_count} packets, {error_count} errors.")
    finally:
        ser.close()

if __name__ == "__main__":
    main()
