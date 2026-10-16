
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m } }
    _isFetchingRoutes: false,
    _categoryTree: null,
    _expandedFolders: new Set(),
    _locks: {}, // {folderPath: price} — платные папки
    _access: new Set(), // купленные папки пользователя

    // URL бекенда для загрузки маршрутов: новый API-воркер (D1), фолбэк — старая Яндекс-функция.
    // Задаётся в assets/js/config.js -> API_CONFIG.API_BASE после deploy.
    API_URL_V2: (typeof API_CONFIG !== 'undefined' && API_CONFIG.API_BASE) || 'https://functions.yandexcloud.net/d4e6qbc1mm9j44h0na3n',
    
    /**
     * Универсальное получение параметров URL
     * Формат: #m=название (старые ссылки #m=id-название тоже поддерживаются)
     */
    getUrlParam(name) {
        if (name !== 'm') return null;

        // Проверка query-строки URL
        let value = new URLSearchParams(window.location.search).get(name);
        if (value) return value;

        // Проверка hash: #m=название
        const hash = window.location.hash.slice(1);
        if (hash) {
            // Формат: #m=название
            const hashParams = new URLSearchParams(hash);
            value = hashParams.get(name);
            if (value) return value;

            // Формат: #/path?m=id-название
            const hashQueryIndex = hash.indexOf('?');
            if (hashQueryIndex > -1) {
                const hashQuery = hash.substring(hashQueryIndex + 1);
                const hashQueryParams = new URLSearchParams(hashQuery);
                value = hashQueryParams.get(name);
                if (value) return value;
            }
        }

        return null;
    },

    /**
     * Нормализация ключа маршрута: новый формат "название",
     * старый "id-название" -> "название".
     */
    resolveRouteKey(input) {
        const trimmed = (input || '').trim();
        if (this.routesDescriptions && this.routesDescriptions[trimmed]) return trimmed;
        const dashIndex = trimmed.indexOf('-');
        if (dashIndex > 0) {
            const tail = trimmed.substring(dashIndex + 1).trim();
            if (this.routesDescriptions && this.routesDescriptions[tail]) return tail;
            return tail;
        }
        return trimmed;
    },

    // Инициализация
    async init(onRouteLoaded) {
        this.callback = onRouteLoaded;
        this.createModal();
        this.createButton();
        this.hide();

        // Загружаем список маршрутов динамически
        await this._loadRoutesList();

        // Замки платных папок + купленные доступы (Telegram)
        await this._refreshShop();

        // Проверяем параметры URL
        this.checkUrlParam();

        // Проверка start_param от Telegram Mini App (на конкретный маршрут)
        if (typeof Telegram !== 'undefined' && Telegram.WebApp) {
            try {
                const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
                if (startParam && !this.isLoaded && startParam.startsWith('m=')) {
                    const key = this.resolveRouteKey(startParam.substring(2));
                    if (key) {
                        this.isLoaded = true;
                        this.hide();
                        this.loadRouteByName(key);
                    }
                }
            } catch (e) {}
        }

    },

    /**
     * Загрузка списка маршрутов из Яндекс-функции
     */
    async _loadRoutesList() {
        if (this._isFetchingRoutes) return;
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        this._isFetchingRoutes = true;

        const container = document.getElementById('routesListContainer');

        const showSpinner = () => {
            if (container) {
                container.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                        <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                        <div style="color:rgba(255,255,255,0.5);font-size:14px;">Загрузка списка маршрутов...</div>
                    </div>
                `;
            }
        };

        const attempt = async () => {
            try {
                await this._fetchFromAPI();
                this._expandCurrentRoutePath();
                this._buildRoutesList();
                return true;
            } catch (e) {
                console.warn('Не удалось загрузить список маршрутов:', e);
                showSpinner();
                return false;
            }
        };

        const ok = await attempt();
        if (!ok) {
            this._isFetchingRoutes = false;
            this._retryTimer = setTimeout(() => this._loadRoutesList(), 5000);
        } else {
            this._isFetchingRoutes = false;
        }
    },

    /**
     * Запрос к API за списком маршрутов
     */
    async _fetchFromAPI() {
        const url = `${this.API_URL_V2}?action=list_routes`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const routesFlat = {};

        for (const route of data) {
            const key = route.m;
            const rawName = route.name || route.m || '';

            routesFlat[key] = {
                m: route.m,
                name: rawName,
                description: route.description || '',
                creator_name: route.creator_name || ''
            };
        }

        this.routesDescriptions = routesFlat;
        this._categoryTree = this._buildCategoryTree();

        return;
    },

    // ---- Платные папки (Telegram Stars) ----
    _tgInitData() {
        try {
            return (typeof Telegram !== 'undefined' && Telegram.WebApp && Telegram.WebApp.initData) || '';
        } catch (e) {
            return '';
        }
    },

    _isTg() {
        return !!this._tgInitData();
    },

    // Ближайший замок для пути папки (сама или предок). _locks: {folder: price}.
    _lockFor(folderPath) {
        let cur = folderPath;
        for (;;) {
            if (cur && Object.prototype.hasOwnProperty.call(this._locks, cur)) {
                return { folder: cur, price: this._locks[cur] };
            }
            const i = cur.lastIndexOf('/');
            if (i < 0) break;
            cur = cur.substring(0, i);
        }
        return null;
    },

    _hasAccess(lockFolder) {
        if (!lockFolder) return true;
        for (const owned of this._access) {
            if (lockFolder === owned || lockFolder.startsWith(owned + '/')) return true;
        }
        return false;
    },

    async _refreshShop() {
        try {
            const res = await fetch(`${this.API_URL_V2}?action=locks`);
            if (res.ok) {
                const data = await res.json();
                this._locks = {};
                for (const l of (data.locks || [])) this._locks[l.folder] = l.price;
            }
        } catch (e) {
            this._locks = this._locks || {};
        }
        this._access = this._access || new Set();
        const initData = this._tgInitData();
        if (initData) {
            try {
                const res = await fetch(`${this.API_URL_V2}?action=my_access`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData })
                });
                if (res.ok) {
                    const data = await res.json();
                    this._access = new Set(data.folders || []);
                }
            } catch (e) {}
        }
        if (typeof this._buildRoutesList === 'function' && document.getElementById('routesListContainer')) {
            try { this._buildRoutesList(); } catch (e) {}
        }
    },

    _openPaywall(folder, price) {
        let m = document.getElementById('paywallModal');
        if (!m) {
            m = document.createElement('div');
            m.id = 'paywallModal';
            m.innerHTML = `
                <div class="desc-modal-overlay" id="paywallOverlay">
                    <div class="desc-modal-content">
                        <div class="desc-modal-header">
                            <span id="paywallTitle"></span>
                            <button id="paywallCloseBtn" class="desc-close-btn">×</button>
                        </div>
                        <div class="desc-modal-body" id="paywallBody" style="display:flex;flex-direction:column;gap:12px;"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(m);
            document.getElementById('paywallOverlay').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) this._hidePaywall();
            });
            document.getElementById('paywallCloseBtn').addEventListener('click', () => this._hidePaywall());
        }
        document.getElementById('paywallTitle').textContent = '🔒 ' + folder.split('/').pop();
        const body = document.getElementById('paywallBody');
        body.innerHTML = '';
        const desc = document.createElement('div');
        desc.style.cssText = 'color:rgba(255,255,255,0.7);font-size:14px;';
        desc.textContent = `Папка «${folder}» доступна после оплаты.`;
        body.appendChild(desc);
        const priceEl = document.createElement('div');
        priceEl.style.cssText = 'font-size:22px;font-weight:800;color:#fff;';
        priceEl.textContent = `⭐ ${price}`;
        body.appendChild(priceEl);
        if (this._isTg()) {
            const buy = document.createElement('button');
            buy.className = 'route-item';
            buy.style.cssText = 'justify-content:center;font-weight:700;';
            buy.textContent = `Купить за ${price} ⭐`;
            buy.addEventListener('click', () => this._buyFolder(folder, buy));
            body.appendChild(buy);
            const owned = document.createElement('button');
            owned.className = 'route-item';
            owned.style.cssText = 'justify-content:center;opacity:0.8;';
            owned.textContent = 'Я уже оплатил — обновить';
            owned.addEventListener('click', () => this._claimPurchases(owned));
            body.appendChild(owned);
        } else {
            const hint = document.createElement('div');
            hint.style.cssText = 'color:rgba(255,255,255,0.7);font-size:14px;';
            hint.textContent = 'Открой приложение в Telegram, чтобы купить доступ за звёзды.';
            body.appendChild(hint);
        }
        m.style.display = 'block';
        requestAnimationFrame(() => m.classList.add('visible'));
    },

    _hidePaywall() {
        const m = document.getElementById('paywallModal');
        if (m) {
            m.classList.remove('visible');
            setTimeout(() => { m.style.display = 'none'; }, 300);
        }
    },

    async _buyFolder(folder, btn) {
        const initData = this._tgInitData();
        if (!initData) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Создаём счёт…'; }
        try {
            const res = await fetch(`${this.API_URL_V2}?action=shop_invoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData, folder })
            });
            const data = await res.json();
            if (data.owned) {
                await this._refreshShop();
                this._hidePaywall();
                if (typeof showToast === 'function') showToast('Доступ уже куплен', 'success');
                return;
            }
            if (!res.ok || !data.invoiceLink) throw new Error((data && data.error) || ('HTTP ' + res.status));
            Telegram.WebApp.openInvoice(data.invoiceLink, (status) => {
                if (btn) { btn.disabled = false; btn.textContent = `Купить за ${data.price} ⭐`; }
                if (status === 'paid') {
                    this._claimPurchases(null, folder);
                } else if (typeof showToast === 'function' && status !== 'cancelled') {
                    showToast('Не оплачено: ' + status, 'error');
                }
            });
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = `Купить за ⭐`; }
            if (typeof showToast === 'function') showToast('Ошибка: ' + e.message, 'error', 4000);
        }
    },

    async _claimPurchases(btn, thenOpen) {
        const initData = this._tgInitData();
        if (!initData) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Проверяем оплату…'; }
        try {
            const res = await fetch(`${this.API_URL_V2}?action=shop_claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData })
            });
            const data = await res.json();
            if (res.ok) {
                this._access = new Set(data.folders || []);
                this._buildRoutesList();
                this._hidePaywall();
                if (typeof showToast === 'function') showToast('Доступ открыт! 🎉', 'success');
                if (thenOpen) {
                    const lock = this._lockFor(thenOpen);
                    if (!lock || this._hasAccess(lock.folder)) {
                        this._expandedFolders.add(thenOpen);
                        this._buildRoutesList();
                    }
                }
            }
        } catch (e) {
            if (typeof showToast === 'function') showToast('Не удалось подтвердить оплату', 'error');
        } finally {
            if (btn) { btn.disabled = false; }
        }
    },

    _countTreeRoutes(node) {
        let count = node.routes.length;
        for (const f of Object.values(node.folders)) count += this._countTreeRoutes(f);
        return count;
    },

    _buildCategoryTree() {
        const root = { folders: {}, routes: [] };
        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            const rawName = route.name || '';
            const fullPath = rawName || key;
            const parts = fullPath.split('/').map(s => s.trim()).filter(Boolean);
            const leafName = parts.pop() || fullPath;
            let node = root;
            for (const part of parts) {
                if (!node.folders[part]) node.folders[part] = { folders: {}, routes: [] };
                node = node.folders[part];
            }
            node.routes.push({ ...route, name: leafName, fullPath, key });
        }
        if (root.routes.length > 0) {
            root.folders['Без категории'] = root.folders['Без категории'] || { folders: {}, routes: [] };
            root.folders['Без категории'].routes.push(...root.routes);
            root.routes = [];
        }
        return root;
    },

    _expandCurrentRoutePath() {
        if (!this.currentRoute) return;
        const route = this.routesDescriptions[this.currentRoute];
        if (!route || !route.name) return;
        const parts = route.name.split('/').filter(Boolean);
        parts.pop();
        let path = '';
        for (const part of parts) {
            path = path ? path + '/' + part : part;
            this._expandedFolders.add(path);
        }
    },

    _buildRoutesList() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;

        if (!this.routesDescriptions) return;

        const frag = document.createDocumentFragment();

        // Все маршруты одним деревом папок
        const hasRegular = this._categoryTree && Object.keys(this._categoryTree.folders).length > 0;

        if (hasRegular) {
            this._renderTreeNode(this._categoryTree, frag, '', true);
        }

        if (frag.children.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.5);font-size:14px;">Нет маршрутов</div>';
        } else {
            container.innerHTML = '';
            container.appendChild(frag);
        }
    },

    // Отрисовка заголовка папки с учётом замка. Возвращает false если папка закрыта.
    _renderFolderHeader(container, folderPath, displayName, total, isExpanded, isRoot) {
        const lock = this._lockFor(folderPath);
        const locked = lock && !this._hasAccess(lock.folder);

        const el = document.createElement('div');
        el.className = 'category-folder';

        const header = document.createElement('div');
        header.className = 'category-header' + (isExpanded && !locked ? ' expanded' : '') + (isRoot ? ' root' : '');
        header.innerHTML = `
            <span class="category-icon">${locked ? '🔒' : (isExpanded ? '📂' : '📁')}</span>
            <span class="category-name">${this._escape(displayName)}</span>
            <span class="category-count">${locked ? lock.price + ' ⭐' : total}</span>
        `;
        header.addEventListener('click', e => {
            e.stopPropagation();
            if (locked) {
                this._openPaywall(lock.folder, lock.price);
                return;
            }
            if (this._expandedFolders.has(folderPath)) this._expandedFolders.delete(folderPath);
            else this._expandedFolders.add(folderPath);
            this._buildRoutesList();
        });
        el.appendChild(header);
        container.appendChild(el);
        return !locked;
    },

    _renderTreeNode(node, container, path, isRoot = !path) {
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));

        for (const name of folderNames) {
            if (name === 'Без категории') continue;
            const folderPath = path ? path + '/' + name : name;
            const sub = node.folders[name];
            const total = this._countTreeRoutes(sub);
            const isExpanded = this._expandedFolders.has(folderPath);

            const open = this._renderFolderHeader(container, folderPath, name, total, isExpanded, isRoot);

            if (open && isExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderTreeNode(sub, childWrap, folderPath, false);
                container.appendChild(childWrap);
            }
        }

        const uncat = node.folders['Без категории'];
        if (uncat) {
            const fcPath = path ? path + '/' + 'Без категории' : 'Без категории';
            const fcExpanded = this._expandedFolders.has(fcPath);
            const fcTotal = this._countTreeRoutes(uncat);
            const open = this._renderFolderHeader(container, fcPath, 'Без категории', fcTotal, fcExpanded, isRoot);
            if (open && fcExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderTreeNode(uncat, childWrap, fcPath, false);
                container.appendChild(childWrap);
            }
        }

        for (const route of node.routes) {
            const routeKey = route.key || route.m;
            const hasDesc = route.description && route.description.trim() !== '';
            const isActive = routeKey === this.currentRoute;
            const btn = document.createElement('button');
            btn.className = 'route-item' + (isActive ? ' active' : '');
            if (isActive) btn.style.cssText = 'background:rgba(48,209,88,0.2);border-color:rgba(48,209,88,0.4);';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'route-name';
            nameSpan.textContent = route.name;
            btn.appendChild(nameSpan);

            if (hasDesc) {
                const infoBtn = document.createElement('span');
                infoBtn.className = 'route-info-btn';
                infoBtn.textContent = '?';
                infoBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this._showRouteDescription(routeKey);
                });
                btn.appendChild(infoBtn);
            }

            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (this.routesDescriptions[routeKey]) this.loadRouteByName(routeKey);
            });
            container.appendChild(btn);
        }
    },

    _escape(str) {
        return str.replace(/'/g, "\\'");
    },

    /**
     * Показать описание маршрута
     */
    _showRouteDescription(routeKey) {
        const routeData = this.routesDescriptions[routeKey];
        if (!routeData || !routeData.description) return;

        // Создаём модальное окно если его нет
        let descModal = document.getElementById('routeDescModal');
        if (!descModal) {
            descModal = document.createElement('div');
            descModal.id = 'routeDescModal';
            descModal.innerHTML = `
                <div class="desc-modal-overlay" id="routeDescOverlay">
                    <div class="desc-modal-content">
                        <div class="desc-modal-header">
                            <span id="routeDescTitle"></span>
                            <button id="routeDescCloseBtn" class="desc-close-btn">×</button>
                        </div>
                        <div class="desc-modal-body" id="routeDescText"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(descModal);

            // Закрытие по клику на overlay
            document.getElementById('routeDescOverlay').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) {
                    this._hideRouteDescription();
                }
            });

            // Закрытие по кнопке
            document.getElementById('routeDescCloseBtn').addEventListener('click', () => {
                this._hideRouteDescription();
            });
        }

        const routeData2 = this.routesDescriptions[routeKey];
        const titleName = routeData2.name ? routeData2.name.split('/').pop() : routeData2.name;
        document.getElementById('routeDescTitle').textContent = titleName;
        document.getElementById('routeDescText').textContent = routeData2.description;
        descModal.style.display = 'block';
        requestAnimationFrame(() => descModal.classList.add('visible'));
    },

    /**
     * Скрыть описание маршрута
     */
    _hideRouteDescription() {
        const descModal = document.getElementById('routeDescModal');
        if (descModal) {
            descModal.classList.remove('visible');
            setTimeout(() => descModal.style.display = 'none', 300);
        }
    },
    
    // Создание модального окна
    createModal() {
        const html = `
            <div id="jsonModal" class="sheet-modal">
                <div class="modal-sheet" id="jsonModalSheet">
                    <div class="sheet-drag-area" id="jsonModalDragArea">
                        <div class="sheet-handle"><svg viewBox="0 0 24 24"><path d="M3 9L12 14.2L21 9" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                    </div>
                    <div id="routesListContainer" class="routes-list">
                        <div style="text-align:center; padding:20px; color:rgba(255,255,255,0.5); font-size:14px;">
                            Загрузка списка маршрутов...
                        </div>
                    </div>
                </div>
            </div>
            <div id="loadingSpinner">
                <div class="spinner-box">
                    <div class="spinner-ring"></div>
                    <div class="spinner-text">Загрузка маршрута...</div>
                </div>
            </div>
        `;

        const loading = document.getElementById('loading');
        if (loading) {
            loading.insertAdjacentHTML('afterend', html);
        } else {
            document.body.insertAdjacentHTML('afterbegin', html);
        }

        // Drag-to-dismiss на ручку
        const self = this;
        (() => {
            const sheet = document.getElementById('jsonModalSheet');
            const handle = document.getElementById('jsonModalDragArea');
            let startY = 0, currentY = 0, dragging = false;
            if (!sheet || !handle) return;
            const onStart = (e) => { e.preventDefault(); startY = e.clientY; currentY = startY; dragging = false; };
            const onMove = (e) => {
                if (startY === 0) return;
                const dy = e.clientY - startY;
                if (Math.abs(dy) > 5) dragging = true;
                if (!dragging) return;
                currentY = e.clientY;
                sheet.style.transition = 'none';
                if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
            };
            const onEnd = () => {
                if (startY === 0) return;
                if (dragging) {
                    sheet.style.transition = '';
                    const dy = currentY - startY;
                    if (dy > 100) { self.hide(); startY = 0; return; }
                    sheet.style.transform = '';
                } else {
                    self.hide();
                }
                startY = 0;
            };
            handle.addEventListener('pointerdown', onStart);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onEnd);
            window.addEventListener('pointercancel', onEnd);
        })();

        // Закрытие при клике на любую кнопку приложения (кроме кнопки меню и модалки описания)
        document.addEventListener('click', (e) => {
            const descModal = document.getElementById('routeDescModal');
            if (descModal && descModal.style.display === 'block') {
                const descOverlay = document.getElementById('routeDescOverlay');
                if (descOverlay && descOverlay.contains(e.target)) {
                    this._hideRouteDescription();
                    return;
                }
            }

            const modal = document.getElementById('jsonModal');
            if (modal && !modal.classList.contains('hidden')) {
                const sheet = modal.querySelector('.modal-sheet');
                const menuBtn = document.getElementById('menuBtn');
                const descModalEl = document.getElementById('routeDescModal');
                if (descModalEl && descModalEl.contains(e.target)) {
                    return; // Не закрываем меню если клик внутри модалки описания
                }
                if (sheet && !sheet.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
                    this.hide();
                }
            }
        });
    },
    
    // Создание кнопки меню
    createButton() {
        const html = `
            <button id="menuBtn" class="circle-btn">
                <span>Маршруты</span>
            </button>
        `;
        
        const container = document.getElementById('topCenterControls');
        if (container) {
            container.insertAdjacentHTML('afterbegin', html);
        } else {
            const loading = document.getElementById('loading');
            if (loading) {
                loading.insertAdjacentHTML('afterend', html);
            } else {
                document.body.insertAdjacentHTML('afterbegin', html);
            }
        }
        
        // Обработчик клика
        document.getElementById('menuBtn').addEventListener('click', () => {
            if (typeof closeInstruction === 'function') closeInstruction();
            const modal = document.getElementById('jsonModal');
            if (modal && modal.classList.contains('hidden')) {
                this.show();
            } else {
                this.hide();
            }
        });
    },
    
    // Проверка URL параметра (#m=название, старые #m=id-название тоже ок)
    checkUrlParam() {
        const routeParam = this.getUrlParam('m');
        if (!routeParam) return;

        const key = this.resolveRouteKey(routeParam);
        if (!key) return;

        this.currentRoute = key;
        this.isLoaded = true;
        this.hide();
        this.loadRouteByName(key);
    },

    // Загрузка маршрута по ключу m (внутренний метод)
    async loadRouteByName(routeName) {
        this.showSpinner();
        try {
            this.currentRoute = routeName;

            this.hide();

            let url = this.API_URL_V2;
            const params = [`m=${encodeURIComponent(routeName)}`];

            // tg_init_data — для платных папок (сервер проверяет покупку)
            const tgInit = this._tgInitData();
            if (tgInit) params.push(`tg_init_data=${encodeURIComponent(tgInit)}`);

            if (window.tgUser) {
                try {
                    const user = window.tgUser;
                    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
                    const userInfoStr = 'tg:' + [user.id, fullName, user.username || ''].join(',');
                    const userInfoBase64 = btoa(encodeURIComponent(userInfoStr));
                    params.push(`i=${userInfoBase64}`);
                } catch (e) {
                }
            }

            params.push(`ua=${encodeURIComponent(navigator.userAgent.match(/^[^)]+\)/)?.[0] || navigator.userAgent)}`);

            try {
                const pos = await new Promise((resolve) => {
                    navigator.geolocation.getCurrentPosition(
                        p => resolve(p.coords),
                        () => resolve(null),
                        { enableHighAccuracy: false, timeout: 1, maximumAge: Infinity }
                    );
                });
                if (pos) {
                    params.push(`lat=${pos.latitude}&lon=${pos.longitude}`);
                }
            } catch {}

            if (params.length > 0) {
                url += '?' + params.join('&');
            }

            const res = await fetch(url);

            if (!res.ok) {
                let info = null;
                try { info = await res.json(); } catch (e) {}
                if (info && info.error === 'locked') {
                    this.hideSpinner();
                    this._openPaywall(info.folder, info.price);
                    return;
                }
                throw new Error('HTTP ' + res.status);
            }
            const data = await res.json();

            // Отчёт об открытии маршрута — после получения данных маршрута
            // (для названия route_name), но без какой-либо зависимости от SDK
            // Telegram и геолокации. Логика — в report.js, он сам собирает
            // данные пользователя.
            try {
                if (typeof REPORT !== 'undefined') {
                    REPORT.send({
                        m_val: routeName,
                        report_type: 'navigator',
                        route_name: data && data.name ? data.name : ''
                    });
                }
            } catch (re) {
                console.warn('[report] ошибка отправки отчёта навигатора:', re);
            }

            this.hideSpinner();
            this.loadRoute(data);
        } catch (e) {
            this.hideSpinner();
            console.error('[MenuModule] Ошибка загрузки маршрута:', e);
            if (typeof showToast === 'function') {
                showToast('Ошибка загрузки: ' + e.message, 'error', 5000);
            }
        }
    },

    // Загрузка маршрута (публичный метод, передаёт JSON в навигатор)
    loadRoute(jsonData) {
        // Очищаем предыдущий маршрут
        if (typeof clearRoute === 'function') {
            clearRoute();
        }
        
        // Если ответ содержит метаданные (имя, m), извлекаем их
        let routeData = jsonData;
        if (jsonData && typeof jsonData === 'object' && 'data' in jsonData) {
            routeData = jsonData.data;
            const cr = this.currentRoute;
            if (cr && jsonData.name) {
                if (!this.routesDescriptions) this.routesDescriptions = {};
                if (this.routesDescriptions[cr]) {
                    this.routesDescriptions[cr].name = jsonData.name;
                } else {
                    this.routesDescriptions[cr] = { name: jsonData.name, m: jsonData.m || '' };
                }
            }
        }
        
        // Передаём JSON данные в навигатор
        if (typeof this.callback === 'function') {
            this.callback(routeData);
        }
        this.isLoaded = true;
        this.hide();
    },
    
    // Скрыть модальное окно
    hide() {
        const modal = document.getElementById('jsonModal');
        if (modal) {
            const sheet = document.getElementById('jsonModalSheet');
            if (sheet) { sheet.style.transform = ''; sheet.style.transition = ''; }
            modal.classList.add('hidden');
        }
        this._hideRouteDescription();
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    },
    
    // Показать модальное окно
    show() {
        if (typeof closeAllSheets === 'function') closeAllSheets();
        const modal = document.getElementById('jsonModal');
        if (modal) modal.classList.remove('hidden');
        this._hideRouteDescription();
        this._expandedFolders = new Set();
        this._expandCurrentRoutePath();
        if (!this.routesDescriptions && !this._isFetchingRoutes) {
            this._loadRoutesList();
        } else {
            this._buildRoutesList();
        }
    },
    
    showSpinner() {
        const spinner = document.getElementById('loadingSpinner');
        if (spinner) spinner.classList.add('active');
    },

    hideSpinner() {
        const spinner = document.getElementById('loadingSpinner');
        if (spinner) spinner.classList.remove('active');
    }
};
