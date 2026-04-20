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
static const float ROT_SCALE    = 30000.0f; // angular vel → SpaceMouse units (tuned for 100Hz deltas)
static const float DEADZONE_RAD = 0.001f;   // ~0.06° deadzone
static const float SMOOTH_ALPHA = 0.4f;     // EMA smoothing (0.0=sluggish, 1.0=raw/noisy)
static const unsigned long IDLE_TIMEOUT_MS = 80;  // zero-out after no data

// RGB LED heartbeat (Arduino Nano ESP32 built-in NeoPixel on GPIO48)
static const uint8_t RGB_LED_PIN = 48;

// =================== GLOBALS ===================
USBHID        usbHID;
SpaceMouseHID smDevice;

// Heartbeat state
unsigned long lastHeartbeatMs = 0;

// Quaternion state
volatile float curQw = 1.0f, curQx = 0.0f, curQy = 0.0f, curQz = 0.0f;
volatile uint8_t curFlags = 0;
volatile bool newData = false;
volatile unsigned long lastRecvTime = 0;

float prevQw = 1.0f, prevQx = 0.0f, prevQy = 0.0f, prevQz = 0.0f;
bool hasPrevious = false;
bool motionActive = false;  // tracks whether we're sending non-zero

// Smoothed angular velocity (EMA filtered)
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
    float v = val * ROT_SCALE;
    if (v >  350.0f) v =  350.0f;
    if (v < -350.0f) v = -350.0f;
    return (int16_t)v;
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
    curQw = p->qw;
    curQx = p->qx;
    curQy = p->qy;
    curQz = p->qz;
    curFlags = p->flags;
    newData = true;
    lastRecvTime = millis();
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
    if (newData) {
        newData = false;

        // Snapshot volatile data
        float qw = curQw, qx = curQx, qy = curQy, qz = curQz;
        uint8_t flags = curFlags;

        // Tap → reset home
        if (flags & ENOW_FLAG_TAP) {
            prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
            hasPrevious = true;
            sendZero();
            motionActive = false;
            return;
        }

        if (!hasPrevious) {
            prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
            hasPrevious = true;
            return;
        }

        // Compute delta quaternion
        float dw, dx, dy, dz;
        quatDelta(qw, qx, qy, qz, prevQw, prevQx, prevQy, prevQz, dw, dx, dy, dz);

        // Angular velocity
        float rx, ry, rz;
        deltaToAngVel(dw, dx, dy, dz, rx, ry, rz);

        // Deadzone
        if (fabsf(rx) < DEADZONE_RAD) rx = 0;
        if (fabsf(ry) < DEADZONE_RAD) ry = 0;
        if (fabsf(rz) < DEADZONE_RAD) rz = 0;

        // EMA smoothing to reduce jitter
        smoothRx = SMOOTH_ALPHA * rx + (1.0f - SMOOTH_ALPHA) * smoothRx;
        smoothRy = SMOOTH_ALPHA * ry + (1.0f - SMOOTH_ALPHA) * smoothRy;
        smoothRz = SMOOTH_ALPHA * rz + (1.0f - SMOOTH_ALPHA) * smoothRz;

        int16_t smRx = toSM(smoothRx);
        int16_t smRy = toSM(smoothRy);
        int16_t smRz = toSM(smoothRz);

        if (smRx != 0 || smRy != 0 || smRz != 0) {
            sendTranslation(0, 0, 0);
            sendRotation(smRx, smRy, smRz);
            motionActive = true;
        } else if (motionActive) {
            // Send one zero frame to stop motion
            sendZero();
            motionActive = false;
        }

        prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
    }

    // If no data for IDLE_TIMEOUT_MS, send zero to stop any drift
    if (motionActive && (millis() - lastRecvTime > IDLE_TIMEOUT_MS)) {
        sendZero();
        motionActive = false;
    }

    updateHeartbeat();
    delay(1);  // yield
}
