// report.js — отправка отчёта о маршруте в Telegram через Cloudflare Worker.
// Worker (cloudflare_worker/worker.js) проксирует запрос в Telegram Bot API,
// скрывая токен бота от клиента и обходя блокировки api.telegram.org из РФ.
const REPORT = (() => {
    // Адрес Cloudflare Worker для отправки отчётов
    const REPORT_API_URL = 'https://pad-report.ivan43103.workers.dev/';
    // Если на воркере задан env REPORT_KEY — продублируйте его здесь
    const REPORT_KEY = '';

    // Утилиты для работы с i_val (id,имя,город,.. в base64 + url-encode)
    function b64decode(str) {
        // Браузерное декодирование base64 (из переданной строки i_val)
        try {
            const binary = atob(str);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            return '';
        }
    }

    function decodeUserInfo(iVal) {
        let userId = '?', userName = '?', third = '';
        let platform = 'browser';
        let platformIcon = '';

        if (iVal) {
            try {
                const decoded = decodeURIComponent(b64decode(iVal));
                let data = decoded;
                if (decoded.startsWith('vk:')) {
                    platform = 'vk';
                    data = decoded.substring(3);
                } else if (decoded.startsWith('tg:')) {
                    platform = 'tg';
                    data = decoded.substring(3);
                } else if (decoded.startsWith('user:')) {
                    platform = 'user';
                    data = decoded.substring(5);
                }
                const parts = data.split(',');
                userId = parts[0] || '?';
                userName = parts[1] || '?';
                third = parts[2] || '';

                if (platform === 'vk') {
                    platformIcon = ' VK';
                } else if (platform === 'tg') {
                    platformIcon = ' TG';
                } else if (platform === 'user') {
                    platformIcon = ' 👤';
                }
            } catch (e) {
                userName = 'ошибка декодирования';
            }
        }
        return { userId, userName, third, platform, platformIcon };
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Формирование текста сообщения — идентично backend/notifier.py
    function buildMessage({ user_id, m_val, i_val, report_type, route_name, user_agent }) {
        const now = new Date();
        const moscowOffset = 3 * 60 * 60 * 1000;
        const moscow = new Date(now.getTime() + moscowOffset);
        const nowMoscow =
            String(moscow.getUTCDate()).padStart(2, '0') + '.' +
            String(moscow.getUTCMonth() + 1).padStart(2, '0') + '.' +
            moscow.getUTCFullYear() + ' ' +
            String(moscow.getUTCHours()).padStart(2, '0') + ':' +
            String(moscow.getUTCMinutes()).padStart(2, '0') + ':' +
            String(moscow.getUTCSeconds()).padStart(2, '0');

        const info = decodeUserInfo(i_val);
        let userInfoText = '';
        if (i_val) {
            if (info.platform === 'vk') {
                const thirdPart = info.third ? `, Город: ${info.third}` : '';
                userInfoText = `ID: ${info.userId}, Имя: ${info.userName}${thirdPart}`;
            } else if (info.platform === 'tg') {
                const thirdPart = info.third ? `, @${info.third}` : '';
                userInfoText = `ID: ${info.userId}, Имя: ${info.userName}${thirdPart}`;
            } else if (info.platform === 'user') {
                userInfoText = `Логин: ${info.userId}`;
            } else {
                const thirdPart = info.third ? `, ${info.third}` : '';
                userInfoText = `ID: ${info.userId}, Имя: ${info.userName}${thirdPart}`;
            }
        }

        const tgLink = `https://t.me/E_ia_bot?startapp=m=${user_id}-${m_val}`;
        const user_id_esc = escapeHtml(String(user_id));
        const display = escapeHtml(route_name || `${user_id}-${m_val}`);
        const routeLineEditor = `Ⓜ️ Маршрут: ${user_id_esc} — <a href="${tgLink}">${display}</a>`;
        const routeLineNav = `🆔 Маршрут: ${user_id_esc} — <a href="${tgLink}">${display}</a>`;

        let extraLines = '';
        if (user_agent) {
            const uaShort = user_agent.length > 120 ? user_agent.substring(0, 120) + '...' : user_agent;
            extraLines += `\n📱 <code>${escapeHtml(uaShort)}</code>`;
        }

        const userInfoEsc = escapeHtml(userInfoText);

        if (report_type === 'editor') {
            return `📊 <b>Загрузка маршрута в редакторе</b>${info.platformIcon}\n` +
                `🕒 <code>${nowMoscow}</code>\n` +
                `${routeLineEditor}\n` +
                `👤 Пользователь: ${userInfoEsc}` +
                `${extraLines}`;
        }
        return `📊 <b>Запуск навигатора</b>${info.platformIcon}\n` +
            `🕒 <code>${nowMoscow}</code>\n` +
            `${routeLineNav}\n` +
            `👤 Пользователь: ${userInfoEsc}` +
            `${extraLines}`;
    }

    // Отправка текстового сообщения (+ координат) через Cloudflare Worker
    function sendMessage(text, lat, lon) {
        const payload = { text };
        if (lat && lon) {
            payload.lat = Number(lat);
            payload.lon = Number(lon);
        }
        const init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };
        if (REPORT_KEY) init.headers['X-Report-Key'] = REPORT_KEY;
        init.body = JSON.stringify(payload);

        fetch(REPORT_API_URL, init).catch(e => console.warn('[report] send error:', e));
    }

    /***
     * Отправка отчёта. Параметры:
     *   user_id: ID пользователя
     *   m_val: имя маршрута
     *   i_val: закодированная информация о пользователе (id,имя,город)
     *   report_type: 'navigator' или 'editor'
     *   route_name: отображаемое имя маршрута
     *   user_agent: User-Agent браузера
     *   lat, lon: координаты (опционально)
     */
    function send(options) {
        const { user_id, m_val, i_val, report_type, route_name, user_agent, lat, lon } = options || {};
        const message = buildMessage({ user_id, m_val, i_val, report_type, route_name, user_agent });
        sendMessage(message, lat, lon);
    }

    return { send };
})();
