// USB_freeD — 3D IMU Mouse
// CodeCell C6 (ESP32-C6 + BNO085) firmware
// Streams absolute orientation quaternions over USB Serial at 100Hz
// Chrome extension reads via Web Serial API to control Onshape viewport

#include <Arduino.h>
#include <CodeCell.h>
#include "packet.h"

// =================== CONFIG ===================
static const uint8_t STREAM_RATE_HZ = 100;
static const unsigned long STATUS_INTERVAL_MS = 5000;

// =================== GLOBALS ===================
CodeCell myCodeCell;
ImuPacket pkt;

bool homeResetPending = false;
unsigned long lastStatusTime = 0;
unsigned long packetCount = 0;

// =================== SETUP ===================
void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n=== USB_freeD — 3D IMU Mouse ===");
  Serial.println("CodeCell C6 + BNO085 | Quaternion streaming over USB Serial");

  // Initialize CodeCell with full rotation vector (includes magnetometer for absolute yaw)
  // Also enable tap detection for home-reset gesture
  myCodeCell.Init(MOTION_ROTATION + MOTION_TAP_DETECTOR);
  Serial.println("[OK] CodeCell initialized (BNO085: rotation + tap)");

  myCodeCell.LED(0, 30, 0);  // Green = ready
  Serial.printf("[OK] Streaming at %d Hz — tap device to reset home\n\n", STREAM_RATE_HZ);
}

// =================== MAIN LOOP ===================
void loop() {
  if (myCodeCell.Run(STREAM_RATE_HZ)) {

    // Check for tap gesture → home reset
    uint8_t flags = 0;
    if (myCodeCell.Motion_TapDetectorRead()) {
      flags |= FLAG_HOME_RESET | FLAG_TAP;
      homeResetPending = true;
      myCodeCell.LED(0, 0, 40);  // Blue flash = home reset
    }

    // Read quaternion (rotation vector with magnetometer)
    float qw, qx, qy, qz;
    myCodeCell.Motion_RotationVectorRead(qw, qx, qy, qz);

    // If home reset was just triggered, flag it for one packet
    if (homeResetPending) {
      flags |= FLAG_HOME_RESET;
      homeResetPending = false;
    }

    // Battery level
    uint8_t battery = (uint8_t)myCodeCell.BatteryLevelRead();

    // Build and send binary packet
    buildPacket(pkt, qw, qx, qy, qz, flags, battery);
    Serial.write(reinterpret_cast<const uint8_t*>(&pkt), PACKET_SIZE);

    packetCount++;

    // Restore LED to green after tap flash
    if (flags & FLAG_TAP) {
      // LED will be reset to green on next non-tap cycle by CodeCell.Run()
    }

    // Periodic human-readable status on a second line (for debug via serial monitor)
    if (millis() - lastStatusTime >= STATUS_INTERVAL_MS) {
      lastStatusTime = millis();
      // Send as a text line that won't be confused with binary packets
      // (starts with '#', not 0xAA)
      char status[128];
      snprintf(status, sizeof(status),
               "\n# Q:[%+.3f %+.3f %+.3f %+.3f] Batt:%d Pkts:%lu\n",
               qw, qx, qy, qz, battery, packetCount);
      Serial.print(status);
    }
  }
}