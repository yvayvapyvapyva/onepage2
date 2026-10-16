-- D1 schema для API маршрутов (порт YDB таблиц roads/users из backend/handler.py).
-- Применять: wrangler d1 execute nav-db --file=cloudflare_worker/schema.sql
-- TTS-кэш (tts_cache) сюда НЕ переносим — TTS остаётся на Yandex.

CREATE TABLE IF NOT EXISTS roads (
  id           TEXT NOT NULL,
  m            TEXT NOT NULL,
  json         TEXT,
  name         TEXT,
  description  TEXT DEFAULT '',
  visible      INTEGER DEFAULT 0,
  creator_name TEXT DEFAULT '',
  PRIMARY KEY (id, m)
);

CREATE INDEX IF NOT EXISTS idx_roads_visible ON roads (visible);
CREATE INDEX IF NOT EXISTS idx_roads_creator ON roads (id);

CREATE TABLE IF NOT EXISTS users (
  login        TEXT PRIMARY KEY,
  password     TEXT NOT NULL,
  creator_name TEXT DEFAULT '',
  created_at   INTEGER
);
