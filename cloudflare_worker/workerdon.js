// Mini App + Stars через Cloudflare Worker
// Роуты:
//  POST /         — webhook от Telegram (апдейты)
//  POST /invoice  — запрос от Mini App: выдать ссылку на оплату

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

  // 2. Успешная оплата — выдаём товар
  if (message.successful_payment) {
    const pay = message.successful_payment;
    const chatId = message.chat.id;
    console.log(
      `PAID ${pay.telegram_payment_charge_id} payload=${pay.invoice_payload} stars=${pay.total_amount}`
    );
    const isDonate = String(pay.invoice_payload || "").startsWith("donate:");
    // TODO production: проверить pay.invoice_payload и записать charge_id в KV/D1,
    // чтобы при ретрае webhook не выдать товар дважды.
    await tgApi(env, "sendMessage", {
      chat_id: chatId,
      text: isDonate
        ? `Спасибо за поддержку! ❤️\nТвои ${pay.total_amount} ⭐ очень помогут!`
        : `Оплата прошла! ⭐ ${pay.total_amount}\nСпасибо за покупку 🎉`,
    });
    return;
  }

  // 3. Обычные команды
  const chatId = message.chat?.id;
  const text = message.text || "";
  if (!chatId) return;

  let reply;
  if (text === "/start") reply = "Привет! Открой Mini App и нажми Купить ⭐";
  else if (text === "/ping") reply = "pong 🏓";
  else reply = `Ты написал: ${text}`;

  await tgApi(env, "sendMessage", { chat_id: chatId, text: reply });
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
