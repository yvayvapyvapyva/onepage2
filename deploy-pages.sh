#!/bin/bash
# Деплой сайта на Cloudflare Pages (проект avtoinstruktor).
# Публикуется ТОЛЬКО перечисленное ниже (белый список) — новые файлы в
# репозитории (секреты вроде .env, бэкапы, исходники воркеров) наружу
# по умолчанию не попадают.
# Использование: ./deploy-pages.sh
set -e
cd "$(dirname "$0")"

# Белый список: что уходит на сайт.
SITE_FILES=(
  index.html
  navigator.html
  editor.html
  instr.html
  instr_editor.html
  ico.png
  assets
  znaki
)

STAGE="$(mktemp -d)"
trap "rm -rf $STAGE" EXIT

for f in "${SITE_FILES[@]}"; do
  cp -R "$f" "$STAGE/"
done

# Никакого мусора ОС на публикацию.
find "$STAGE" -name '.DS_Store' -delete

wrangler pages deploy "$STAGE" --project-name=avtoinstruktor --branch=main
