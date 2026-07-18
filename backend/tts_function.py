#!/usr/bin/env python3
"""
tts_function.py — Yandex Cloud Function для синтеза речи через edge-tts
с кэшированием в YDB.

Зависимости (requirements-tts.txt):
  edge-tts>=6.0.0
  ydb>=3.0.0

Запрос:
  - {"voice_type": "command|comment", "texts": [...]}
  - {"batches": [{"voice_type": "command|comment", "texts": [...]}, ...]}
Ответ:
  {"audios": {"текст": "<base64>", ...}, "format": "mp3"}
"""

import asyncio
import json
import base64
import hashlib
import os
from datetime import datetime

try:
    import edge_tts
except ImportError:
    edge_tts = None

try:
    import ydb
    import ydb.iam
except ImportError:
    ydb = None

VOICES = {
    "command": "ru-RU-DmitryNeural",
    "comment": "ru-RU-SvetlanaNeural",
}
PITCHES = {
    "command": "-10Hz",
    "comment": "+0Hz",
}
VOLUME = "+30%"


YDB_ENDPOINT = os.environ.get("YDB_ENDPOINT", "")
YDB_DATABASE = os.environ.get("YDB_DATABASE", "")

_pool = None
_table_ready = False


def _get_pool():
    global _pool
    if _pool is not None:
        return _pool
    if not ydb or not YDB_ENDPOINT or not YDB_DATABASE:
        return None
    try:
        driver_config = ydb.DriverConfig(
            YDB_ENDPOINT,
            YDB_DATABASE,
            credentials=ydb.iam.MetadataUrlCredentials(),
        )
        driver = ydb.Driver(driver_config)
        driver.wait(timeout=10)
        _pool = ydb.SessionPool(driver)
    except Exception:
        _pool = None
    return _pool


def _ensure_table():
    global _table_ready
    if _table_ready:
        return True
    pool = _get_pool()
    if not pool:
        return False
    try:
        def create(session):
            session.execute_scheme(
                "CREATE TABLE IF NOT EXISTS tts_cache ("
                "cache_key Utf8,"
                "params Utf8,"
                "audio_data String,"
                "created_at Timestamp,"
                "PRIMARY KEY (cache_key)"
                ");"
            )
        pool.retry_operation_sync(create)
        try:
            def add_column(session):
                session.execute_scheme(
                    "ALTER TABLE tts_cache ADD COLUMN params Utf8;"
                )
            pool.retry_operation_sync(add_column)
        except Exception:
            pass
        _table_ready = True
        return True
    except Exception:
        return False


def _resolve_voice(voice_type):
    return VOICES.get(voice_type, VOICES["command"])


def _cache_key(text, voice, pitch, volume):
    raw = f"{text}\0{voice}\0{pitch}\0{volume}".encode("utf-8")
    return hashlib.md5(raw).hexdigest()


def _get_cached(session, keys):
    if not keys:
        return {}
    declarations = []
    params = {}
    conditions = []
    for i, key in enumerate(keys):
        p = f"$k{i}"
        declarations.append(f"DECLARE {p} AS Utf8;")
        params[p] = key
        conditions.append(f"cache_key = {p}")
    where = " OR ".join(conditions)
    decl = "\n".join(declarations)
    query = f"{decl}\nSELECT cache_key, audio_data FROM tts_cache WHERE {where};"

    prepared = session.prepare(query)
    result = session.transaction().execute(prepared, parameters=params, commit_tx=True)
    cached = {}
    for row in result[0].rows:
        cached[row["cache_key"]] = row["audio_data"].decode("utf-8")
    return cached


def _save_batch(session, items):
    if not items:
        return
    ts = datetime.utcnow()
    declarations = []
    params = {}
    value_rows = []
    for i, (key, params_json, b64) in enumerate(items):
        pk = f"$k{i}"
        pp = f"$p{i}"
        pd = f"$d{i}"
        pt = f"$t{i}"
        declarations.append(f"DECLARE {pk} AS Utf8;")
        declarations.append(f"DECLARE {pp} AS Utf8;")
        declarations.append(f"DECLARE {pd} AS String;")
        declarations.append(f"DECLARE {pt} AS Timestamp;")
        params[pk] = key
        params[pp] = params_json
        params[pd] = b64.encode("utf-8")
        params[pt] = ts
        value_rows.append(f"({pk}, {pp}, {pd}, {pt})")
    decl = "\n".join(declarations)
    values = ",\n".join(value_rows)
    query = (
        f"{decl}\n"
        f"UPSERT INTO tts_cache (cache_key, params, audio_data, created_at)\n"
        f"VALUES\n{values};"
    )
    prepared = session.prepare(query)
    session.transaction().execute(prepared, parameters=params, commit_tx=True)


def _cors(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": json.dumps(body, ensure_ascii=False) if isinstance(body, (dict, list)) else str(body),
    }


async def _synthesize_one(text, voice, pitch, volume):
    result = b""
    communicate = edge_tts.Communicate(text, voice=voice, pitch=pitch, volume=volume)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            result += chunk["data"]
    return text, result


def _process_batch(texts, voice_type, audios, use_cache, pool, debug):
    """Synthesize or fetch from cache for one voice_type batch. Modifies audios in-place."""
    voice = _resolve_voice(voice_type)
    pitch = PITCHES.get(voice_type, PITCHES["command"])
    keys = {t: _cache_key(t, voice, pitch, VOLUME) for t in texts}
    cached_map = {}
    uncached_texts = []
    uncached_keys = []

    if use_cache:
        def query_cache(session):
            return _get_cached(session, list(keys.values()))
        try:
            cached_map = pool.retry_operation_sync(query_cache)
        except Exception as e:
            debug.setdefault("cache_query_errors", []).append(str(e))
            use_cache = False

    cached_count = 0
    for text in texts:
        k = keys[text]
        if k in cached_map:
            audios[text] = cached_map[k]
            cached_count += 1
        else:
            uncached_texts.append(text)
            uncached_keys.append(k)

    debug.setdefault("batch", []).append({
        "voice_type": voice_type,
        "total": len(texts),
        "cached": cached_count,
        "synthesized": len(uncached_texts),
    })

    if not uncached_texts:
        return []

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        results = loop.run_until_complete(
            asyncio.gather(*[_synthesize_one(t, voice, pitch, VOLUME) for t in uncached_texts])
        )
    finally:
        loop.close()

    new_items = []
    for text, audio_data in results:
        b64 = base64.b64encode(audio_data).decode("utf-8")
        audios[text] = b64
        if use_cache:
            idx = uncached_texts.index(text)
            params_json = json.dumps(
                {"text": text, "voice": voice, "pitch": pitch, "volume": VOLUME},
                ensure_ascii=False,
            )
            new_items.append((uncached_keys[idx], params_json, b64))

    if use_cache and new_items:
        try:
            pool.retry_operation_sync(lambda s: _save_batch(s, new_items))
        except Exception as e:
            debug.setdefault("cache_save_errors", []).append(str(e))

    return new_items


def handler(event, context):
    try:
        if event.get("httpMethod") == "OPTIONS":
            return _cors(200, {"ok": True})

        if edge_tts is None:
            return _cors(500, {"error": "edge-tts not installed"})

        body = json.loads(event.get("body", "{}"))
        use_cache = _ensure_table()
        pool = _get_pool() if use_cache else None
        debug = {"use_cache": use_cache}

        audios = {}
        batches = body.get("batches")
        if not isinstance(batches, list) or not batches:
            return _cors(400, {"error": "batches must be a non-empty array"})

        debug["batches_received"] = [
            {"voice_type": b.get("voice_type", "command"), "texts_count": len(b.get("texts", []) or [])}
            for b in batches
        ]

        for b in batches:
            voice_type = b.get("voice_type", "command")
            texts = b.get("texts", [])
            if not isinstance(texts, list) or not texts:
                continue
            texts = [t.strip() for t in texts if t and t.strip()]
            if not texts:
                continue
            _process_batch(texts, voice_type, audios, use_cache, pool, debug)

        print(json.dumps({"tts_cache": debug}))
        return _cors(200, {"audios": audios, "format": "mp3"})

    except Exception as e:
        return _cors(500, {"error": str(e)})
