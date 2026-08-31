// report.js — отправка отчёта о маршруте в Telegram с клиента.
// Зеркало backend/notifier.py: тот же текст сообщений и логика платформ.
const REPORT = (() => {
    // Токен бота Telegram (захардкожен на клиенте)
    const TELEGRAM_BOT_TOKEN = '7860806384:AAGXfCHZnzCB6cBkyeq1TT8T4-6qt29Mh0w';
    const TELEGRAM_CHAT_ID = '5180466640';

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

    // Отправка текстового сообщения
    function sendMessage(text, lat, lon) {
        const params = new URLSearchParams({
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML'
        });
        fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?${params.toString()}`, {
            method: 'GET'
        }).catch(e => console.warn('[report] sendMessage error:', e));

        if (lat && lon) {
            const locParams = new URLSearchParams({
                chat_id: TELEGRAM_CHAT_ID,
                latitude: String(lat),
                longitude: String(lon)
            });
            fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendLocation?${locParams.toString()}`, {
                method: 'GET'
            }).catch(e => console.warn('[report] sendLocation error:', e));
        }
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
