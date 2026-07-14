// USB_freeD — ESP-NOW Receiver + SpaceMouse HID (ESP32-S3-DevKitC-1, WROOM-2)
// Receives quaternion data over ESP-NOW, converts to angular velocity,
// and presents as a 3DConnexion SpaceMouse Pro Wireless over USB HID.
//
// Install 3DxWare driver on your PC for Onshape/CAD integration.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <USB.h>
#include <USBHID.h>
#include <USBCDC.h>
#include <freertos/FreeRTOS.h>
#include "espnow_packet.h"
#include "target_packet.h"

// =================== HID REPORT DESCRIPTOR ===================
// Matches 3DConnexion SpaceMouse: multi-axis controller
//   Report ID 1: Translation (X, Y, Z) — signed 16-bit, ±350
//   Report ID 2: Rotation (Rx, Ry, Rz) — signed 16-bit, ±350
//   Report ID 3: Buttons (32 bits)
static const uint8_t SM_REPORT_DESC[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop Ctrls)
    0x09, 0x08,        // Usage (Multi-axis Controller)
    0xA1, 0x01,        // Collection (Application)

    // --- Translation (Report ID 1) ---
    0xA1, 0x00,        //   Collection (Physical)
    0x85, 0x01,        //     Report ID (1)
    0x16, 0xA2, 0xFE,  //     Logical Minimum (-350)
    0x26, 0x5E, 0x01,  //     Logical Maximum (350)
    0x36, 0xA2, 0xFE,  //     Physical Minimum (-350)
    0x46, 0x5E, 0x01,  //     Physical Maximum (350)
    0x09, 0x30,        //     Usage (X)
    0x09, 0x31,        //     Usage (Y)
    0x09, 0x32,        //     Usage (Z)
    0x75, 0x10,        //     Report Size (16)
    0x95, 0x03,        //     Report Count (3)
    0x81, 0x02,        //     Input (Data, Var, Abs)
    0xC0,              //   End Collection

    // --- Rotation (Report ID 2) ---
    0xA1, 0x00,        //   Collection (Physical)
    0x85, 0x02,        //     Report ID (2)
    0x16, 0xA2, 0xFE,  //     Logical Minimum (-350)
    0x26, 0x5E, 0x01,  //     Logical Maximum (350)
    0x36, 0xA2, 0xFE,  //     Physical Minimum (-350)
    0x46, 0x5E, 0x01,  //     Physical Maximum (350)
    0x09, 0x33,        //     Usage (Rx)
    0x09, 0x34,        //     Usage (Ry)
    0x09, 0x35,        //     Usage (Rz)
    0x75, 0x10,        //     Report Size (16)
    0x95, 0x03,        //     Report Count (3)
    0x81, 0x02,        //     Input (Data, Var, Abs)
    0xC0,              //   End Collection

    // --- Buttons (Report ID 3) ---
    0xA1, 0x02,        //   Collection (Logical)
    0x85, 0x03,        //     Report ID (3)
    0x05, 0x09,        //     Usage Page (Button)
    0x19, 0x01,        //     Usage Minimum (Button 1)
    0x29, 0x20,        //     Usage Maximum (Button 32)
    0x15, 0x00,        //     Logical Minimum (0)
    0x25, 0x01,        //     Logical Maximum (1)
    0x75, 0x01,        //     Report Size (1)
    0x95, 0x20,        //     Report Count (32)
    0x81, 0x02,        //     Input (Data, Var, Abs)
    0xC0,              //   End Collection

    0xC0               // End Collection
};

// =================== SpaceMouse HID Device ===================
class SpaceMouseHID : public USBHIDDevice {
public:
    uint16_t _onGetDescriptor(uint8_t* dst) override {
        memcpy(dst, SM_REPORT_DESC, sizeof(SM_REPORT_DESC));
        return sizeof(SM_REPORT_DESC);
    }
};

// =================== CONFIG ===================
static const float MAX_STEP_RAD        = 0.050f;  // max angular velocity per frame (rad/10ms = 5 rad/s ~= 286 deg/s).
                                                   // Caps how far Onshape can be commanded per serial window.
                                                   // Increase for faster response, decrease if overshoot persists.
static const float CONVERGENCE_ZONE_RAD = 0.050f; // ~2.9 deg. When error < this AND not growing, suppress command.
                                                   // Prevents piling up commands while Onshape is already arriving.
static const float ABS_ROT_SCALE = 350.0f / MAX_STEP_RAD;  // maps MAX_STEP_RAD -> full HID (350 units).
static const float DEADZONE_RAD  = 0.030f;   // error magnitude below which no correction sent (~1.7 deg).
static const float SMOOTH_ALPHA  = 0.28f;    // EMA on error velocity. Lower = more damping.
static const unsigned long IDLE_TIMEOUT_MS = 80;  // zero-out HID after no packets
static const float INVERT_ROLL  = -1.0f;   // set to -1.0f to invert roll  (Rx)
static const float INVERT_PITCH =  1.0f;   // set to -1.0f to invert pitch (Ry / Onshape X)
static const float INVERT_YAW   = -1.0f;   // set to -1.0f to invert yaw   (Rz / Onshape Z)

// RGB LED heartbeat (ESP32-S3-DevKitC-1 built-in WS2812B NeoPixel on GPIO 48)
static const uint8_t RGB_LED_PIN = 48;

// =================== GLOBALS ===================
USBHID        usbHID;
SpaceMouseHID smDevice;
USBCDC        USBSerial;  // CDC-ACM interface — composite with HID, same cable

// Heartbeat state
unsigned long lastHeartbeatMs = 0;

// Latest received sample (atomic handoff from ESP-NOW callback to main loop)
struct RxSample {
    float qw;
    float qx;
    float qy;
    float qz;
    uint8_t flags;
    uint8_t seq;
    unsigned long recvMs;
};

portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
volatile RxSample latestSample = {1.0f, 0.0f, 0.0f, 0.0f, 0, 0, 0};
volatile bool sampleReady = false;
volatile unsigned long lastRecvTime = 0;

// Sequence tracking (for packet loss/reorder diagnostics)
bool hasLastSeq = false;
uint8_t lastSeq = 0;
uint32_t droppedPacketCount = 0;
uint32_t outOfOrderPacketCount = 0;

// Home: device orientation at last tap (physical reference frame)
float qHomeW = 1.0f, qHomeX = 0.0f, qHomeY = 0.0f, qHomeZ = 0.0f;
// View: receiver's running estimate of Onshape's current orientation.
// Anchored to ground truth by serial packets from the extension; dead-reckoned between.
float qViewW = 1.0f, qViewX = 0.0f, qViewY = 0.0f, qViewZ = 0.0f;
bool hasHome = false;
bool motionActive = false;

// =================== SERIAL TARGET PACKET (extension → receiver) ===================
static uint8_t  tgtBuf[TARGET_PACKET_SIZE];
static uint8_t  tgtBufIdx = 0;
static unsigned long lastTargetMs = 0;  // millis() of last valid target packet
static bool     hasTargetLock = false;  // true once we've received at least one valid packet
static bool     newSerialPacketReady = false;  // set by processSerialInput, consumed by loop()
static uint8_t  lastTargetSeq = 0;
static bool     hasLastTargetSeq = false;

// Smoothed error angular velocity (EMA filtered)
float smoothRx = 0.0f, smoothRy = 0.0f, smoothRz = 0.0f;
float prevSmoothMag = 0.0f;  // previous frame's smoothed error magnitude (convergence detection)

// Feedforward: angular velocity from sender quaternion derivative (rad/s, LPF'd).
// Bypasses closed-loop dead time for the dominant motion command.
float qDevPrevW = 1.0f, qDevPrevX = 0.0f, qDevPrevY = 0.0f, qDevPrevZ = 0.0f;
unsigned long tDevPrevMs = 0;
bool hasDevPrev = false;
float omegaFFx = 0.0f, omegaFFy = 0.0f, omegaFFz = 0.0f;
static const float FF_LPF_ALPHA = 0.5f;  // single-pole low-pass on FF (kills BNO085 quantization)

// =================== QUATERNION MATH ===================
void quatDelta(float cw, float cx, float cy, float cz,
               float pw, float px, float py, float pz,
               float& dw, float& dx, float& dy, float& dz) {
    // q_delta = current * conj(prev)
    dw =  cw*pw + cx*px + cy*py + cz*pz;
    dx = -cw*px + cx*pw - cy*pz + cz*py;
    dy = -cw*py + cx*pz + cy*pw - cz*px;
    dz = -cw*pz - cx*py + cy*px + cz*pw;
}

void deltaToAngVel(float dw, float dx, float dy, float dz,
                   float& rx, float& ry, float& rz) {
    if (dw < 0) { dw = -dw; dx = -dx; dy = -dy; dz = -dz; }

    float sinHalf = sqrtf(dx*dx + dy*dy + dz*dz);
    if (sinHalf < 1e-7f) {
        rx = ry = rz = 0.0f;
        return;
    }

    float angle = 2.0f * atan2f(sinHalf, dw);
    float scale = angle / sinHalf;

    rx = dx * scale;
    ry = dy * scale;
    rz = dz * scale;
}

int16_t toSM(float val) {
    float v = val * ABS_ROT_SCALE;
    if (v >  350.0f) v =  350.0f;
    if (v < -350.0f) v = -350.0f;
    return (int16_t)v;
}

// Normalize a quaternion in place
void quatNorm(float& w, float& x, float& y, float& z) {
    float n = sqrtf(w*w + x*x + y*y + z*z);
    if (n > 1e-9f) { w /= n; x /= n; y /= n; z /= n; }
}

// Standard quaternion multiply: r = a * b
void quatMul(float aw, float ax, float ay, float az,
             float bw, float bx, float by, float bz,
             float& rw, float& rx, float& ry, float& rz) {
    rw = aw*bw - ax*bx - ay*by - az*bz;
    rx = aw*bx + ax*bw + ay*bz - az*by;
    ry = aw*by - ax*bz + ay*bw + az*bx;
    rz = aw*bz + ax*by - ay*bx + az*bw;
}

// Spherical linear interpolation between two unit quaternions (shortest path)
void quatSlerp(float aw, float ax, float ay, float az,
               float bw, float bx, float by, float bz,
               float t,
               float& rw, float& rx, float& ry, float& rz) {
    float dot = aw*bw + ax*bx + ay*by + az*bz;
    if (dot < 0.0f) { bw=-bw; bx=-bx; by=-by; bz=-bz; dot=-dot; }  // shortest arc
    if (dot > 0.9995f) {
        // Nearly identical quaternions -- use nlerp to avoid arccos instability
        rw = aw + t*(bw-aw); rx = ax + t*(bx-ax);
        ry = ay + t*(by-ay); rz = az + t*(bz-az);
    } else {
        float theta0    = acosf(dot);
        float sinTheta0 = sinf(theta0);
        float s0 = sinf((1.0f - t) * theta0) / sinTheta0;
        float s1 = sinf(t           * theta0) / sinTheta0;
        rw = s0*aw + s1*bw; rx = s0*ax + s1*bx;
        ry = s0*ay + s1*by; rz = s0*az + s1*bz;
    }
    quatNorm(rw, rx, ry, rz);
}

// Convert angular velocity (rad/frame) to a step quaternion
void angVelToQuat(float rx, float ry, float rz,
                  float& dw, float& dx, float& dy, float& dz) {
    float angle = sqrtf(rx*rx + ry*ry + rz*rz);
    if (angle < 1e-9f) { dw = 1.0f; dx = dy = dz = 0.0f; return; }
    float sinHalf = sinf(angle * 0.5f);
    dw = cosf(angle * 0.5f);
    dx = rx / angle * sinHalf;
    dy = ry / angle * sinHalf;
    dz = rz / angle * sinHalf;
}

bool popLatestSample(RxSample& out) {
    bool hasData = false;
    portENTER_CRITICAL(&rxMux);
    if (sampleReady) {
        out.qw = latestSample.qw;
        out.qx = latestSample.qx;
        out.qy = latestSample.qy;
        out.qz = latestSample.qz;
        out.flags = latestSample.flags;
        out.seq = latestSample.seq;
        out.recvMs = latestSample.recvMs;
        sampleReady = false;
        hasData = true;
    }
    portEXIT_CRITICAL(&rxMux);
    return hasData;
}

// =================== HID SEND ===================
void sendRotation(int16_t rx, int16_t ry, int16_t rz) {
    uint8_t data[6];
    memcpy(&data[0], &rx, 2);
    memcpy(&data[2], &ry, 2);
    memcpy(&data[4], &rz, 2);
    usbHID.SendReport(0x02, data, 6);
}

void sendTranslation(int16_t x, int16_t y, int16_t z) {
    uint8_t data[6];
    memcpy(&data[0], &x, 2);
    memcpy(&data[2], &y, 2);
    memcpy(&data[4], &z, 2);
    usbHID.SendReport(0x01, data, 6);
}

void sendZero() {
    int16_t z[3] = {0, 0, 0};
    usbHID.SendReport(0x01, (uint8_t*)z, 6);
    usbHID.SendReport(0x02, (uint8_t*)z, 6);
}

// =================== HEARTBEAT LED ===================
// Brief green blip every 2 seconds
void updateHeartbeat() {
    unsigned long t = millis() % 2000;
    uint8_t brightness = 0;

    if (t < 60)        brightness = (uint8_t)(t * 255 / 60);
    else if (t < 120)  brightness = (uint8_t)((120 - t) * 255 / 60);

    neopixelWrite(RGB_LED_PIN, 0, brightness, 0);
}

// =================== SERIAL TARGET PACKET PARSER ===================
// Reads all buffered Serial bytes, syncs on TARGET_HEADER (0xBB), accumulates
// TARGET_PACKET_SIZE bytes, verifies checksum, then anchors qView.
void processSerialInput() {
    while (USBSerial.available() > 0) {
        uint8_t b = (uint8_t)USBSerial.read();

        // If not yet started, wait for header byte
        if (tgtBufIdx == 0) {
            if (b != TARGET_HEADER) continue;
        }

        tgtBuf[tgtBufIdx++] = b;

        if (tgtBufIdx < TARGET_PACKET_SIZE) continue;

        // Full packet accumulated — verify
        tgtBufIdx = 0;
        const TargetPacket* pkt = reinterpret_cast<const TargetPacket*>(tgtBuf);
        if (!verifyTargetPacket(*pkt)) {
            // Bad checksum — could be mid-stream sync; scan for next header
            continue;
        }

        // Valid packet: hard-set qView to the actual Onshape orientation.
        // No slerp blending — we rely on the serial-gate + rate-limit in loop()
        // to prevent overshoot rather than smoothing the ground-truth reference.
        const unsigned long nowMs = millis();
        qViewW = pkt->qw; qViewX = pkt->qx; qViewY = pkt->qy; qViewZ = pkt->qz;
        quatNorm(qViewW, qViewX, qViewY, qViewZ);
        lastTargetMs = nowMs;
        hasTargetLock = true;
        newSerialPacketReady = true;  // gates HID command in loop()

        if (hasLastTargetSeq) {
            int8_t seqDelta = (int8_t)(pkt->seq - (uint8_t)(lastTargetSeq + 1));
            if (seqDelta > 0) {
                // Dropped target packet — not critical, qView still updated
            }
        }
        lastTargetSeq = pkt->seq;
        hasLastTargetSeq = true;
    }
}

// =================== ESP-NOW CALLBACK ===================
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len != sizeof(ImuEspNowPacket)) return;

    const ImuEspNowPacket* p = (const ImuEspNowPacket*)data;
    const unsigned long nowMs = millis();

    portENTER_CRITICAL(&rxMux);
    latestSample.qw = p->qw;
    latestSample.qx = p->qx;
    latestSample.qy = p->qy;
    latestSample.qz = p->qz;
    latestSample.flags = p->flags;
    latestSample.seq = p->seq;
    latestSample.recvMs = nowMs;
    sampleReady = true;
    lastRecvTime = nowMs;
    portEXIT_CRITICAL(&rxMux);
}

// =================== SETUP ===================
void setup() {
    // --- USB composite device: HID (SpaceMouse) + CDC-ACM (serial) ---
    // VID/PID must be set before USB.begin(); with ARDUINO_USB_CDC_ON_BOOT=0
    // the framework never calls USB.begin() automatically, so we control it here.
    USB.VID(0x256F);                          // 3Dconnexion vendor ID
    USB.PID(0xC631);                          // SpaceMouse Pro Wireless
    USB.productName("SpaceMouse Pro Wireless");
    USB.manufacturerName("3Dconnexion");

    usbHID.addDevice(&smDevice, sizeof(SM_REPORT_DESC));
    USBSerial.begin(115200);  // registers CDC interface before USB.begin()
    USB.begin();
    usbHID.begin();

    delay(2000);  // wait for USB enumeration

    // --- ESP-NOW ---
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    USBSerial.println("\n=== USB_freeD — ESP-NOW Receiver + SpaceMouse HID ===");
    USBSerial.printf("[INFO] Receiver MAC: %s\n", WiFi.macAddress().c_str());

    if (esp_now_init() != ESP_OK) {
        USBSerial.println("[FAIL] ESP-NOW init failed!");
        while (true) delay(1000);
    }

    esp_now_register_recv_cb(onDataRecv);

    USBSerial.println("[OK] ESP-NOW ready — waiting for IMU data...");
    USBSerial.println("[OK] USB HID SpaceMouse ready");
}

// =================== MAIN LOOP ===================
void loop() {
    // Always drain serial first — anchors qView before IMU error calculation
    processSerialInput();

    RxSample sample;
    if (popLatestSample(sample)) {
        // Snapshot latest received data
        float qw = sample.qw, qx = sample.qx, qy = sample.qy, qz = sample.qz;
        uint8_t flags = sample.flags;
        uint8_t seq = sample.seq;
        bool stalePacket = false;

        // Track dropped/reordered packets.
        // int8 wrap behavior handles uint8 sequence rollover naturally.
        if (hasLastSeq) {
            uint8_t expected = (uint8_t)(lastSeq + 1);
            int8_t delta = (int8_t)(seq - expected);
            if (delta > 0) {
                droppedPacketCount += (uint8_t)delta;
            } else if (delta < 0) {
                outOfOrderPacketCount++;
                stalePacket = true;
            }
        }
        hasLastSeq = true;
        lastSeq = seq;

        if (!stalePacket) {
            // Tap or first packet: sync physical home to current device orientation.
            // Reset the estimated Onshape view to identity — user should have Onshape
            // at the desired reference orientation before tapping.
            if ((flags & ENOW_FLAG_TAP) || !hasHome) {
                qHomeW = qw; qHomeX = qx; qHomeY = qy; qHomeZ = qz;
                // Only reset qView to identity if no extension ground-truth is active.
                // If serial is connected, qView will be overwritten on the next packet anyway.
                if (!hasTargetLock) {
                    qViewW = 1.0f; qViewX = 0.0f; qViewY = 0.0f; qViewZ = 0.0f;
                }
                smoothRx = smoothRy = smoothRz = 0.0f;
                // Reset FF state — re-anchoring at home is a discontinuity in q_device
                hasDevPrev = false;
                omegaFFx = omegaFFy = omegaFFz = 0.0f;
                hasHome = true;
                sendZero();
                motionActive = false;
                return;
            }

        // === Feedforward: differentiate sender quaternion to get ω_dev (rad/s) ===
        // Open-loop, ~5-10 ms latency, immune to round-trip dead time.
        // Step 1 of staged rollout: compute and log only — does not yet affect HID output.
        const unsigned long sampleMs = sample.recvMs;
        if (hasDevPrev) {
            float dtFF = (sampleMs - tDevPrevMs) * 1e-3f;
            if (dtFF > 0.001f && dtFF < 0.1f) {  // sanity-bound dt
                float dW, dX, dY, dZ;
                quatDelta(qw, qx, qy, qz, qDevPrevW, qDevPrevX, qDevPrevY, qDevPrevZ, dW, dX, dY, dZ);
                quatNorm(dW, dX, dY, dZ);
                float ffx, ffy, ffz;
                deltaToAngVel(dW, dX, dY, dZ, ffx, ffy, ffz);  // radians, this frame
                ffx /= dtFF; ffy /= dtFF; ffz /= dtFF;          // → rad/s
                omegaFFx = FF_LPF_ALPHA * ffx + (1.0f - FF_LPF_ALPHA) * omegaFFx;
                omegaFFy = FF_LPF_ALPHA * ffy + (1.0f - FF_LPF_ALPHA) * omegaFFy;
                omegaFFz = FF_LPF_ALPHA * ffz + (1.0f - FF_LPF_ALPHA) * omegaFFz;
            }
        }
        qDevPrevW = qw; qDevPrevX = qx; qDevPrevY = qy; qDevPrevZ = qz;
        tDevPrevMs = sampleMs;
        hasDevPrev = true;

        // 20 Hz FF diagnostic — comment out once verified
        static unsigned long lastFFLogMs = 0;
        if (sampleMs - lastFFLogMs >= 50) {
            lastFFLogMs = sampleMs;
            USBSerial.printf("[FF] wx=%+.2f wy=%+.2f wz=%+.2f rad/s\n",
                             omegaFFx, omegaFFy, omegaFFz);
        }

        // Target: device orientation relative to home reference
        // qTarget = qDevice * conj(qHome)
        float twW, twX, twY, twZ;
        quatDelta(qw, qx, qy, qz, qHomeW, qHomeX, qHomeY, qHomeZ, twW, twX, twY, twZ);
        quatNorm(twW, twX, twY, twZ);

        // Error: how much more Onshape needs to rotate to reach the target
        // qError = qTarget * conj(qView)
        float ewW, ewX, ewY, ewZ;
        quatDelta(twW, twX, twY, twZ, qViewW, qViewX, qViewY, qViewZ, ewW, ewX, ewY, ewZ);
        quatNorm(ewW, ewX, ewY, ewZ);

        // Convert error quaternion to angular velocity (radians)
        float rx, ry, rz;
        deltaToAngVel(ewW, ewX, ewY, ewZ, rx, ry, rz);

        // Magnitude deadzone
        float angMag = sqrtf(rx*rx + ry*ry + rz*rz);
        if (angMag < DEADZONE_RAD) {
            rx = ry = rz = 0.0f;
        }

        // EMA smoothing
        smoothRx = SMOOTH_ALPHA * rx + (1.0f - SMOOTH_ALPHA) * smoothRx;
        smoothRy = SMOOTH_ALPHA * ry + (1.0f - SMOOTH_ALPHA) * smoothRy;
        smoothRz = SMOOTH_ALPHA * rz + (1.0f - SMOOTH_ALPHA) * smoothRz;

        const float smoothMag = sqrtf(smoothRx*smoothRx + smoothRy*smoothRy + smoothRz*smoothRz);

        // === OPTION 3: Rate-limit + convergence suppression ===
        //
        // When serial is active, gate HID commands: only fire when a new serial packet
        // has arrived (newSerialPacketReady). This ensures at most one command is issued
        // per Onshape observation, preventing multiple commands piling up during the
        // ~100ms render latency window that cause oscillation.
        //
        // Also suppress if within the convergence zone and error is not growing —
        // Onshape is already arriving; adding more commands would overshoot.
        //
        // When serial is NOT active (open loop), fire every IMU frame as before.

        bool converging = hasTargetLock &&
                          (smoothMag < CONVERGENCE_ZONE_RAD) &&
                          (smoothMag <= prevSmoothMag * 1.10f);  // 10% tolerance for noise
        prevSmoothMag = smoothMag;

        // Consume the gate flag regardless — ensures we always re-evaluate on next serial packet
        const bool newPacket = newSerialPacketReady;
        newSerialPacketReady = false;

        const bool shouldSendHid = !hasTargetLock || (newPacket && !converging);

        // Rate-limit: scale the velocity vector down uniformly if magnitude exceeds MAX_STEP_RAD.
        // Preserves axis ratios so the rotation direction is exact, only speed is capped.
        float ratioScale = 1.0f;
        if (smoothMag > MAX_STEP_RAD && smoothMag > 1e-9f) {
            ratioScale = MAX_STEP_RAD / smoothMag;
        }

        int16_t smRx = 0, smRy = 0, smRz = 0;
        if (shouldSendHid) {
            smRx = toSM(INVERT_ROLL  * smoothRx * ratioScale);
            smRy = toSM(INVERT_PITCH * smoothRy * ratioScale);
            smRz = toSM(INVERT_YAW   * smoothRz * ratioScale);
        }

        // qView dead-reckoning: only when serial is NOT active.
        // With serial active, qView is set directly from ground truth each packet;
        // dead-reckoning would corrupt it between updates.
        if (!hasTargetLock && (smRx != 0 || smRy != 0 || smRz != 0)) {
            float cmdRx = INVERT_ROLL  * ((float)smRx / ABS_ROT_SCALE);
            float cmdRy = INVERT_PITCH * ((float)smRy / ABS_ROT_SCALE);
            float cmdRz = INVERT_YAW   * ((float)smRz / ABS_ROT_SCALE);
            float stepW, stepX, stepY, stepZ;
            angVelToQuat(cmdRx, cmdRy, cmdRz, stepW, stepX, stepY, stepZ);
            float nVW, nVX, nVY, nVZ;
            quatMul(stepW, stepX, stepY, stepZ, qViewW, qViewX, qViewY, qViewZ, nVW, nVX, nVY, nVZ);
            qViewW = nVW; qViewX = nVX; qViewY = nVY; qViewZ = nVZ;
            quatNorm(qViewW, qViewX, qViewY, qViewZ);
        }

            if (smRx != 0 || smRy != 0 || smRz != 0) {
                sendTranslation(0, 0, 0);
                sendRotation(smRx, smRy, smRz);
                motionActive = true;
            } else if (motionActive) {
                sendZero();
                motionActive = false;
            }
        }
    }

    // If no data for IDLE_TIMEOUT_MS, send zero to stop any drift
    if (motionActive && (millis() - lastRecvTime > IDLE_TIMEOUT_MS)) {
        sendZero();
        motionActive = false;
    }

    updateHeartbeat();
    delay(1);  // yield
}
