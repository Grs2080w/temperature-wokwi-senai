# Wokwi

1. https://wokwi.com → New project → **ESP32**.
2. Substitua `sketch.ino`, `diagram.json` e `libraries.txt` pelos arquivos desta pasta.
3. Em `sketch.ino`, confira `DB_URL` (URL do Realtime Database, sem barra no final).
4. Play. O monitor serial mostra `[sala1] T=22.0C H=45.0% -> HTTP 200` a cada 15 s.

| Sala | Sensor | Pino |
|---|---|---|
| sala1 | DHT22 `dht1` | GPIO 15 |
| sala2 | DHT22 `dht2` | GPIO 4 |

Para simular alerta: clique no DHT22 durante a simulação e mude temperatura/umidade (ex.: 30 °C).

`HTTP 401/permission denied` = regras do RTDB não publicadas; `HTTP -1` = sem Wi-Fi/URL errada.
