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

      // ---- Получение маршрута (навигатор и редактор) ----
      if (action === 'get' || action === 'get_protected') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const { row, m } = await findRoute(env, mVal);
        if (!row) return json({ error: 'not_found' }, 404);
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

      return json({ error: 'unknown_action' }, 400);
    } catch (e) {
      return json({ error: 'internal_server_error', details: String(e && e.message || e) }, 500);
    }
  },
};
