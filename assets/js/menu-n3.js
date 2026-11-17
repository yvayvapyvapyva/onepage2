
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m, data } }
    _routesLoaded: false,
    _isFetchingRoutes: false,
    _catalog: [],
    _folders: [],
    _folderMap: new Map(),
    _folderCounts: new Map(),
    _folderPremiumCounts: new Map(),
    _folderPath: [],
    _previewObserver: null,
    _previewImages: new Map(),
    _previewJobs: new Map(),
    _previewQueue: [],
    _previewQueuedKeys: new Set(),
    _previewFetching: new Set(),
    _previewActive: false,
    _catalogLoaded: false,
    _owners: [],
    _ownersLoaded: false,
    _ownerBundles: new Map(),
    _routeOwners: new Map(),
    _activeOwnerId: null,
    API_OWNERS_URL: '/api/owners',
    API_CATALOG_URL: '/api/catalog',
    API_ROUTE_URL: '/api/route',

    // Кэш полных маршрутов: нужен для повторного открытия и превью.
    _routeDataCache: new Map(),
    _routeRequests: new Map(),

    /**
     * Универсальное получение параметров URL.
     * Поддерживается формат: #m=<m>, ?m=<m> и #/path?m=<m>.
     */
    getUrlParam(name) {
        if (name !== 'm') return null;

        // Проверка query-строки URL
        let value = new URLSearchParams(window.location.search).get(name);
        if (value) return value;

        // Проверка hash
        const hash = window.location.hash.slice(1);
        if (hash) {
            const hashParams = new URLSearchParams(hash);
            value = hashParams.get(name);
            if (value) return value;

            // Формат: #/path?m=<m>
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

    // Инициализация
    async init(onRouteLoaded) {
        this.callback = onRouteLoaded;
        // После перезагрузки меню всегда открывается в корне маршрутов:
        // пройденный путь по папкам хранится только в памяти вкладки.
        this._folderPath = [];
        this._forgetStoredFolderPath();
        this.createModal();
        this.hide();

        // На старте грузим только корневые папки владельцев и счётчики.
        await this._loadOwners();

        // Проверяем параметр #m=<маршрут> в адресе
        this.checkUrlParam();
    },

    async _loadOwners() {
        if (this._isFetchingRoutes) return;
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        this._isFetchingRoutes = true;
        this._showListLoading('Загрузка владельцев...');
        try {
            const response = await fetch(this.API_OWNERS_URL, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const owners = Array.isArray(payload && payload.owners) ? payload.owners : [];
            this._owners = owners
                .filter(owner => owner && owner.root_folder_id)
                .map(owner => ({
                    folder_id: String(owner.root_folder_id),
                    parent_id: '',
                    name: owner.name || 'Владелец',
                    sort_order: 0,
                    is_owner_root: true,
                    ownerRootId: String(owner.root_folder_id),
                    count: Number(owner.routes_count) || 0,
                    premium_count: Number(owner.premium_count) || 0
                }));
            this._ownersLoaded = true;
            this._routesLoaded = true;
            this._showOwnersRoot();
        } catch (e) {
            console.warn('Не удалось загрузить список владельцев:', e);
            const container = document.getElementById('routesListContainer');
            if (container) {
                container.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                        <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                        <div style="color:rgba(18,28,46,0.5);font-size:14px;">Не удалось загрузить. Повторяем...</div>
                    </div>
                `;
            }
            this._retryTimer = setTimeout(() => this._loadOwners(), 5000);
        } finally {
            this._isFetchingRoutes = false;
        }
    },

    _showOwnersRoot() {
        this._activeOwnerId = null;
        this._folderPath = [];
        this._folders = this._owners.slice();
        this._folderMap = new Map(
            this._owners.map(folder => [folder.folder_id, folder])
        );
        this._folderCounts = new Map(
            this._owners.map(folder => [folder.folder_id, folder.count || 0])
        );
        this._folderPremiumCounts = new Map(
            this._owners.map(folder => [folder.folder_id, folder.premium_count || 0])
        );
        this._catalog = [];
        this._routesLoaded = true;
        this._buildRoutesList();
    },

    async _fetchOwnerBundle(kind, value) {
        const param = kind === 'm' ? 'm' : 'owner';
        const url = this.API_CATALOG_URL + '?' + param + '=' + encodeURIComponent(value);
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.json()).error || ''; } catch (e) {}
            throw new Error(detail || `HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (!payload || !payload.owner || !Array.isArray(payload.folders) || !Array.isArray(payload.routes)) {
            throw new Error('Некорректный ответ каталога владельца');
        }
        return payload;
    },

    _applyOwnerBundle(rootFolderId, bundle) {
        const rootId = String(rootFolderId || '');
        if (!rootId || !bundle) return;
        this._activeOwnerId = rootId;

        for (const route of bundle.routes || []) {
            const key = String(route.m || '');
            if (!key) continue;
            const previous = this.routesDescriptions[key];
            this.routesDescriptions[key] = {
                m: key,
                name: route.name || route.title || key,
                title: route.title || route.name || key,
                folder_id: route.folder_id || '',
                description: typeof route.description === 'string' ? route.description.trim() : '',
                point_count: Number.isFinite(route.point_count) ? route.point_count : null,
                distance_meters: Number.isFinite(route.distance_meters) ? route.distance_meters : null,
                premium: !!route.premium,
                locked: !!route.locked,
                viewed: !!route.viewed || !!(previous && previous.viewed),
                ownerRootId: rootId
            };
            this._routeOwners.set(key, rootId);
            if (!route.locked && Array.isArray(route.data)) {
                this._routeDataCache.set(key, route);
            }
        }

        this._ownerBundles.set(rootId, bundle);
        this._folders = Array.isArray(bundle.folders) ? bundle.folders.slice() : [];
        if (!this._folders.some(folder => folder.folder_id === rootId) && bundle.owner) {
            this._folders.unshift({
                folder_id: rootId,
                parent_id: '',
                name: bundle.owner.name || 'Владелец',
                sort_order: 0,
                is_owner_root: true
            });
        }
        this._folderMap = new Map(
            this._folders.map(folder => [folder.folder_id, folder])
        );
        this._folderPath = [rootId];
        this._buildCatalog();
        this._routesLoaded = true;
        this._buildRoutesList();
    },

    async _openOwner(rootFolderId) {
        const rootId = String(rootFolderId || '');
        if (!rootId) return;
        const cached = this._ownerBundles.get(rootId);
        if (cached) {
            this._applyOwnerBundle(rootId, cached);
            return;
        }
        this._isFetchingRoutes = true;
        this._showListLoading('Загрузка маршрутов...');
        try {
            const bundle = await this._fetchOwnerBundle('owner', rootId);
            this._applyOwnerBundle(rootId, bundle);
        } catch (e) {
            console.warn('Не удалось загрузить маршруты владельца:', e);
            if (typeof showToast === 'function') {
                showToast('Ошибка загрузки: ' + e.message, 'error', 5000);
            }
            this._showOwnersRoot();
        } finally {
            this._isFetchingRoutes = false;
        }
    },

    async _ensureOwnerForRoute(routeM) {
        const key = String(routeM || '');
        const cachedRoot = this._routeOwners.get(key);
        if (cachedRoot && this._ownerBundles.has(cachedRoot)) {
            const cached = this._ownerBundles.get(cachedRoot);
            // Не сбрасываем текущую папку меню, если владелец уже активен.
            if (this._activeOwnerId !== cachedRoot) {
                this._applyOwnerBundle(cachedRoot, cached);
            }
            return cached;
        }
        const bundle = await this._fetchOwnerBundle('m', key);
        const rootId = String(bundle.owner.root_folder_id || '');
        if (!rootId) throw new Error('Не найден владелец маршрута');
        this._applyOwnerBundle(rootId, bundle);
        return bundle;
    },

    async _fetchRoute(routeM) {
        const key = String(routeM);
        if (this._routeDataCache.has(key)) return this._routeDataCache.get(key);
        if (this._routeRequests.has(key)) return this._routeRequests.get(key);

        const request = (async () => {
            const response = await fetch(
                this.API_ROUTE_URL + '?m=' + encodeURIComponent(key),
                {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store'
                }
            );

            let payload = null;
            try {
                payload = await response.json();
            } catch (e) {}

            if (!response.ok) {
                const error = new Error(
                    (payload && payload.error) || `HTTP ${response.status}`
                );
                throw error;
            }
            if (!payload || !Array.isArray(payload.data)) {
                throw new Error('Некорректный ответ маршрута');
            }

            this._routeDataCache.set(key, payload);
            return payload;
        })();

        this._routeRequests.set(key, request);
        try {
            return await request;
        } finally {
            this._routeRequests.delete(key);
        }
    },

    /**
     * Плоский каталог маршрутов с деревом папок.
     *
     * folderPath хранит folder_id, а не названия: папку можно переименовать,
     * не ломая сохранённое состояние меню.
     */
    _buildCatalog() {
        const catalog = [];
        this._folderCounts = new Map();
        this._folderPremiumCounts = new Map();

        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            if (this._activeOwnerId && route.ownerRootId !== this._activeOwnerId) continue;
            const chain = this._folderChain(route.folder_id);
            const folders = chain.map(folder => folder.folder_id);
            const folderNames = chain.map(folder => folder.name);
            const title = (route.title || route.name || key).trim() || key;
            const fullPath = [...folderNames, title].join(' / ');
            const top = folderNames[0] || 'Без категории';
            const sub = folderNames.length > 1 ? folderNames.slice(1).join(' / ') : null;

            catalog.push({
                key,
                m: route.m || key,
                name: title,
                title,
                fullPath,
                top,
                sub,
                folders,
                folderNames,
                description: typeof route.description === 'string' ? route.description.trim() : '',
                folder_id: route.folder_id || '',
                premium: !!route.premium,
                locked: !!route.locked,
                viewed: !!route.viewed,
                ...this._routeStats(route)
            });

            for (const folderId of folders) {
                this._folderCounts.set(
                    folderId,
                    (this._folderCounts.get(folderId) || 0) + 1
                );
                if (route.premium) {
                    this._folderPremiumCounts.set(
                        folderId,
                        (this._folderPremiumCounts.get(folderId) || 0) + 1
                    );
                }
            }
        }

        catalog.sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'ru'));
        this._catalog = catalog;

        let validPath = [];
        let parentId = '';
        for (const folderId of this._folderPath) {
            const folder = this._folderMap.get(folderId);
            if (!folder || (folder.parent_id || '') !== parentId) break;
            validPath.push(folderId);
            parentId = folderId;
        }
        this._folderPath = validPath;
    },

    _folderChain(folderId) {
        const chain = [];
        const seen = new Set();
        let current = folderId || '';
        while (current && this._folderMap.has(current) && !seen.has(current)) {
            seen.add(current);
            const folder = this._folderMap.get(current);
            chain.push(folder);
            current = folder.parent_id || '';
        }
        return chain.reverse();
    },

    _routeStats(route) {
        // Новый API присылает готовые метрики. Старый формат с data
        // поддерживаем на случай локальной отладки.
        const measured = Array.isArray(route.data)
            ? this._measureRoute(route.data)
            : { pointCount: 0, distanceMeters: 0 };
        return {
            pointCount: Number.isFinite(route.point_count)
                ? route.point_count
                : measured.pointCount,
            distanceMeters: Number.isFinite(route.distance_meters)
                ? route.distance_meters
                : measured.distanceMeters
        };
    },

    _measureRoute(data) {
        if (!Array.isArray(data)) return { pointCount: 0, distanceMeters: 0 };

        let pointCount = 0;
        let distanceMeters = 0;
        for (const segment of data) {
            if (!segment || !Array.isArray(segment.pts)) continue;
            let previous = null;
            let hasPoint = false;
            for (const point of segment.pts) {
                if (!Array.isArray(point) ||
                    !Number.isFinite(point[0]) ||
                    !Number.isFinite(point[1]) ||
                    Math.abs(point[0]) > 90 ||
                    Math.abs(point[1]) > 180) continue;
                hasPoint = true;
                if (previous) {
                    const radians = Math.PI / 180;
                    const dLat = (point[0] - previous[0]) * radians;
                    const dLon = (point[1] - previous[1]) * radians;
                    const a = Math.sin(dLat / 2) ** 2 +
                        Math.cos(previous[0] * radians) *
                        Math.cos(point[0] * radians) *
                        Math.sin(dLon / 2) ** 2;
                    const arc = Math.min(1, Math.max(0, a));
                    distanceMeters += 6371000 * 2 *
                        Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
                }
                previous = point;
            }
            if (hasPoint) pointCount++;
        }
        return { pointCount, distanceMeters };
    },

    _forgetStoredFolderPath() {
        // Старые версии запоминали папку и восстанавливали её после перезагрузки.
        // Теперь путь живёт только в памяти, поэтому ключ нужно убрать.
        try {
            localStorage.removeItem('osm_routes_menu_state_v2');
        } catch (e) {}
    },

    _getChildFolders(parentId) {
        const parent = parentId || '';
        return this._folders
            .filter(folder => (folder.parent_id || '') === parent)
            .map(folder => ({
                ...folder,
                count: this._folderCounts.get(folder.folder_id) || 0,
                premiumCount: this._folderPremiumCounts.get(folder.folder_id) || 0
            }))
            .sort((a, b) => {
                const ao = Number.isFinite(a.sort_order) ? a.sort_order : 0;
                const bo = Number.isFinite(b.sort_order) ? b.sort_order : 0;
                if (ao !== bo) return ao - bo;
                return a.name.localeCompare(b.name, 'ru');
            });
    },

    _isWithinFolder(item, path) {
        return item.folders.length >= path.length &&
            path.every((folderId, index) => item.folders[index] === folderId);
    },

    _getFilteredRoutes() {
        return this._catalog.filter(item =>
            item.folders.length === this._folderPath.length &&
            this._isWithinFolder(item, this._folderPath)
        );
    },

    // Индикация загрузки списка маршрутов
    _showListLoading(text) {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                <div style="color:rgba(18,28,46,0.5);font-size:14px;">${text || 'Загрузка маршрутов...'}</div>
            </div>
        `;
    },

    _buildRoutesList() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();

        // Список ещё не получен — показываем спиннер, а не «Нет маршрутов».
        if (!this._routesLoaded) {
            this._renderBreadcrumbs();
            if (this._isFetchingRoutes) {
                this._showListLoading();
            } else {
                this._loadOwners();
            }
            return;
        }

        const routes = this._getFilteredRoutes();
        this._renderBreadcrumbs();

        container.innerHTML = '';

        if (!this._catalog.length && !this._folders.length) {
            container.innerHTML = '<div class="routes-empty"><div class="routes-empty-title">Нет маршрутов</div></div>';
            return;
        }

        const childFolders = this._getChildFolders(this._folderPath[this._folderPath.length - 1] || '');
        if (!routes.length && !childFolders.length) {
            const empty = document.createElement('div');
            empty.className = 'routes-empty';
            empty.innerHTML = '<div class="routes-empty-title">В этом разделе нет маршрутов</div>';
            container.appendChild(empty);
            return;
        }

        const summary = document.createElement('div');
        summary.className = 'routes-results-meta';
        const countLabel = `${routes.length} ${this._pluralize(routes.length, 'маршрут', 'маршрута', 'маршрутов')}`;
        const ownersRoot = !this._activeOwnerId && this._folderPath.length === 0;
        summary.textContent = ownersRoot
            ? `${childFolders.length} ${this._pluralize(childFolders.length, 'владелец', 'владельца', 'владельцев')}`
            : childFolders.length
                ? `${childFolders.length} ${this._pluralize(childFolders.length, 'папка', 'папки', 'папок')} · ${countLabel}`
                : countLabel;
        container.appendChild(summary);
        if (childFolders.length) {
            const folderList = document.createElement('div');
            folderList.className = 'routes-folder-list';
            for (const folder of childFolders) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'routes-folder-row';
                button.dataset.folderId = folder.folder_id;
                button.dataset.folderName = folder.name;
                if (folder.is_owner_root) button.dataset.ownerRoot = '1';
                const premiumCount = folder.premiumCount || 0;
                const countAria = `${folder.count} ${this._pluralize(folder.count, 'маршрут', 'маршрута', 'маршрутов')}` +
                    (premiumCount > 0
                        ? `, из них ${premiumCount} ${this._pluralize(premiumCount, 'премиум-маршрут', 'премиум-маршрута', 'премиум-маршрутов')}`
                        : '');
                button.innerHTML = `
                    <span class="routes-folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></span>
                    <span class="routes-folder-name">${this._escape(folder.name)}</span>
                    <span class="routes-folder-count" aria-label="${countAria}">
                        ${folder.count}
                    </span>
                    ${premiumCount > 0 ? `<span class="routes-folder-premium-badge">★ ${premiumCount}</span>` : ''}
                    <span class="routes-folder-chevron" aria-hidden="true">›</span>
                `;
                folderList.appendChild(button);
            }
            container.appendChild(folderList);
        }
        const instructors = this._instructorsForCurrentFolder();
        if (instructors.length) {
            const instructorBtn = document.createElement('button');
            instructorBtn.type = 'button';
            instructorBtn.className = 'instructors-row';
            instructorBtn.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;margin:8px 0 0;border:1px solid rgba(18,28,46,0.12);border-radius:14px;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer;text-align:left;';
            const title = document.createElement('span');
            title.style.cssText = 'font-weight:700;flex:1;';
            title.textContent = 'Инструкторы по вождению';
            const count = document.createElement('span');
            count.style.cssText = 'color:#5B6B80;font-size:13px;';
            count.textContent = String(instructors.length);
            const chevron = document.createElement('span');
            chevron.style.cssText = 'color:#5B6B80;';
            chevron.textContent = '›';
            instructorBtn.append(title, count, chevron);
            instructorBtn.addEventListener('click', () => {
                if (window.OnepageInstructors) {
                    window.OnepageInstructors.open(
                        instructors,
                        this._folderMap.get(this._folderPath[this._folderPath.length - 1] || '')?.name || ''
                    );
                }
            });
            container.appendChild(instructorBtn);
        }

        const frag = document.createDocumentFragment();
        for (const route of routes) frag.appendChild(this._createRouteRow(route));
        container.appendChild(frag);
        this._observeRoutePreviews(container);
        this._scrollToCurrentRoute(container);
    },

    _instructorsForCurrentFolder() {
        const folderId = this._folderPath[this._folderPath.length - 1] || '';
        if (!folderId) return [];
        const folder = this._folderMap.get(folderId);
        return folder && Array.isArray(folder.instructors) ? folder.instructors : [];
    },

    // Прокручивает список к загруженному маршруту, чтобы при открытии меню
    // было видно, где остановились. Срабатывает, только если строка есть
    // в текущей папке и не видна целиком.
    _scrollToCurrentRoute(container) {
        if (!this.currentRoute) return;
        const row = container.querySelector('.route-row.is-active');
        if (!row) return;
        const box = container.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        if (!box.height || (rect.top >= box.top && rect.bottom <= box.bottom)) return;
        container.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
    },

    _renderBreadcrumbs() {
        const back = document.getElementById('jsonModalBack');
        if (back) back.hidden = this._folderPath.length === 0;

        const el = document.getElementById('routesBreadcrumb');
        if (!el) return;
        el.innerHTML = '';
        const labels = [
            { id: '', name: this._ownersLoaded ? 'Владельцы' : 'Все маршруты' },
            ...this._folderPath.map(id => ({
                id,
                name: this._folderMap.get(id)?.name || id
            }))
        ];
        el.hidden = false;

        labels.forEach((label, index) => {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'routes-breadcrumb-separator';
                separator.textContent = '›';
                separator.setAttribute('aria-hidden', 'true');
                el.appendChild(separator);
            }
            const item = document.createElement('button');
            item.type = 'button';
            const isCurrent = index === labels.length - 1;
            item.className = 'routes-breadcrumb-item' + (isCurrent ? ' current' : '');
            item.textContent = label.name;
            item.dataset.breadcrumbIndex = String(index);
            if (isCurrent) item.setAttribute('aria-current', 'location');
            el.appendChild(item);
        });
    },

    _pluralize(count, one, few, many) {
        const mod100 = count % 100;
        if (mod100 >= 11 && mod100 <= 14) return many;
        switch (count % 10) {
            case 1: return one;
            case 2:
            case 3:
            case 4: return few;
            default: return many;
        }
    },

    markRouteViewed(routeKey) {
        const key = String(routeKey || '');
        if (!key) return;
        if (this.routesDescriptions[key]) this.routesDescriptions[key].viewed = true;
        const item = this._catalog.find(entry => entry.key === key);
        if (item) item.viewed = true;

        const row = document.querySelector(
            '.route-row[data-route-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]'
        );
        if (!row) return;
        const title = row.querySelector('.route-row-title');
        const details = row.querySelector('.route-row-details');
        if (!title || !details) return;
        if (details.querySelector('.route-row-viewed')) return;
        const active = row.classList.contains('is-active') ||
            Array.from(details.querySelectorAll('.route-row-badge'))
                .some(badge => badge.textContent === 'Загружен');
        if (active) return;
        let flagRow = details.querySelector('.route-row-flags');
        if (!flagRow) {
            flagRow = document.createElement('span');
            flagRow.className = 'route-row-flags';
            details.appendChild(flagRow);
        }
        const viewed = document.createElement('span');
        viewed.className = 'route-row-viewed';
        viewed.textContent = 'Просмотрен';
        flagRow.appendChild(viewed);
    },

    _createRouteRow(route) {
        const isActive = route.key === this.currentRoute;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'route-row' + (isActive ? ' is-active' : '') + (route.locked ? ' is-locked' : '');
        btn.dataset.routeKey = route.key;
        if (isActive) btn.setAttribute('aria-current', 'true');
        if (route.locked) btn.setAttribute('aria-disabled', 'true');

        const preview = document.createElement('span');
        preview.className = 'route-preview' + (route.locked ? ' is-locked' : '');
        preview.dataset.routeKey = route.key;
        preview.setAttribute('aria-hidden', 'true');
        if (route.locked) {
            preview.innerHTML = '<svg class="route-preview-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';
        }

        const main = document.createElement('span');
        main.className = 'route-row-main';

        const title = document.createElement('span');
        title.className = 'route-row-title';

        const name = document.createElement('span');
        name.className = 'route-row-name';
        name.textContent = route.name || route.m;
        title.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'route-row-meta';
        meta.textContent = route.folderNames.length ? route.folderNames.join(' · ') : 'Без папки';

        main.appendChild(title);
        const details = document.createElement('span');
        details.className = 'route-row-details';
        details.appendChild(meta);
        const stats = [];
        if (route.pointCount) {
            stats.push(`${route.pointCount} ${this._pluralize(route.pointCount, 'точка', 'точки', 'точек')}`);
        }
        if (route.distanceMeters >= 10) {
            const distanceLabel = route.distanceMeters >= 1000
                ? `${(route.distanceMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
                : `${Math.round(route.distanceMeters)} м`;
            stats.push(`≈ ${distanceLabel}`);
        }
        if (stats.length) {
            const statsEl = document.createElement('span');
            statsEl.className = 'route-row-stats';
            statsEl.textContent = stats.join(' · ');
            details.appendChild(statsEl);
        }
        const flags = [];
        if (isActive) {
            const activeBadge = document.createElement('span');
            activeBadge.className = 'route-row-badge';
            activeBadge.textContent = 'Загружен';
            flags.push(activeBadge);
        }
        if (route.premium) {
            const premiumBadge = document.createElement('span');
            premiumBadge.className = 'route-row-badge route-row-badge-premium';
            premiumBadge.textContent = '★ Премиум';
            flags.push(premiumBadge);
        }
        if (route.viewed && !isActive) {
            const viewed = document.createElement('span');
            viewed.className = 'route-row-viewed';
            viewed.textContent = 'Просмотрен';
            flags.push(viewed);
        }
        if (flags.length) {
            const flagRow = document.createElement('span');
            flagRow.className = 'route-row-flags';
            flags.forEach(flag => flagRow.appendChild(flag));
            details.appendChild(flagRow);
        }
        main.append(title, details);

        const tail = document.createElement('span');
        tail.className = 'route-row-tail';
        tail.setAttribute('aria-hidden', 'true');
        tail.innerHTML = isActive
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

        btn.append(preview, main, tail);
        btn.addEventListener('click', event => {
            event.stopPropagation();
            if (route.locked) {
                if (window.OnepageShop && typeof window.OnepageShop.openPaywall === 'function') {
                    window.OnepageShop.openPaywall(route.folder_id);
                } else if (typeof window.openPremiumOffer === 'function') {
                    window.openPremiumOffer();
                } else if (typeof showToast === 'function') {
                    showToast('Маршрут доступен после оплаты папки', 'info', 4000);
                }
                return;
            }
            if (route.m) this.loadRouteByName(route.m);
        });
        return btn;
    },

    _destroyRoutePreviews() {
        if (this._previewObserver) {
            this._previewObserver.disconnect();
            this._previewObserver = null;
        }
    },

    _previewTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },

    _previewPalette() {
        const styles = getComputedStyle(document.documentElement);
        const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
        return {
            from: read('--preview-bg-from', '#F8FAFC'),
            to: read('--preview-bg-to', '#E8EEF6'),
            shadow: read('--preview-shadow', 'rgba(18, 28, 46, 0.20)'),
            dotStroke: '#121A28'
        };
    },

    refreshRoutePreviews() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();
        this._previewQueue = [];
        this._previewQueuedKeys.clear();
        this._previewFetching.clear();
        this._previewJobs.clear();
        this._previewActive = false;
        this._previewImages.clear();
        container.querySelectorAll('.route-preview').forEach(element => {
            if (element.classList.contains('is-locked')) return;
            delete element.dataset.previewKey;
            element.replaceChildren();
            element.classList.remove('is-loading', 'is-empty');
        });
        this._observeRoutePreviews(container);
    },

    _observeRoutePreviews(container) {
        const previews = container.querySelectorAll('.route-preview:not(.is-locked)');
        if (!previews.length) return;

        const showPreviewImage = (element, key, imageUrl) => {
            if (!element.isConnected || element.dataset.previewKey !== key) return;
            const image = document.createElement('img');
            image.className = 'route-preview-image';
            image.alt = '';
            image.src = imageUrl;
            element.replaceChildren(image);
            element.classList.remove('is-loading', 'is-empty');
        };

        previews.forEach(element => {
            const key = `route-preview-v20\0${this._previewTheme()}\0${element.dataset.routeKey}`;
            element.dataset.previewKey = key;
            const image = this._previewImages.get(key);
            if (image) showPreviewImage(element, key, image);
        });

        const renderPreview = async (element, key, routeData) => {
            const palette = this._previewPalette();
            try {
                const points = [];
                const project = point => {
                    const latitude = Math.max(-85.0511, Math.min(85.0511, point[0]));
                    const longitude = point[1];
                    const sinLatitude = Math.sin(latitude * Math.PI / 180);
                    return {
                        x: (longitude + 180) / 360,
                        y: 0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)
                    };
                };

                let pointNumber = 0;
                for (const segment of routeData) {
                    if (!segment || !Array.isArray(segment.pts)) continue;
                    const coordinates = segment.pts.filter(point =>
                        Array.isArray(point) &&
                        Number.isFinite(point[0]) &&
                        Number.isFinite(point[1]) &&
                        Math.abs(point[0]) <= 90 &&
                        Math.abs(point[1]) <= 180
                    );
                    if (!coordinates.length) continue;
                    pointNumber++;
                    points.push({
                        coordinates,
                        color: this._ROUTE_COLORS[segment.color] || '#FFD700'
                    });
                }

                if (!points.length) {
                    element.classList.remove('is-loading');
                    element.classList.add('is-empty');
                    return;
                }

                const width = Math.max(1, element.clientWidth);
                const height = Math.max(1, element.clientHeight);
                const pixelRatio = 2;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(width * pixelRatio);
                canvas.height = Math.round(height * pixelRatio);
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Could not create preview canvas');
                context.scale(pixelRatio, pixelRatio);

                const background = context.createLinearGradient(0, 0, width, height);
                background.addColorStop(0, palette.from);
                background.addColorStop(1, palette.to);
                context.fillStyle = background;
                context.fillRect(0, 0, width, height);

                const projected = points.map(point => ({
                    ...point,
                    path: point.coordinates.map(project)
                }));
                let minX = Infinity;
                let maxX = -Infinity;
                let minY = Infinity;
                let maxY = -Infinity;
                for (const point of projected) {
                    for (const coordinate of point.path) {
                        minX = Math.min(minX, coordinate.x);
                        maxX = Math.max(maxX, coordinate.x);
                        minY = Math.min(minY, coordinate.y);
                        maxY = Math.max(maxY, coordinate.y);
                    }
                }
                const padding = 6;
                const scale = Math.min(
                    (width - padding * 2) / Math.max(maxX - minX, 1e-9),
                    (height - padding * 2) / Math.max(maxY - minY, 1e-9)
                );
                const offsetX = (width - (maxX - minX) * scale) / 2;
                const offsetY = (height - (maxY - minY) * scale) / 2;
                const toCanvas = point => ({
                    x: offsetX + (point.x - minX) * scale,
                    y: offsetY + (point.y - minY) * scale
                });

                for (const point of projected) {
                    if (point.path.length < 2) continue;
                    context.beginPath();
                    point.path.forEach((coordinate, index) => {
                        const position = toCanvas(coordinate);
                        if (index === 0) context.moveTo(position.x, position.y);
                        else context.lineTo(position.x, position.y);
                    });
                    context.lineCap = 'round';
                    context.lineJoin = 'round';
                    context.strokeStyle = palette.shadow;
                    context.lineWidth = 4;
                    context.stroke();
                    context.strokeStyle = point.color;
                    context.lineWidth = 2;
                    context.stroke();
                }

                const dotRadius = 2.4;
                for (const point of projected) {
                    if (!point.path.length) continue;
                    const position = toCanvas(point.path[0]);
                    context.beginPath();
                    context.arc(position.x, position.y, dotRadius, 0, Math.PI * 2);
                    context.fillStyle = point.color;
                    context.fill();
                    context.beginPath();
                    context.arc(position.x, position.y, dotRadius + 0.3, 0, Math.PI * 2);
                    context.lineWidth = 0.5;
                    context.strokeStyle = palette.dotStroke;
                    context.globalAlpha = 0.75;
                    context.stroke();
                    context.globalAlpha = 1;
                }

                if (projected.length && projected[0].path.length) {
                    const position = toCanvas(projected[0].path[0]);
                    context.beginPath();
                    context.arc(position.x, position.y, dotRadius + 1.6, 0, Math.PI * 2);
                    context.lineWidth = 1.5;
                    context.strokeStyle = '#34C759';
                    context.stroke();
                }

                const imageUrl = canvas.toDataURL('image/jpeg', 0.92);
                this._previewImages.set(key, imageUrl);
                document.querySelectorAll('.route-preview').forEach(candidate => {
                    showPreviewImage(candidate, key, imageUrl);
                });
            } catch (error) {
                console.warn('Не удалось создать превью маршрута:', error);
                element.classList.remove('is-loading');
                element.classList.add('is-empty');
            } finally {
                this._previewJobs.delete(key);
                this._previewActive = false;
                startNextPreview();
            }
        };

        const startNextPreview = () => {
            if (this._previewActive) return;
            while (this._previewQueue.length) {
                const job = this._previewQueue.shift();
                this._previewQueuedKeys.delete(job.key);
                if (!job.element.isConnected) continue;
                if (job.element.dataset.previewKey !== job.key) continue;
                const cachedImage = this._previewImages.get(job.key);
                if (cachedImage) {
                    job.showCached(cachedImage);
                    continue;
                }
                if (this._previewJobs.has(job.key)) continue;
                this._previewActive = true;
                this._previewJobs.set(job.key, true);
                job.element.replaceChildren();
                job.element.classList.add('is-loading');
                void renderPreview(job.element, job.key, job.routeData);
                return;
            }
        };

        const queuePreview = (element, key, routeData) => {
            if (this._previewJobs.has(key) || this._previewQueuedKeys.has(key)) return;
            this._previewQueuedKeys.add(key);
            this._previewQueue.push({
                key,
                element,
                routeData,
                showCached: image => showPreviewImage(element, key, image),
            });
            startNextPreview();
        };

        const createPreview = element => {
            if (!element.isConnected) return;
            const key = element.dataset.previewKey;
            const cachedImage = this._previewImages.get(key);
            if (cachedImage) {
                showPreviewImage(element, key, cachedImage);
                return;
            }
            if (
                this._previewJobs.has(key) ||
                this._previewQueuedKeys.has(key) ||
                this._previewFetching.has(key)
            ) return;

            const routeKey = element.dataset.routeKey;
            const cachedRoute = this._routeDataCache.get(routeKey);
            if (cachedRoute && Array.isArray(cachedRoute.data)) {
                queuePreview(element, key, cachedRoute.data);
                return;
            }

            // Старый локальный формат с data внутри каталога.
            const inlineData = this.routesDescriptions[routeKey]?.data;
            if (Array.isArray(inlineData)) {
                queuePreview(element, key, inlineData);
                return;
            }

            // Каталог без геометрии: догружаем её только для видимой строки.
            this._previewFetching.add(key);
            element.replaceChildren();
            element.classList.add('is-loading');
            this._fetchRoute(routeKey)
                .then(payload => {
                    this._previewFetching.delete(key);
                    if (!element.isConnected || element.dataset.previewKey !== key) return;
                    if (!Array.isArray(payload.data)) {
                        element.classList.remove('is-loading');
                        element.classList.add('is-empty');
                        return;
                    }
                    queuePreview(element, key, payload.data);
                })
                .catch(error => {
                    this._previewFetching.delete(key);
                    if (!element.isConnected || element.dataset.previewKey !== key) return;
                    element.classList.remove('is-loading');
                    element.classList.add('is-empty');
                    console.warn('Не удалось загрузить превью маршрута:', error);
                });
        };

        if (typeof IntersectionObserver === 'undefined') {
            Array.from(previews).slice(0, 2).forEach(createPreview);
            return;
        }

        this._previewObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const element = entry.target;
                if (entry.isIntersecting) {
                    this._previewObserver.unobserve(element);
                    createPreview(element);
                }
            }
        }, {
            root: container,
            rootMargin: '240px 0px'
        });
        previews.forEach(element => this._previewObserver.observe(element));
    },

    // Цвета сегментов маршрута (те же, что в навигаторе и редакторе)
    _ROUTE_COLORS: {
        Gold: '#FFD700', Blue: '#007AFF', Red: '#FF3B30', Fuchsia: '#AF52DE',
        Orange: '#FF9500', Purple: '#5856D6', Cyan: '#5AC8FA', Brown: '#A2845E',
        Lime: '#34C759'
    },

    // HTML-экранирование для вставки в innerHTML.
    _escape(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    // Создание модального окна
    createModal() {
        const html = `
            <div id="jsonModal" class="screen-modal">
                <div class="screen-panel" id="jsonModalScreen">
                    <header class="screen-head">
                        <button type="button" class="screen-back" id="jsonModalBack" aria-label="Назад" hidden>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
                        </button>
                        <h1 class="screen-title">Маршруты</h1>
                        <button type="button" class="screen-close" id="jsonModalClose" aria-label="Закрыть">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                    </header>
                    <div id="routesToolbar" class="routes-toolbar">
                        <nav id="routesBreadcrumb" class="routes-breadcrumb" aria-label="Путь к папке" hidden></nav>
                    </div>
                    <div id="routesListContainer" class="routes-list">
                        <div style="text-align:center; padding:20px; color:rgba(18,28,46,0.5); font-size:14px;">
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

        const closeBtn = document.getElementById('jsonModalClose');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());

        const backBtn = document.getElementById('jsonModalBack');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (this._folderPath.length === 0) return;
                if (this._activeOwnerId && this._folderPath.length === 1) {
                    this._showOwnersRoot();
                    return;
                }
                this._folderPath = this._folderPath.slice(0, -1);
                this._buildRoutesList();
            });
        }

        const breadcrumb = document.getElementById('routesBreadcrumb');
        if (breadcrumb) {
            breadcrumb.addEventListener('click', event => {
                const item = event.target.closest('[data-breadcrumb-index]');
                if (!item) return;
                const index = Number(item.dataset.breadcrumbIndex);
                if (!Number.isInteger(index)) return;
                if (index === 0 && this._activeOwnerId) {
                    this._showOwnersRoot();
                    return;
                }
                this._folderPath = index === 0 ? [] : this._folderPath.slice(0, index);
                this._buildRoutesList();
            });
        }

        const routesList = document.getElementById('routesListContainer');
        if (routesList) {
            routesList.addEventListener('click', event => {
                const folder = event.target.closest('[data-folder-id]');
                if (!folder || !routesList.contains(folder)) return;
                if (folder.dataset.ownerRoot === '1' && !this._activeOwnerId) {
                    this._openOwner(folder.dataset.folderId);
                    return;
                }
                // Внутри загруженного пакета владельца переходы по папкам
                // выполняются без запросов к сети.
                this._folderPath = [...this._folderPath, folder.dataset.folderId];
                this._buildRoutesList();
            });
        }
    },

    _resetCatalog() {
        this._catalogLoaded = false;
        this._owners = [];
        this._ownersLoaded = false;
        this._ownerBundles.clear();
        this._routeOwners.clear();
        this._activeOwnerId = null;
        this._catalog = [];
        this.routesDescriptions = {};
        this._folders = [];
        this._folderMap.clear();
        this._folderCounts.clear();
        this._folderPremiumCounts.clear();
        this._routeDataCache.clear();
        this._routeRequests.clear();
    },

    // Проверка URL параметра
    checkUrlParam() {
        const routeParam = this.getUrlParam('m');
        if (!routeParam) return;

        this.currentRoute = routeParam;
        this.isLoaded = true;
        this.hide();
        this.loadRouteByName(routeParam);
    },

    // Загрузка маршрута по m
    async loadRouteByName(routeM) {
        this.showSpinner();
        try {
            if (!routeM) throw new Error('Не указан маршрут');

            // Пакет владельца содержит маршруты и знаки. Он загружается один
            // раз при открытии корневой папки или по прямой ссылке ?m=...
            await this._ensureOwnerForRoute(routeM);

            const meta = this.routesDescriptions && this.routesDescriptions[routeM];
            if (meta && meta.locked) {
                throw new Error('premium_locked');
            }
            this.currentRoute = routeM;

            this.hide();

            // Геометрия уже в кэше пакета владельца; _fetchRoute остаётся
            // запасным путём для премиум-маршрута после оплаты.
            const data = await this._fetchRoute(routeM);

            await this.loadRoute(data);
            this.hideSpinner();
        } catch (e) {
            this.hideSpinner();
            console.error('[MenuModule] Ошибка загрузки маршрута:', e);
            if (typeof showToast === 'function') {
                if (e && e.message === 'premium_locked') {
                    if (typeof window.openPremiumOffer === 'function') {
                        window.openPremiumOffer();
                    } else {
                        showToast('Премиум-маршрут доступен по подписке', 'info', 4000);
                    }
                } else {
                    showToast('Ошибка загрузки: ' + e.message, 'error', 5000);
                }
            }
        }
    },

    // Загрузка маршрута (публичный метод, передаёт JSON в навигатор)
    async loadRoute(jsonData) {
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
                    this.routesDescriptions[cr] = { name: jsonData.name, m: jsonData.m || cr };
                }
            }
        }

        // Передаём JSON данные в навигатор
        if (typeof this.callback === 'function') {
            await this.callback(routeData);
        }
        this.isLoaded = true;
        this.hide();
    },

    // Скрыть модальное окно
    hide() {
        this._destroyRoutePreviews();
        const modal = document.getElementById('jsonModal');
        if (modal) modal.classList.add('hidden');
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

        this._buildRoutesList();
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
