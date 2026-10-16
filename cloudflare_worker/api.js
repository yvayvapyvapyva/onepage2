// Cloudflare Worker — API маршрутов на D1. Порт backend/handler.py (Yandex Function + YDB).
//
// Роуты (совместимы со старым API 1:1, фронт ходит так же):
//   GET /?action=list_routes[&creator=ID]          — публичный список (visible=1)
//   GET /?action=get&id=ID&m=NAME                  — публичный маршрут {name, m, data}
//   GET/POST /?action=register&login=&password=[&creator_name=]
//   GET/POST /?action=login&login=&password=
//   ...&action=list|get_protected|delete|save|get_meta|save_meta&p=tg|user...
//     p=tg:   + id + tg_init_data (проверка HMAC WebAppData)
//     p=user: + login + password (или ADMIN_ACCESS_KEY вместо пароля)
//
// Env:
//   DB               — D1 database binding (см. schema.sql)
//   TELEGRAM_TOKEN   — токен бота, для проверки tg_init_data (wrangler secret put)
//   ADMIN_ACCESS_KEY — мастер-пароль (wrangler secret put, опционально)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Origin, Accept',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

// Проверка Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyTgInitData(initData, botToken) {
  if (!botToken) return { uid: null, err: 'TELEGRAM_TOKEN not configured' };
  if (!initData) return { uid: null, err: 'tg_init_data missing' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { uid: null, err: 'hash missing from tg_init_data' };
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
    if (hex !== hash) return { uid: null, err: 'invalid tg signature' };

    let user;
    try {
      user = JSON.parse(params.get('user') || 'null');
    } catch {
      return { uid: null, err: 'invalid user data' };
    }
    if (!user || !user.id) return { uid: null, err: 'user id missing' };
    return { uid: String(user.id), err: null };
  } catch (e) {
    return { uid: null, err: String(e) };
  }
}

async function authUser(url, env) {
  const platform = url.searchParams.get('p') || 'user';
  if (platform === 'tg') {
    const { uid, err } = await verifyTgInitData(
      url.searchParams.get('tg_init_data') || '', env.TELEGRAM_TOKEN);
    if (!uid) return { uid: null, res: json({ error: 'invalid_tg_signature', message: err }, 401) };
    return { uid, res: null };
  }
  if (platform === 'user') {
    const login = (url.searchParams.get('login') || '').trim();
    const password = url.searchParams.get('password') || '';
    if (!login || !password) return { uid: null, res: json({ error: 'missing_credentials' }, 401) };
    if (env.ADMIN_ACCESS_KEY && password === env.ADMIN_ACCESS_KEY) return { uid: login, res: null };
    const row = await env.DB.prepare(
      'SELECT login, password FROM users WHERE login = ?').bind(login).first();
    if (!row || row.password !== password) {
      return { uid: null, res: json({ error: 'invalid_credentials' }, 401) };
    }
    return { uid: login, res: null };
  }
  return { uid: null, res: json({ error: 'unknown_platform' }, 401) };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.DB) return json({ error: 'DB not bound' }, 500);

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'get';
    const mVal = url.searchParams.get('m');
    const idVal = url.searchParams.get('id');
    const creatorFilter = url.searchParams.get('creator') || '';

    let bodyData = {};
    if (request.method === 'POST') {
      try {
        bodyData = await request.json();
      } catch {
        bodyData = {};
      }
    }

    try {
      // ---- Публичный список маршрутов (без подписи) ----
      if (action === 'list_routes') {
        const rows = creatorFilter
          ? (await env.DB.prepare(
              'SELECT DISTINCT id, m, name, description, creator_name FROM roads WHERE id = ? AND visible = 1 AND name IS NOT NULL ORDER BY name')
              .bind(creatorFilter).all()).results
          : (await env.DB.prepare(
              'SELECT DISTINCT id, m, name, description, creator_name FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
              .all()).results;
        return json((rows || []).map((r) => ({
          id: r.id, m: r.m, name: r.name,
          description: r.description || '', creator_name: r.creator_name || '',
        })), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      }

      // ---- Регистрация ----
      if (action === 'register') {
        const login = (url.searchParams.get('login') || '').trim();
        const password = url.searchParams.get('password') || '';
        const creatorName = url.searchParams.get('creator_name') || login;
        if (!login || !password) return json({ error: 'missing_fields' }, 400);
        if (login.length < 2 || password.length < 3) {
          return json({ error: 'login_min_2_password_min_3' }, 400);
        }
        if (!/[A-Za-zА-Яа-яЁё]/.test(login)) return json({ error: 'login_must_contain_letter' }, 400);
        if (login.includes('-')) return json({ error: 'login_no_hyphen' }, 400);
        const existing = await env.DB.prepare(
          'SELECT login FROM users WHERE login = ?').bind(login).first();
        if (existing) return json({ error: 'login_taken' }, 409);
        // NOTE: пароли хранятся plain-text ради совместимости со старой базой YDB.
        await env.DB.prepare(
          'INSERT INTO users (login, password, creator_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(login) DO UPDATE SET password=excluded.password, creator_name=excluded.creator_name')
          .bind(login, password, creatorName, Date.now() * 1000).run();
        return json({ status: 'registered' });
      }

      // ---- Логин ----
      if (action === 'login') {
        const login = (url.searchParams.get('login') || '').trim();
        const password = url.searchParams.get('password') || '';
        if (!login || !password) return json({ error: 'missing_fields' }, 400);
        if (env.ADMIN_ACCESS_KEY && password === env.ADMIN_ACCESS_KEY) {
          const row = await env.DB.prepare(
            'SELECT creator_name FROM users WHERE login = ?').bind(login).first();
          return json({ status: 'ok', login, name: (row && row.creator_name) || login, admin: true });
        }
        const row = await env.DB.prepare(
          'SELECT password, creator_name FROM users WHERE login = ?').bind(login).first();
        if (!row || row.password !== password) return json({ error: 'invalid_credentials' }, 401);
        return json({ status: 'ok', login, name: row.creator_name || login });
      }

      // ---- Публичное получение маршрута (для навигатора) ----
      if (action === 'get') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        if (!idVal) return json({ error: 'missing_id' }, 400);
        const row = await env.DB.prepare(
          'SELECT json, name FROM roads WHERE id = ? AND m = ?').bind(idVal, mVal).first();
        if (!row) return json({ error: 'not_found' }, 404);
        let data;
        try {
          data = typeof row.json === 'string' ? JSON.parse(row.json) : row.json;
        } catch {
          data = [];
        }
        return json({ name: row.name || '', m: mVal, data });
      }

      // ---- Приватные экшены (tg / user) ----
      const { uid, res: authErr } = await authUser(url, env);
      if (!uid) return authErr;

      if (action === 'list') {
        const rows = (await env.DB.prepare(
          'SELECT m, name, visible FROM roads WHERE id = ?').bind(uid).all()).results || [];
        return json({
          routes: rows.map((r) => ({
            m: r.m, name: r.name || '', visible: r.visible === 1,
          })),
        });
      }

      if (action === 'get_protected') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const row = await env.DB.prepare(
          'SELECT json FROM roads WHERE id = ? AND m = ?').bind(uid, mVal).first();
        if (!row) return json({ error: 'route_not_found' }, 404);
        let data;
        try {
          data = typeof row.json === 'string' ? JSON.parse(row.json) : row.json;
        } catch {
          data = [];
        }
        return json({ id: uid, m: mVal, data });
      }

      if (action === 'delete') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        await env.DB.prepare('DELETE FROM roads WHERE id = ? AND m = ?').bind(uid, mVal).run();
        return json({ status: 'deleted' });
      }

      if (action === 'save') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const newJson = Array.isArray(bodyData.data) ? bodyData.data : bodyData.data || [];
        await env.DB.prepare(
          'INSERT INTO roads (id, m, json) VALUES (?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json')
          .bind(uid, mVal, typeof newJson === 'string' ? newJson : JSON.stringify(newJson)).run();
        return json({ status: 'saved' });
      }

      if (action === 'get_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const row = await env.DB.prepare(
          'SELECT name, description, visible, creator_name FROM roads WHERE id = ? AND m = ?')
          .bind(uid, mVal).first();
        if (!row) return json({ error: 'route_not_found' }, 404);
        return json({
          name: row.name || '', description: row.description || '',
          visible: row.visible === 1, creator_name: row.creator_name || '',
        });
      }

      if (action === 'save_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const name = bodyData.name || '';
        const description = bodyData.description || '';
        const visible = bodyData.visible ? 1 : 0;
        const newM = bodyData.new_m || '';
        const creatorName = bodyData.creator_name || '';
        if (newM && newM !== mVal) {
          // Переименование: копируем json + мета под новым m, старый удаляем
          const src = await env.DB.prepare(
            'SELECT json, creator_name FROM roads WHERE id = ? AND m = ?').bind(uid, mVal).first();
          if (!src) return json({ error: 'route_not_found' }, 404);
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO roads (id, m, json, name, description, visible, creator_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json, name=excluded.name, description=excluded.description, visible=excluded.visible, creator_name=excluded.creator_name')
              .bind(uid, newM, src.json, name, description, visible,
                creatorName || src.creator_name || ''),
            env.DB.prepare('DELETE FROM roads WHERE id = ? AND m = ?').bind(uid, mVal),
          ]);
          return json({ status: 'meta_saved', new_m: newM });
        }
        if (creatorName) {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, creator_name = ? WHERE id = ? AND m = ?')
            .bind(name, description, visible, creatorName, uid, mVal).run();
        } else {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ? WHERE id = ? AND m = ?')
            .bind(name, description, visible, uid, mVal).run();
        }
        return json({ status: 'meta_saved' });
      }

      return json({ error: 'unknown_action' }, 400);
    } catch (e) {
      return json({ error: 'internal_server_error', details: String(e && e.message || e) }, 500);
    }
  },
};
