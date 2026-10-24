# Plano — Monitoramento de temperatura e umidade (2 salas)

## 1. Arquitetura

```
Wokwi (ESP32 + 2x DHT22)
   │  HTTPS POST (REST) a cada 15 s
   ▼
Realtime Database  readings/{sala1|sala2}/{pushId} = {temperature, humidity, timestamp}
   │   ▲ leitura ao vivo (onChildAdded)
   │   │
   │   └──────────────────────────────┐
   ▼ cron-job.org chama POST /run     │
Flask (PythonAnywhere) a cada 1 min   │
   - lê readings novas, calcula média/mediana/desvio/min/max/fora dos limites
   - grava no Firestore, apaga do RTDB o que já processou (mantém a última)
   ▼                                  │
Firestore                             │
   rooms/{sala}                     (nome + limites, editável pelo admin)
   rooms/{sala}/readings/{id}       leituras brutas (histórico fino)
   rooms/{sala}/stats/{ts}          resumo de cada ciclo (mean, median, stdDev, sum, sumSquares…)
   rooms/{sala}/summary/latest      último resumo
   rooms/{sala}/daily/{AAAA-MM-DD}  acumulado do dia
   cycles/{id}                      média do ciclo com as duas salas
   users/{uid}                      {email, role: admin|user}
   ▲                                  │
   └──────── Frontend (Vite + JS + Chart.js, Firebase Hosting) ◄─┘
             Auth (e-mail/senha) + papéis admin/user
```

**Por que dois bancos:** o Realtime Database tem latência mínima e serve ao vivo; o Firestore guarda
histórico consultável por período e as configurações com regras por papel. O Flask faz a ponte
(requisito do PROJECT.md).

## 2. Decisões

| Tema | Decisão |
|---|---|
| Faixas padrão | Temp 18–25 °C, Umidade 30–60 % (já em `DEFAULT_LIMITS` do Flask); admin altera na tela |
| Alerta | Leitura < mín ou > máx → card vermelho + faixa de alerta no topo; sensor sem dados > 90 s → "Sem dados" |
| Estatísticas | Média, mediana, desvio padrão (amostral, n−1) por sala/variável: janela ao vivo (cliente), resumo do último ciclo e acumulado do dia (Flask), período do histórico |
| Histórico | ≤ 6 h usa leituras brutas; acima disso usa os resumos `stats` (média exata via soma/soma dos quadrados; mediana aproximada) |
| Papéis | `admin`: edita limites e papéis; `user`: só leitura. Imposto nas **regras do Firestore**, não só na interface |
| Cota gratuita | Firestore: 20 mil escritas/dia. 2 salas × 1 leitura/15 s = 11,5 mil/dia → cabe. Não diminuir o intervalo |
| Gravação pelo Wokwi | Regra do RTDB aceita POST sem login só em `readings/sala1|sala2` com validação de tipo/faixa. Para produção: autenticar o dispositivo |

## 3. Etapas

1. **Firebase** — criar projeto, Auth, Firestore, RTDB, regras (`docs/SETUP-FIREBASE.md`).
2. **Wokwi** — `wokwi/` (sketch, diagram.json, libraries.txt).
3. **PythonAnywhere** — `pythonanywhere/` (reaproveitado; ajustes: token por variável de ambiente, requirements, .gitignore, README).
4. **Frontend** — `frontend/`: login, painel ao vivo, histórico/análise, configurações (admin).
5. **Deploy e teste ponta a ponta** — `firebase deploy`, cron-job.org, rodar o Wokwi, forçar valores fora da faixa.
