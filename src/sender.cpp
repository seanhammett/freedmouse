// USB_freeD — ESP-NOW Sender (CodeCell C6)
// Reads BNO085 quaternion and broadcasts over ESP-NOW at 100Hz
// Paired with receiver on Arduino Nano ESP32 (SpaceMouse HID)

#include <Arduino.h>
#include <CodeCell.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_pm.h>
#include "espnow_packet.h"

// =================== CONFIG ===================
static const uint8_t STREAM_RATE_HZ = 100;
static const uint16_t BATTERY_UPDATE_MS = 1000;
static const uint16_t STATUS_LED_FLASH_MS = 60;
static const uint8_t STATUS_LED_FLASH_BRIGHTNESS = 1;

// Broadcast address — receiver must be in promiscuous mode or paired
// To pair with a specific receiver, replace with its MAC address
static uint8_t receiverMAC[] = {0xE4, 0xB0, 0x63, 0xAE, 0xBA, 0xF8}; // MAC: E4:B0:63:AE:BA:F8

// =================== GLOBALS ===================
CodeCell myCodeCell;
ImuEspNowPacket pkt;
uint8_t seqNum = 0;
bool espNowReady = false;
uint8_t batteryLevel = 0;
uint32_t lastBatteryReadMs = 0;
uint32_t statusLedUntilMs = 0;
volatile bool sendFailurePending = false;

esp_now_peer_info_t peerInfo;

static void flashStatusLed(uint8_t r, uint8_t g, uint8_t b, uint32_t nowMs) {
    myCodeCell.LED_SetBrightness(STATUS_LED_FLASH_BRIGHTNESS);
    myCodeCell.LED(r, g, b);
    statusLedUntilMs = nowMs + STATUS_LED_FLASH_MS;
}

static void updateStatusLed(uint32_t nowMs) {
    if ((int32_t)(nowMs - statusLedUntilMs) >= 0) {
        myCodeCell.LED(0, 0, 0);
        myCodeCell.LED_SetBrightness(0);
    }
}

// =================== CALLBACKS ===================
void onDataSent(const uint8_t *mac, esp_now_send_status_t status) {
    if (status != ESP_NOW_SEND_SUCCESS) {
        sendFailurePending = true;
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

    // Power management: CPU max 80MHz, light sleep between ticks (~10x idle current reduction)
    esp_pm_config_t pmConfig = {
        .max_freq_mhz = 80,
        .min_freq_mhz = 10,
        .light_sleep_enable = true
    };
    if (esp_pm_configure(&pmConfig) != ESP_OK) {
        Serial.println("[WARN] Power management config failed");
    }

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
    batteryLevel = (uint8_t)myCodeCell.BatteryLevelRead();
    lastBatteryReadMs = millis();
    myCodeCell.LED(0, 0, 0);
    myCodeCell.LED_SetBrightness(0);
    Serial.printf("[OK] ESP-NOW ready — streaming at %d Hz\n\n", STREAM_RATE_HZ);
}

// =================== MAIN LOOP ===================
void loop() {
    if (!myCodeCell.Run(STREAM_RATE_HZ)) {
        updateStatusLed(millis());
        delay(1);
        return;
    }

    const uint32_t nowMs = millis();

    if (sendFailurePending) {
        sendFailurePending = false;
        flashStatusLed(30, 0, 0, nowMs);
    }

    // Check for tap gesture
    uint8_t flags = 0;
    if (myCodeCell.Motion_TapDetectorRead()) {
        flags |= ENOW_FLAG_HOME_RESET | ENOW_FLAG_TAP;
        flashStatusLed(0, 0, 40, nowMs);
    }

    // Read quaternion
    float qw, qx, qy, qz;
    myCodeCell.Motion_RotationVectorRead(qw, qx, qy, qz);

    if ((nowMs - lastBatteryReadMs) >= BATTERY_UPDATE_MS) {
        batteryLevel = (uint8_t)myCodeCell.BatteryLevelRead();
        lastBatteryReadMs = nowMs;
    }

    if (espNowReady) {
        // Build ESP-NOW packet
        pkt.qw = qw;
        pkt.qx = qx;
        pkt.qy = qy;
        pkt.qz = qz;
        pkt.flags = flags;
        pkt.battery = batteryLevel;
        pkt.seq = seqNum++;

        // Send
        esp_now_send(receiverMAC, (const uint8_t*)&pkt, sizeof(pkt));
    }

    updateStatusLed(nowMs);
}
