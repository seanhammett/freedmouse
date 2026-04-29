#pragma once
#include <stdint.h>
#include <string.h>

// Binary serial packet: PC Chrome Extension → Receiver (USB CDC, 115200 baud)
//
// Byte layout (18 bytes total):
//   [0]       Header:   0xBB
//   [1..4]    float32:  quaternion W  (little-endian)
//   [5..8]    float32:  quaternion X
//   [9..12]   float32:  quaternion Y
//   [13..16]  float32:  quaternion Z
//   [17]      uint8:    sequence number (wraps at 255)
//   [18]      uint8:    checksum (XOR of bytes 1..17)
// Total: 19 bytes
//
// The receiver replaces its dead-reckoned qView with the incoming quaternion
// on each valid packet, anchoring the closed-loop error calculation to the
// real Onshape orientation observed by the extension.

static const uint8_t TARGET_HEADER    = 0xBB;
static const uint8_t TARGET_PACKET_SIZE = 19;   // header + 4*float + seq + checksum

struct __attribute__((packed)) TargetPacket {
    uint8_t header;    // 0xBB
    float   qw;
    float   qx;
    float   qy;
    float   qz;
    uint8_t seq;
    uint8_t checksum;  // XOR of bytes 1..17
};

static_assert(sizeof(TargetPacket) == TARGET_PACKET_SIZE, "TargetPacket must be 19 bytes");

inline uint8_t computeTargetChecksum(const TargetPacket& pkt) {
    const uint8_t* b = reinterpret_cast<const uint8_t*>(&pkt);
    uint8_t cs = 0;
    for (uint8_t i = 1; i < TARGET_PACKET_SIZE - 1; i++) {
        cs ^= b[i];
    }
    return cs;
}

inline void buildTargetPacket(TargetPacket& pkt, float w, float x, float y, float z, uint8_t seq) {
    pkt.header = TARGET_HEADER;
    pkt.qw = w;
    pkt.qx = x;
    pkt.qy = y;
    pkt.qz = z;
    pkt.seq = seq;
    pkt.checksum = computeTargetChecksum(pkt);
}

inline bool verifyTargetPacket(const TargetPacket& pkt) {
    if (pkt.header != TARGET_HEADER) return false;
    return computeTargetChecksum(pkt) == pkt.checksum;
}
