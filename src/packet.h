#pragma once
#include <stdint.h>
#include <string.h>

// Binary serial packet format for 3D IMU Mouse
//
// Byte layout (20 bytes total):
//   [0]      Header:   0xAA
//   [1..4]   float32:  quaternion W
//   [5..8]   float32:  quaternion X
//   [9..12]  float32:  quaternion Y
//   [13..16] float32:  quaternion Z
//   [17]     uint8:    flags (bit 0 = home reset, bit 1 = tap detected)
//   [18]     uint8:    battery level (0-100, 101=charging, 102=USB)
//   [19]     uint8:    checksum (XOR of bytes 1..18)

static const uint8_t PACKET_HEADER   = 0xAA;
static const uint8_t PACKET_SIZE     = 20;
static const uint8_t PAYLOAD_SIZE    = 18;  // bytes 1..18

// Flag bits
static const uint8_t FLAG_HOME_RESET = 0x01;
static const uint8_t FLAG_TAP        = 0x02;

struct __attribute__((packed)) ImuPacket {
  uint8_t header;
  float   qw;
  float   qx;
  float   qy;
  float   qz;
  uint8_t flags;
  uint8_t battery;
  uint8_t checksum;
};

static_assert(sizeof(ImuPacket) == PACKET_SIZE, "ImuPacket must be 20 bytes");

inline uint8_t computeChecksum(const ImuPacket& pkt) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&pkt);
  uint8_t cs = 0;
  for (uint8_t i = 1; i < PACKET_SIZE - 1; i++) {
    cs ^= bytes[i];
  }
  return cs;
}

inline void buildPacket(ImuPacket& pkt, float w, float x, float y, float z,
                        uint8_t flags, uint8_t battery) {
  pkt.header  = PACKET_HEADER;
  pkt.qw      = w;
  pkt.qx      = x;
  pkt.qy      = y;
  pkt.qz      = z;
  pkt.flags   = flags;
  pkt.battery = battery;
  pkt.checksum = computeChecksum(pkt);
}
