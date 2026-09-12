// Cloudflare Worker — прокси отчётов в Telegram Bot API.
//
// Клиент приложения шлёт POST { text, lat?, lon? } сюда (workers.dev доступен из РФ),
// Worker со своей стороны пересылает сообщение и координаты в api.telegram.org,
// гарантированно доступный из глобальной сети Cloudflare.

export default {
    async fetch(request, env) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Report-Key'
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ ok: false, error: 'method' }), {
                status: 405,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        try {
            if (env.REPORT_KEY) {
                const key = request.headers.get('X-Report-Key');
                if (key !== env.REPORT_KEY) {
                    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
                        status: 403,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
            }

            const body = await request.json();
            const text = String(body.text || '').trim();
            const hasLocation = Number.isFinite(body.lat) && Number.isFinite(body.lon);

            if (!text && !hasLocation) {
                return new Response(JSON.stringify({ ok: true, skipped: true }), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            const tel = 'https://api.telegram.org/bot' + env.BOT_TOKEN + '/';
            const chatId = env.REPORT_CHAT_ID;

            let ok = false;
            if (text) {
                const res = await fetch(tel + 'sendMessage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: text,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    })
                });
                ok = res.ok;
            }

            if (hasLocation) {
                const locParams = new URLSearchParams({
                    chat_id: chatId,
                    latitude: String(body.lat),
                    longitude: String(body.lon)
                });
                await fetch(tel + 'sendLocation?' + locParams, { method: 'GET' });
            }

            return new Response(JSON.stringify({ ok: text ? ok : true }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: String(e) }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};