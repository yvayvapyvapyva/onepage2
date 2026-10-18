// Оплата Telegram Stars: запись покупок, баланс, возвраты и уведомления в канал.

import { tgApi } from './telegram.js';
import { escapeHtml } from './http.js';
import { ACCESS_DAYS, getFolderPath } from './db.js';

// Админ бота: ADMIN_IDS — Telegram user id через запятую (команды /balance, /stats, /refund).
export function isAdmin(chatId, env) {
  const adminKey = String(env.ADMIN_IDS || "");
  return adminKey.split(",").map((s) => s.trim()).filter(Boolean).includes(String(chatId));
}

// Единственная точка записи покупки. Используется обоими путями:
//   1) вебхук Telegram (successful_payment) — передаёт сырой платёж (raw);
//   2) самовосстановление shop_claim — передаёт транзакцию из getStarTransactions.
// Идемпотентность: UNIQUE(charge_id) + INSERT OR IGNORE — повторная запись того
// же платежа дубля не создаёт и возвращает { duplicate: true }.
export async function recordPurchase(env, pay) {
  const chargeId = pay.chargeId;
  if (!chargeId) return { duplicate: false };

  const payload = String(pay.payload || '');
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(pay.ts) > 0 ? Number(pay.ts) : now;
  const stars = Number(pay.stars || 0);

  let productType = 'other';
  let productId = '';
  let expiresAt = null;

  if (payload.startsWith('folder:')) {
    productType = 'folder_access';
    // payload = folder:<uid>:id=<id папки>:<timestamp>
    // Доступ считается по id папки, путь в payload не участвует.
    const tag = payload.split(':')[2] || '';
    productId = tag.startsWith('id=') ? tag.slice(3) : '';
    expiresAt = ts + ACCESS_DAYS * 24 * 3600;
  } else if (payload.startsWith('donate:')) {
    productType = 'donate';
    productId = 'donate';
  } else if (payload.startsWith('premium_30d:')) {
    productType = 'premium';
    productId = 'premium_30d';
    expiresAt = ts + 30 * 24 * 3600;
  }

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO purchases
       (user_id, product_type, product_id, charge_id, payload,
        stars, currency, status, ts, expires_at, raw_response)
     VALUES (?, ?, ?, ?, ?, ?, 'XTR', 'active', ?, ?, ?)`
  ).bind(
    pay.userId != null ? String(pay.userId) : null,
    productType,
    productId,
    chargeId,
    payload,
    stars,
    ts,
    expiresAt,
    pay.raw ? JSON.stringify(pay.raw) : null
  ).run();

  if (!(res.meta && res.meta.changes)) return { duplicate: true };
  return { duplicate: false, chargeId, productType, productId, stars };
}

// Формат числа звёзд из целой части и нанозвёзд (1e-9).
export function formatStars(amount, nanos) {
  let stars = Number(amount || 0) + Math.trunc(Number(nanos || 0) / 1_000_000_000);
  const frac = Math.abs(Number(nanos || 0) % 1_000_000_000);
  return frac ? `${stars}.${String(frac).padStart(9, "0").replace(/0+$/, "")}` : `${stars}`;
}

// Числовой баланс звёзд бота.
// Bot API getMyStarBalance — прямой баланс бота.
// Возвращает { total } либо { error }.
export async function getStarsBalance(env) {
  const res = await tgApi(env, "getMyStarBalance", {});
  if (!res?.ok) return { error: res?.description || "ошибка API" };
  return { total: formatStars(res.result?.amount, res.result?.nanostar_amount) };
}

export async function getStarsBalanceText(env) {
  const b = await getStarsBalance(env);
  if (b.error) return "Не смог получить баланс: " + b.error;
  return `⭐ Баланс звёзд бота: ${b.total}`;
}

export async function getStatsText(env) {
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

// Возврат оплаты (админ-команда /refund). Делает refundStarPayment,
// помечает покупку refunded и уведомляет канал.
export async function handleRefund(chatId, args, env, ctx) {
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
    await notifyChannel(env, await buildRefundText(env, info, uid, chargeId, balance));
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  else await job;

  await tgApi(env, 'sendMessage', { chat_id: chatId, text: `✅ Возврат${amount} выполнен.` });
}

// =====================================================================
// Уведомления в канал (env.PURCHASE_CHANNEL_ID)
// =====================================================================

// Как показать продукт человеку. Для доступа к папке в базе лежит id папки,
// а в сообщении нужен путь, поэтому разворачиваем id → путь (папки может уже не быть).
export async function productDisplayId(env, productType, productId) {
  if (productType !== 'folder_access') return String(productId || '');
  const raw = String(productId == null ? '' : productId);
  // В product_id лежит числовой id папки. Если он не распознан — показываем
  // как есть, чтобы это было видно в уведомлении, а не пряталось за «#0».
  if (!/^\d+$/.test(raw)) return raw || '—';
  const path = await getFolderPath(env, Number(raw));
  return path || `#${raw}`;
}

// Человекочитаемое название продукта.
export function productLabel(productType, productId) {
  const id = String(productId || '');
  if (productType === 'folder_access') return `Доступ к папке «${id}»`;
  if (productType === 'premium') return 'Premium на 30 дней';
  if (productType === 'donate') return 'Донат';
  return id ? `Покупка «${id}»` : 'Покупка';
}

// Сумма в звёздах либо в валюте.
export function moneyText(amount, currency) {
  return currency === 'XTR' ? `${amount} ⭐` : `${amount} ${currency}`;
}

// Дата/время по Москве (+03:00), без зависимости от tz-данных рантайма.
export function moscowNow() {
  const m = new Date(Date.now() + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(m.getUTCDate())}.${p(m.getUTCMonth() + 1)}.${m.getUTCFullYear()} ` +
    `${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`;
}

// Отправка в канал. Без PURCHASE_CHANNEL_ID — тихо ничего не делать; ошибки не пробрасывать.
export async function notifyChannel(env, text) {
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
export async function buildPurchaseText(env, pay, from, record, balance) {
  const user = from || {};
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || '—';
  const username = user.username ? '@' + user.username : 'без username';
  const uid = user.id != null ? user.id : '—';
  const label = productLabel(record.productType,
    await productDisplayId(env, record.productType, record.productId));
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
export async function buildRefundText(env, info, uid, chargeId, balance) {
  const label = productLabel(info && info.product_type,
    await productDisplayId(env, info && info.product_type, info && info.product_id));
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
