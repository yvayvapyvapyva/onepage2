/**
 * Вход через Яндекс ID для navigator3.
 *
 * Модуль работает только на том origin, где есть /api/me (то есть на API
 * Gateway). На старом домене бакета запрос вернёт HTML, и вход просто не
 * показывается — навигатор продолжает работать как раньше.
 */
const AuthModule = {
    user: null,
    logoutToken: '',
    enabled: false,
    _initialized: false,

    async init() {
        if (this._initialized) return;
        this._initialized = true;
        this._bind();
        // Сначала проверяем сессию: если вход уже состоялся, ошибку из URL
        // не показываем, а просто чистим адрес. Иначе после успешного
        // OAuth можно увидеть «сессия истекла», хотя пользователь вошёл.
        await this._load();
        this._showUrlError();
        this._showLoggedOut();
    },

    _bind() {
        const login = document.getElementById('accountLogin');
        if (login) login.addEventListener('click', () => this.login(true));

        const logout = document.getElementById('accountLogout');
        if (logout) logout.addEventListener('click', () => this.logout());
    },

    async _load() {
        try {
            const response = await fetch('/api/me', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) return;
            // 502/503 бывают, пока функция не задеплоена или не настроена.
            // В этом случае вход не показываем, чтобы не вести в тупик.
            if (response.status !== 200 && response.status !== 401) return;

            this.enabled = true;
            if (response.ok) {
                const data = await response.json();
                this.user = data && data.user ? data.user : null;
                this.logoutToken =
                    data && typeof data.logout_token === 'string'
                        ? data.logout_token
                        : '';
            } else {
                this.user = null;
                this.logoutToken = '';
            }
            this.render();
        } catch (e) {
            // Старый origin без API: молча оставляем вход скрытым.
        }
    },

    render() {
        const loginGroup = document.getElementById('accountLoginGroup');
        const userGroup = document.getElementById('accountUserGroup');
        if (loginGroup) loginGroup.hidden = !this.enabled || !!this.user;
        if (userGroup) userGroup.hidden = !this.enabled || !this.user;

        // Звезда премиума на иконке профиля: данные уже есть в /api/me.
        if (typeof window.updatePremiumBadge === 'function') {
            window.updatePremiumBadge(!!(this.user && this.user.premium_active));
        }

        if (!this.user) return;

        const name = document.getElementById('accountName');
        if (name) {
            name.textContent =
                this.user.display_name || this.user.login || 'Пользователь';
        }

        const email = document.getElementById('accountEmail');
        if (email) {
            email.textContent = this.user.email || '';
            email.hidden = !this.user.email;
        }
    },

    login(forceConfirm = false) {
        const returnTo =
            window.location.pathname +
            window.location.search +
            window.location.hash;
        // base — origin, на котором должен закончиться вход: на публичном
        // домене он совпадает с PUBLIC_BASE_URL, редактор на домене шлюза
        // передаёт свой. Бэкенд принимает только адреса из белого списка.
        const params = new URLSearchParams({
            return: returnTo,
            base: window.location.origin,
        });
        // force_confirm заставляет Яндекс показать форму входа, даже если
        // аккаунт уже сохранён: можно выбрать другой или ввести почту.
        if (forceConfirm) params.set('force_confirm', '1');
        window.location.href = '/auth/yandex/start?' + params.toString();
    },

    async logout() {
        const button = document.getElementById('accountLogout');
        if (button) {
            button.disabled = true;
            button.textContent = 'Выходим…';
        }
        // CDN перед публичным доменом пропускает только GET, HEAD и OPTIONS,
        // поэтому выходим обычным переходом по подписанной ссылке.
        if (this.logoutToken) {
            const url = new URL('/auth/logout', window.location.origin);
            url.searchParams.set('t', this.logoutToken);
            url.searchParams.set(
                'return',
                window.location.pathname + window.location.search
            );
            // replace, чтобы ссылка с токеном не оставалась в истории.
            window.location.replace(url.toString());
            return;
        }
        // Запасной путь для старых сборок бэкенда, где токена ещё нет.
        try {
            const response = await fetch('/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
        } catch (e) {
            if (button) {
                button.disabled = false;
                button.textContent = 'Выйти';
            }
            if (typeof window.showToast === 'function') {
                window.showToast('Не удалось выйти, попробуйте ещё раз', 'error', 4000);
            }
            return;
        }
        window.location.reload();
    },

    _showLoggedOut() {
        const params = new URLSearchParams(window.location.search);
        if (!params.get('logged_out')) return;
        if (typeof window.showToast === 'function') {
            window.showToast('Вы вышли из аккаунта', 'success', 4000);
        }
        this._cleanUrl(params, 'logged_out');
    },

    _showUrlError() {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('auth_error');
        if (!code) return;

        if (this.user) {
            this._cleanUrl(params, 'auth_error');
            return;
        }

        const messages = {
            access_denied: 'Вход отменён на стороне Яндекса',
            state_mismatch: 'Сессия входа истекла, попробуйте снова',
            token_exchange_failed: 'Яндекс не подтвердил вход, попробуйте снова',
            profile_failed: 'Не удалось получить профиль Яндекса',
            storage_failed: 'Ошибка сохранения пользователя, попробуйте позже',
            blocked: 'Доступ для этого аккаунта заблокирован',
            auth_not_configured: 'Вход временно недоступен',
            logout_failed: 'Не удалось выйти из аккаунта, попробуйте снова',
        };
        if (typeof window.showToast === 'function') {
            window.showToast(messages[code] || 'Не удалось войти', 'error', 5000);
        }
        this._cleanUrl(params, 'auth_error');
    },

    _cleanUrl(params, key) {
        params.delete(key);
        const query = params.toString();
        const clean =
            window.location.pathname +
            (query ? '?' + query : '') +
            window.location.hash;
        window.history.replaceState(null, '', clean);
    },
};

window.AuthModule = AuthModule;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AuthModule.init());
} else {
    AuthModule.init();
}
