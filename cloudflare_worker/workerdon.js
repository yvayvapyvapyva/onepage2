// Mini App + Stars через Cloudflare Worker
// Роуты:
//  POST /         — webhook от Telegram (апдейты)
//  POST /invoice  — запрос от Mini App: выдать ссылку на оплату
//
// Env:
//  TG_TOKEN    — токен бота (обязательно)
//  TG_SECRET   — секрет webhook (опционально, проверка X-Telegram-Bot-Api-Secret-Token)
//  ADMIN_IDS   — telegram user id админов через запятую (для /balance /stats /refund)
//  PAYMENTS_KV — KV-namespace для учёта оплат (защита от дублей + /stats + /refund)

const PRODUCTS = {
  premium_30d: {
    title: "Premium 30 дней",
    description: "Доступ к премиум-функциям на 30 дней",
    // amount — в звёздах (50 = 50 ⭐). Валюта всегда XTR.
    prices: [{ label: "Premium 30 дней", amount: 50 }],
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS-префлайт от браузера/Telegram WebView (иначе Safari отдаёт "Load failed").
    // don.js шлёт text/plain чтобы префлайта не было, но заголовок в ответе всё равно нужен.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET") {
      return new Response("ok - cloudflare worker alive", { status: 200, headers: CORS });
    }

    // --- 1. Mini App просит ссылку на оплату ---
    if (url.pathname === "/invoice" && request.method === "POST") {
      return handleCreateInvoice(request, env);
    }

    // --- 2. Webhook от Telegram ---
    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    if (env.TG_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (got !== env.TG_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("ok - bad json", { status: 200 });
    }

    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok", { status: 200 });
  },
};

// ---------- Mini App -> invoice link ----------
async function handleCreateInvoice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  const { product_id, initData, amount } = body;

  // Донат — сумма приходит от юзера (1..10000 ⭐)
  let product = PRODUCTS[product_id];
  if (product_id === "donate") {
    const stars = Math.floor(Number(amount));
    if (!Number.isFinite(stars) || stars < 1 || stars > 10000) {
      return json({ ok: false, error: "amount must be 1..10000" }, 400);
    }
    product = {
      title: "Благодарность ❤️",
      description: `Донат ${stars} ⭐`,
      prices: [{ label: "Донат", amount: stars }],
    };
  }

  if (!product) return json({ ok: false, error: "unknown product" }, 400);

  // Проверка подлинности: что запрос реально из твоего Mini App
  const valid = await verifyInitData(initData || "", env.TG_TOKEN);
  if (!valid) return json({ ok: false, error: "bad initData" }, 403);

  const userId = valid.user?.id;
  // payload — чтобы потом понять, за что заплатили. Должен быть уникальным.
  const payload = `${product_id}:${userId}:${Date.now()}`;

  const res = await tgApi(env, "createInvoiceLink", {
    title: product.title,
    description: product.description,
    payload,
    currency: "XTR",
    prices: product.prices,
  });

  if (!res?.ok) {
    console.log("createInvoiceLink failed:", JSON.stringify(res).slice(0, 500));
    return json({ ok: false, error: "invoice failed" }, 500);
  }
  return json({ ok: true, invoiceLink: res.result });
}

// ---------- Telegram updates ----------
async function handleUpdate(update, env) {
  // 1. Подтверждение оплаты — ответить ОБЯЗАТЕЛЬНО за <10 сек
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    // Тут можно проверить payload/цену и отклонить: ok:false
    await tgApi(env, "answerPreCheckoutQuery", {
      pre_checkout_query_id: q.id,
      ok: true,
    });
    return;
  }

  const message = update.message || update.edited_message || {};

  // 2. Успешная оплата — только учёт в KV, сообщений юзеру нет.
  if (message.successful_payment) {
    const pay = message.successful_payment;
    // Пишем в KV: защита от повторной обработки при ретрае webhook.
    const { duplicate } = await recordPayment(env, pay, message.from);
    console.log(
      `PAID ${pay.telegram_payment_charge_id} payload=${pay.invoice_payload} stars=${pay.total_amount} duplicate=${duplicate}`
    );
    return;
  }

  // 3. Обычные команды
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId) return;

  const cmd = text.split(" ")[0].split("@")[0];

  // /balance — только для админа. Не админу — тихо, без сообщений.
  if (cmd === "/balance") {
    if (!isAdmin(chatId, env)) return;
    const reply = await getStarsBalanceText(env);
    await tgApi(env, "sendMessage", { chat_id: chatId, text: reply });
    return;
  }

  // /stats — только для админа. Не админу — тихо, без сообщений.
  if (cmd === "/stats") {
    if (!isAdmin(chatId, env)) return;
    const reply = await getStatsText(env);
    await tgApi(env, "sendMessage", { chat_id: chatId, text: reply });
    return;
  }

  // /refund — только для админа. Форматы:
  //   /refund <charge_id>            — user_id берём из KV
  //   /refund <user_id> <charge_id>  — если записи в KV нет
  // Не админу — тихо, без сообщений.
  if (cmd === "/refund") {
    if (!isAdmin(chatId, env)) return;
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    let uid = null,
      chargeId = null;
    if (args.length === 1) {
      chargeId = args[0];
      const rec = await getPayment(env, chargeId);
      if (!rec || !rec.uid) {
        await tgApi(env, "sendMessage", {
          chat_id: chatId,
          text: "Не нашёл оплату в KV. Формат: /refund <user_id> <charge_id>",
        });
        return;
      }
      uid = rec.uid;
    } else if (args.length >= 2) {
      uid = Number(args[0]);
      chargeId = args[1];
    } else {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Формат: /refund <charge_id>  или  /refund <user_id> <charge_id>",
      });
      return;
    }
    if (!Number.isFinite(uid) || !chargeId) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "Формат: /refund <charge_id>  или  /refund <user_id> <charge_id>",
      });
      return;
    }
    const res = await tgApi(env, "refundStarPayment", {
      user_id: uid,
      telegram_payment_charge_id: chargeId,
    });
    if (!res?.ok) {
      await tgApi(env, "sendMessage", {
        chat_id: chatId,
        text: "↩️ Возврат не удался: " + (res?.description || "ошибка API"),
      });
      return;
    }
    const rec = await markRefunded(env, chargeId);
    const amount = rec ? ` ${rec.amount} ⭐` : "";
    await tgApi(env, "sendMessage", { chat_id: chatId, text: `✅ Возврат${amount} выполнен.` });
    return;
  }

  // /start — только для админа: список команд. Остальным — тихо.
  if (cmd === "/start" && isAdmin(chatId, env)) {
    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text: [
        "Админ-команды:",
        "/balance — баланс звёзд",
        "/stats — статистика оплат",
        "/refund <charge_id> — возврат",
        "/refund <user_id> <charge_id> — возврат без записи в KV",
      ].join("\n"),
    });
    return;
  }

  // Остальное — тихо: /ping и обычный текст без ответов.
  return;
}

// ---------- helpers ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
async function tgApi(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  console.log(`TG ${method}: ${r.status}`);
  return data;
}

// ADMIN_IDS — telegram user id админов через запятую, например "123456789,987654321".
function isAdmin(chatId, env) {
  const ids = String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(chatId));
}

// Суммирует getStarTransactions с пагинацией (до ~2000 последних операций).
async function getStarsBalanceText(env) {
  let offset = 0,
    stars = 0,
    nanos = 0,
    count = 0,
    pages = 0;
  while (pages < 20) {
    const res = await tgApi(env, "getStarTransactions", { offset, limit: 100 });
    if (!res?.ok) return "Не смог получить транзакции: " + (res?.description || "ошибка API");
    const txns = res.result?.transactions || [];
    for (const t of txns) {
      stars += Number(t.amount || 0);
      nanos += Number(t.nanostar_amount || 0);
      count++;
    }
    if (txns.length < 100) break;
    offset += 100;
    pages++;
  }
  stars += Math.trunc(nanos / 1_000_000_000);
  const frac = Math.abs(nanos % 1_000_000_000);
  const total = frac ? `${stars}.${String(frac).padStart(9, "0").replace(/0+$/, "")}` : `${stars}`;
  const more = pages >= 20 ? "\n(учтены последние ~2000 операций)" : "";
  return `⭐ Баланс звёзд бота: ${total}\nОпераций учтено: ${count}${more}`;
}

// ---------- Учёт оплат в KV ----------
// Ключ pay:<charge_id> -> { charge_id, uid, name, username, amount, kind, payload, ts, refunded }.
// Возвращает { duplicate: true }, если такой charge_id уже обрабатывали (ретрай webhook).
async function recordPayment(env, pay, from) {
  const kv = env.PAYMENTS_KV;
  if (!kv) return { duplicate: false };
  const chargeId = pay.telegram_payment_charge_id;
  if (!chargeId) return { duplicate: false };
  const key = `pay:${chargeId}`;
  if (await kv.get(key)) return { duplicate: true };
  const payload = String(pay.invoice_payload || "");
  const kind = payload.startsWith("donate:")
    ? "donate"
    : payload.startsWith("premium_30d:")
      ? "premium"
      : "other";
  const rec = {
    charge_id: chargeId,
    uid: from?.id ?? null,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null,
    username: from?.username || null,
    amount: Number(pay.total_amount || 0),
    kind,
    payload,
    ts: Math.floor(Date.now() / 1000),
    refunded: false,
  };
  await kv.put(key, JSON.stringify(rec));
  return { duplicate: false };
}

async function getPayment(env, chargeId) {
  try {
    const raw = await env.PAYMENTS_KV?.get(`pay:${chargeId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function markRefunded(env, chargeId) {
  const rec = await getPayment(env, chargeId);
  if (!rec || !env.PAYMENTS_KV) return rec;
  rec.refunded = true;
  await env.PAYMENTS_KV.put(`pay:${chargeId}`, JSON.stringify(rec));
  return rec;
}

// /stats: итоги, донаты/premium, возвраты, топ-5 донатеров, по дням (UTC).
async function getStatsText(env) {
  const kv = env.PAYMENTS_KV;
  if (!kv) {
    return "⛔ Не подключён PAYMENTS_KV: создай KV-namespace и привяжи его к воркеру как PAYMENTS_KV, затем задеплои.";
  }
  const recs = [];
  let cursor = undefined,
    guard = 0;
  while (guard++ < 10) {
    const page = await kv.list({ prefix: "pay:", limit: 1000, cursor });
    for (const k of page.keys) {
      try {
        const raw = await kv.get(k.name);
        if (raw) recs.push(JSON.parse(raw));
      } catch {}
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  if (!recs.length) return "📊 Оплат пока нет.";
  const live = recs.filter((r) => !r.refunded);
  const refunded = recs.filter((r) => r.refunded);
  const sum = (arr) => arr.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const byKind = (kind) => sum(live.filter((r) => r.kind === kind));

  const donors = new Map();
  for (const r of live) {
    const id = r.uid ?? r.charge_id;
    const cur = donors.get(id) || { sum: 0, name: null, username: null, uid: r.uid ?? null };
    cur.sum += Number(r.amount) || 0;
    if (r.name) cur.name = r.name;
    if (r.username) cur.username = r.username;
    donors.set(id, cur);
  }
  const top = [...donors.values()].sort((a, b) => b.sum - a.sum).slice(0, 5);

  const byDay = new Map();
  for (const r of live) {
    const d = new Date((Number(r.ts) || 0) * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + (Number(r.amount) || 0));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);

  const lines = [
    "📊 Статистика",
    `💰 Всего: ${sum(live)} ⭐ (${live.length} оплат, ${donors.size} чел.)`,
    `❤️ Донаты: ${byKind("donate")} ⭐`,
    `👑 Premium: ${byKind("premium")} ⭐`,
  ];
  if (refunded.length) lines.push(`↩️ Возвратов: ${refunded.length} (${sum(refunded)} ⭐)`);
  lines.push("", "🏆 Топ-5:");
  top.forEach((d, i) => {
    const who = [d.name || "без имени"];
    if (d.username) who.push("@" + d.username);
    if (d.uid != null) who.push("id" + d.uid);
    lines.push(`${i + 1}. ${who.join(" · ")} — ${d.sum} ⭐`);
  });
  lines.push("", "📅 По дням:");
  days.forEach(([d, s]) => lines.push(`${d} — ${s} ⭐`));
  return lines.join("\n");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Проверка Telegram WebApp initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const enc = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      enc.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dataCheckString));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return null;

    // Срок годности — 24 часа
    const authDate = Number(params.get("auth_date") || 0);
    if (Date.now() / 1000 - authDate > 86400) return null;

    return { user: JSON.parse(params.get("user") || "null") };
  } catch (e) {
    console.log("verifyInitData failed:", e);
    return null;
  }
}
