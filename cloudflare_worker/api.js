// Cloudflare Worker — API маршрутов на D1.
//
// Упрощённая модель: общий неймспейс, без аккаунтов и создателей.
// Любой посетитель видит все маршруты и может редактировать.
// Ключ маршрута — только `m` (колонка id всегда 'shared', оставлена для совместимости).
//
// Роуты:
//   GET /?action=list_routes                      — публичный список (visible=1)
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
//   иначе 403 {error:'locked', folder, price}. Редактор (get_protected) без ограничений.
//
// Env:
//   DB               — D1 database binding (см. schema.sql)
//   TELEGRAM_TOKEN   — токен бота (wrangler secret put, для /report)
//   REPORT_CHAT_ID   — чат для отчётов (wrangler secret put)
//   REPORT_KEY       — опциональный ключ в заголовке X-Report-Key (wrangler secret put)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Origin, Accept',
};

const SHARED_ID = 'shared';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
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
    'SELECT json, name FROM roads WHERE m = ?').bind(mRaw).first();
  if (row) return { row, m: mRaw };
  if (mRaw.includes('-')) {
    const m = resolveM(mRaw);
    row = await env.DB.prepare(
      'SELECT json, name FROM roads WHERE m = ?').bind(m).first();
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
async function verifyTgInitData(initData, botToken) {
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
  const rows = (await env.DB.prepare(
    'SELECT id, name, parent_id, price FROM folders WHERE price > 0').all()).results || [];
  const map = new Map();
  for (const r of rows) {
    const path = await getFolderPath(env, r.id);
    if (path) map.set(path, r.price);
  }
  return map;
}

// Доступ действует 30 дней с момента оплаты.
const ACCESS_DAYS = 30;
const accessSince = () => Math.floor(Date.now() / 1000) - ACCESS_DAYS * 24 * 3600;

// Есть ли у пользователя действующий доступ: куплена совпавшая или любая вышележащая папка.
async function hasAccess(env, uid, lockFolder) {
  const rows = (await env.DB.prepare(
    'SELECT folder FROM purchases WHERE user_id = ? AND ts > ?').bind(uid, accessSince()).all()).results || [];
  return rows.some((r) => lockFolder === r.folder || lockFolder.startsWith(r.folder + '/'));
}

// Карта folder -> unix-ts окончания доступа (для отображения).
async function accessExpires(env, uid) {
  const rows = (await env.DB.prepare(
    'SELECT folder, ts FROM purchases WHERE user_id = ? AND ts > ?').bind(uid, accessSince()).all()).results || [];
  const out = {};
  for (const r of rows) out[r.folder] = r.ts + ACCESS_DAYS * 24 * 3600;
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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
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

      // ---- Получение маршрута ----
      // get — навигатор, с проверкой платных папок (нужен tg_init_data покупателя).
      // get_protected — редактор, без ограничений.
      if (action === 'get' || action === 'get_protected') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const { row, m } = await findRoute(env, mVal);
        if (!row) return json({ error: 'not_found' }, 404);
        if (action === 'get') {
          const lock = lockForFolder(folderOf(row.name || ''), await loadLocks(env));
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
        const rows = (await env.DB.prepare(
          'SELECT folder, price FROM folder_locks ORDER BY folder').all()).results || [];
        return json({ locks: rows.map((r) => ({ folder: r.folder, price: r.price })) });
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

      // Подтвердить оплаты: сверяем getStarTransactions по payload, пишем в purchases.
      if (action === 'shop_claim') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        const found = [];
        let offset = 0;
        for (let page = 0; page < 5; page++) {
          const res = await tgApi(env, 'getStarTransactions', { offset, limit: 100 });
          if (!res || !res.ok) break;
          const txns = (res.result && res.result.transactions) || [];
          for (const t of txns) {
            for (const p of [t.source, t.receiver]) {
              const payload = p && p.invoice_payload;
              if (typeof payload === 'string' && payload.startsWith(`folder:${uid}:`)) {
                const parts = payload.split(':');
                const folder = parts.slice(2, -1).join(':');
                const stars = Math.trunc(Number(t.amount || 0));
                if (folder) {
                  found.push({ folder, stars, payload });
                  await env.DB.prepare(
                    'INSERT INTO purchases (user_id, folder, stars, ts, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, folder) DO UPDATE SET stars=excluded.stars, ts=excluded.ts, payload=excluded.payload')
                    .bind(uid, folder, stars, Math.floor(Date.now() / 1000), payload).run();
                }
              }
            }
          }
          if (txns.length < 100) break;
          offset += 100;
        }
        const expires = await accessExpires(env, uid);
        return json({ ok: true, claimed: found.length, folders: Object.keys(expires), expires });
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
