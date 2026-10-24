"""Monitoramento hospitalar: gatilho web (Flask no PythonAnywhere, Python 3.12).

Um cron externo (ex.: cron-job.org) chama:
    POST https://SEUUSUARIO.pythonanywhere.com/run      (cabecalho X-Job-Token)

Cada chamada roda CYCLES_PER_CALL ciclos, com SECONDS_BETWEEN_CYCLES de pausa entre
eles, respeitando MAX_REQUEST_SECONDS. Cada ciclo, para cada sala:
  - le as leituras novas de /readings/{sala} no Realtime Database;
  - calcula media, mediana, desvio padrao, minimo, maximo e leituras fora dos limites
    (limites vindos do Firestore: rooms/{sala});
  - grava no Firestore as leituras brutas e o resumo do periodo (stats);
  - atualiza o resumo mais recente (rooms/{sala}/summary/latest) e o acumulado do
    dia (rooms/{sala}/daily/{AAAA-MM-DD});
  - grava a media do ciclo com as duas salas em cycles/{cycleId};
  - so depois de gravar com sucesso, apaga do Realtime Database o que ja foi
    processado, mantendo apenas a leitura mais recente.

O PythonAnywhere nao suporta threads em web apps, entao o Flask dele nao consegue
repetir o job sozinho em segundo plano: quem dispara cada chamada e o cron externo.
"""
import fcntl
import hmac
import json
import math
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, abort, jsonify, request

# =====================================================================
#  CONFIGURACAO: edite aqui
# =====================================================================
DATABASE_URL = "https://temperatura-wokwi-default-rtdb.firebaseio.com"  # sem barra no final
SERVICE_ACCOUNT_FILE = "serviceAccountKey.json"   # na mesma pasta deste arquivo

# Protege o endereco /run. Defina a variavel de ambiente JOB_TOKEN (arquivo WSGI) com um
# texto longo e aleatorio; nunca deixe o token no codigo.
JOB_TOKEN = os.environ.get("JOB_TOKEN", "troque-este-token")

# ---- loop de cada chamada ao /run ----
CYCLES_PER_CALL = 1          # quantos ciclos rodar a cada chamada
SECONDS_BETWEEN_CYCLES = 10  # pausa entre ciclos da mesma chamada
MAX_REQUEST_SECONDS = 25     # teto da chamada inteira (o cron-job.org espera no maximo 30 s)

# ---- salas e limites ----
ROOMS = {"sala1": "Sala 1", "sala2": "Sala 2"}
# Valores de exemplo, usados so quando rooms/{sala} ainda nao existe no Firestore.
DEFAULT_LIMITS = {
    "temperature": {"min": 18.0, "max": 25.0},   # graus C
    "humidity": {"min": 30.0, "max": 60.0},      # %
}

# fuso usado para separar os acumulados por dia (rooms/{sala}/daily/{AAAA-MM-DD})
TIMEZONE = "America/Sao_Paulo"

# ---- avancado ----
RAW_RETENTION_DAYS = 30       # preenche expireAt nas leituras (so vale se ativar a politica TTL)
HTTP_TIMEOUT_SECONDS = 30
COMMIT_CHUNK = 400            # escritas por commit no Firestore (maximo 500)
DELETE_CHUNK = 1000           # chaves apagadas por requisicao no Realtime Database
FIRESTORE_URL = "https://firestore.googleapis.com/v1"
# =====================================================================

BASE_DIR = Path(__file__).resolve().parent
LOCK_FILE = BASE_DIR / "job.lock"
VARIABLES = ("temperature", "humidity")
SCOPES = [
    "https://www.googleapis.com/auth/datastore",
    "https://www.googleapis.com/auth/firebase.database",
    "https://www.googleapis.com/auth/userinfo.email",
]
_session_cache = {}


# ---------------------------------------------------------------------
#  Autenticacao e HTTP
# ---------------------------------------------------------------------
def make_session():
    """Sessao HTTP autenticada com a conta de servico (ignora as regras de seguranca)."""
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    key_file = BASE_DIR / SERVICE_ACCOUNT_FILE
    if not key_file.exists():
        raise FileNotFoundError(f"Chave da conta de servico nao encontrada: {key_file}")
    creds = service_account.Credentials.from_service_account_file(str(key_file), scopes=SCOPES)
    return AuthorizedSession(creds), creds.project_id


def get_session():
    """Reaproveita a sessao entre chamadas (o worker do Flask continua vivo)."""
    if "session" not in _session_cache:
        _session_cache["session"] = make_session()
    return _session_cache["session"]


def check(response):
    if not response.ok:
        where = response.url.split("?")[0]
        raise RuntimeError(
            f"HTTP {response.status_code} em {response.request.method} {where}: {response.text[:300]}"
        )
    return response


# ---------------------------------------------------------------------
#  Realtime Database (REST)
# ---------------------------------------------------------------------
def rtdb_url(path):
    return f"{DATABASE_URL.rstrip('/')}/{path}.json"


def rtdb_get(session, path):
    return check(session.get(rtdb_url(path), timeout=HTTP_TIMEOUT_SECONDS)).json()


def rtdb_put(session, path, data):
    check(session.put(rtdb_url(path), json=data, timeout=HTTP_TIMEOUT_SECONDS))


def rtdb_delete_keys(session, path, keys):
    """Apaga varias chaves de uma vez: PATCH com valor null remove o no."""
    for i in range(0, len(keys), DELETE_CHUNK):
        chunk = keys[i:i + DELETE_CHUNK]
        check(session.patch(rtdb_url(path), json={k: None for k in chunk}, timeout=HTTP_TIMEOUT_SECONDS))


# ---------------------------------------------------------------------
#  Firestore (REST)
# ---------------------------------------------------------------------
def doc_name(project, path):
    return f"projects/{project}/databases/(default)/documents/{path}"


def to_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, datetime):
        iso = v.astimezone(timezone.utc).isoformat(timespec="milliseconds")
        return {"timestampValue": iso.replace("+00:00", "Z")}
    if isinstance(v, dict):
        return {"mapValue": {"fields": to_fields(v)}}
    raise TypeError(f"Tipo nao suportado para o Firestore: {type(v)}")


def to_fields(d):
    return {k: to_value(v) for k, v in d.items()}


def from_value(fv):
    if "doubleValue" in fv:
        return float(fv["doubleValue"])
    if "integerValue" in fv:
        return float(fv["integerValue"])
    if "stringValue" in fv:
        return fv["stringValue"]
    if "mapValue" in fv:
        return {k: from_value(x) for k, x in fv["mapValue"].get("fields", {}).items()}
    return None


def commit_url(project):
    return f"{FIRESTORE_URL.rstrip('/')}/projects/{project}/databases/(default)/documents:commit"


def commit(session, project, writes):
    check(session.post(commit_url(project), json={"writes": writes}, timeout=HTTP_TIMEOUT_SECONDS))


def get_doc(session, project, path):
    """Le um documento do Firestore como dict simples; None se nao existir."""
    resp = session.get(f"{FIRESTORE_URL.rstrip('/')}/{doc_name(project, path)}", timeout=HTTP_TIMEOUT_SECONDS)
    if resp.status_code == 404:
        return None
    check(resp)
    return from_value({"mapValue": {"fields": resp.json().get("fields", {})}})


def upsert(project, path, data):
    return {"update": {"name": doc_name(project, path), "fields": to_fields(data)}}


def limits_are_valid(limits):
    try:
        for var in VARIABLES:
            lo, hi = limits[var]["min"], limits[var]["max"]
            if not isinstance(lo, float) or not isinstance(hi, float) or lo >= hi:
                return False
        return True
    except (KeyError, TypeError):
        return False


def load_limits(session, project, room_id, dry_run):
    """Le os limites de rooms/{sala}. Se o documento nao existe, cria com os valores de exemplo."""
    path = f"rooms/{room_id}"
    resp = session.get(f"{FIRESTORE_URL.rstrip('/')}/{doc_name(project, path)}", timeout=HTTP_TIMEOUT_SECONDS)
    if resp.status_code == 404:
        if not dry_run:
            write = upsert(project, path, {
                "name": ROOMS[room_id],
                "limits": DEFAULT_LIMITS,
                "updatedAt": datetime.now(timezone.utc),
                "updatedBy": "system",
            })
            write["currentDocument"] = {"exists": False}  # nunca sobrescreve limites ja existentes
            r = session.post(commit_url(project), json={"writes": [write]}, timeout=HTTP_TIMEOUT_SECONDS)
            if r.status_code != 409:
                check(r)
        return DEFAULT_LIMITS
    check(resp)
    limits = from_value({"mapValue": {"fields": resp.json().get("fields", {})}}).get("limits")
    if not limits_are_valid(limits):
        print(f"[{room_id}] AVISO: limites invalidos no Firestore, usando os valores de exemplo",
              file=sys.stderr)
        return DEFAULT_LIMITS
    return limits


# ---------------------------------------------------------------------
#  Processamento
# ---------------------------------------------------------------------
def ms_to_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def parse_reading(item):
    """Devolve a leitura normalizada ou None se estiver incompleta/invalida."""
    if not isinstance(item, dict):
        return None
    out = {}
    for name in VARIABLES + ("timestamp",):
        v = item.get(name)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        out[name] = float(v)
    out["timestamp"] = int(out["timestamp"])
    return out


def summarize(values, limit):
    n = len(values)
    total = sum(values)
    return {
        "mean": round(total / n, 4),
        "median": round(float(statistics.median(values)), 4),
        "stdDev": round(statistics.stdev(values), 4) if n > 1 else 0.0,  # amostral (n-1)
        "min": min(values),
        "max": max(values),
        "count": n,
        "belowMin": sum(1 for v in values if v < limit["min"]),
        "aboveMax": sum(1 for v in values if v > limit["max"]),
        "sum": round(total, 4),
        "sumSquares": round(sum(v * v for v in values), 4),
    }


def count_out_of_range(readings, limits):
    return sum(
        1 for r in readings
        if not (limits["temperature"]["min"] <= r["temperature"] <= limits["temperature"]["max"])
        or not (limits["humidity"]["min"] <= r["humidity"] <= limits["humidity"]["max"])
    )


def build_stats(readings, limits, cycle_id=None):
    temps = [r["temperature"] for r in readings]
    hums = [r["humidity"] for r in readings]
    out_of_range = count_out_of_range(readings, limits)
    last = readings[-1]
    return {
        "cycleId": cycle_id,
        "latestReading": {
            "temperature": last["temperature"],
            "humidity": last["humidity"],
            "timestamp": ms_to_dt(last["timestamp"]),
        },
        "periodStart": ms_to_dt(readings[0]["timestamp"]),
        "periodEnd": ms_to_dt(readings[-1]["timestamp"]),
        "count": len(readings),
        "temperature": summarize(temps, limits["temperature"]),
        "humidity": summarize(hums, limits["humidity"]),
        "readingsOutOfRange": out_of_range,
        "limits": limits,
        "createdAt": datetime.now(timezone.utc),
    }


def day_id(ms):
    """Data (AAAA-MM-DD) da leitura no fuso configurado."""
    return ms_to_dt(ms).astimezone(ZoneInfo(TIMEZONE)).strftime("%Y-%m-%d")


def combine(old, values, limit):
    """Junta o acumulado antigo de uma variavel com valores novos (media e desvio exatos)."""
    old = old or {}
    count = int(old.get("count", 0)) + len(values)
    total = old.get("sum", 0.0) + sum(values)
    squares = old.get("sumSquares", 0.0) + sum(v * v for v in values)
    lows = ([old["min"]] if "min" in old else []) + values
    highs = ([old["max"]] if "max" in old else []) + values
    variance = (squares - total * total / count) / (count - 1) if count > 1 else 0.0
    return {
        "mean": round(total / count, 4),
        "stdDev": round(math.sqrt(max(variance, 0.0)), 4),
        "min": min(lows),
        "max": max(highs),
        "count": count,
        "belowMin": int(old.get("belowMin", 0)) + sum(1 for v in values if v < limit["min"]),
        "aboveMax": int(old.get("aboveMax", 0)) + sum(1 for v in values if v > limit["max"]),
        "sum": round(total, 4),
        "sumSquares": round(squares, 4),
    }


def daily_writes(session, project, room_id, new, limits):
    """Acumulado por dia. Guarda a ultima leitura contada (lastTimestamp/lastKey), entao
    reprocessar o mesmo periodo depois de uma falha nao conta nada duas vezes."""
    by_day = {}
    for key, r in new:
        by_day.setdefault(day_id(r["timestamp"]), []).append((key, r))
    writes = []
    for day, items in sorted(by_day.items()):
        path = f"rooms/{room_id}/daily/{day}"
        old = get_doc(session, project, path) or {}
        mark = (int(old.get("lastTimestamp", -1)), str(old.get("lastKey", "")))
        items = [(k, r) for k, r in items if (r["timestamp"], k) > mark]
        if not items:
            continue
        rs = [r for _, r in items]
        writes.append(upsert(project, path, {
            "date": day,
            "timezone": TIMEZONE,
            "count": int(old.get("count", 0)) + len(rs),
            "temperature": combine(old.get("temperature"), [r["temperature"] for r in rs], limits["temperature"]),
            "humidity": combine(old.get("humidity"), [r["humidity"] for r in rs], limits["humidity"]),
            "readingsOutOfRange": int(old.get("readingsOutOfRange", 0)) + count_out_of_range(rs, limits),
            "lastTimestamp": items[-1][1]["timestamp"],
            "lastKey": items[-1][0],
            "updatedAt": datetime.now(timezone.utc),
        }))
    return writes


CYCLE_FIELDS = ("mean", "median", "stdDev", "min", "max", "count", "belowMin", "aboveMax")


def cycle_doc(cycle_id, collect):
    """Media do ciclo: uma linha por sala e o consolidado das salas."""
    rooms = {}
    total = {v: {"sum": 0.0, "min": None, "max": None} for v in VARIABLES}
    count = 0
    start = end = None
    for room_id, st in collect.items():
        rooms[room_id] = {
            "count": st["count"],
            "periodStart": st["periodStart"],
            "periodEnd": st["periodEnd"],
            "readingsOutOfRange": st["readingsOutOfRange"],
        }
        for var in VARIABLES:
            rooms[room_id][var] = {k: st[var][k] for k in CYCLE_FIELDS}
            t = total[var]
            t["sum"] += st[var]["sum"]
            t["min"] = st[var]["min"] if t["min"] is None else min(t["min"], st[var]["min"])
            t["max"] = st[var]["max"] if t["max"] is None else max(t["max"], st[var]["max"])
        count += st["count"]
        start = st["periodStart"] if start is None else min(start, st["periodStart"])
        end = st["periodEnd"] if end is None else max(end, st["periodEnd"])
    overall = {"count": count}
    for var in VARIABLES:
        t = total[var]
        overall[var] = {"mean": round(t["sum"] / count, 4), "min": t["min"], "max": t["max"]}
    return {
        "cycleId": cycle_id,
        "createdAt": datetime.now(timezone.utc),
        "periodStart": start,
        "periodEnd": end,
        "count": count,
        "rooms": rooms,
        "overall": overall,
    }


def reading_doc(r):
    ts = ms_to_dt(r["timestamp"])
    return {
        "temperature": r["temperature"],
        "humidity": r["humidity"],
        "timestamp": ts,
        "expireAt": ts + timedelta(days=RAW_RETENTION_DAYS),
    }


def process_room(session, project, room_id, dry_run=False, cycle_id=None, collect=None):
    summary = {"room": room_id, "fetched": 0, "invalid": 0, "new": 0, "deleted": 0}

    raw = rtdb_get(session, f"readings/{room_id}") or {}
    if not isinstance(raw, dict):
        raw = {}
    summary["fetched"] = len(raw)

    valid = {}
    for key, item in raw.items():
        parsed = parse_reading(item)
        if parsed is not None:
            valid[key] = parsed
    summary["invalid"] = len(raw) - len(valid)

    # ordem cronologica; a chave desempata leituras com o mesmo timestamp
    ordered = sorted(valid.items(), key=lambda kv: (kv[1]["timestamp"], kv[0]))

    meta = rtdb_get(session, f"meta/{room_id}") or {}
    last = (int(meta.get("lastTimestamp", -1)), str(meta.get("lastKey", "")))
    new = [(k, r) for k, r in ordered if (r["timestamp"], k) > last]
    summary["new"] = len(new)

    if new:
        readings = [r for _, r in new]
        limits = load_limits(session, project, room_id, dry_run)
        stats = build_stats(readings, limits, cycle_id)
        summary["stats"] = json.loads(json.dumps(stats, default=lambda o: o.isoformat()))

        if not dry_run:
            writes = [upsert(project, f"rooms/{room_id}/readings/{k}", reading_doc(r)) for k, r in new]
            # o resumo vai por ultimo: se algo falhar antes, nada e apagado e o proximo
            # ciclo refaz o mesmo periodo (os IDs sao fixos, entao nao duplica)
            writes.append(upsert(project, f"rooms/{room_id}/stats/{readings[0]['timestamp']}", stats))
            # acumulado do dia e resumo mais recente vao junto, no ultimo commit
            writes += daily_writes(session, project, room_id, new, limits)
            writes.append(upsert(project, f"rooms/{room_id}/summary/latest", stats))
            for i in range(0, len(writes), COMMIT_CHUNK):
                commit(session, project, writes[i:i + COMMIT_CHUNK])
            if collect is not None:
                collect[room_id] = stats
            last_key, last_reading = new[-1]
            rtdb_put(session, f"meta/{room_id}",
                     {"lastKey": last_key, "lastTimestamp": last_reading["timestamp"]})

    # limpeza: apaga tudo que foi lido, exceto a leitura mais recente
    keep_key = ordered[-1][0] if ordered else None
    to_delete = [k for k in raw if k != keep_key]
    if to_delete and not dry_run:
        rtdb_delete_keys(session, f"readings/{room_id}", to_delete)
        summary["deleted"] = len(to_delete)
    return summary


def acquire_lock():
    handle = open(LOCK_FILE, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def run_once(session=None, project_id=None, dry_run=False):
    """Um ciclo: processa todas as salas. Nao deixa duas execucoes sobrepostas."""
    lock = acquire_lock()
    if lock is None:
        return {"ok": True, "skipped": "outra execucao em andamento", "rooms": [], "errors": []}
    try:
        if session is None:
            session, project_id = get_session()
        rooms, errors = [], []
        cycle_id = int(time.time() * 1000)
        collect = {}
        for room_id in ROOMS:
            try:
                rooms.append(process_room(session, project_id, room_id, dry_run, cycle_id, collect))
            except Exception as exc:  # uma sala com erro nao impede a outra
                errors.append({"room": room_id, "error": str(exc)})
        if collect and not dry_run:
            try:  # media do ciclo (salas + consolidado)
                commit(session, project_id, [upsert(project_id, f"cycles/{cycle_id}", cycle_doc(cycle_id, collect))])
            except Exception as exc:
                errors.append({"room": "cycle", "error": str(exc)})
        return {"ok": not errors, "dryRun": dry_run, "rooms": rooms, "errors": errors}
    finally:
        lock.close()


def run_cycles(cycles=None, pause=None, max_seconds=None, dry_run=False):
    """O loop de cada chamada: repete o ciclo, respeitando o tempo maximo da requisicao."""
    cycles = max(1, CYCLES_PER_CALL if cycles is None else cycles)
    pause = SECONDS_BETWEEN_CYCLES if pause is None else pause
    max_seconds = MAX_REQUEST_SECONDS if max_seconds is None else max_seconds

    started = time.monotonic()
    cpu_started = time.process_time()
    results = []
    for i in range(cycles):
        results.append(run_once(dry_run=dry_run))
        if i == cycles - 1:
            break
        if time.monotonic() - started + pause > max_seconds:
            break  # outro ciclo estouraria o tempo da chamada
        time.sleep(pause)
    return {
        "ok": all(r["ok"] for r in results),
        "cycles": len(results),
        "elapsedSeconds": round(time.monotonic() - started, 1),
        # CPU usada nesta chamada: compare com o limite de 100 s/dia do plano gratuito
        "cpuSeconds": round(time.process_time() - cpu_started, 2),
        "results": results,
    }


# ---------------------------------------------------------------------
#  Web app Flask
# ---------------------------------------------------------------------
app = Flask(__name__)
application = app  # nome que o arquivo WSGI do PythonAnywhere espera


@app.get("/")
def index():
    return jsonify({"ok": True, "service": "monitoramento-job"})


@app.post("/run")
def run():
    if not JOB_TOKEN or JOB_TOKEN.startswith("troque"):
        return jsonify({"ok": False, "error": "Defina a variavel de ambiente JOB_TOKEN"}), 503
    given = request.headers.get("X-Job-Token", "")
    if not hmac.compare_digest(given, JOB_TOKEN):
        abort(403)
    try:
        result = run_cycles(dry_run=request.args.get("dry_run") == "1")
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    return jsonify(result), (200 if result["ok"] else 500)