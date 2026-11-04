-- D1 schema для API маршрутов (порт YDB таблиц roads/users из backend/handler.py).
-- Применять: wrangler d1 execute nav-db --file=cloudflare_worker/schema.sql
-- TTS-кэш (tts_cache) сюда НЕ переносим — TTS остаётся на Yandex.

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

-- Инструкторы, привязанные к папкам (реклама практических занятий).
-- Одна папка — много инструкторов; фото — в отдельной таблице, чтобы
-- каталог и списки папок не тащили бинарники.
CREATE TABLE IF NOT EXISTS folder_instructors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id  INTEGER NOT NULL REFERENCES folders(id),
  name       TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  car_model  TEXT DEFAULT '',
  text       TEXT DEFAULT '',
  url        TEXT DEFAULT '',
  visible    INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_folder_instructors_folder
  ON folder_instructors (folder_id, sort_order, id);

-- Фото инструктора ('avatar') и автомобиля ('car').
-- Лимит D1 — 2 МБ на строку/BLOB, клиент сжимает до ~200 КБ.
CREATE TABLE IF NOT EXISTS folder_instructor_photos (
  instructor_id INTEGER NOT NULL REFERENCES folder_instructors(id),
  kind          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         BLOB NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (instructor_id, kind)
);

-- Маршруты. id — исторический дискриминатор (всегда 'shared'); составной ключ
-- (id, m) оставлен ради совместимости. folder_id NULL = маршрут в корне.
CREATE TABLE IF NOT EXISTS roads (
  id           TEXT NOT NULL,
  m            TEXT NOT NULL,
  json         TEXT,
  name         TEXT,
  description  TEXT DEFAULT '',
  visible      INTEGER DEFAULT 0,
  creator_name TEXT DEFAULT '',
  folder_id    INTEGER REFERENCES folders(id),
  PRIMARY KEY (id, m)
);

CREATE INDEX IF NOT EXISTS idx_roads_visible ON roads (visible);
CREATE INDEX IF NOT EXISTS idx_roads_creator ON roads (id);
CREATE INDEX IF NOT EXISTS idx_roads_folder ON roads (folder_id);

-- Купленные доступы: user_id — Telegram user id, product_id — путь к папке/продукту.
-- Поддерживает разные типы продуктов (folder_access, premium, donate) и полную историю покупок.
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  product_type    TEXT NOT NULL DEFAULT 'folder_access',
  product_id      TEXT NOT NULL,
  charge_id       TEXT UNIQUE,
  payload         TEXT,
  stars           INTEGER NOT NULL DEFAULT 0,
  currency        TEXT DEFAULT 'XTR',
  status          TEXT NOT NULL DEFAULT 'active',
  ts              INTEGER NOT NULL,
  expires_at      INTEGER,
  refunded_at     INTEGER,
  refund_reason   TEXT,
  raw_response    TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_status ON purchases (user_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_expires ON purchases (expires_at);
CREATE INDEX IF NOT EXISTS idx_purchases_user_product ON purchases (user_id, product_type, product_id);
-- charge_id уже UNIQUE в определении таблицы — отдельный индекс не нужен.
