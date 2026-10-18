// Доступ редактора маршрутов: ключ из браузера либо подписанный initData Telegram.

import { verifyTgInitData } from './telegram.js';

// Экшены, доступные только редакторам маршрутов (см. requireEditor).
// Публичные остаются открытыми: catalog, get, list_routes, locks, my_access,
// shop_invoice, shop_claim, editor_check.
export const EDITOR_ACTIONS = new Set([
  'list', 'get_protected', 'get_meta',
  'delete', 'save', 'save_meta',
  'save_lock', 'del_lock',
  'folder_list', 'folder_create', 'folder_rename', 'folder_delete',
  'folder_move', 'folder_settings', 'route_move',
]);

// Среди читаемых/пишущих экшенов только эти требуют прав редактора.
export function editorIds(env) {
  return String(env.EDITOR_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function editorIdAllowed(uid, env) {
  return uid != null && editorIds(env).includes(String(uid));
}

// Сравнение строк за постоянное время (для ключа доступа).
export function safeEqual(a, b) {
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
export async function requireEditor(request, bodyData, env) {
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
