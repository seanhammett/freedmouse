// Quick utility: prints this board's MAC address over Serial repeatedly.
// Upload with: pio run -e mac-check -t upload

#include <Arduino.h>
#include <WiFi.h>

void setup() {
    Serial.begin(115200);
    delay(2000);
    WiFi.mode(WIFI_STA);
}

void loop() {
    Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
    delay(1000);
}
