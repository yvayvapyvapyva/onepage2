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

-- Реальные папки (иерархия, parent_id для вложенности).
-- visible — показывать ли папку в списках (1/0).
-- price — цена доступа в звёздах Telegram Stars (0 = бесплатно).
CREATE TABLE IF NOT EXISTS folders (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES folders(id),
  owner_id  TEXT DEFAULT '',
  visible   INTEGER DEFAULT 1,
  price     INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Ссылка маршрута на папку (nullable — маршрут без папки = корень).
ALTER TABLE roads ADD COLUMN folder_id INTEGER REFERENCES folders(id);
CREATE INDEX IF NOT EXISTS idx_roads_folder ON roads (folder_id);

-- Купленные доступы: user_id — Telegram user id, product_id — путь к папке/продукту.
-- Поддерживает разные типы продуктов (folder_access, premium, donate) и полную историю покупок.
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  product_type    TEXT NOT NULL DEFAULT 'folder_access',
  product_id      TEXT NOT NULL,
  charge_id       TEXT UNIQUE,
  order_id        TEXT UNIQUE,
  payload         TEXT,
  stars           INTEGER NOT NULL DEFAULT 0,
  currency        TEXT DEFAULT 'XTR',
  status          TEXT NOT NULL DEFAULT 'active',
  ts              INTEGER NOT NULL,
  expires_at      INTEGER,
  refunded_at     INTEGER,
  refund_reason   TEXT,
  platform        TEXT,
  promo_code      TEXT,
  referrer_user_id TEXT,
  raw_response    TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_status ON purchases (user_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_expires ON purchases (expires_at);
CREATE INDEX IF NOT EXISTS idx_purchases_user_product ON purchases (user_id, product_type, product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_charge ON purchases (charge_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_order ON purchases (order_id);
