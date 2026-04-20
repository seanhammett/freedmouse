#pragma once
#include <stdint.h>

// ESP-NOW packet for IMU orientation data
// Sent from CodeCell C6 → Arduino Nano ESP32
// 19 bytes — fits within ESP-NOW's 250-byte limit

static const uint8_t ESPNOW_CHANNEL = 1;

struct __attribute__((packed)) ImuEspNowPacket {
    float qw;          // quaternion W
    float qx;          // quaternion X
    float qy;          // quaternion Y
    float qz;          // quaternion Z
    uint8_t flags;     // bit 0 = home reset, bit 1 = tap
    uint8_t battery;   // 0-100
    uint8_t seq;       // sequence number (wraps at 255)
};

static_assert(sizeof(ImuEspNowPacket) == 19, "ImuEspNowPacket must be 19 bytes");

// Flag bits (shared with packet.h)
static const uint8_t ENOW_FLAG_HOME_RESET = 0x01;
static const uint8_t ENOW_FLAG_TAP        = 0x02;
