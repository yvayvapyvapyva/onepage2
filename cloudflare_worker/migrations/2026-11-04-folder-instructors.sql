-- Инструкторы, привязанные к папкам (реклама практических занятий).
-- Одна папка — много инструкторов; фото хранятся в D1 отдельной таблицей,
-- чтобы списки папок и каталог не тащили бинарники.

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
