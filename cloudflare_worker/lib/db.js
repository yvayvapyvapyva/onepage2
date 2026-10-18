// Чтение данных из D1: маршруты, папки, замки платных папок, доступы покупателей.

// Ключ маршрута — только `m`. Колонка id всегда 'shared' (оставлена для совместимости).
export const SHARED_ID = 'shared';

// Нормализация ключа: новые ссылки — #m=NAME, старые — #m=ID-NAME.
export function resolveM(raw) {
  if (!raw) return '';
  return raw.includes('-') ? raw.substring(raw.indexOf('-') + 1) : raw;
}

export async function findRoute(env, mRaw) {
  if (!mRaw) return { row: null, m: '' };
  // сначала точное совпадение, затем legacy-формат ID-NAME
  let row = await env.DB.prepare(
    'SELECT json, name, folder_id FROM roads WHERE m = ?').bind(mRaw).first();
  if (row) return { row, m: mRaw };
  if (mRaw.includes('-')) {
    const m = resolveM(mRaw);
    row = await env.DB.prepare(
      'SELECT json, name, folder_id FROM roads WHERE m = ?').bind(m).first();
    if (row) return { row, m };
  }
  return { row: null, m: mRaw };
}

export function parseData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
}

// Папка маршрута из отображаемого имени "A/B/Имя" -> "A/B".
export function folderOf(routeName) {
  const parts = String(routeName || '').split('/').map((s) => s.trim()).filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function normFolder(f) {
  return String(f || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
}

// Восстановить полный путь папки по её id (через parent_id).
export async function getFolderPath(env, id) {
  const parts = [];
  let cur = id;
  while (cur !== null && cur !== undefined) {
    const row = await env.DB.prepare('SELECT name, parent_id FROM folders WHERE id = ?').bind(cur).first();
    if (!row) break;
    parts.unshift(row.name);
    cur = row.parent_id;
  }
  return parts.join('/');
}

// Найти id папки по полному пути (например "А/Б/В").
export async function findFolderIdByPath(env, path) {
  const parts = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let parentId = null;
  let currentId = null;
  for (const part of parts) {
    const row = await env.DB.prepare(
      'SELECT id FROM folders WHERE name = ? AND (parent_id IS NULL OR parent_id = ?)'
    ).bind(part, parentId).first();
    if (!row) return null;
    currentId = row.id;
    parentId = row.id;
  }
  return currentId;
}

// Ближайший замок для папки (сама папка или предок). locks: Map(folder->price).
export function lockForFolder(folder, locks) {
  let cur = folder;
  for (;;) {
    if (locks.has(cur)) return { folder: cur, price: locks.get(cur) };
    const i = cur.lastIndexOf('/');
    if (i < 0) break;
    cur = cur.substring(0, i);
  }
  return null;
}

export async function loadLocks(env) {
  // Пути строим по ВСЕМ папкам (не только платным): иначе путь вложенной
  // платной папки обрежется на первом бесплатном родителе и замок не совпадёт.
  const rows = (await env.DB.prepare(
    'SELECT id, name, parent_id, price FROM folders').all()).results || [];
  // постройка путей в памяти
  const byId = new Map(rows.map(r => [r.id, r]));
  const pathCache = new Map();
  function pathOf(id) {
    if (pathCache.has(id)) return pathCache.get(id);
    const parts = [];
    let cur = id;
    while (cur !== null && cur !== undefined && byId.has(cur)) {
      const f = byId.get(cur);
      parts.unshift(f.name);
      cur = f.parent_id;
    }
    const p = parts.join('/');
    pathCache.set(id, p);
    return p;
  }
  const map = new Map();
  for (const r of rows) {
    if (r.price > 0) {
      const p = pathOf(r.id);
      if (p) map.set(p, r.price);
    }
  }
  return map;
}

// Доступ действует 30 дней с момента оплаты.
export const ACCESS_DAYS = 30;

// Есть ли у пользователя действующий доступ к папке (покупка активна и не истекла)
export async function hasAccess(env, uid, lockFolder) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    `SELECT 1 FROM purchases
     WHERE user_id = ? AND product_type = 'folder_access' AND product_id = ?
       AND status = 'active' AND expires_at > ?
     LIMIT 1`)
    .bind(uid, lockFolder, now)
    .all()).results || [];
  return rows.length > 0;
}

// Карта folder -> unix-ts окончания доступа (для отображения).
export async function accessExpires(env, uid) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    `SELECT product_id AS folder, expires_at FROM purchases
     WHERE user_id = ? AND product_type = 'folder_access'
       AND status = 'active' AND expires_at > ?`)
    .bind(uid, now)
    .all()).results || [];
  const out = {};
  for (const r of rows) out[r.folder] = r.expires_at;
  return out;
}
