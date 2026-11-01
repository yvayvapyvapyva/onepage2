#!/usr/bin/env python3
"""
tts_function.py — Yandex Cloud Function для синтеза речи через edge-tts
с хранением готовых mp3 в Object Storage.

Механизм:
  1. Клиент сам вычисляет имя файла: SHA-256 от
     "текст\\0голос\\0pitch\\0volume" -> v1/<hash>.mp3.
  2. Клиент делает HEAD по публичному URL. Файл есть — синтез не нужен.
  3. Функция получает только отсутствующие фразы, синтезирует их,
     загружает в бакет и возвращает готовые URL.

Запрос:
  {"batches": [{"voice_type": "command|comment", "texts": ["..."]}, ...]}

Ответ:
  {"audios": [{"voice_type": "command", "text": "...", "url": "https://..."}],
   "format": "mp3"}

Зависимости: edge-tts (см. requirements.txt).
Переменные окружения:
  TTS_BUCKET — имя бакета Object Storage (по умолчанию eia-tts).
Сервисному аккаунту функции нужны права на запись в бакет.
"""

import asyncio
import hashlib
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import edge_tts


BUCKET = os.environ.get("TTS_BUCKET", "eia-tts")
BUCKET_URL = f"https://storage.yandexcloud.net/{BUCKET}"
VOICE_SETTINGS = {
    "command": ("ru-RU-DmitryNeural", "-10Hz"),
    "comment": ("ru-RU-SvetlanaNeural", "+0Hz"),
}
VOLUME = "+30%"
MAX_AUDIO_ITEMS = 100
MAX_TEXT_LENGTH = 1000
MAX_CONCURRENT_SYNTHESIS = 4
METADATA_TOKEN_URL = (
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
)


def _cors(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def _object_key(text, voice_type):
    voice, pitch = VOICE_SETTINGS[voice_type]
    raw = f"{text}\0{voice}\0{pitch}\0{VOLUME}".encode("utf-8")
    return "v1/" + hashlib.sha256(raw).hexdigest() + ".mp3"


def _object_url(key):
    return f"{BUCKET_URL}/{key}"


def _object_exists(url):
    try:
        with urlopen(Request(url, method="HEAD"), timeout=10):
            return True
    except HTTPError as error:
        if error.code == 404:
            return False
        raise


def _iam_token():
    request = Request(
        METADATA_TOKEN_URL,
        headers={"Metadata-Flavor": "Google"},
    )
    with urlopen(request, timeout=5) as response:
        token = json.loads(response.read().decode("utf-8")).get("access_token")
    if not token:
        raise RuntimeError("IAM token is missing from the function metadata response")
    return token


def _upload_object(url, audio):
    request = Request(
        url,
        data=audio,
        method="PUT",
        headers={
            "Authorization": "Bearer " + _iam_token(),
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
    with urlopen(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Object Storage upload failed: HTTP {response.status}")


async def _synthesize(text, voice_type):
    voice, pitch = VOICE_SETTINGS[voice_type]
    communicate = edge_tts.Communicate(
        text,
        voice=voice,
        pitch=pitch,
        volume=VOLUME,
    )
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("Speech synthesis returned an empty audio file")
    return audio


def _run_async(coroutine):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coroutine)
    finally:
        loop.close()


async def _ensure_audios(items):
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_SYNTHESIS)
    return await asyncio.gather(
        *(_ensure_audio(text, voice_type, semaphore) for voice_type, text in items)
    )


async def _ensure_audio(text, voice_type, semaphore):
    key = _object_key(text, voice_type)
    url = _object_url(key)
    if await asyncio.to_thread(_object_exists, url):
        return url
    async with semaphore:
        # Повторная проверка: пока ждали слот, файл мог создать другой запрос.
        if await asyncio.to_thread(_object_exists, url):
            return url
        audio = await _synthesize(text, voice_type)
        await asyncio.to_thread(_upload_object, url, audio)
    return url


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return _cors(200, {"ok": True})
    if event.get("httpMethod") != "POST":
        return _cors(405, {"error": "Method not allowed"})

    try:
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict):
            return _cors(400, {"error": "Request body must be a JSON object"})
        batches = body.get("batches")
        if not isinstance(batches, list) or not batches:
            return _cors(400, {"error": "batches must be a non-empty array"})

        items = []
        seen = set()
        for batch in batches:
            if not isinstance(batch, dict):
                return _cors(400, {"error": "Each batch must be an object"})
            voice_type = batch.get("voice_type", "command")
            texts = batch.get("texts")
            if voice_type not in VOICE_SETTINGS:
                return _cors(400, {"error": "Unsupported voice_type"})
            if not isinstance(texts, list):
                return _cors(400, {"error": "texts must be an array"})

            for value in texts:
                if not isinstance(value, str):
                    return _cors(400, {"error": "Each text must be a string"})
                text = value.strip()
                if not text:
                    continue
                if len(text) > MAX_TEXT_LENGTH:
                    return _cors(400, {"error": "Text exceeds the maximum length"})
                item_key = (voice_type, text)
                if item_key not in seen:
                    seen.add(item_key)
                    items.append(item_key)
                if len(items) > MAX_AUDIO_ITEMS:
                    return _cors(400, {"error": "Request exceeds the maximum number of audio items"})

        urls = _run_async(_ensure_audios(items))
        audios = []
        for (voice_type, text), url in zip(items, urls):
            audios.append({
                "voice_type": voice_type,
                "text": text,
                "url": url,
            })

        return _cors(200, {"audios": audios, "format": "mp3"})
    except (json.JSONDecodeError, TypeError) as error:
        print(f"Invalid TTS request: {error}")
        return _cors(400, {"error": "Request body must be valid JSON"})
    except Exception as error:
        print(f"TTS cache error: {error}")
        return _cors(502, {"error": "TTS audio could not be generated or stored"})
