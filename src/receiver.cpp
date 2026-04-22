// USB_freeD — ESP-NOW Receiver + SpaceMouse HID (Arduino Nano ESP32 / S3)
// Receives quaternion data over ESP-NOW, converts to angular velocity,
// and presents as a 3DConnexion SpaceMouse Pro Wireless over USB HID.
//
// Install 3DxWare driver on your PC for Onshape/CAD integration.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <USB.h>
#include <USBHID.h>
#include <freertos/FreeRTOS.h>
#include "espnow_packet.h"

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
static const float ABS_ROT_SCALE = 8000.0f;  // error (rad) → SpaceMouse units; saturates at 350 (≈4° error),
                                              // then proportional. Higher = faster slew, larger deadband.
static const float DEADZONE_RAD  = 0.005f;  // error magnitude (rad) below which no correction is sent (~0.3°)
static const float SMOOTH_ALPHA  = 0.75f;   // EMA on error velocity (higher = more responsive, less smooth)
static const unsigned long IDLE_TIMEOUT_MS = 80;  // zero-out HID after no packets
static const float INVERT_ROLL  = -1.0f;   // set to -1.0f to invert roll  (Rx)
static const float INVERT_PITCH =  1.0f;   // set to -1.0f to invert pitch (Ry / Onshape X)
static const float INVERT_YAW   = -1.0f;   // set to -1.0f to invert yaw   (Rz / Onshape Z)

// RGB LED heartbeat (Arduino Nano ESP32 built-in NeoPixel on GPIO48)
static const uint8_t RGB_LED_PIN = 48;

// =================== GLOBALS ===================
USBHID        usbHID;
SpaceMouseHID smDevice;

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
// View: receiver's running estimate of Onshape's current orientation
float qViewW = 1.0f, qViewX = 0.0f, qViewY = 0.0f, qViewZ = 0.0f;
bool hasHome = false;
bool motionActive = false;

// Smoothed error angular velocity (EMA filtered)
float smoothRx = 0.0f, smoothRy = 0.0f, smoothRz = 0.0f;

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
    Serial.begin(115200);  // debug output over USB CDC (separate from HID)

    Serial.println("\n=== USB_freeD — ESP-NOW Receiver + SpaceMouse HID ===");
    Serial.printf("[INFO] Receiver MAC: %s\n", WiFi.macAddress().c_str());

    // --- USB HID as SpaceMouse ---
    USB.VID(0x256F);                          // 3Dconnexion vendor ID
    USB.PID(0xC631);                          // SpaceMouse Pro Wireless
    USB.productName("SpaceMouse Pro Wireless");
    USB.manufacturerName("3Dconnexion");

    usbHID.addDevice(&smDevice, sizeof(SM_REPORT_DESC));
    USB.begin();
    usbHID.begin();

    delay(2000);  // wait for USB enumeration

    // --- ESP-NOW ---
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    Serial.println("\n=== USB_freeD — ESP-NOW Receiver + SpaceMouse HID ===");
    Serial.printf("[INFO] Receiver MAC: %s\n", WiFi.macAddress().c_str());

    if (esp_now_init() != ESP_OK) {
        Serial.println("[FAIL] ESP-NOW init failed!");
        while (true) delay(1000);
    }

    esp_now_register_recv_cb(onDataRecv);

    Serial.println("[OK] ESP-NOW ready — waiting for IMU data...");
    Serial.println("[OK] USB HID SpaceMouse ready");
}

// =================== MAIN LOOP ===================
void loop() {
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
                qViewW = 1.0f; qViewX = 0.0f; qViewY = 0.0f; qViewZ = 0.0f;
                smoothRx = smoothRy = smoothRz = 0.0f;
                hasHome = true;
                sendZero();
                motionActive = false;
                return;
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

        // Apply axis inversions and quantize/clamp to the exact HID command we send.
        int16_t smRx = toSM(INVERT_ROLL  * smoothRx);
        int16_t smRy = toSM(INVERT_PITCH * smoothRy);
        int16_t smRz = toSM(INVERT_YAW   * smoothRz);

        // Integrate qView from the exact command after clamp/quantization.
        // Mapping back through INVERT_* keeps qView in the same physical frame as qTarget.
        float cmdRx = INVERT_ROLL  * ((float)smRx / ABS_ROT_SCALE);
        float cmdRy = INVERT_PITCH * ((float)smRy / ABS_ROT_SCALE);
        float cmdRz = INVERT_YAW   * ((float)smRz / ABS_ROT_SCALE);

        float stepW, stepX, stepY, stepZ;
        angVelToQuat(cmdRx, cmdRy, cmdRz, stepW, stepX, stepY, stepZ);
        float nVW, nVX, nVY, nVZ;
        quatMul(stepW, stepX, stepY, stepZ, qViewW, qViewX, qViewY, qViewZ, nVW, nVX, nVY, nVZ);
        qViewW = nVW; qViewX = nVX; qViewY = nVY; qViewZ = nVZ;
        quatNorm(qViewW, qViewX, qViewY, qViewZ);

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
