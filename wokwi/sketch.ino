// Monitoramento de 2 salas: 2x DHT22 -> Firebase Realtime Database (REST)
// Wokwi: ESP32 DevKit C v4. Wi-Fi "Wokwi-GUEST" (sem senha, canal 6).
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>

// ---- configuracao ----
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
// URL do Realtime Database, sem barra no final
const char* DB_URL = "https://temperatura-wokwi-default-rtdb.firebaseio.com";
// 15 s => ~11,5 mil escritas/dia no Firestore (cota gratuita: 20 mil). Nao diminuir.
const unsigned long INTERVAL_MS = 15000;

struct Room {
  const char* id;     // chave em /readings/{id}
  uint8_t pin;
  DHT dht;
  Room(const char* i, uint8_t p) : id(i), pin(p), dht(p, DHT22) {}
};

Room rooms[] = { Room("sala1", 15), Room("sala2", 4) };
const int ROOM_COUNT = sizeof(rooms) / sizeof(rooms[0]);

unsigned long lastSend = 0;

void connectWifi() {
  Serial.print("Conectando ao Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.println(" ok");
}

// POST em /readings/{sala}.json cria um no com chave unica (push id).
// O timestamp e preenchido pelo servidor ({".sv":"timestamp"}), entao nao precisa de NTP.
bool sendReading(const char* roomId, float t, float h) {
  WiFiClientSecure client;
  client.setInsecure();  // demo: nao valida o certificado
  HTTPClient http;
  String url = String(DB_URL) + "/readings/" + roomId + ".json";
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");

  char body[128];
  snprintf(body, sizeof(body),
           "{\"temperature\":%.1f,\"humidity\":%.1f,\"timestamp\":{\".sv\":\"timestamp\"}}", t, h);
  int code = http.POST((uint8_t*)body, strlen(body));
  Serial.printf("[%s] T=%.1fC H=%.1f%% -> HTTP %d\n", roomId, t, h, code);
  http.end();
  return code == 200;
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < ROOM_COUNT; i++) rooms[i].dht.begin();
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  if (millis() - lastSend >= INTERVAL_MS || lastSend == 0) {
    lastSend = millis();
    for (int i = 0; i < ROOM_COUNT; i++) {
      float t = rooms[i].dht.readTemperature();
      float h = rooms[i].dht.readHumidity();
      if (isnan(t) || isnan(h)) {
        Serial.printf("[%s] falha na leitura do DHT22\n", rooms[i].id);
        continue;
      }
      sendReading(rooms[i].id, t, h);
    }
  }
}
