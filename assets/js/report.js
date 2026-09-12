// report.js — отправка отчёта о маршруте в Telegram через Cloudflare Worker.
//
// Модуль САМОДОСТАТОЧЕН и не зависит от Telegram/VK SDK, от загрузчика страницы
// и от геолокации: работает сразу после подключения скрипта. Отправка делается
// в момент открытия маршрута (навигатор/редактор), но сам код отчёта живёт
// здесь, а не в логике навигации.
//
// Worker (cloudflare_worker/worker.js) пересылает запрос в Telegram Bot API,
// скрывая токен бота от клиента и обходя блокировки api.telegram.org из РФ.
// Клиент шлёт только { text } (без координат) — точно как в рабочем
// pad-приложении: этот путь проверен и доставляется без VPN.
const REPORT = (() => {
    // Адрес Cloudflare Worker для отправки отчётов
    const REPORT_API_URL = 'https://pad-report.ivan43103.workers.dev/';
    // Если на воркере задан env REPORT_KEY — продублируйте его здесь
    const REPORT_KEY = '';
    // Кол-во попыток и задержка повтора при сетевой ошибке / ok=false
    const MAX_ATTEMPTS = 2;
    const RETRY_DELAY_MS = 2000;

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

    // Собирает i_val ('платформа:id,имя,третье поле') из глобального состояния
    // приложения. Зависит только от данных, которые платформа успела записать
    // в window (tgUser / vkUser / auth-платформа / последний резерв — initData),
    // и никогда — от факта загрузки SDK Telegram.
    function buildUserInfo() {
        try {
            let raw = '';
            if (window.vkUser) {
                const user = window.vkUser;
                const city = user.city?.title || 'не указан';
                const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
                raw = 'vk:' + [user.id, fullName, city].join(',');
            } else if (window.tgUser) {
                const user = window.tgUser;
                const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
                raw = 'tg:' + [user.id, fullName, user.username || ''].join(',');
            } else if (window.authPlatform === 'user') {
                raw = 'user:' + window.authLogin;
            } else {
                const u = window.Telegram && window.Telegram.WebApp &&
                    window.Telegram.WebApp.initDataUnsafe &&
                    window.Telegram.WebApp.initDataUnsafe.user;
                if (u) {
                    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
                    raw = 'tg:' + [u.id, fullName, u.username || ''].join(',');
                }
            }
            return raw ? btoa(encodeURIComponent(raw)) : '';
        } catch (e) {
            return '';
        }
    }

    function buildUserAgent() {
        try {
            return navigator.userAgent.match(/^[^)]+\)/)?.[0] || navigator.userAgent;
        } catch (e) {
            return '';
        }
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

    // Отправка сообщения через Cloudflare Worker.
    // Шлём ТОЛЬКО { text } — как в проверенном рабочем pad-приложении.
    // Никакой зависимости от SDK/геолокации. При сетевой ошибке или ok=false
    // делаем одну повторную попытку и пишем результат в консоль (для диагностики).
    function sendMessage(text) {
        if (!text) return;
        const init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };
        if (REPORT_KEY) init.headers['X-Report-Key'] = REPORT_KEY;
        init.body = JSON.stringify({ text });

        let attempt = 0;
        const doSend = () => {
            attempt++;
            fetch(REPORT_API_URL, init)
                .then(res => res.json().catch(() => null))
                .then(data => {
                    if (!data || data.ok !== true) {
                        console.warn('[report] воркер вернул ok=false (попытка ' + attempt + '):',
                            (data && data.error) || 'тело ответа отсутствует');
                        if (attempt < MAX_ATTEMPTS) setTimeout(doSend, RETRY_DELAY_MS);
                    }
                })
                .catch(err => {
                    console.warn('[report] сетевая ошибка при отправке (попытка ' + attempt + '):', err);
                    if (attempt < MAX_ATTEMPTS) setTimeout(doSend, RETRY_DELAY_MS);
                });
        };
        doSend();
    }

    /***
     * Отправка отчёта. Параметры:
     *   user_id: ID пользователя (владелец маршрута / логин)
     *   m_val: имя маршрута
     *   report_type: 'navigator' или 'editor'
     *   i_val: закодированная информация о пользователе (опционально;
     *          если не передано — report.js соберёт сама из window)
     *   route_name: отображаемое имя маршрута
     *   user_agent: User-Agent браузера (опционально)
     */
    function send(options) {
        const { user_id, m_val, i_val, report_type, route_name, user_agent } = options || {};
        const message = buildMessage({
            user_id,
            m_val,
            i_val: i_val === undefined ? buildUserInfo() : i_val,
            report_type,
            route_name,
            user_agent: user_agent === undefined ? buildUserAgent() : user_agent
        });
        sendMessage(message);
    }

    return { send };
})();