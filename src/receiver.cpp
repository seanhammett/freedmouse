// USB_freeD — ESP-NOW Receiver + SpaceMouse HID (ESP32-S3-DevKitC-1, WROOM-2)
// Receives quaternion data over ESP-NOW, converts to angular velocity,
// and presents as a 3DConnexion SpaceMouse Pro Wireless over USB HID.
//
// Install 3DxWare driver on your PC for Onshape/CAD integration.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
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
// Proportional velocity controller (redesigned 2026-07-17 from closed-loop
// capture usb-freed-diag-1784206891821). The old mapping put FULL HID
// deflection at just 0.05 rad (2.9°) of error — bang-bang control that,
// with ~150 ms of loop dead time, limit-cycled at 2-5 Hz (measured 70-160°/s
// sustained wobble around a static target) and capped top speed at the same
// 0.05 rad/10ms ceiling (measured 291°/s max). Now: commanded angular
// VELOCITY is proportional to error, saturating only for errors > ~72°.
//   error 3° → ~12°/s, error 10° → ~40°/s, error ≥72° → 286°/s (full).
// Constants below are MEASURED, not guessed — staircase calibration
// 2026-07-17 (diagnostics/usb-freed-diag-1784276618596.json, tools/analyze_cal.js):
//   HID→velocity: ~0.48 °/s per HID unit (linear to ~200 units; ~0.7 at 350)
//   loop dead time: 58 ms median (command → observed view motion)
//   driver deadband: below ~150 units the response is erratic (sometimes 0)
static const float KP_PER_S       = 5.0f;   // commanded rad/s per rad of error.
                                            // Stability: KP_PER_S × loop dead time < ~1.
                                            // τ ≈ 58 ms plant + ~45 ms EMA lag → product ≈ 0.5.
static const float VEL_MAX_RAD_S  = 2.94f;  // 350 HID units on the measured linear slope
                                            // (real speed at 350 is ~4.2 rad/s — superlinear top end).
static const float CONVERGENCE_ZONE_RAD = 0.050f; // ~2.9 deg. When error < this AND not growing, suppress command.
                                                   // Prevents piling up commands while Onshape is already arriving.
static const float ABS_ROT_SCALE = 350.0f / VEL_MAX_RAD_S;  // ≈119 HID units per commanded rad/s (measured slope)
// Hysteresis deadzone (Schmitt trigger): start correcting only above ENTER,
// keep correcting down to EXIT, then stop until ENTER is crossed again.
// A single threshold hunts when the driver's response curve enforces a
// minimum output speed; hysteresis gives 0.6° final repeatability without a
// limit cycle around the boundary.
static const float DEADZONE_ENTER_RAD = 0.026f;  // ~1.5° — begin correcting
static const float DEADZONE_EXIT_RAD  = 0.010f;  // ~0.6° — stop correcting
static const float SMOOTH_ALPHA  = 0.40f;    // EMA on error velocity. Lower = more damping.
                                              // Raised from 0.28: the EMA's ~2.5-sample lag is part of the
                                              // loop dead time that drives oscillation.
static const unsigned long IDLE_TIMEOUT_MS = 80;  // zero-out HID after no packets

// Error→HID axis map, measured by the cal staircase (coherence 1.00 on all
// 24 phases, invariant to view orientation — a fixed Y-up/Z-up mismatch):
//   HID +x rotates the view about +x
//   HID +y rotates the view about +z
//   HID +z rotates the view about −y
// So a desired view-frame rotation (rx, ry, rz) must be sent as
// (hidX, hidY, hidZ) = (rx, rz, −ry). The old INVERT_* feel-tuned constants
// are gone — they were compensating this permutation on one axis and
// fighting it on the others, which is what cross-coupled the closed loop
// into its 2-5 Hz spiral.

// RGB LED heartbeat (ESP32-S3-DevKitC-1 built-in WS2812B NeoPixel on GPIO 48)
static const uint8_t RGB_LED_PIN = 48;

// =================== GLOBALS ===================
USBHID        usbHID;
SpaceMouseHID smDevice;
USBCDC        USBSerial;  // CDC-ACM interface — composite with HID, same cable

// Heartbeat state
unsigned long lastHeartbeatMs = 0;

// ---- Safe CDC output ----
// Two hard constraints discovered in the field (2026-07-16):
//  1. USBCDC::write() spins FOREVER when the host stops draining the FIFO
//     while DTR stays asserted — setTxTimeoutMs() only bounds the mutex
//     take, not the copy loop. Decoded WDT backtrace: loop() →
//     Print::printf → USBCDC::write, 4s task-watchdog panic.
//  2. The core's CDC TX FIFO is only 64 bytes (CONFIG_TINYUSB_CDC_TX_BUFSIZE
//     in the prebuilt esp32-arduino-libs), SMALLER THAN EVERY LINE WE PRINT.
//     A whole-line availableForWrite() pre-check therefore drops 100% of
//     output — which is why four diag captures in a row had zero TL lines.
// So: lines are queued whole into this software ring and cdcPump() dribbles
// them into the FIFO in ≤availableForWrite() chunks from loop(). Nothing
// ever blocks; sustained throughput is ~64 B/ms, far above telemetry rate.
static const size_t CDC_RING_SIZE = 4096;
static uint8_t cdcRing[CDC_RING_SIZE];
static size_t cdcRingHead = 0;   // write index
static size_t cdcRingTail = 0;   // read index
static size_t cdcRingCount = 0;
uint32_t cdcDroppedLines = 0;

static void cdcPrintf(const char* fmt, ...) {
    char buf[240];
    va_list args;
    va_start(args, fmt);
    int len = vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    if (len <= 0) return;
    if (len > (int)sizeof(buf) - 1) len = (int)sizeof(buf) - 1;
    if ((size_t)len > CDC_RING_SIZE - cdcRingCount) {
        cdcDroppedLines++;  // ring full (host absent or slow) — drop whole line
        return;
    }
    for (int i = 0; i < len; i++) {
        cdcRing[cdcRingHead] = (uint8_t)buf[i];
        cdcRingHead = (cdcRingHead + 1) % CDC_RING_SIZE;
    }
    cdcRingCount += (size_t)len;
}

static void cdcPump() {
    while (cdcRingCount > 0) {
        int avail = USBSerial.availableForWrite();
        if (avail <= 0) return;  // FIFO full or host not connected
        size_t n = (size_t)avail;
        if (n > cdcRingCount) n = cdcRingCount;
        if (n > CDC_RING_SIZE - cdcRingTail) n = CDC_RING_SIZE - cdcRingTail;  // contiguous run
        size_t w = USBSerial.write(cdcRing + cdcRingTail, n);
        if (w == 0) return;
        cdcRingTail = (cdcRingTail + w) % CDC_RING_SIZE;
        cdcRingCount -= w;
        if (w < n) return;
    }
}

// Latest received sample (atomic handoff from ESP-NOW callback to main loop)
struct RxSample {
    float qw;
    float qx;
    float qy;
    float qz;
    uint8_t flags;
    uint8_t seq;
    uint8_t bootId;
    unsigned long recvMs;
};

portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
volatile RxSample latestSample = {1.0f, 0.0f, 0.0f, 0.0f, 0, 0, 0, 0};
volatile bool sampleReady = false;
volatile unsigned long lastRecvTime = 0;

// Sequence tracking (for packet loss/reorder diagnostics)
bool hasLastSeq = false;
uint8_t lastSeq = 0;
uint32_t droppedPacketCount = 0;
uint32_t outOfOrderPacketCount = 0;

// Link diagnostics — printed at 1 Hz from loop()
volatile uint32_t rxPacketCount = 0;
uint32_t hidReportCount = 0;
unsigned long lastRxStatsMs = 0;

// Closed-loop telemetry for the extension's system recorder: one "TL,..."
// CSV line per interval carrying the receiver's full control state. Only
// emitted while a serial target lock is active (i.e. the loop is closed).
static const uint16_t TELEM_INTERVAL_MS = 20;  // 50 Hz
unsigned long lastTelemMs = 0;

// Sender reboot tracking: the packet carries a random per-boot ID. When it
// changes, the sender's BNO085 restarted with a fresh yaw reference — qDev
// is suddenly in a new frame and the old qHome is meaningless. Field capture
// 2026-07-16: a boot-looping sender (3-7s gaps, seq resets) made Onshape
// swing to a random orientation after every gap.
uint8_t  lastSenderBootId = 0;
uint32_t senderRebootCount = 0;

// Last computed target (qDev relative to home) — used to re-anchor qHome
// across sender reboots so the view target stays continuous.
float qTgtLastW = 1.0f, qTgtLastX = 0.0f, qTgtLastY = 0.0f, qTgtLastZ = 0.0f;

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
        out.bootId = latestSample.bootId;
        out.recvMs = latestSample.recvMs;
        sampleReady = false;
        hasData = true;
    }
    portEXIT_CRITICAL(&rxMux);
    return hasData;
}

// =================== HID SEND ===================
// All HID sends are guarded by ready() and use a short timeout. SendReport's
// default behavior can block waiting on the interrupt endpoint; combined with
// CDC traffic at closed-loop rates that can wedge loop() — the device stays
// enumerated (TinyUSB task lives) but stops producing reports entirely.
static const uint32_t HID_SEND_TIMEOUT_MS = 5;
uint32_t hidSkippedCount = 0;

static bool hidWrite(uint8_t reportId, const uint8_t* data, size_t len) {
    if (!usbHID.ready()) {
        hidSkippedCount++;
        return false;
    }
    return usbHID.SendReport(reportId, data, len, HID_SEND_TIMEOUT_MS);
}

void sendRotation(int16_t rx, int16_t ry, int16_t rz) {
    uint8_t data[6];
    memcpy(&data[0], &rx, 2);
    memcpy(&data[2], &ry, 2);
    memcpy(&data[4], &rz, 2);
    hidWrite(0x02, data, 6);
}

bool sendTranslation(int16_t x, int16_t y, int16_t z) {
    uint8_t data[6];
    memcpy(&data[0], &x, 2);
    memcpy(&data[2], &y, 2);
    memcpy(&data[4], &z, 2);
    return hidWrite(0x01, data, 6);
}

// Zeroing must be RELIABLE: if the final zero after a motion burst is
// dropped (endpoint busy), the driver holds the last nonzero rotation and
// the view spins forever. So zeroing is a *request* retried every loop()
// until both reports actually go out.
bool zeroRotPending = false;
bool zeroTraPending = false;
bool traZeroSentForBurst = false;

void sendZero() {
    zeroRotPending = true;
    zeroTraPending = true;
}

void flushPendingZeros() {
    int16_t z[3] = {0, 0, 0};
    if (zeroTraPending && hidWrite(0x01, (uint8_t*)z, 6)) zeroTraPending = false;
    if (zeroRotPending && hidWrite(0x02, (uint8_t*)z, 6)) zeroRotPending = false;
}

// =================== HEARTBEAT LED ===================
// Brief green blip every 2 seconds
void updateHeartbeat() {
    unsigned long t = millis() % 2000;
    uint8_t brightness = 0;

    if (t < 60)        brightness = (uint8_t)(t * 255 / 60);
    else if (t < 120)  brightness = (uint8_t)((120 - t) * 255 / 60);

    // Only touch the LED when the value changes — loop() runs at ~1 kHz and
    // each neopixelWrite is a blocking RMT transaction.
    static uint8_t lastBrightness = 255;
    if (brightness != lastBrightness) {
        lastBrightness = brightness;
        neopixelWrite(RGB_LED_PIN, 0, brightness, 0);
    }
}

// =================== CALIBRATION MODE ===================
// Plant identification: drive a deterministic open-loop HID staircase (each
// rotation axis, ± several magnitudes, fixed hold/gap timing) while the
// extension records Onshape's true response. Offline analysis of one capture
// yields the actual HID→velocity curve and loop dead time. Field data
// 2026-07-16 showed the view moving ~15× faster than the commanded velocity
// for small errors — the control loop cannot be tuned until this curve is
// measured instead of assumed.
static bool calActive = false;
static uint8_t calPhase = 0;
static unsigned long calPhaseStartMs = 0;
static bool calDriving = false;
static unsigned long calLastSendMs = 0;

static const int16_t CAL_MAGS[] = {50, 100, 200, 350};
static const uint8_t CAL_NUM_MAGS = 4;
static const uint8_t CAL_PHASES = 3 * CAL_NUM_MAGS * 2;  // axis × magnitude × sign
static const unsigned long CAL_HOLD_MS = 1200;
static const unsigned long CAL_GAP_MS  = 500;

static void calPhaseValue(uint8_t phase, uint8_t& axis, int16_t& value) {
    axis = phase / (CAL_NUM_MAGS * 2);
    const uint8_t rem = phase % (CAL_NUM_MAGS * 2);
    const int16_t mag = CAL_MAGS[rem / 2];
    // + then − at each magnitude, so the view roughly returns to where it was
    value = (rem % 2 == 0) ? mag : (int16_t)-mag;
}

static void handleCalCommand(uint8_t cmd) {
    if (cmd == CAL_CMD_START_ROT && !calActive) {
        calActive = true;
        calPhase = 0;
        calDriving = true;
        calPhaseStartMs = millis();
        calLastSendMs = 0;
        uint8_t ax; int16_t v;
        calPhaseValue(0, ax, v);
        cdcPrintf("CAL,%lu,start\n", millis());
        cdcPrintf("CAL,%lu,%c,%d\n", millis(), "xyz"[ax], (int)v);
        Serial0.println("[CAL] staircase started");
    } else if (cmd == CAL_CMD_ABORT && calActive) {
        calActive = false;
        sendZero();
        cdcPrintf("CAL,%lu,abort\n", millis());
        Serial0.println("[CAL] aborted");
    }
}

static void runCalibration() {
    const unsigned long now = millis();
    const unsigned long elapsed = now - calPhaseStartMs;
    uint8_t ax; int16_t v;
    calPhaseValue(calPhase, ax, v);

    if (calDriving) {
        if (elapsed >= CAL_HOLD_MS) {
            calDriving = false;
            calPhaseStartMs = now;
            sendZero();
            cdcPrintf("CAL,%lu,zero\n", now);
        } else if (now - calLastSendMs >= 20) {
            // Refresh the report so the driver keeps applying the velocity
            calLastSendMs = now;
            int16_t r[3] = {0, 0, 0};
            r[ax] = v;
            sendRotation(r[0], r[1], r[2]);
            hidReportCount++;
        }
    } else if (elapsed >= CAL_GAP_MS) {
        calPhase++;
        if (calPhase >= CAL_PHASES) {
            calActive = false;
            sendZero();
            cdcPrintf("CAL,%lu,done\n", now);
            Serial0.println("[CAL] done");
            return;
        }
        calDriving = true;
        calPhaseStartMs = now;
        calLastSendMs = 0;
        calPhaseValue(calPhase, ax, v);
        cdcPrintf("CAL,%lu,%c,%d\n", now, "xyz"[ax], (int)v);
    }
}

// =================== SERIAL TARGET PACKET PARSER ===================
// Reads all buffered Serial bytes, syncs on TARGET_HEADER (0xBB), accumulates
// TARGET_PACKET_SIZE bytes, verifies checksum, then anchors qView.
void processSerialInput() {
    while (USBSerial.available() > 0) {
        uint8_t b = (uint8_t)USBSerial.read();

        // If not yet started, wait for a known header byte
        if (tgtBufIdx == 0) {
            if (b != TARGET_HEADER && b != CAL_HEADER) continue;
        }

        tgtBuf[tgtBufIdx++] = b;

        const uint8_t need = (tgtBuf[0] == CAL_HEADER) ? CAL_PACKET_SIZE
                                                       : TARGET_PACKET_SIZE;
        if (tgtBufIdx < need) continue;

        // Full packet accumulated — verify
        tgtBufIdx = 0;

        if (tgtBuf[0] == CAL_HEADER) {
            if ((uint8_t)(CAL_HEADER ^ tgtBuf[1]) == tgtBuf[2]) {
                handleCalCommand(tgtBuf[1]);
            }
            continue;
        }

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
    latestSample.bootId = p->bootId;
    latestSample.recvMs = nowMs;
    sampleReady = true;
    lastRecvTime = nowMs;
    portEXIT_CRITICAL(&rxMux);
    rxPacketCount++;
}

// =================== SETUP ===================
void setup() {
    // Crash forensics FIRST — the reset reason gates USB recovery below.
    const esp_reset_reason_t rr = esp_reset_reason();
    const bool crashed = (rr == ESP_RST_PANIC || rr == ESP_RST_INT_WDT ||
                          rr == ESP_RST_TASK_WDT || rr == ESP_RST_WDT);

    if (crashed) {
        // A panic/WDT reboot is only a CPU reset: the USB PHY keeps D+
        // pulled up, so the host never sees a disconnect and won't
        // re-enumerate the rebooted device (observed 2026-07-16: hidReady=0
        // forever after a WDT panic). Drive the data lines low briefly so
        // the host registers a real detach before we bring USB back up.
        pinMode(19, OUTPUT);  // USB D-
        pinMode(20, OUTPUT);  // USB D+
        digitalWrite(19, LOW);
        digitalWrite(20, LOW);
        delay(250);
    }

    // --- USB composite device: HID (SpaceMouse) + CDC-ACM (serial) ---
    // VID/PID must be set before USB.begin(); with ARDUINO_USB_CDC_ON_BOOT=0
    // the framework never calls USB.begin() automatically, so we control it here.
    USB.VID(0x256F);                          // 3Dconnexion vendor ID
    USB.PID(0xC631);                          // SpaceMouse Pro Wireless
    USB.productName("SpaceMouse Pro Wireless");
    USB.manufacturerName("3Dconnexion");

    usbHID.addDevice(&smDevice, sizeof(SM_REPORT_DESC));
    USBSerial.begin(115200);  // registers CDC interface before USB.begin()
    // Zero TX timeout bounds the tx-lock take inside USBCDC. It does NOT
    // make write() non-blocking (its copy loop retries forever on a full
    // FIFO) — that protection lives in cdcPrintf()'s space pre-check.
    USBSerial.setTxTimeoutMs(0);
    USB.begin();
    usbHID.begin();

    delay(2000);  // wait for USB enumeration

    // UART0 (the board's second USB connector) carries boot/crash forensics
    // and mirrored stats — panic backtraces land there too. This is how to
    // watch the receiver while the native port is busy being the SpaceMouse.
    Serial0.begin(115200);

    // Crash forensics: report WHY we booted. A panic/watchdog reset right
    // after closed-loop use is the signature of a firmware crash; flash red
    // so it's visible with no serial monitor attached at all.
    if (crashed) {
        for (int i = 0; i < 6; i++) {
            neopixelWrite(RGB_LED_PIN, 60, 0, 0);
            delay(150);
            neopixelWrite(RGB_LED_PIN, 0, 0, 0);
            delay(150);
        }
    }

    // --- ESP-NOW ---
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);
    // Pin the radio to the shared channel and disable modem sleep — a
    // sleeping STA radio silently drops ESP-NOW frames.
    WiFi.setSleep(false);
    esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

    cdcPrintf("\n=== USB_freeD — ESP-NOW Receiver + SpaceMouse HID ===\n");
    cdcPrintf("[BOOT] reset reason: %d%s\n", (int)rr, crashed ? " (CRASH!)" : "");
    cdcPrintf("[INFO] Receiver MAC: %s\n", WiFi.macAddress().c_str());
    Serial0.println("\n=== USB_freeD receiver (UART mirror) ===");
    Serial0.printf("[BOOT] reset reason: %d%s\n", (int)rr, crashed ? " (CRASH!)" : "");

    if (esp_now_init() != ESP_OK) {
        cdcPrintf("[FAIL] ESP-NOW init failed!\n");
        Serial0.println("[FAIL] ESP-NOW init failed!");
        while (true) delay(1000);
    }

    esp_now_register_recv_cb(onDataRecv);

    cdcPrintf("[OK] ESP-NOW ready — waiting for IMU data...\n");
    cdcPrintf("[OK] USB HID SpaceMouse ready\n");

    // Task watchdog on the loop task: the field failure mode is loop()
    // silently blocking (device stays enumerated, HID goes dead). With the
    // WDT armed, any >4s stall panics WITH A BACKTRACE naming the blocked
    // call (on UART0), then reboots into a working state — self-diagnosing
    // and self-recovering instead of freezing until power-cycle.
    esp_task_wdt_config_t wdtCfg = {
        .timeout_ms = 4000,
        .idle_core_mask = 0,
        .trigger_panic = true,
    };
    if (esp_task_wdt_reconfigure(&wdtCfg) != ESP_OK) {
        esp_task_wdt_init(&wdtCfg);
    }
    if (esp_task_wdt_add(NULL) == ESP_OK) {
        Serial0.println("[OK] loop watchdog armed (4s)");
    } else {
        Serial0.println("[WARN] loop watchdog not armed");
    }
}

// How long the serial ground truth may go quiet before the receiver reverts
// to open-loop mode. Field capture 2026-07-16: a ~1s USB stall killed the
// extension's serial stream while hasTargetLock stayed true forever — HID
// commands are gated on new serial packets in closed loop, so the device
// went permanently mute despite a healthy loop and live ESP-NOW.
static const unsigned long TARGET_LOCK_TIMEOUT_MS = 500;

// =================== MAIN LOOP ===================
void loop() {
    esp_task_wdt_reset();

    // Always drain serial first — anchors qView before IMU error calculation
    processSerialInput();

    // Serial ground truth gone quiet → open loop. The extension auto-
    // reconnects and the next valid packet re-enters closed loop seamlessly.
    if (hasTargetLock && (millis() - lastTargetMs) > TARGET_LOCK_TIMEOUT_MS) {
        hasTargetLock = false;
        newSerialPacketReady = false;
        Serial0.println("[TGT] target lock lost (serial quiet) — open loop");
    }

    // Calibration overrides normal control: known HID staircase, IMU ignored.
    // Samples are still popped so the latest-sample slot doesn't go stale.
    if (calActive) {
        runCalibration();
        RxSample discard;
        popLatestSample(discard);
        cdcPump();
        flushPendingZeros();
        updateHeartbeat();
        delay(1);
        return;
    }

    RxSample sample;
    if (popLatestSample(sample)) {
        // Snapshot latest received data
        float qw = sample.qw, qx = sample.qx, qy = sample.qy, qz = sample.qz;
        uint8_t flags = sample.flags;
        uint8_t seq = sample.seq;
        bool stalePacket = false;

        // Sender reboot: its BNO085 restarted with a new yaw reference, so
        // qDev jumped to an unrelated frame. Re-anchor qHome so the current
        // target is preserved (qHome = conj(qTgtLast) ⊗ qDev) — the view
        // stays put instead of swinging to a random orientation.
        if (lastSenderBootId != 0 && sample.bootId != lastSenderBootId) {
            senderRebootCount++;
            if (hasHome) {
                quatMul(qTgtLastW, -qTgtLastX, -qTgtLastY, -qTgtLastZ,
                        sample.qw, sample.qx, sample.qy, sample.qz,
                        qHomeW, qHomeX, qHomeY, qHomeZ);
                quatNorm(qHomeW, qHomeX, qHomeY, qHomeZ);
            }
            // FF derivative and seq history straddle the discontinuity — reset both
            hasDevPrev = false;
            omegaFFx = omegaFFy = omegaFFz = 0.0f;
            hasLastSeq = false;
            char msg[80];
            snprintf(msg, sizeof(msg), "[RX] sender reboot #%lu — home re-anchored",
                     (unsigned long)senderRebootCount);
            cdcPrintf("%s\n", msg);
            Serial0.println(msg);
        }
        lastSenderBootId = sample.bootId;

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
                // Home == device ⇒ target is identity
                qTgtLastW = 1.0f; qTgtLastX = qTgtLastY = qTgtLastZ = 0.0f;
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

        // 20 Hz FF diagnostic — open loop only (closed loop emits TL telemetry)
        static unsigned long lastFFLogMs = 0;
        if (!hasTargetLock && sampleMs - lastFFLogMs >= 50) {
            lastFFLogMs = sampleMs;
            cdcPrintf("[FF] wx=%+.2f wy=%+.2f wz=%+.2f rad/s\n",
                      omegaFFx, omegaFFy, omegaFFz);
        }

        // Target: device orientation relative to home reference
        // qTarget = qDevice * conj(qHome)
        float twW, twX, twY, twZ;
        quatDelta(qw, qx, qy, qz, qHomeW, qHomeX, qHomeY, qHomeZ, twW, twX, twY, twZ);
        quatNorm(twW, twX, twY, twZ);
        // Remember the target so a sender reboot can re-anchor home onto it
        qTgtLastW = twW; qTgtLastX = twX; qTgtLastY = twY; qTgtLastZ = twZ;

        // Error: how much more Onshape needs to rotate to reach the target
        // qError = qTarget * conj(qView)
        float ewW, ewX, ewY, ewZ;
        quatDelta(twW, twX, twY, twZ, qViewW, qViewX, qViewY, qViewZ, ewW, ewX, ewY, ewZ);
        quatNorm(ewW, ewX, ewY, ewZ);

        // Convert error quaternion to angular velocity (radians)
        float rx, ry, rz;
        deltaToAngVel(ewW, ewX, ewY, ewZ, rx, ry, rz);

        // Hysteresis deadzone: correct only while "correcting" is latched.
        float angMag = sqrtf(rx*rx + ry*ry + rz*rz);
        static bool correcting = false;
        if (!correcting && angMag > DEADZONE_ENTER_RAD) correcting = true;
        else if (correcting && angMag < DEADZONE_EXIT_RAD) correcting = false;
        if (!correcting) {
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

        // Proportional velocity command: vel = Kp × error, saturated at
        // VEL_MAX_RAD_S with axis ratios preserved (direction exact, speed
        // capped). Small error → slow approach → no limit cycle.
        float velScale = KP_PER_S;
        const float velMag = KP_PER_S * smoothMag;
        if (velMag > VEL_MAX_RAD_S && smoothMag > 1e-9f) {
            velScale = VEL_MAX_RAD_S / smoothMag;
        }

        int16_t smRx = 0, smRy = 0, smRz = 0;
        if (shouldSendHid) {
            // Measured map: (hidX, hidY, hidZ) = (rx, rz, −ry)
            smRx = toSM( smoothRx * velScale);
            smRy = toSM( smoothRz * velScale);
            smRz = toSM(-smoothRy * velScale);
        }

        // qView dead-reckoning: only when serial is NOT active.
        // With serial active, qView is set directly from ground truth each packet;
        // dead-reckoning would corrupt it between updates.
        // HID units decode to rad/s; one IMU frame is ~10ms of that velocity.
        if (!hasTargetLock && (smRx != 0 || smRy != 0 || smRz != 0)) {
            const float frameDt = 0.010f;
            // Inverse of the measured map: (rx, ry, rz) = (hidX, −hidZ, hidY)
            float cmdRx = ( (float)smRx / ABS_ROT_SCALE) * frameDt;
            float cmdRy = (-(float)smRz / ABS_ROT_SCALE) * frameDt;
            float cmdRz = ( (float)smRy / ABS_ROT_SCALE) * frameDt;
            float stepW, stepX, stepY, stepZ;
            angVelToQuat(cmdRx, cmdRy, cmdRz, stepW, stepX, stepY, stepZ);
            float nVW, nVX, nVY, nVZ;
            quatMul(stepW, stepX, stepY, stepZ, qViewW, qViewX, qViewY, qViewZ, nVW, nVX, nVY, nVZ);
            qViewW = nVW; qViewX = nVX; qViewY = nVY; qViewZ = nVZ;
            quatNorm(qViewW, qViewX, qViewY, qViewZ);
        }

            if (smRx != 0 || smRy != 0 || smRz != 0) {
                // Motion cancels any queued zeroing (a late zero after this
                // rotation would stop the view mid-move).
                zeroRotPending = false;
                zeroTraPending = false;
                // Translation is always 0 — send it once per motion burst
                // (retrying until accepted), not every frame: the interrupt
                // endpoint carries ~1 report per 10ms host poll, and per-frame
                // zero translations were consuming half of that budget.
                if (!motionActive) traZeroSentForBurst = false;
                if (!traZeroSentForBurst) traZeroSentForBurst = sendTranslation(0, 0, 0);
                sendRotation(smRx, smRy, smRz);
                hidReportCount++;
                motionActive = true;
            } else if (motionActive) {
                sendZero();
                motionActive = false;
            }

            // Closed-loop telemetry: device quat, view estimate, smoothed
            // error, HID command, gating flags. The extension's recorder
            // captures these lines alongside its own ground-truth stream so
            // the whole loop can be tuned offline from one JSON.
            // cdcPrintf drops the line when the FIFO is full rather than
            // stalling loop().
            if (hasTargetLock && (millis() - lastTelemMs) >= TELEM_INTERVAL_MS) {
                lastTelemMs = millis();
                cdcPrintf(
                    "TL,%lu,%u,%u,"
                    "%.4f,%.4f,%.4f,%.4f,"
                    "%.4f,%.4f,%.4f,%.4f,"
                    "%.4f,%.4f,%.4f,"
                    "%d,%d,%d,%d,%d,%d\n",
                    millis(), (unsigned)seq, (unsigned)lastTargetSeq,
                    qw, qx, qy, qz,
                    qViewW, qViewX, qViewY, qViewZ,
                    smoothRx, smoothRy, smoothRz,
                    (int)smRx, (int)smRy, (int)smRz,
                    (int)shouldSendHid, (int)converging, (int)motionActive);
            }
        }
    }

    // 1 Hz link stats: rx counting up proves the ESP-NOW link; hid counting
    // up while the device moves proves reports are being pushed to the host.
    // Mirrored to UART0 so the receiver can be watched on its second USB
    // connector while the native port is busy being the SpaceMouse.
    if (millis() - lastRxStatsMs >= 1000) {
        lastRxStatsMs = millis();
        char stats[200];
        snprintf(stats, sizeof(stats),
                 "[RX] pkts=%lu drops=%lu ooo=%lu sboot=%lu hid=%lu hidSkip=%lu hidReady=%d tgt=%d ageMs=%lu cdcDrop=%lu",
                 (unsigned long)rxPacketCount,
                 (unsigned long)droppedPacketCount,
                 (unsigned long)outOfOrderPacketCount,
                 (unsigned long)senderRebootCount,
                 (unsigned long)hidReportCount,
                 (unsigned long)hidSkippedCount,
                 (int)usbHID.ready(),
                 (int)hasTargetLock,
                 lastRecvTime ? (unsigned long)(millis() - lastRecvTime) : 0UL,
                 (unsigned long)cdcDroppedLines);
        cdcPrintf("%s\n", stats);
        Serial0.println(stats);
    }

    // If no data for IDLE_TIMEOUT_MS, send zero to stop any drift
    if (motionActive && (millis() - lastRecvTime > IDLE_TIMEOUT_MS)) {
        sendZero();
        motionActive = false;
    }

    // Retry any zero reports the endpoint refused earlier — a dropped final
    // zero means the view keeps rotating forever.
    flushPendingZeros();

    // Dribble queued CDC output into the 64-byte TX FIFO
    cdcPump();

    updateHeartbeat();
    delay(1);  // yield
}
