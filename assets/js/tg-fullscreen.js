/* Полноэкранный режим Telegram Mini App.
 *
 * Bot API 8.0: requestFullscreen() прячет шапку Telegram и отдаёт приложению
 * всю высоту экрана. На старых клиентах остаётся обычный expand().
 * Заодно выставляем безопасные отступы: в полноэкранном режиме env() в
 * WebView часто равен нулю, а Telegram отдаёт значения в safeAreaInset.
 */
(function (global) {
    'use strict';

    const root = document.documentElement;
    let applied = false;

    function webApp() {
        return (global.Telegram && global.Telegram.WebApp) || null;
    }

    function applyInsets(app) {
        const safe = app.safeAreaInset || {};
        const content = app.contentSafeAreaInset || {};
        const top = Math.max(Number(safe.top) || 0, Number(content.top) || 0);
        const bottom = Math.max(Number(safe.bottom) || 0, Number(content.bottom) || 0);
        root.style.setProperty('--tg-safe-top', top + 'px');
        root.style.setProperty('--tg-safe-bottom', bottom + 'px');
        root.classList.toggle('tg-fullscreen', !!app.isFullscreen);
    }

    function apply() {
        const app = webApp();
        if (!app) return false;

        try { app.ready(); } catch (e) {}
        try { app.expand(); } catch (e) {}

        const supported = typeof app.isVersionAtLeast === 'function'
            ? app.isVersionAtLeast('8.0')
            : false;
        if (supported && !app.isFullscreen && typeof app.requestFullscreen === 'function') {
            try { app.requestFullscreen(); } catch (e) {}
        }
        try {
            if (typeof app.disableVerticalSwipes === 'function') app.disableVerticalSwipes();
        } catch (e) {}

        applyInsets(app);
        try {
            if (typeof app.onEvent === 'function') {
                app.onEvent('fullscreenChanged', () => applyInsets(app));
                app.onEvent('viewportChanged', () => applyInsets(app));
                app.onEvent('safeAreaChanged', () => applyInsets(app));
                app.onEvent('contentSafeAreaChanged', () => applyInsets(app));
            }
        } catch (e) {}

        applied = true;
        return true;
    }

    global.__tgApplyFullscreen = apply;

    // SDK грузится асинхронно: ждём до ~5 секунд.
    if (!apply()) {
        let attempts = 0;
        const timer = setInterval(() => {
            if (apply() || ++attempts > 50) clearInterval(timer);
        }, 100);
    }

    // Некоторые клиенты разрешают fullscreen только после касания.
    document.addEventListener('pointerdown', function once() {
        document.removeEventListener('pointerdown', once);
        const app = webApp();
        if (!app) return;
        try {
            if (!app.isFullscreen && typeof app.requestFullscreen === 'function') {
                const supported = typeof app.isVersionAtLeast === 'function'
                    ? app.isVersionAtLeast('8.0')
                    : false;
                if (supported) app.requestFullscreen();
            }
        } catch (e) {}
        applyInsets(app);
    }, { once: true });
})(window);
