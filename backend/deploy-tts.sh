#!/bin/sh
# Деплой TTS-функции: edge-tts + Object Storage (механизм как в проекте osm).
#
# Функция синтезирует только отсутствующие mp3 и складывает их в бакет;
# клиент сам проверяет файл по SHA-256-URL и вызывает функцию лишь при промахе.
#
# По умолчанию обновляется общая функция d4e3cj3q3ff36qlrhbg8 (бакет eia-tts),
# которую использует и osm. Чтобы поднять отдельную копию, задайте:
#   FUNCTION_ID=... SERVICE_ACCOUNT_ID=... TTS_BUCKET=...
#
# Требуется установленный и авторизованный `yc` (Yandex Cloud CLI).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

FUNCTION_ID="${FUNCTION_ID:-d4e3cj3q3ff36qlrhbg8}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-ajes1766qghjbk20pcjp}"
TTS_BUCKET="${TTS_BUCKET:-eia-tts}"

yc serverless function version create \
  --function-id "$FUNCTION_ID" \
  --runtime python314 \
  --entrypoint tts_function.handler \
  --memory 512MB \
  --execution-timeout 300s \
  --service-account-id "$SERVICE_ACCOUNT_ID" \
  --source-path "$SCRIPT_DIR" \
  --environment TTS_BUCKET="$TTS_BUCKET" \
  --description "Cache-first navigator TTS in $TTS_BUCKET"
