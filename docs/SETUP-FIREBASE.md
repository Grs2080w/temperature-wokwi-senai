# Configurar Firebase (Firestore + Realtime Database + Auth)

Projeto já existente: **temperatura-wokwi** (vem do `serviceAccountKey.json`).

## 1. Console (https://console.firebase.google.com → temperatura-wokwi)

1. **Build → Authentication → Get started → Sign-in method → E-mail/senha → Ativar.**
2. **Build → Firestore Database → Create database** → modo produção, região `southamerica-east1` (São Paulo).
3. **Build → Realtime Database → Create database** → modo bloqueado (as regras abaixo substituem).
   Copie a URL que aparece no topo, ex.: `https://temperatura-wokwi-default-rtdb.firebaseio.com`
   (se a região não for EUA, a URL é `https://temperatura-wokwi-default-rtdb.<regiao>.firebasedatabase.app`).
4. **Project settings (engrenagem) → Your apps → Web (`</>`)** → registrar app → copiar o objeto `firebaseConfig`.
   Esses valores vão no `frontend/.env` (não são segredos; a proteção são as regras).

## 2. O que cada parte precisa

| Parte | O que usa |
|---|---|
| **Wokwi** (ESP32) | Só a URL do RTDB (`DB_URL` no sketch). Sem credencial: a regra permite POST em `readings/sala1|sala2` |
| **Flask / PythonAnywhere** | `serviceAccountKey.json` (Project settings → Service accounts → Generate new private key) + `DATABASE_URL`. A conta de serviço ignora as regras |
| **Frontend** | `apiKey, authDomain, databaseURL, projectId, appId` (`frontend/.env`) |
| **Segredo do cron** | `JOB_TOKEN` (cabeçalho `X-Job-Token`) |

> A chave da conta de serviço é uma credencial de administrador. Nunca commitar (`.gitignore` já cobre).
> Se ela já foi compartilhada/commitada, gere outra e revogue a antiga.

## 3. Regras

Arquivos prontos neste repositório: `database.rules.json` e `firestore.rules`.

```bash
npm i -g firebase-tools
firebase login
firebase use temperatura-wokwi
firebase deploy --only firestore:rules,database
```

(ou cole o conteúdo de cada arquivo no console → aba Regras → Publicar).

## 4. Primeiro administrador

Toda conta nova é criada como `user` (a regra impede criar já como admin).

1. Abra o frontend e crie uma conta (aba "Criar conta").
2. Console → Firestore → coleção `users` → documento com o UID da conta → altere o campo `role` para `admin`.
3. A partir daí esse admin promove/rebaixa os outros pela tela **Configurações**.

## 5. Índices

Todas as consultas usam um único campo (filtro + ordenação no mesmo campo): não precisam de índice composto.

## 6. (Opcional) Expirar leituras brutas

O Flask grava `expireAt` em cada leitura (30 dias). Para apagar automaticamente:
Firestore → TTL → Create policy → coleção `readings` (grupo de coleções), campo `expireAt`.
