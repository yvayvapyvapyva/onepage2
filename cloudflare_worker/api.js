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
  const rows = (await env.DB.prepare('SELECT folder, price FROM folder_locks').all()).results || [];
  return new Map(rows.map((r) => [r.folder, r.price]));
}

// Есть ли у пользователя доступ: куплена совпавшая или любая вышележащая папка.
async function hasAccess(env, uid, lockFolder) {
  const rows = (await env.DB.prepare(
    'SELECT folder FROM purchases WHERE user_id = ?').bind(uid).all()).results || [];
  return rows.some((r) => lockFolder === r.folder || lockFolder.startsWith(r.folder + '/'));
}

function normFolder(f) {
  return String(f || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
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
          'SELECT m, name, description, creator_name FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
          .all()).results || [];
        return json(rows.map((r) => ({
          m: r.m, name: r.name,
          description: r.description || '', creator_name: r.creator_name || '',
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
          'SELECT m, name, visible FROM roads ORDER BY name').all()).results || [];
        return json({
          routes: rows.map((r) => ({
            m: r.m, name: r.name || '', visible: r.visible === 1,
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
          'SELECT name, description, visible, creator_name FROM roads WHERE m = ?')
          .bind(resolveM(mVal)).first();
        if (!row) return json({ error: 'route_not_found' }, 404);
        return json({
          name: row.name || '', description: row.description || '',
          visible: row.visible === 1, creator_name: row.creator_name || '',
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
        if (newM && newM !== m) {
          // Переименование: копируем json + мета под новым m, старый удаляем
          const src = await env.DB.prepare(
            'SELECT json, creator_name FROM roads WHERE m = ?').bind(m).first();
          if (!src) return json({ error: 'route_not_found' }, 404);
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO roads (id, m, json, name, description, visible, creator_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json, name=excluded.name, description=excluded.description, visible=excluded.visible, creator_name=excluded.creator_name')
              .bind(SHARED_ID, newM, src.json, name, description, visible,
                creatorName || src.creator_name || ''),
            env.DB.prepare('DELETE FROM roads WHERE m = ?').bind(m),
          ]);
          return json({ status: 'meta_saved', new_m: newM });
        }
        if (creatorName) {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, creator_name = ? WHERE m = ?')
            .bind(name, description, visible, creatorName, m).run();
        } else {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ? WHERE m = ?')
            .bind(name, description, visible, m).run();
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
        if (price === 0) {
          await env.DB.prepare('DELETE FROM folder_locks WHERE folder = ?').bind(folder).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO folder_locks (folder, price) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET price=excluded.price')
            .bind(folder, price).run();
        }
        return json({ status: 'ok', folder, price });
      }

      if (action === 'del_lock') {
        const folder = normFolder(bodyData.folder || url.searchParams.get('folder'));
        if (!folder) return json({ error: 'missing_folder' }, 400);
        await env.DB.prepare('DELETE FROM folder_locks WHERE folder = ?').bind(folder).run();
        return json({ status: 'ok' });
      }

      // Купленные папки пользователя (Telegram).
      if (action === 'my_access') {
        const initData = bodyData.initData || url.searchParams.get('tg_init_data') || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        const rows = (await env.DB.prepare(
          'SELECT folder FROM purchases WHERE user_id = ?').bind(uid).all()).results || [];
        return json({ user_id: uid, folders: rows.map((r) => r.folder) });
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
          description: `Доступ к папке «${lock.folder}» навсегда`.substring(0, 255),
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
        const rows = (await env.DB.prepare(
          'SELECT folder FROM purchases WHERE user_id = ?').bind(uid).all()).results || [];
        return json({ ok: true, claimed: found.length, folders: rows.map((r) => r.folder) });
      }

      return json({ error: 'unknown_action' }, 400);
    } catch (e) {
      return json({ error: 'internal_server_error', details: String(e && e.message || e) }, 500);
    }
  },
};
