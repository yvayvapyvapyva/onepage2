// Cloudflare Worker — API маршрутов на D1.
//
// Точка входа: роутинг по action и ответы. Вся логика вынесена в lib/:
//   lib/http.js      — CORS, json(), escapeHtml()
//   lib/telegram.js  — verifyTgInitData(), tgApi()
//   lib/db.js        — маршруты, папки, замки платных папок, доступы покупателей
//   lib/editor.js    — EDITOR_ACTIONS, requireEditor()
//   lib/shop.js      — покупки, баланс звёзд, возвраты, уведомления в канал
//   lib/bot.js       — вебхук Telegram и админ-команды бота
//   lib/report.js    — прокси отчётов в Telegram Bot API
//
// Упрощённая модель: общий неймспейс, без аккаунтов.
// Читать маршруты может любой посетитель, редактировать — только редакторы
// (см. EDITOR_IDS / EDITOR_ACCESS_KEY и requireEditor).
// Ключ маршрута — только `m` (колонка id всегда 'shared', оставлена для совместимости).
//
// Роуты:
//   GET /?action=list_routes                      — публичный список (visible=1)
//   GET /?action=catalog                          — маршруты + папки + замки одним ответом (меню)
// Оба публичных списка не показывают скрытые папки (visible=0 в редакторе) и то,
// что внутри них. В редакторе такие папки видны и доступны как обычно.
//   GET /?action=get&m=NAME                       — маршрут {name, m, data}
//   GET/POST /?action=list                        — все маршруты (для редактора)
//   GET/POST /?action=get_protected&m=NAME        — то же, что get (для редактора)
//   POST /?action=save&m=NAME {data}              — сохранить точки
//   POST /?action=delete&m=NAME                   — удалить
//   GET/POST /?action=get_meta&m=NAME             — метаданные
//   POST /?action=save_meta&m=NAME {name, description, visible, creator_name, new_m?}
//   POST /report { text, lat?, lon? }             — прокси отчётов в Telegram Bot API
//   Платные папки (Telegram Stars):
//   GET  /?action=locks                            — {locks:[{id, folder, price}]} (публично)
//   POST /?action=save_lock {folder, price}        — пометить папку платной (price 0 — снять)
//   POST /?action=del_lock {folder}               — снять замок
//   POST /?action=my_access {initData}            — {user_id, ids:[...], expires:{id:ts}} (Telegram)
//   POST /?action=shop_invoice {initData, folder_id} — {invoiceLink, price, folder, folder_id}
//   POST /?action=shop_claim {initData}           — сверить оплаты, {ids:[...], expires}
//   Замки и доступ считаются по id папки, а не по пути из имён: у двух папок
//   может быть одинаковое имя. Маршрут в платной папке через action=get требует
//   tg_init_data покупателя, иначе 403 {error:'locked', id, folder, price}.
//   Редакторские экшены доступны только редакторам (см. requireEditor).
//
// Env:
//   DB               — D1 database binding (см. schema.sql)
//   TELEGRAM_TOKEN   — токен бота (wrangler secret put, для /report и вебхука)
//   TG_SECRET        — секрет вебхука Telegram (заголовок X-Telegram-Bot-Api-Secret-Token)
//   REPORT_CHAT_ID   — чат для отчётов (переменная [vars])
//   PURCHASE_CHANNEL_ID — канал для уведомлений о покупках и возвратах
//                         (@username публичного или -100… приватного). Не задан — уведомления не шлются.
//   EDITOR_IDS       — Telegram user id редакторов через запятую (чтение/правка маршрутов).
//   EDITOR_ACCESS_KEY — ключ для входа в редактор из браузера (вне Telegram). Не задан — только через Telegram.
//   ADMIN_IDS        — Telegram user id админов бота (команды /balance, /stats, /refund), через запятую.

import { CORS, json } from './lib/http.js';
import { verifyTgInitData, tgApi } from './lib/telegram.js';
import {
  SHARED_ID, resolveM, findRoute, parseData, normFolder,
  lockForFolder, loadFolderIndex, folderPathIn, findFolderIdByPath,
  hasAccess, accessExpires, hiddenFolderIds,
} from './lib/db.js';
import { EDITOR_ACTIONS, requireEditor } from './lib/editor.js';
import { handleReport } from './lib/report.js';
import { recordPurchase } from './lib/shop.js';
import { handleTelegramWebhook } from './lib/bot.js';

// Список платных папок для клиента: id — для сопоставления, folder — для показа.
// Путь в ответе справочный: у двух папок может быть одинаковое имя, различает их id.
function locksFromIndex(index) {
  const out = [];
  for (const f of index.values()) {
    if ((f.price || 0) > 0) {
      out.push({ id: f.id, folder: folderPathIn(index, f.id), price: f.price });
    }
  }
  return out;
}

// Попадает ли маршрут в публичные списки (catalog, list_routes). Маршрут в
// скрытой папке — не попадает; папка задаётся по id. Маршрут с несуществующей
// папкой считается корневым и показывается как раньше.
function isPublicRoute(route, hidden) {
  const fid = route.folder_id;
  return fid === null || fid === undefined || !hidden.has(fid);
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
        const folders = (await env.DB.prepare(
          'SELECT id, parent_id, visible FROM folders').all()).results || [];
        const hidden = hiddenFolderIds(folders);
        return json(rows
          .filter((r) => isPublicRoute(r, hidden))
          .map((r) => ({
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
          'SELECT id, name, parent_id, price, visible FROM folders ORDER BY name').all()).results || [];
        // Скрытые в редакторе папки в приложение не попадают — ни сама папка,
        // ни маршруты внутри неё (скрытие наследуется вниз, см. hiddenFolderIds).
        const hidden = hiddenFolderIds(folders);
        const locks = locksFromIndex(await loadFolderIndex(env));
        return json({
          routes: routes
            .filter((r) => isPublicRoute(r, hidden))
            .map((r) => ({
              m: r.m, name: r.name,
              description: r.description || '', creator_name: r.creator_name || '',
              folder_id: r.folder_id || null,
            })),
          folders: folders
            .filter((f) => !hidden.has(f.id))
            .map((f) => ({
              id: f.id, name: f.name, parent_id: f.parent_id, price: f.price || 0,
            })),
          locks,
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
          // Папка маршрута — только folder_id (реальная иерархия). Замок ищем
          // по id, а не по пути из имён: у двух папок-соседей имя может совпадать.
          const index = await loadFolderIndex(env);
          const folderId = row.folder_id;
          const lock = folderId !== null && folderId !== undefined
            ? lockForFolder(index, folderId)
            : null;
          if (lock) {
            const initData = url.searchParams.get('tg_init_data') || bodyData.tg_init_data || '';
            const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
            if (!uid) return json({ error: 'locked', id: lock.id, folder: lock.folder, price: lock.price }, 403);
            if (!(await hasAccess(env, uid, lock.id))) {
              return json({ error: 'locked', id: lock.id, folder: lock.folder, price: lock.price }, 403);
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
        return json({ locks: locksFromIndex(await loadFolderIndex(env)) });
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
        return json({ user_id: uid, ids: Object.keys(expires), expires });
      }

      // Создать счёт на папку (Telegram Stars).
      if (action === 'shop_invoice') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        // Папка задаётся по id: клиент присылает folder_id.
        const index = await loadFolderIndex(env);
        const rawId = bodyData.folder_id;
        const folderId = rawId === null || rawId === undefined || rawId === '' ? NaN : Number(rawId);
        if (!Number.isFinite(folderId)) {
          return json({ error: 'missing_folder' }, 400);
        }
        const lock = lockForFolder(index, folderId);
        if (!lock) return json({ error: 'not_locked' }, 400);
        if (await hasAccess(env, uid, lock.id)) {
          return json({ ok: true, owned: true, folder: lock.folder, folder_id: lock.id });
        }
        const title = (`Доступ: ${lock.folder}`).substring(0, 32);
        // В payload — id папки: путь не годится, у двух папок может совпасть имя.
        const payload = `folder:${uid}:id=${lock.id}:${Date.now()}`;
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
        return json({ ok: true, invoiceLink: res.result, price: lock.price, folder: lock.folder, folder_id: lock.id });
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
                if (!t.id) continue;
                // payload передаём как есть: разбор формата (id/старый путь) — в recordPurchase.
                const rec = await recordPurchase(env, {
                  chargeId: t.id,
                  userId: uid,
                  payload,
                  stars,
                  ts: t.date,
                });
                if (!rec.duplicate) claimed++;
              }
            }
          }
          if (txns.length < 100) break;
          offset += 100;
        }
        const expires = await accessExpires(env, uid);
        return json({ ok: true, claimed, ids: Object.keys(expires), expires });
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
