// Прокси отчётов в Telegram Bot API (токен бота скрыт от клиента).

import { json } from './http.js';

export async function handleReport(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  try {
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
