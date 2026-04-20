// USB_freeD — ESP-NOW Sender (CodeCell C6)
// Reads BNO085 quaternion and broadcasts over ESP-NOW at 100Hz
// Paired with receiver on Arduino Nano ESP32 (SpaceMouse HID)

#include <Arduino.h>
#include <CodeCell.h>
#include <WiFi.h>
#include <esp_now.h>
#include "espnow_packet.h"

// =================== CONFIG ===================
static const uint8_t STREAM_RATE_HZ = 100;

// Broadcast address — receiver must be in promiscuous mode or paired
// To pair with a specific receiver, replace with its MAC address
static uint8_t receiverMAC[] = {0xE4, 0xB0, 0x63, 0xAE, 0xBA, 0xF8}; // MAC: E4:B0:63:AE:BA:F8

// =================== GLOBALS ===================
CodeCell myCodeCell;
ImuEspNowPacket pkt;
uint8_t seqNum = 0;
bool espNowReady = false;

esp_now_peer_info_t peerInfo;

// =================== CALLBACKS ===================
void onDataSent(const uint8_t *mac, esp_now_send_status_t status) {
    // Optional: could flash LED on failure
    if (status != ESP_NOW_SEND_SUCCESS) {
        myCodeCell.LED(30, 0, 0);  // Red = send failed
    }
}

// =================== SETUP ===================
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=== USB_freeD — ESP-NOW Sender ===");
    Serial.println("CodeCell C6 + BNO085 → ESP-NOW broadcast");

    // Initialize CodeCell (IMU)
    myCodeCell.Init(MOTION_ROTATION + MOTION_TAP_DETECTOR);
    Serial.println("[OK] CodeCell initialized (BNO085: rotation + tap)");

    // Initialize WiFi in station mode (required for ESP-NOW)
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    // Print MAC address so receiver can be configured
    Serial.printf("[INFO] Sender MAC: %s\n", WiFi.macAddress().c_str());

    // Initialize ESP-NOW
    if (esp_now_init() != ESP_OK) {
        Serial.println("[FAIL] ESP-NOW init failed!");
        myCodeCell.LED(30, 0, 0);
        while (true) delay(1000);
    }

    esp_now_register_send_cb(onDataSent);

    // Add broadcast peer
    memset(&peerInfo, 0, sizeof(peerInfo));
    memcpy(peerInfo.peer_addr, receiverMAC, 6);
    peerInfo.channel = 0;  // use current channel
    peerInfo.encrypt = false;

    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("[FAIL] Failed to add peer!");
        myCodeCell.LED(30, 0, 0);
        while (true) delay(1000);
    }

    espNowReady = true;
    myCodeCell.LED(0, 30, 0);  // Green = ready
    Serial.printf("[OK] ESP-NOW ready — streaming at %d Hz\n\n", STREAM_RATE_HZ);
}

// =================== MAIN LOOP ===================
void loop() {
    if (myCodeCell.Run(STREAM_RATE_HZ)) {

        // Check for tap gesture
        uint8_t flags = 0;
        if (myCodeCell.Motion_TapDetectorRead()) {
            flags |= ENOW_FLAG_HOME_RESET | ENOW_FLAG_TAP;
            myCodeCell.LED(0, 0, 40);  // Blue flash = tap
        }

        // Read quaternion
        float qw, qx, qy, qz;
        myCodeCell.Motion_RotationVectorRead(qw, qx, qy, qz);

        // Battery
        uint8_t battery = (uint8_t)myCodeCell.BatteryLevelRead();

        // Build ESP-NOW packet
        pkt.qw = qw;
        pkt.qx = qx;
        pkt.qy = qy;
        pkt.qz = qz;
        pkt.flags = flags;
        pkt.battery = battery;
        pkt.seq = seqNum++;

        // Send
        esp_now_send(receiverMAC, (const uint8_t*)&pkt, sizeof(pkt));

        // LED feedback
        if (!(flags & ENOW_FLAG_TAP)) {
            myCodeCell.LED(0, 30, 0);  // Green = normal
        }
    }
}
