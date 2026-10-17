// Cloudflare Worker — API маршрутов на D1.
//
// Упрощённая модель: общий неймспейс, без аккаунтов.
// Читать маршруты может любой посетитель, редактировать — только редакторы
// (см. EDITOR_IDS / EDITOR_ACCESS_KEY и requireEditor ниже).
// Ключ маршрута — только `m` (колонка id всегда 'shared', оставлена для совместимости).
//
// Роуты:
//   GET /?action=list_routes                      — публичный список (visible=1)
//   GET /?action=catalog                          — маршруты + папки + замки одним ответом (меню)
//   GET /?action=get&m=NAME                       — маршрут {name, m, data}
//   GET/POST /?action=list                        — все маршруты (для редактора)
//   GET/POST /?action=get_protected&m=NAME        — то же, что get (для редактора)
//   POST /?action=save&m=NAME {data}              — сохранить точки
//   POST /?action=delete&m=NAME                   — удалить
//   GET/POST /?action=get_meta&m=NAME             — метаданные
//   POST /?action=save_meta&m=NAME {name, description, visible, creator_name, new_m?}
//   POST /report { text, lat?, lon? }             — прокси отчётов в Telegram Bot API
//   Платные папки (Telegram Stars):
//   GET  /?action=locks                            — {locks:[{folder, price}]} (публично)
//   POST /?action=save_lock {folder, price}        — пометить папку платной (price 0 — снять)
//   POST /?action=del_lock {folder}               — снять замок
//   POST /?action=my_access {initData}            — {user_id, folders:[купленные]} (Telegram)
//   POST /?action=shop_invoice {initData, folder} — {invoiceLink, price, folder}
//   POST /?action=shop_claim {initData}           — сверить оплаты, {folders:[...]}
//   Маршрут в платной папке через action=get требует tg_init_data покупателя,
//   иначе 403 {error:'locked', folder, price}. Редакторские экшены доступны
//   только редакторам (см. requireEditor).
//
// Env:
//   DB               — D1 database binding (см. schema.sql)
//   TELEGRAM_TOKEN   — токен бота (wrangler secret put, для /report)
//   REPORT_CHAT_ID   — чат для отчётов (wrangler secret put)
//   REPORT_KEY       — опциональный ключ в заголовке X-Report-Key (wrangler secret put)
//   PURCHASE_CHANNEL_ID — канал для уведомлений о покупках и возвратах
//                         (@username публичного или -100… приватного). Не задан — уведомления не шлются.
//   EDITOR_IDS       — Telegram user id редакторов через запятую (чтение/правка маршрутов).
//   EDITOR_ACCESS_KEY — ключ для входа в редактор из браузера (вне Telegram). Не задан — только через Telegram.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Origin, Accept, X-Editor-Key',
};

// Экшены, доступные только редакторам маршрутов (см. requireEditor).
// Публичные остаются открытыми: catalog, get, list_routes, locks, my_access,
// shop_invoice, shop_claim, editor_check.
const EDITOR_ACTIONS = new Set([
  'list', 'get_protected', 'get_meta',
  'delete', 'save', 'save_meta',
  'save_lock', 'del_lock',
  'folder_list', 'folder_create', 'folder_rename', 'folder_delete',
  'folder_move', 'folder_settings', 'route_move',
]);

const SHARED_ID = 'shared';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

// Экранирование для parse_mode: 'HTML'.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Прокси отчётов в Telegram Bot API (токен бота скрыт от клиента).
async function handleReport(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  try {
    if (env.REPORT_KEY) {
      const key = request.headers.get('X-Report-Key');
      if (key !== env.REPORT_KEY) return json({ ok: false, error: 'forbidden' }, 403);
    }
    const body = await request.json();
    const text = String(body.text || '').trim();
    const hasLocation = Number.isFinite(body.lat) && Number.isFinite(body.lon);
    if (!text && !hasLocation) return json({ ok: true, skipped: true });

    const tel = 'https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/';
    const chatId = env.REPORT_CHAT_ID;
    let ok = false;
    if (text) {
      const res = await fetch(tel + 'sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        }),
      });
      ok = res.ok;
    }
    if (hasLocation) {
      const locParams = new URLSearchParams({
        chat_id: chatId, latitude: String(body.lat), longitude: String(body.lon),
      });
      await fetch(tel + 'sendLocation?' + locParams, { method: 'GET' });
    }
    return json({ ok: text ? ok : true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Нормализация ключа: новые ссылки — #m=NAME, старые — #m=ID-NAME.
function resolveM(raw) {
  if (!raw) return '';
  return raw.includes('-') ? raw.substring(raw.indexOf('-') + 1) : raw;
}

async function findRoute(env, mRaw) {
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

function parseData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
}

// Проверка Telegram Mini App initData (без проверки срока — покупки интерактивные).
// maxAgeSec > 0 — дополнительно требовать свежесть auth_date (для редактора).
async function verifyTgInitData(initData, botToken, maxAgeSec = 0) {
  if (!botToken) return { uid: null, err: 'TELEGRAM_TOKEN not configured' };
  if (!initData) return { uid: null, err: 'initData missing' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { uid: null, err: 'hash missing' };
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const enc = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));
    const key = await crypto.subtle.importKey(
      'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dataCheckString));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return { uid: null, err: 'bad signature' };
    if (maxAgeSec > 0) {
      const authDate = Number(params.get('auth_date') || 0);
      const now = Math.floor(Date.now() / 1000);
      if (!authDate || now - authDate > maxAgeSec) {
        return { uid: null, err: 'initData expired' };
      }
    }
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return { uid: null, err: 'no user' };
    return { uid: String(user.id), err: null };
  } catch (e) {
    return { uid: null, err: String(e) };
  }
}

async function tgApi(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}

// ---- Доступ к редактору маршрутов ----

// Среди читаемых/пишущих экшенов только эти требуют прав редактора.
function editorIds(env) {
  return String(env.EDITOR_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function editorIdAllowed(uid, env) {
  return uid != null && editorIds(env).includes(String(uid));
}

// Сравнение строк за постоянное время (для ключа доступа).
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Доступ редактора к API. Два независимых способа:
//   1) ключ EDITOR_ACCESS_KEY — для входа из браузера (вне Telegram);
//   2) подписанный Telegram.WebApp.initData, uid которого есть в EDITOR_IDS.
// ID берётся из подписи Telegram (подделать нельзя), а не из тела запроса.
// Возвращает { ok, uid, via } либо { ok:false, err }.
async function requireEditor(request, bodyData, env) {
  const url = new URL(request.url);
  const givenKey = bodyData.editor_key || request.headers.get('X-Editor-Key') ||
    url.searchParams.get('editor_key') || '';
  const accessKey = String(env.EDITOR_ACCESS_KEY || '');
  if (accessKey && givenKey && safeEqual(givenKey, accessKey)) {
    return { ok: true, uid: null, via: 'key' };
  }

  const initData = bodyData.tg_init_data || url.searchParams.get('tg_init_data') || '';
  const { uid } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN, 24 * 3600);
  if (uid && editorIdAllowed(uid, env)) return { ok: true, uid, via: 'tg' };
  return { ok: false, err: 'forbidden' };
}

// Папка маршрута из отображаемого имени "A/B/Имя" -> "A/B".
function folderOf(routeName) {
  const parts = String(routeName || '').split('/').map((s) => s.trim()).filter(Boolean);
  parts.pop();
  return parts.join('/');
}

// Ближайший замок для папки (сама папка или предок). locks: Map(folder->price).
function lockForFolder(folder, locks) {
  let cur = folder;
  for (;;) {
    if (locks.has(cur)) return { folder: cur, price: locks.get(cur) };
    const i = cur.lastIndexOf('/');
    if (i < 0) break;
    cur = cur.substring(0, i);
  }
  return null;
}

async function loadLocks(env) {
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
const ACCESS_DAYS = 30;
const accessSince = () => Math.floor(Date.now() / 1000) - ACCESS_DAYS * 24 * 3600;

// Есть ли у пользователя действующий доступ к папке (покупка активна и не истекла)
async function hasAccess(env, uid, lockFolder) {
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
async function accessExpires(env, uid) {
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

function normFolder(f) {
  return String(f || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
}

// Восстановить полный путь папки по её id (через parent_id).
async function getFolderPath(env, id) {
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
async function findFolderIdByPath(env, path) {
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/webhook') return handleTelegramWebhook(request, env, ctx);
    if (url.pathname === '/report') return handleReport(request, env);

    if (!env.DB) return json({ error: 'DB not bound' }, 500);

    const action = url.searchParams.get('action') || 'get';
    const mVal = url.searchParams.get('m');

    let bodyData = {};
    if (request.method === 'POST') {
      try {
        bodyData = await request.json();
      } catch {
        bodyData = {};
      }
    }

    try {
      // ---- Публичный список маршрутов ----
      if (action === 'list_routes') {
        const rows = (await env.DB.prepare(
          'SELECT m, name, description, creator_name, folder_id FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
          .all()).results || [];
        return json(rows.map((r) => ({
          m: r.m, name: r.name,
          description: r.description || '', creator_name: r.creator_name || '',
          folder_id: r.folder_id || null,
        })), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      }

      // ---- Каталог одним запросом: маршруты + папки + замки ----
      // Нужен меню навигатора, чтобы дерево папок строилось сразу из одного
      // ответа. Иначе список успевает отрисоваться «плоским» до прихода
      // отдельного запроса folder_list.
      if (action === 'catalog') {
        const routes = (await env.DB.prepare(
          'SELECT m, name, description, creator_name, folder_id FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
          .all()).results || [];
        const folders = (await env.DB.prepare(
          'SELECT id, name, parent_id, price FROM folders ORDER BY name').all()).results || [];
        const locks = await loadLocks(env);
        return json({
          routes: routes.map((r) => ({
            m: r.m, name: r.name,
            description: r.description || '', creator_name: r.creator_name || '',
            folder_id: r.folder_id || null,
          })),
          folders: folders.map((f) => ({
            id: f.id, name: f.name, parent_id: f.parent_id, price: f.price || 0,
          })),
          locks: Array.from(locks.entries()).map(([folder, price]) => ({ folder, price })),
        }, 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      }

      // ---- Проверка прав редактора (без изменений данных) ----
      if (action === 'editor_check') {
        const guard = await requireEditor(request, bodyData, env);
        return json({ allowed: guard.ok, via: guard.via || null, uid: guard.uid || null });
      }

      // ---- Защита редакторских экшенов ----
      if (EDITOR_ACTIONS.has(action)) {
        const guard = await requireEditor(request, bodyData, env);
        if (!guard.ok) return json({ error: 'forbidden' }, 403);
      }

      // ---- Получение маршрута ----
      // get — навигатор, с проверкой платных папок (нужен tg_init_data покупателя).
      // get_protected — редактор, без ограничений.
      if (action === 'get' || action === 'get_protected') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const { row, m } = await findRoute(env, mVal);
        if (!row) return json({ error: 'not_found' }, 404);
        if (action === 'get') {
          // Папку маршрута берём из folder_id (реальная иерархия), а не из имени:
          // имя маршрута может не совпадать с деревом папок.
          let routeFolder = '';
          if (row.folder_id !== null && row.folder_id !== undefined) {
            routeFolder = await getFolderPath(env, row.folder_id);
          }
          if (!routeFolder) routeFolder = folderOf(row.name || ''); // фолбэк для старых данных
          const lock = lockForFolder(routeFolder, await loadLocks(env));
          if (lock) {
            const initData = url.searchParams.get('tg_init_data') || bodyData.tg_init_data || '';
            const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
            if (!uid) return json({ error: 'locked', folder: lock.folder, price: lock.price }, 403);
            if (!(await hasAccess(env, uid, lock.folder))) {
              return json({ error: 'locked', folder: lock.folder, price: lock.price }, 403);
            }
          }
        }
        return json({ name: row.name || '', m, data: parseData(row.json) });
      }

      // ---- Полный список (для редактора) ----
      if (action === 'list') {
        const rows = (await env.DB.prepare(
          'SELECT m, name, visible, folder_id FROM roads ORDER BY name').all()).results || [];
        return json({
          routes: rows.map((r) => ({
            m: r.m, name: r.name || '', visible: r.visible === 1, folder_id: r.folder_id || null,
          })),
        });
      }

      if (action === 'delete') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        await env.DB.prepare('DELETE FROM roads WHERE m = ?').bind(resolveM(mVal)).run();
        return json({ status: 'deleted' });
      }

      if (action === 'save') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const newJson = bodyData.data || [];
        await env.DB.prepare(
          'INSERT INTO roads (id, m, json) VALUES (?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json')
          .bind(SHARED_ID, m, typeof newJson === 'string' ? newJson : JSON.stringify(newJson)).run();
        return json({ status: 'saved' });
      }

      if (action === 'get_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const row = await env.DB.prepare(
          'SELECT name, description, visible, creator_name, folder_id FROM roads WHERE m = ?')
          .bind(resolveM(mVal)).first();
        if (!row) return json({ error: 'route_not_found' }, 404);
        return json({
          name: row.name || '', description: row.description || '',
          visible: row.visible === 1, creator_name: row.creator_name || '',
          folder_id: row.folder_id || null,
        });
      }

      if (action === 'save_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const name = bodyData.name || '';
        const description = bodyData.description || '';
        const visible = bodyData.visible ? 1 : 0;
        const newM = bodyData.new_m || '';
        const creatorName = bodyData.creator_name || '';
        const folderId = bodyData.folder_id !== undefined ? bodyData.folder_id : null;
        if (newM && newM !== m) {
          // Переименование: копируем json + мета под новым m, старый удаляем
          const src = await env.DB.prepare(
            'SELECT json, creator_name FROM roads WHERE m = ?').bind(m).first();
          if (!src) return json({ error: 'route_not_found' }, 404);
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO roads (id, m, json, name, description, visible, creator_name, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json, name=excluded.name, description=excluded.description, visible=excluded.visible, creator_name=excluded.creator_name, folder_id=excluded.folder_id')
              .bind(SHARED_ID, newM, src.json, name, description, visible,
                creatorName || src.creator_name || '', folderId),
            env.DB.prepare('DELETE FROM roads WHERE m = ?').bind(m),
          ]);
          return json({ status: 'meta_saved', new_m: newM });
        }
        if (creatorName) {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, creator_name = ?, folder_id = ? WHERE m = ?')
            .bind(name, description, visible, creatorName, folderId, m).run();
        } else {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, folder_id = ? WHERE m = ?')
            .bind(name, description, visible, folderId, m).run();
        }
        return json({ status: 'meta_saved' });
      }

      // ---- Платные папки ----
      if (action === 'locks') {
        const locks = await loadLocks(env);
        return json({ locks: Array.from(locks.entries()).map(([folder, price]) => ({ folder, price })) });
      }

      if (action === 'save_lock') {
        const folder = normFolder(bodyData.folder || url.searchParams.get('folder'));
        const price = Math.floor(Number(bodyData.price ?? url.searchParams.get('price')));
        if (!folder) return json({ error: 'missing_folder' }, 400);
        if (!Number.isFinite(price) || price < 0 || price > 10000) {
          return json({ error: 'bad_price' }, 400);
        }
        const folderId = await findFolderIdByPath(env, folder);
        if (!folderId) return json({ error: 'folder_not_found' }, 400);
        await env.DB.prepare('UPDATE folders SET price = ? WHERE id = ?').bind(price, folderId).run();
        return json({ status: 'ok', folder, price });
      }

      if (action === 'del_lock') {
        const folder = normFolder(bodyData.folder || url.searchParams.get('folder'));
        if (!folder) return json({ error: 'missing_folder' }, 400);
        const folderId = await findFolderIdByPath(env, folder);
        if (!folderId) return json({ error: 'folder_not_found' }, 400);
        await env.DB.prepare('UPDATE folders SET price = 0 WHERE id = ?').bind(folderId).run();
        return json({ status: 'ok' });
      }

      // Купленные папки пользователя (Telegram). Только действующие (30 дней).
      if (action === 'my_access') {
        const initData = bodyData.initData || url.searchParams.get('tg_init_data') || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        const expires = await accessExpires(env, uid);
        return json({ user_id: uid, folders: Object.keys(expires), expires });
      }

      // Создать счёт на папку (Telegram Stars).
      if (action === 'shop_invoice') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        const locks = await loadLocks(env);
        const lock = lockForFolder(normFolder(bodyData.folder), locks);
        if (!lock) return json({ error: 'not_locked' }, 400);
        if (await hasAccess(env, uid, lock.folder)) {
          return json({ ok: true, owned: true, folder: lock.folder });
        }
        const title = (`Доступ: ${lock.folder}`).substring(0, 32);
        const payload = `folder:${uid}:${lock.folder}:${Date.now()}`;
        const res = await tgApi(env, 'createInvoiceLink', {
          title,
          description: `Доступ к папке «${lock.folder}» на 30 дней`.substring(0, 255),
          payload,
          currency: 'XTR',
          prices: [{ label: title, amount: lock.price }],
        });
        if (!res || !res.ok) {
          return json({ ok: false, error: 'invoice_failed', details: res && res.description }, 500);
        }
        return json({ ok: true, invoiceLink: res.result, price: lock.price, folder: lock.folder });
      }

      // Подтвердить оплаты: сверяем getStarTransactions по payload и, если вебхук
      // ещё не записал покупку, записываем её сами (подстраховка от задержки).
      if (action === 'shop_claim') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        let claimed = 0;
        let offset = 0;
        for (let page = 0; page < 5; page++) {
          const res = await tgApi(env, 'getStarTransactions', { offset, limit: 100 });
          if (!res || !res.ok) break;
          const txns = (res.result && res.result.transactions) || [];
          for (const t of txns) {
            const stars = Math.trunc(Number(t.amount || 0));
            if (!(stars > 0)) continue; // возвраты и списания пропускаем
            for (const p of [t.source, t.receiver]) {
              const payload = p && p.invoice_payload;
              if (typeof payload === 'string' && payload.startsWith(`folder:${uid}:`)) {
                const folder = payload.split(':').slice(2, -1).join(':');
                if (folder && await recordClaimedPurchase(env, uid, folder, stars, t.id, t.date)) {
                  claimed++;
                }
              }
            }
          }
          if (txns.length < 100) break;
          offset += 100;
        }
        const expires = await accessExpires(env, uid);
        return json({ ok: true, claimed, folders: Object.keys(expires), expires });
      }

      // ---- Папки (реальная иерархия) ----

      // Список всех папок (плоский)
      if (action === 'folder_list') {
        const rows = (await env.DB.prepare(
          'SELECT id, name, parent_id, owner_id, visible, price FROM folders ORDER BY name').all()).results || [];
        return json({ folders: rows.map((r) => ({ id: r.id, name: r.name, parent_id: r.parent_id, owner_id: r.owner_id, visible: r.visible === 1, price: r.price })) });
      }

      // Создать папку
      if (action === 'folder_create') {
        const name = String(bodyData.name || '').trim();
        const parentId = bodyData.parent_id !== undefined ? bodyData.parent_id : null;
        const visible = bodyData.visible !== false ? 1 : 0;
        const price = Math.floor(Number(bodyData.price ?? 0));
        if (!name) return json({ error: 'missing_name' }, 400);
        if (!Number.isFinite(price) || price < 0 || price > 10000) {
          return json({ error: 'bad_price' }, 400);
        }
        const res = await env.DB.prepare(
          'INSERT INTO folders (name, parent_id, visible, price) VALUES (?, ?, ?, ?)').bind(name, parentId, visible, price).run();
        const id = res.meta && res.meta.last_row_id ? res.meta.last_row_id : null;
        return json({ status: 'ok', id, name, parent_id: parentId, visible: visible === 1, price });
      }

      // Переименовать папку
      if (action === 'folder_rename') {
        const id = Number(bodyData.id);
        const name = String(bodyData.name || '').trim();
        if (!Number.isFinite(id) || !name) return json({ error: 'bad_params' }, 400);
        await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ?').bind(name, id).run();
        return json({ status: 'ok' });
      }

      // Удалить папку (только если пустая: нет подпапок и нет маршрутов)
      if (action === 'folder_delete') {
        const id = Number(bodyData.id);
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        const children = (await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(id).all()).results || [];
        const routes = (await env.DB.prepare('SELECT m FROM roads WHERE folder_id = ?').bind(id).all()).results || [];
        if (children.length > 0) return json({ error: 'folder_not_empty' }, 400);
        if (routes.length > 0) return json({ error: 'folder_has_routes' }, 400);
        await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
        return json({ status: 'ok' });
      }

      // Переместить папку (изменить parent_id). Защита от циклов.
      if (action === 'folder_move') {
        const id = Number(bodyData.id);
        const parentId = bodyData.parent_id !== undefined ? bodyData.parent_id : null;
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        if (parentId !== null && parentId === id) return json({ error: 'cyclic_move' }, 400);
        if (parentId !== null) {
          let cur = parentId;
          let cyclic = false;
          while (cur !== null) {
            if (cur === id) { cyclic = true; break; }
            const p = (await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(cur).first());
            cur = p ? p.parent_id : null;
          }
          if (cyclic) return json({ error: 'cyclic_move' }, 400);
        }
        await env.DB.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').bind(parentId, id).run();
        return json({ status: 'ok' });
      }

      // Настройки папки: имя, видимость, цена
      if (action === 'folder_settings') {
        const id = Number(bodyData.id);
        const name = bodyData.name !== undefined ? String(bodyData.name).trim() : null;
        const visible = bodyData.visible !== undefined ? (bodyData.visible ? 1 : 0) : null;
        const price = bodyData.price !== undefined ? Math.floor(Number(bodyData.price)) : null;
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10000)) {
          return json({ error: 'bad_price' }, 400);
        }
        const sets = [];
        const vals = [];
        if (name !== null) { sets.push('name = ?'); vals.push(name); }
        if (visible !== null) { sets.push('visible = ?'); vals.push(visible); }
        if (price !== null) { sets.push('price = ?'); vals.push(price); }
        if (sets.length === 0) return json({ error: 'nothing_to_update' }, 400);
        vals.push(id);
        await env.DB.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ status: 'ok' });
      }

      // Переместить маршрут в папку (folder_id = null — в корень)
      if (action === 'route_move') {
        const mVal = bodyData.m || url.searchParams.get('m');
        const folderId = bodyData.folder_id !== undefined ? bodyData.folder_id : null;
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const row = await env.DB.prepare('SELECT id FROM roads WHERE m = ?').bind(m).first();
        if (!row) return json({ error: 'route_not_found' }, 404);
        await env.DB.prepare('UPDATE roads SET folder_id = ? WHERE m = ?').bind(folderId, m).run();
        return json({ status: 'ok' });
      }

      return json({ error: 'unknown_action' }, 400);
    } catch (e) {
      return json({ error: 'internal_server_error', details: String(e && e.message || e) }, 500);
    }
  },
};

// =====================================================================
// Telegram Webhook + админ-команды (перенесено из workerdon.js)
// =====================================================================

function isAdmin(chatId, env) {
  const adminKey = String(env.ADMIN_ACCESS_KEY || env.ADMIN_IDS || "");
  return adminKey.split(",").map((s) => s.trim()).filter(Boolean).includes(String(chatId));
}

async function recordPurchase(env, pay, from) {
  const chargeId = pay.telegram_payment_charge_id;
  if (!chargeId) return { duplicate: false };

  // Защита от дублей по charge_id
  const existing = await env.DB.prepare(
    'SELECT 1 FROM purchases WHERE charge_id = ? LIMIT 1'
  ).bind(chargeId).first();
  if (existing) return { duplicate: true };

  const payload = String(pay.invoice_payload || "");
  const now = Math.floor(Date.now() / 1000);
  const stars = Number(pay.total_amount || 0);
  const currency = pay.currency || 'XTR';

  let productType = 'other';
  let productId = '';
  let expiresAt = null;

  if (payload.startsWith('folder:')) {
    productType = 'folder_access';
    const parts = payload.split(':');
    productId = parts.slice(2, -1).join(':');
    expiresAt = now + ACCESS_DAYS * 24 * 3600;
  } else if (payload.startsWith('donate:')) {
    productType = 'donate';
    productId = 'donate';
  } else if (payload.startsWith('premium_30d:')) {
    productType = 'premium';
    productId = 'premium_30d';
    expiresAt = now + 30 * 24 * 3600;
  }

  const orderId = `order:${chargeId}:${now}`;

  await env.DB.prepare(
    `INSERT INTO purchases
       (user_id, product_type, product_id, charge_id, order_id, payload,
        stars, currency, status, ts, expires_at, raw_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'XTR', 'active', ?, ?, ?)`
  ).bind(
    from && from.id != null ? String(from.id) : null,
    productType,
    productId,
    chargeId,
    orderId,
    payload,
    stars,
    now,
    expiresAt,
    JSON.stringify(pay)
  ).run();

  return { duplicate: false, chargeId, productType, productId, stars };
}

// Подстраховка к вебхуку: записать покупку папки, найденную в getStarTransactions.
// charge_id = id транзакции = telegram_payment_charge_id, поэтому повторная запись
// (и запись вебхуком) не создаёт дублей — INSERT OR IGNORE по UNIQUE(charge_id).
async function recordClaimedPurchase(env, uid, folder, stars, chargeId, ts) {
  if (!chargeId || !folder || !(stars > 0)) return false;
  const now = Math.floor(Date.now() / 1000);
  const base = Number(ts) > 0 ? Number(ts) : now;
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO purchases
       (user_id, product_type, product_id, charge_id, order_id, payload,
        stars, currency, status, ts, expires_at)
     VALUES (?, 'folder_access', ?, ?, NULL, ?, ?, 'XTR', 'active', ?, ?)`
  ).bind(
    uid, folder, chargeId, `folder:${uid}:${folder}`, stars, base,
    base + ACCESS_DAYS * 24 * 3600
  ).run();
  return !!(res.meta && res.meta.changes);
}

// Формат числа звёзд из целой части и нанозвёзд (1e-9).
function formatStars(amount, nanos) {
  let stars = Number(amount || 0) + Math.trunc(Number(nanos || 0) / 1_000_000_000);
  const frac = Math.abs(Number(nanos || 0) % 1_000_000_000);
  return frac ? `${stars}.${String(frac).padStart(9, "0").replace(/0+$/, "")}` : `${stars}`;
}

// Числовой баланс звёзд бота.
// Bot API getMyStarBalance — прямой баланс бота.
// Возвращает { total } либо { error }.
async function getStarsBalance(env) {
  const res = await tgApi(env, "getMyStarBalance", {});
  if (!res?.ok) return { error: res?.description || "ошибка API" };
  return { total: formatStars(res.result?.amount, res.result?.nanostar_amount) };
}

async function getStarsBalanceText(env) {
  const b = await getStarsBalance(env);
  if (b.error) return "Не смог получить баланс: " + b.error;
  return `⭐ Баланс звёзд бота: ${b.total}`;
}

async function getStatsText(env) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    `SELECT * FROM purchases WHERE status = 'active' AND ts > ?`
  ).bind(now - 30 * 24 * 3600).all()).results || [];

  if (!rows.length) return "📊 Оплат пока нет.";

  const sum = (arr) => arr.reduce((a, r) => a + (Number(r.stars) || 0), 0);
  const total = sum(rows);

  const byType = {};
  for (const r of rows) {
    byType[r.product_type] = (byType[r.product_type] || 0) + (Number(r.stars) || 0);
  }

  const lines = [
    "📊 Статистика покупок",
    `💰 Всего: ${total} ⭐ (${rows.length} покупок)`,
  ];
  for (const [type, amount] of Object.entries(byType)) {
    lines.push(`📦 ${type}: ${amount} ⭐`);
  }

  const byDay = {};
  for (const r of rows) {
    const d = new Date((Number(r.ts) || 0) * 1000).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + (Number(r.stars) || 0);
  }
  const days = Object.entries(byDay).sort((a, b) => b[0] - a[0]).slice(0, 7);
  lines.push("", "📅 По дням:");
  for (const [d, s] of days) lines.push(`${d} — ${s} ⭐`);

  return lines.join("\n");
}

async function handleRefund(chatId, args, env, ctx) {
  let uid = null, chargeId = null;
  if (args.length === 1) {
    chargeId = args[0];
    const row = await env.DB.prepare(
      'SELECT user_id, stars FROM purchases WHERE charge_id = ? LIMIT 1'
    ).bind(chargeId).first();
    if (!row) {
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: "Не нашёл оплату по charge_id. Формат: /refund <user_id> <charge_id>",
      });
      return;
    }
    uid = row.user_id;
  } else if (args.length >= 2) {
    uid = Number(args[0]);
    chargeId = args[1];
  } else {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: "Формат: /refund <charge_id>  или  /refund <user_id> <charge_id>",
    });
    return;
  }

  if (!Number.isFinite(uid) || !chargeId) {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: "Формат: /refund <charge_id>  или  /refund <user_id> <charge_id>",
    });
    return;
  }

  const res = await tgApi(env, 'refundStarPayment', {
    user_id: uid,
    telegram_payment_charge_id: chargeId,
  });

  if (!res?.ok) {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: "↩️ Возврат не удался: " + (res?.description || "ошибка API"),
    });
    return;
  }

  await env.DB.prepare(
    `UPDATE purchases SET status = 'refunded', refunded_at = ?, refund_reason = 'admin' WHERE charge_id = ?`
  ).bind(Math.floor(Date.now() / 1000), chargeId).run();

  const info = await env.DB.prepare(
    'SELECT user_id, stars, product_type, product_id FROM purchases WHERE charge_id = ? LIMIT 1'
  ).bind(chargeId).first();
  const amount = info ? ` ${info.stars} ⭐` : "";

  // Уведомление о возврате в канал (не блокируя ответ на команду)
  const job = (async () => {
    const b = await getStarsBalance(env);
    const balance = b && !b.error ? b.total : null;
    await notifyChannel(env, buildRefundText(info, uid, chargeId, balance));
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  else await job;

  await tgApi(env, 'sendMessage', { chat_id: chatId, text: `✅ Возврат${amount} выполнен.` });
}

// =====================================================================
// Уведомления в канал (env.PURCHASE_CHANNEL_ID)
// =====================================================================

// Человекочитаемое название продукта.
function productLabel(productType, productId) {
  const id = String(productId || '');
  if (productType === 'folder_access') return `Доступ к папке «${id}»`;
  if (productType === 'premium') return 'Premium на 30 дней';
  if (productType === 'donate') return 'Донат';
  return id ? `Покупка «${id}»` : 'Покупка';
}

// Сумма в звёздах либо в валюте.
function moneyText(amount, currency) {
  return currency === 'XTR' ? `${amount} ⭐` : `${amount} ${currency}`;
}

// Дата/время по Москве (+03:00), без зависимости от tz-данных рантайма.
function moscowNow() {
  const m = new Date(Date.now() + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(m.getUTCDate())}.${p(m.getUTCMonth() + 1)}.${m.getUTCFullYear()} ` +
    `${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`;
}

// Отправка в канал. Без PURCHASE_CHANNEL_ID — тихо ничего не делать; ошибки не пробрасывать.
async function notifyChannel(env, text) {
  if (!env.PURCHASE_CHANNEL_ID || !text) return;
  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.PURCHASE_CHANNEL_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('notifyChannel error:', (e && e.message) || e);
  }
}

// Текст уведомления о покупке.
function buildPurchaseText(pay, from, record, balance) {
  const user = from || {};
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || '—';
  const username = user.username ? '@' + user.username : 'без username';
  const uid = user.id != null ? user.id : '—';
  const label = productLabel(record.productType, record.productId);
  const lines = [
    '🛒 <b>Новая покупка</b>',
    `💳 ${escapeHtml(label)}`,
    `💰 Сумма: <b>${moneyText(Number(pay.total_amount || 0), pay.currency || 'XTR')}</b>`,
  ];
  if (balance) lines.push(`💼 Баланс бота: <b>${escapeHtml(balance)} ⭐</b>`);
  lines.push(
    `👤 ${escapeHtml(fullName)} · ${escapeHtml(username)}`,
    `🆔 <code>${uid}</code>`,
    `🕒 ${moscowNow()} (МСК)`,
  );
  if (record.chargeId) lines.push(`🧾 <code>${escapeHtml(record.chargeId)}</code>`);
  return lines.join('\n');
}

// Текст уведомления о возврате.
function buildRefundText(info, uid, chargeId, balance) {
  const label = productLabel(info && info.product_type, info && info.product_id);
  const amount = info ? Number(info.stars || 0) : 0;
  const u = uid != null ? uid : (info && info.user_id);
  const lines = [
    '↩️ <b>Возврат</b>',
    `💳 ${escapeHtml(label)}`,
    `💰 Сумма: <b>${amount} ⭐</b>`,
  ];
  if (balance) lines.push(`💼 Баланс бота: <b>${escapeHtml(balance)} ⭐</b>`);
  lines.push(
    `🆔 <code>${u != null ? u : '—'}</code>`,
    `🕒 ${moscowNow()} (МСК)`,
  );
  if (chargeId) lines.push(`🧾 <code>${escapeHtml(chargeId)}</code>`);
  return lines.join('\n');
}

async function handleTelegramWebhook(request, env, ctx) {
  if (env.TG_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (got !== env.TG_SECRET) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  // 1. Подтверждение предварительной оплаты (обязательно ответить за 10 сек)
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    await tgApi(env, "answerPreCheckoutQuery", {
      pre_checkout_query_id: q.id,
      ok: true,
    });
    return json({ ok: true });
  }

  const message = update.message || update.edited_message || {};

  // 2. Успешная оплата — записываем в D1 purchases и уведомляем канал
  if (message.successful_payment) {
    const pay = message.successful_payment;
    const record = await recordPurchase(env, pay, message.from);
    if (!record.duplicate) {
      const job = (async () => {
        const b = await getStarsBalance(env);
        const balance = b && !b.error ? b.total : null;
        await notifyChannel(env, buildPurchaseText(pay, message.from, record, balance));
      })();
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      else await job;
    }
    return json({ ok: true });
  }

  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId) return json({ ok: true });

  const cmd = text.split(" ")[0].split("@")[0];

  if (cmd === "/balance") {
    if (!isAdmin(chatId, env)) return json({ ok: true });
    const reply = await getStarsBalanceText(env);
    await tgApi(env, "sendMessage", { chat_id: chatId, text: reply });
    return json({ ok: true });
  }

  if (cmd === "/stats") {
    if (!isAdmin(chatId, env)) return json({ ok: true });
    const reply = await getStatsText(env);
    await tgApi(env, "sendMessage", { chat_id: chatId, text: reply });
    return json({ ok: true });
  }

  if (cmd === "/refund") {
    if (!isAdmin(chatId, env)) return json({ ok: true });
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    await handleRefund(chatId, args, env, ctx);
    return json({ ok: true });
  }

  if (cmd === "/start" && isAdmin(chatId, env)) {
    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text: [
        "Админ-команды:",
        "/balance — баланс звёзд",
        "/stats — статистика оплат",
        "/refund <charge_id> — возврат",
        "/refund <user_id> <charge_id> — возврат",
      ].join("\n"),
    });
    return json({ ok: true });
  }

  return json({ ok: true });
}
