// USB_freeD — SpaceMouse HID Emulator
// CodeCell C6 (ESP32-C6 + BNO085) firmware
// Presents as 3DConnexion SpaceMouse, sending IMU rotation as HID reports
//
// NOTE: This requires USB-OTG / TinyUSB support. The ESP32-C6 only has
// USB Serial/JTAG — if compilation fails, an ESP32-S3 board is needed.

#include <Arduino.h>
#include <CodeCell.h>
#include <USB.h>
#include <USBHID.h>

// =================== HID REPORT DESCRIPTOR ===================
// Matches 3DConnexion SpaceMouse: multi-axis controller with
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
static const uint8_t  STREAM_RATE_HZ = 100;
static const float    ROT_SCALE      = 2000.0f;  // radians/frame → SpaceMouse units
static const float    DEADZONE_RAD   = 0.002f;   // ~0.1° deadzone

// =================== GLOBALS ===================
USBHID        usbHID;
SpaceMouseHID smDevice;
CodeCell      myCodeCell;

float prevQw = 1.0f, prevQx = 0.0f, prevQy = 0.0f, prevQz = 0.0f;
bool  hasPrevious = false;

// =================== QUATERNION MATH ===================
// Delta quaternion: q_delta = q_current * conj(q_prev)
void quatDelta(float cw, float cx, float cy, float cz,
               float pw, float px, float py, float pz,
               float& dw, float& dx, float& dy, float& dz) {
    // conj(prev) = (pw, -px, -py, -pz)
    // q_delta = current * conj(prev)
    dw = cw*pw + cx*px + cy*py + cz*pz;
    dx = -cw*px + cx*pw - cy*pz + cz*py;
    dy = -cw*py + cx*pz + cy*pw - cz*px;
    dz = -cw*pz - cx*py + cy*px + cz*pw;
}

// Extract angular velocity from delta quaternion (small-angle approximation)
void deltaToAngVel(float dw, float dx, float dy, float dz,
                   float& rx, float& ry, float& rz) {
    // Ensure shortest path
    if (dw < 0) { dw = -dw; dx = -dx; dy = -dy; dz = -dz; }

    float sinHalf = sqrtf(dx*dx + dy*dy + dz*dz);
    if (sinHalf < 1e-7f) {
        rx = ry = rz = 0.0f;
        return;
    }

    float angle = 2.0f * atan2f(sinHalf, dw);
    float scale = angle / sinHalf;

    rx = dx * scale;  // roll  (around X)
    ry = dy * scale;  // pitch (around Y)
    rz = dz * scale;  // yaw   (around Z)
}

// Clamp float to SpaceMouse ±350 range
int16_t toSM(float val) {
    float v = val * ROT_SCALE;
    if (v >  350.0f) v =  350.0f;
    if (v < -350.0f) v = -350.0f;
    return (int16_t)v;
}

// =================== HID SEND HELPERS ===================
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

// =================== SETUP ===================
void setup() {
    // --- USB HID as SpaceMouse ---
    USB.VID(0x256F);                          // 3Dconnexion vendor ID
    USB.PID(0xC631);                          // SpaceMouse Pro Wireless
    USB.productName("SpaceMouse Pro Wireless");
    USB.manufacturerName("3Dconnexion");

    usbHID.addDevice(&smDevice, sizeof(SM_REPORT_DESC));
    USB.begin();
    usbHID.begin();

    // Wait for USB enumeration
    delay(2000);

    // --- IMU ---
    myCodeCell.Init(MOTION_ROTATION + MOTION_TAP_DETECTOR);
    myCodeCell.LED(0, 30, 0);  // Green = ready
}

// =================== MAIN LOOP ===================
void loop() {
    if (myCodeCell.Run(STREAM_RATE_HZ)) {

        float qw, qx, qy, qz;
        myCodeCell.Motion_RotationVectorRead(qw, qx, qy, qz);

        // Tap gesture → reset home position, send zero
        if (myCodeCell.Motion_TapDetectorRead()) {
            prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
            hasPrevious = true;
            sendZero();
            myCodeCell.LED(0, 0, 40);  // Blue flash
            return;
        }

        if (!hasPrevious) {
            prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
            hasPrevious = true;
            return;
        }

        // Compute delta quaternion (change since last frame)
        float dw, dx, dy, dz;
        quatDelta(qw, qx, qy, qz, prevQw, prevQx, prevQy, prevQz, dw, dx, dy, dz);

        // Convert to angular velocity (radians/frame)
        float rx, ry, rz;
        deltaToAngVel(dw, dx, dy, dz, rx, ry, rz);

        // Apply deadzone
        if (fabsf(rx) < DEADZONE_RAD) rx = 0;
        if (fabsf(ry) < DEADZONE_RAD) ry = 0;
        if (fabsf(rz) < DEADZONE_RAD) rz = 0;

        // Scale to SpaceMouse ±350 range and send
        int16_t smRx = toSM(rx);
        int16_t smRy = toSM(ry);
        int16_t smRz = toSM(rz);

        if (smRx != 0 || smRy != 0 || smRz != 0) {
            // Send zero translation + actual rotation
            sendTranslation(0, 0, 0);
            sendRotation(smRx, smRy, smRz);
            myCodeCell.LED(0, 20, 10);  // Teal = active
        } else {
            sendZero();
            myCodeCell.LED(0, 30, 0);   // Green = idle
        }

        // Store for next frame
        prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;
    }
}
