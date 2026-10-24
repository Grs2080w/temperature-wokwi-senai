"""Loop simples: a cada INTERVAL segundos le o Realtime Database, calcula e grava no Firestore.

    python worker.py            (Ctrl+C para parar)

Usa o mesmo processamento do flask_app.py (precisa estar na mesma pasta, junto do
serviceAccountKey.json).
"""
import sys
import time
import traceback
from pathlib import Path

try:
    HERE = Path(__file__).resolve().parent
except NameError:  # rodando via exec() no console: usa a pasta atual
    HERE = Path.cwd()
sys.path.insert(0, str(HERE))  # acha o flask_app.py ao lado
import flask_app

INTERVAL = 60  # segundos entre ciclos

while True:
    try:
        result = flask_app.run_once()
        for room in result["rooms"]:
            print(f"{time.strftime('%H:%M:%S')} {room['room']}: {room['new']} novas, {room['deleted']} apagadas")
        for err in result["errors"]:
            print(f"{time.strftime('%H:%M:%S')} ERRO {err['room']}: {err['error']}")
        if result.get("skipped"):
            print(f"{time.strftime('%H:%M:%S')} {result['skipped']}")
    except Exception:
        traceback.print_exc()
    time.sleep(INTERVAL)
