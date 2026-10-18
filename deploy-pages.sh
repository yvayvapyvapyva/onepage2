#!/bin/bash
# Деплой сайта на Cloudflare Pages (проект avtoinstruktor).
# Заливает только файлы сайта (html, assets, znaki, ico) —
# исходники воркеров (cloudflare_worker/) и бэкенд (backend/) наружу не попадают.
# Использование: ./deploy-pages.sh
set -e
cd "$(dirname "$0")"

STAGE="$(mktemp -d)"
trap "rm -rf $STAGE" EXIT

rsync -a \
  --exclude="backend" \
  --exclude="cloudflare_worker" \
  --exclude=".git" \
  --exclude=".gitignore" \
  --exclude=".env" \
  --exclude=".env.*" \
  --exclude=".DS_Store" \
  --exclude=".wrangler" \
  --exclude="deploy-pages.sh" \
  ./ "$STAGE/"

wrangler pages deploy "$STAGE" --project-name=avtoinstruktor --branch=main
