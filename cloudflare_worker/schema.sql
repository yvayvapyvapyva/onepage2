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

-- Платные папки: folder — полный путь папки (например "ЭКЗАМЕНАЦИОННЫЕ МАРШРУТЫ/МЕЩЕРА"),
-- price — цена доступа в звёздах Telegram Stars (1..10000).
-- Замок наследуется подпапками. Метки ставятся из редактора.
CREATE TABLE IF NOT EXISTS folder_locks (
  folder TEXT PRIMARY KEY,
  price  INTEGER NOT NULL
);

-- Купленные доступы: user_id — Telegram user id, folder — папка из folder_locks.
CREATE TABLE IF NOT EXISTS purchases (
  user_id TEXT NOT NULL,
  folder  TEXT NOT NULL,
  stars   INTEGER DEFAULT 0,
  ts      INTEGER,
  payload TEXT,
  PRIMARY KEY (user_id, folder)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_payload ON purchases (payload);
