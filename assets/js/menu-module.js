
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "id-m": { name, description, id, m } }
    _isFetchingRoutes: false,
    _categoryTree: null,
    _starredTree: null,
    _expandedFolders: new Set(),
    _userRoutes: null,
    _userId: null,
    _expandedPersonalFolders: new Set(),
    _currentIsPersonal: false,
    _filterCreator: '',

    // URL Яндекс-функции для загрузки маршрутов (общий бекенд)
    API_URL_V2: 'https://functions.yandexcloud.net/d4e6qbc1mm9j44h0na3n',
    
    /**
     * Универсальное получение параметров URL
     * Поддерживает только формат: #m=id-название
     */
    getUrlParam(name) {
        if (name !== 'm') return null;

        // Проверка query-строки URL
        let value = new URLSearchParams(window.location.search).get(name);
        if (value) return value;

        // Проверка hash: #m=id-название
        const hash = window.location.hash.slice(1);
        if (hash) {
            // Формат: #m=id-название
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
     * Парсинг ввода в формате "id-название"
     * @returns {{id: string, name: string}}
     */
    parseRouteInput(input) {
        const trimmed = input.trim();
        const dashIndex = trimmed.indexOf('-');
        
        if (dashIndex > 0) {
            const id = trimmed.substring(0, dashIndex).trim();
            const name = trimmed.substring(dashIndex + 1).trim();
            return { id, name };
        }
        return { id: trimmed, name: '' };
    },

    // Инициализация
    async init(onRouteLoaded) {
        this.callback = onRouteLoaded;
        this.createModal();
        this.createButton();
        this.hide();

        // Читаем параметры фильтрации из URL/hash
        const urlM = new URLSearchParams(window.location.search).get('m')
            || (() => {
                const hash = window.location.hash.slice(1);
                if (hash) return new URLSearchParams(hash).get('m');
                return '';
            })() || '';
        if (urlM && !urlM.includes('-')) {
            this._filterCreator = urlM.trim();
        } else {
            this._filterCreator = new URLSearchParams(window.location.search).get('creator')
                || (() => {
                    const hash = window.location.hash.slice(1);
                    if (hash) return new URLSearchParams(hash).get('creator');
                    return '';
                })() || '';
        }

        // Проверка start_param от Telegram Mini App (ДО загрузки маршрутов)
        if (typeof Telegram !== 'undefined' && Telegram.WebApp) {
            try {
                const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
                if (startParam) {
                    if (startParam.startsWith('m=')) {
                        const val = startParam.substring(2);
                        if (val && !val.includes('-')) this._filterCreator = val;
                    } else if (startParam.startsWith('creator=')) {
                        this._filterCreator = startParam.substring(8);
                    }
                }
            } catch (e) {}
        }

        // Загружаем список маршрутов динамически
        await this._loadRoutesList();

        // Загружаем личные маршруты пользователя
        const uid = this._detectUserId();
        if (uid) {
            this._userId = uid;
            await this._fetchUserRoutes(uid);
        } else if (typeof vkBridge !== 'undefined') {
            vkBridge.subscribe((event) => {
                const data = event.detail?.data || null;
                if (data?.id && !this._userId) {
                    this._userId = String(data.id);
                    this._fetchUserRoutes(this._userId).then(() => this._buildRoutesList());
                }
            });
        }

        // Проверяем параметры сразу и при получении данных от VK Bridge
        this.checkUrlParam();

        // Подписка на события VK Bridge для параметров запуска
        if (typeof vkBridge !== 'undefined') {
            vkBridge.subscribe((event) => {
                // Проверяем, что маршрут ещё не загружен
                if (!this.isLoaded && (event && event.type === 'VKWebAppUpdateConfig' || event.detail)) {
                    this.checkUrlParam();
                }
            });

            // Пробуем получить параметры из launchParams
            try {
                vkBridge.send('VKWebAppGetLaunchParams')
                    .then(params => {
                        // Проверяем, что маршрут ещё не загружен
                        if (!this.isLoaded && params && params.m) {
                            const { id, name } = this.parseRouteInput(params.m);
                            if (name) {
                                this.isLoaded = true;
                                this._filterCreator = id;
                                this.hide();
                                this.loadRouteByName(name, id);
                            } else if (id) {
                                this.currentRoute = id;
                            }
                        }
                    })
                    .catch(e => {});
            } catch (e) {
            }
        }

        // Проверка start_param от Telegram Mini App (на конкретный маршрут)
        if (typeof Telegram !== 'undefined' && Telegram.WebApp) {
            try {
                const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
                if (startParam && !this.isLoaded && startParam.startsWith('m=')) {
                    const mValue = startParam.substring(2);
                    const { id, name } = this.parseRouteInput(mValue);
                    if (name) {
                        this.isLoaded = true;
                        this._filterCreator = id;
                        this.hide();
                        this.loadRouteByName(name, id);
                        this._loadRoutesList().then(() => this._buildRoutesList());
                    } else if (id) {
                        this.currentRoute = id;
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
     * Запрос к Яндекс-функции за списком маршрутов
     */
    async _fetchFromAPI() {
        let url = `${this.API_URL_V2}?action=list_routes`;
        if (this._filterCreator) url += `&creator=${encodeURIComponent(this._filterCreator)}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const routesFlat = {};
        
        for (const route of data) {
            const key = `${route.id}-${route.m}`;
            const rawName = route.name || route.m || '';
            
            routesFlat[key] = {
                id: route.id,
                m: route.m,
                name: rawName,
                description: route.description || '',
                creator_name: route.creator_name || ''
            };
        }

        this.routesDescriptions = routesFlat;
        this._categoryTree = this._buildCategoryTree();
        this._starredTree = this._buildStarredTree();
        
        return;
    },

    _detectUserId() {
        if (window.authLogin) return window.authLogin;
        return null;
    },

    _getUserDisplayName() {
        if (window.authName) return window.authName;
        if (window.authLogin) return window.authLogin;
        return '';
    },

    _getFormattedDisplayName() {
        const name = this._getUserDisplayName() || this._detectUserId() || '';
        if (window.authPlatform === 'tg') {
            const uname = window.tgUser?.username || '';
            return uname ? `${name} (tg: @${uname})` : `${name} (tg)`;
        }
        if (window.authPlatform === 'vk') {
            return `${name} (vk: id${window.authLogin})`;
        }
        return name;
    },

    async _fetchUserRoutes(userId) {
        if (!userId) return;
        try {
            let url = this.API_URL_V2;
            const params = ['action=list'];

            if (window.authPlatform === 'tg') {
                params.push(`p=tg&id=${encodeURIComponent(userId)}&tg_init_data=${encodeURIComponent(window.tgInitData || '')}`);
            } else if (window.authPlatform === 'user') {
                params.push(`p=user&login=${encodeURIComponent(window.authLogin)}&password=${encodeURIComponent(window.authPassword)}`);
            } else {
                params.push(`p=vk&id=${encodeURIComponent(userId)}`);
            }

            url += '?' + params.join('&');
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            this._userRoutes = data.routes || [];
        } catch (e) {
            console.warn('[MenuModule] Не удалось загрузить личные маршруты:', e);
            this._userRoutes = [];
        }
    },

    _countTreeRoutes(node) {
        let count = node.routes.length;
        for (const f of Object.values(node.folders)) count += this._countTreeRoutes(f);
        return count;
    },

    _buildCategoryTree() {
        const root = { folders: {}, routes: [] };
        const groups = {};
        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            const rawName = route.name || '';
            if (rawName.startsWith('*')) continue;
            const cid = route.id;
            if (!groups[cid]) {
                groups[cid] = { name: route.creator_name || cid, routes: [] };
            }
            groups[cid].routes.push({ ...route, key });
        }
        for (const group of Object.values(groups)) {
            const node = { folders: {}, routes: [] };
            for (const route of group.routes) {
                const fullPath = route.name || route.key;
                const parts = fullPath.split('/').map(s => s.trim()).filter(Boolean);
                const leafName = parts.pop() || fullPath;
                let n = node;
                for (const part of parts) {
                    if (!n.folders[part]) n.folders[part] = { folders: {}, routes: [] };
                    n = n.folders[part];
                }
                n.routes.push({ ...route, name: leafName, fullPath });
            }
            if (node.routes.length > 0) {
                node.folders['Без категории'] = node.folders['Без категории'] || { folders: {}, routes: [] };
                node.folders['Без категории'].routes.push(...node.routes);
                node.routes = [];
            }
            root.folders[group.name] = node;
        }
        return root;
    },

    _buildStarredTree() {
        const root = { folders: {}, routes: [] };
        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            const rawName = route.name || '';
            if (!rawName.startsWith('*')) continue;
            const cleanName = rawName.substring(1);
            const fullPath = cleanName || key;
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
        const rawName = route.name;
        if (rawName.startsWith('*')) {
            const cleanName = rawName.substring(1);
            const parts = cleanName.split('/').filter(Boolean);
            parts.pop();
            let path = '';
            for (const part of parts) {
                path = path ? path + '/' + part : part;
                this._expandedFolders.add(path);
            }
        } else {
            const creatorName = route.creator_name || route.id;
            this._expandedFolders.add(creatorName);
            const parts = rawName.split('/').filter(Boolean);
            parts.pop();
            let path = creatorName;
            for (const part of parts) {
                path = path + '/' + part;
                this._expandedFolders.add(path);
            }
        }
    },

    _buildPersonalCategoryTree() {
        const root = { folders: {}, routes: [] };
        for (const route of this._userRoutes) {
            const fullPath = route.name || route.m || '';
            const parts = fullPath.split('/').map(s => s.trim()).filter(Boolean);
            const leafName = parts.pop() || fullPath;
            let node = root;
            for (const part of parts) {
                if (!node.folders[part]) node.folders[part] = { folders: {}, routes: [] };
                node = node.folders[part];
            }
            node.routes.push({ m: route.m, name: leafName, fullPath });
        }
        return root;
    },

    _renderPersonalTreeNode(node, container, path) {
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));
        for (const name of folderNames) {
            const folderPath = path ? path + '/' + name : name;
            const sub = node.folders[name];
            const total = this._countTreeRoutes(sub);
            const isExpanded = this._expandedPersonalFolders.has(folderPath);

            const el = document.createElement('div');
            el.className = 'category-folder';

            const header = document.createElement('div');
            header.className = 'category-header' + (isExpanded ? ' expanded' : '');
            header.innerHTML = `
                <span class="category-icon">${isExpanded ? '📂' : '📁'}</span>
                <span class="category-name">${this._escape(name)}</span>
                <span class="category-count">${total}</span>
            `;
            header.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedPersonalFolders.has(folderPath)) this._expandedPersonalFolders.delete(folderPath);
                else this._expandedPersonalFolders.add(folderPath);
                this._buildRoutesList();
            });
            el.appendChild(header);
            container.appendChild(el);

            if (isExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderPersonalTreeNode(sub, childWrap, folderPath);
                container.appendChild(childWrap);
            }
        }

        for (const route of node.routes) {
            const routeKey = `${this._userId}-${route.m}`;
            const isActive = this._currentIsPersonal && routeKey === this.currentRoute;
            const btn = document.createElement('button');
            btn.className = 'route-item' + (isActive ? ' active' : '');
            if (isActive) btn.style.cssText = 'background:rgba(48,209,88,0.2);border-color:rgba(48,209,88,0.4);';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'route-name';
            nameSpan.textContent = route.name;
            btn.appendChild(nameSpan);
            btn.addEventListener('click', () => {
                this.loadRouteByName(route.m, this._userId, true);
            });
            container.appendChild(btn);
        }
    },

    _buildRoutesList() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;

        if (!this.routesDescriptions) return;

        const frag = document.createDocumentFragment();

        // 1. Звёздочки (*) — без папки создателя, в самом верху
        const starredTree = this._starredTree;
        const hasStarred = starredTree && (Object.keys(starredTree.folders).length > 0 || starredTree.routes.length > 0);
        const hasRegular = this._categoryTree && Object.keys(this._categoryTree.folders).length > 0;
        const hasPersonal = this._userRoutes && this._userRoutes.length > 0;

        if (hasStarred) {
            this._renderTreeNode(starredTree, frag, '', false);
        }

        // 2. Папки создателей (без *)
        if (hasRegular) {
            if (hasStarred) {
                const sep = document.createElement('div');
                sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.1);margin:8px 0;flex-shrink:0;';
                frag.appendChild(sep);
            }
            this._renderTreeNode(this._categoryTree, frag, '', true);
        }

        // 3. Личные маршруты
        if (hasPersonal) {
            const sep = document.createElement('div');
            sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.1);margin:8px 0;flex-shrink:0;';
            frag.appendChild(sep);

            const folder = document.createElement('div');
            folder.className = 'category-folder personal';

            const personalTree = this._buildPersonalCategoryTree();
            const total = this._countTreeRoutes(personalTree);
            const isExpanded = this._expandedPersonalFolders.has('__personal__');

            const header = document.createElement('div');
            header.className = 'category-header personal' + (isExpanded ? ' expanded' : '');
            header.innerHTML = `
                <span class="category-icon">👤</span>
                <span class="category-name">Личные — ${this._getFormattedDisplayName()}, видны только вам.</span>
                <span class="category-count">${total}</span>
            `;
            header.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedPersonalFolders.has('__personal__')) this._expandedPersonalFolders.delete('__personal__');
                else this._expandedPersonalFolders.add('__personal__');
                this._buildRoutesList();
            });
            folder.appendChild(header);

            if (isExpanded) {
                const body = document.createElement('div');
                body.className = 'personal-routes-body';
                this._renderPersonalTreeNode(personalTree, body, '');
                folder.appendChild(body);
            }

            frag.appendChild(folder);
        }

        if (frag.children.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.5);font-size:14px;">Нет маршрутов</div>';
        } else {
            container.innerHTML = '';
            container.appendChild(frag);
        }
    },

    _renderTreeNode(node, container, path, isRoot = !path) {
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));

        for (const name of folderNames) {
            if (name === 'Без категории') continue;
            const folderPath = path ? path + '/' + name : name;
            const sub = node.folders[name];
            const total = this._countTreeRoutes(sub);
            const isExpanded = this._expandedFolders.has(folderPath);

            const el = document.createElement('div');
            el.className = 'category-folder';

            const header = document.createElement('div');
            header.className = 'category-header' + (isExpanded ? ' expanded' : '') + (isRoot ? ' root' : '');
            header.innerHTML = `
                <span class="category-icon">${isExpanded ? '📂' : '📁'}</span>
                <span class="category-name">${this._escape(name)}</span>
                <span class="category-count">${total}</span>
            `;
            header.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedFolders.has(folderPath)) this._expandedFolders.delete(folderPath);
                else this._expandedFolders.add(folderPath);
                this._buildRoutesList();
            });
            el.appendChild(header);

            container.appendChild(el);

            if (isExpanded) {
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
            const fcEl = document.createElement('div');
            fcEl.className = 'category-folder';
            const fcHdr = document.createElement('div');
            fcHdr.className = 'category-header' + (fcExpanded ? ' expanded' : '') + (isRoot ? ' root' : '');
            fcHdr.innerHTML = `
                <span class="category-icon">${fcExpanded ? '📂' : '📁'}</span>
                <span class="category-name">Без категории</span>
                <span class="category-count">${fcTotal}</span>
            `;
            fcHdr.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedFolders.has(fcPath)) this._expandedFolders.delete(fcPath);
                else this._expandedFolders.add(fcPath);
                this._buildRoutesList();
            });
            fcEl.appendChild(fcHdr);
            container.appendChild(fcEl);
            if (fcExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderTreeNode(uncat, childWrap, fcPath, false);
                container.appendChild(childWrap);
            }
        }

        for (const route of node.routes) {
            const routeKey = route.key;
            const hasDesc = route.description && route.description.trim() !== '';
            const isActive = !this._currentIsPersonal && routeKey === this.currentRoute;
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
                const route = this.routesDescriptions[routeKey];
                if (route) this.loadRouteByName(route.m, route.id);
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
            <div id="jsonModal">
                <div class="modal-sheet">
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

        // Закрытие при клике на фон (вне modal-sheet)
        document.getElementById('jsonModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('jsonModal')) {
                this.hide();
            }
        });

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
    
    // Проверка URL параметра
    checkUrlParam() {
        const routeParam = this.getUrlParam('m');
        if (!routeParam) return;

        const { id, name } = this.parseRouteInput(routeParam);

        // Только ID, без названия — фильтруем список по создателю
        if (!name) {
            this.currentRoute = id;
            this._filterCreator = id;
            this._loadRoutesList().then(() => this._buildRoutesList());
            return;
        }

        // ID и название — загружаем маршрут
        this.currentRoute = routeParam;
        this._filterCreator = id;
        this.isLoaded = true;
        this.hide();
        this.loadRouteByName(name, id);
        this._loadRoutesList().then(() => this._buildRoutesList());
    },
    
    // Загрузка маршрута по названию (внутренний метод)
    async loadRouteByName(routeName, routeId = null, isPersonal = false) {
        this._currentIsPersonal = isPersonal;
        this.showSpinner();
        try {
            this.currentRoute = routeId ? `${routeId}-${routeName}` : routeName;
            
            this.hide();
            
            let url = this.API_URL_V2;
            const params = [];
            if (routeId) {
                params.push(`id=${encodeURIComponent(routeId)}`);
            }
            if (routeName) {
                params.push(`m=${encodeURIComponent(routeName)}`);
            }

            if (window.vkUser) {
                const user = window.vkUser;
                const city = user.city?.title || 'не указан';
                const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
                const userInfoStr = 'vk:' + [user.id, fullName, city].join(',');
                const userInfoBase64 = btoa(encodeURIComponent(userInfoStr));
                params.push(`i=${userInfoBase64}`);
            } else if (typeof vkBridge !== 'undefined') {
                try {
                    const userInfo = await Promise.race([
                        vkBridge.send('VKWebAppGetUserInfo'),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('timeout')), 1000)
                        )
                    ]);
                    if (userInfo) {
                        const city = userInfo.city?.title || 'не указан';
                        const fullName = [userInfo.first_name, userInfo.last_name].filter(Boolean).join(' ');
                        const userInfoStr = 'vk:' + [userInfo.id, fullName, city].join(',');
                        const userInfoBase64 = btoa(encodeURIComponent(userInfoStr));
                        params.push(`i=${userInfoBase64}`);
                    }
                } catch (e) {
                }
            }

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

            if (window.authPlatform === 'user') {
                try {
                    const userInfoStr = 'user:' + window.authLogin;
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

            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

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
        if (modal) modal.classList.add('hidden');
        this._hideRouteDescription();
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    },
    
    // Показать модальное окно
    show() {
        const modal = document.getElementById('jsonModal');
        if (modal) modal.classList.remove('hidden');
        this._hideRouteDescription();
        this._expandedFolders = new Set();
        this._expandCurrentRoutePath();
        // Если личные маршруты ещё не загружены, пробуем снова
        if (this._userRoutes === null && !this._userId) {
            const uid = this._detectUserId();
            if (uid) {
                this._userId = uid;
                this._fetchUserRoutes(uid).then(() => this._buildRoutesList());
            }
        }
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
