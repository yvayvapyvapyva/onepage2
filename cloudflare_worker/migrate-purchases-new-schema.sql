-- Миграция purchases: старая схема (PRIMARY KEY user_id, folder) -> новая с полной историей.
-- Применить: wrangler d1 execute nav-db --file=cloudflare_worker/migrate-purchases-new-schema.sql --config=cloudflare_worker/wrangler-api.toml

-- 1. Новая таблица с расширенными полями
CREATE TABLE purchases_new (
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

-- 2. Индексы
CREATE INDEX idx_purchases_new_user_status ON purchases_new (user_id, status);
CREATE INDEX idx_purchases_new_expires ON purchases_new (expires_at);
CREATE INDEX idx_purchases_new_user_product ON purchases_new (user_id, product_type, product_id);

-- 3. Перенос старых данных: folder -> product_id, тип 'folder_access', expires_at = ts + 30 дней
INSERT INTO purchases_new (
    user_id, product_type, product_id, stars, ts, expires_at, status, payload, raw_response
)
SELECT
    user_id,
    'folder_access',
    folder,
    stars,
    ts,
    CASE WHEN ts IS NOT NULL THEN ts + 30 * 24 * 3600 ELSE NULL END,
    'active',
    payload,
    payload
FROM purchases;

-- 4. Удаляем старую таблицу и переименовываем новую
DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;
