# Processamento Realtime Database → Firestore

O processamento (média, mediana, desvio padrão, mínimo, máximo e leituras fora dos limites) está em `flask_app.py`. Há duas formas de executá-lo:

## A) `worker.py` — loop local (mais simples)

Roda em qualquer máquina com Python e a chave da conta de serviço em `serviceAccountKey.json` (nesta pasta):

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python worker.py      # um ciclo a cada 60 s (INTERVAL no topo do arquivo)
```

Cada ciclo lê as leituras novas de `/readings/{sala}`, grava no Firestore (leituras, `stats`, `daily`, `summary/latest`, `cycles`) e só depois apaga do RTDB o que já foi processado, mantendo a leitura mais recente.

## B) Flask no PythonAnywhere + agendador externo

O plano gratuito do PythonAnywhere não mantém processos longos, então um agendador externo (ex.: cron-job.org) chama `POST /run` a cada minuto.

1. Web → Add a new web app → Flask. Envie `flask_app.py` e `serviceAccountKey.json`.
2. Console Bash: `pip install --user google-auth requests`.
3. No arquivo WSGI, defina o token **antes** do import:
   ```python
   import os, sys
   os.environ["JOB_TOKEN"] = "UM-TEXTO-LONGO-E-ALEATORIO"
   sys.path.insert(0, "/home/SEUUSUARIO/mysite")
   from flask_app import application
   ```
4. Confira `DATABASE_URL` em `flask_app.py` e faça o Reload.
5. Teste sem gravar: `curl -X POST -H "X-Job-Token: ..." "https://SEUUSUARIO.pythonanywhere.com/run?dry_run=1"`
6. No cron-job.org: método **POST**, cabeçalho `X-Job-Token`, a cada 1 minuto.

> Nunca versione o `serviceAccountKey.json`. Sem a variável `JOB_TOKEN`, o `/run` responde 503.
