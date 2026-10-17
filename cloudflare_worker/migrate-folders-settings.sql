-- Миграция: перенести настройки папок из folder_locks в таблицу folders
ALTER TABLE folders ADD COLUMN visible INTEGER DEFAULT 1;
ALTER TABLE folders ADD COLUMN price INTEGER DEFAULT 0;
DROP TABLE IF EXISTS folder_locks;
