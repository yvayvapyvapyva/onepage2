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

// Индекс всех папок в памяти: id -> {id, name, parent_id, price}.
// Один запрос вместо обхода дерева на каждый маршрут.
export async function loadFolderIndex(env) {
  const rows = (await env.DB.prepare(
    'SELECT id, name, parent_id, price FROM folders').all()).results || [];
  const byId = new Map();
  for (const r of rows) byId.set(r.id, r);
  return byId;
}

// Полный путь папки по её id внутри загруженного индекса. Только для показа
// человеку: ключом доступа путь не является (см. lockForFolder).
export function folderPathIn(index, id) {
  const parts = [];
  const seen = new Set();
  let cur = id;
  while (cur !== null && cur !== undefined && index.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const f = index.get(cur);
    parts.unshift(f.name);
    cur = f.parent_id;
  }
  return parts.join('/');
}

// Ближайший платный предок (включая саму папку) — по id, а не по пути из имён.
// Путь ключом быть не может: у двух папок-соседей может быть одинаковое имя,
// и тогда они слились бы в один «замок».
// Возвращает { id, folder, price } либо null.
export function lockForFolder(index, folderId) {
  const seen = new Set();
  let cur = folderId;
  while (cur !== null && cur !== undefined && index.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const f = index.get(cur);
    if ((f.price || 0) > 0) {
      return { id: f.id, folder: folderPathIn(index, f.id), price: f.price };
    }
    cur = f.parent_id;
  }
  return null;
}

// Доступ действует 30 дней с момента оплаты.
export const ACCESS_DAYS = 30;

// Есть ли у пользователя действующий доступ к папке (покупка активна и не истекла).
// product_id покупки — это id папки, поэтому переименование и переезд папки
// доступ не отбирают.
export async function hasAccess(env, uid, folderId) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    `SELECT 1 FROM purchases
     WHERE user_id = ? AND product_type = 'folder_access' AND product_id = ?
       AND status = 'active' AND expires_at > ?
     LIMIT 1`)
    .bind(uid, String(folderId), now)
    .all()).results || [];
  return rows.length > 0;
}

// Карта id папки -> unix-ts окончания доступа (для отображения).
export async function accessExpires(env, uid) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    `SELECT product_id AS pid, expires_at FROM purchases
     WHERE user_id = ? AND product_type = 'folder_access'
       AND status = 'active' AND expires_at > ?`)
    .bind(uid, now)
    .all()).results || [];
  const out = {};
  for (const r of rows) out[r.pid] = r.expires_at;
  return out;
}
