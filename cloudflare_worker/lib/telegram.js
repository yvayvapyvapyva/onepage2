// Telegram Bot API: вызовы методов и проверка подписи initData Mini App.

// Проверка Telegram Mini App initData (без проверки срока — покупки интерактивные).
// maxAgeSec > 0 — дополнительно требовать свежесть auth_date (для редактора).
export async function verifyTgInitData(initData, botToken, maxAgeSec = 0) {
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
    if (maxAgeSec > 0) {
      const authDate = Number(params.get('auth_date') || 0);
      const now = Math.floor(Date.now() / 1000);
      if (!authDate || now - authDate > maxAgeSec) {
        return { uid: null, err: 'initData expired' };
      }
    }
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return { uid: null, err: 'no user' };
    return { uid: String(user.id), err: null };
  } catch (e) {
    return { uid: null, err: String(e) };
  }
}

export async function tgApi(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
