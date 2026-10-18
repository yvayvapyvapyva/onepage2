// Вебхук Telegram: подтверждение оплаты, запись покупки, админ-команды бота.

import { json } from './http.js';
import { tgApi } from './telegram.js';
import {
  isAdmin,
  recordPurchase,
  getStarsBalance,
  getStarsBalanceText,
  getStatsText,
  handleRefund,
  notifyChannel,
  buildPurchaseText,
} from './shop.js';

export async function handleTelegramWebhook(request, env, ctx) {
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
    const record = await recordPurchase(env, {
      chargeId: pay.telegram_payment_charge_id,
      userId: message.from && message.from.id != null ? message.from.id : null,
      payload: pay.invoice_payload,
      stars: pay.total_amount,
      raw: pay,
    });
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
