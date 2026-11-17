/* Адаптер навигатора3 к API onepage2.
 *
 * Интерфейс навигатора3 ходит в /api/owners, /api/catalog, /api/route.
 * Здесь эти запросы переводятся в действия воркера навигатора
 * (?action=catalog/get) и возвращаются в формате, который ждёт menu-n3.
 */
(function (global) {
    'use strict';

    const API = 'https://nav-api.ivan43103.workers.dev';
    const OWNER_ID = 'shared';
    const OWNER_NAME = 'Автоинструктор';

    const originalFetch = global.fetch ? global.fetch.bind(global) : null;
    if (!originalFetch) return;

    let catalogPromise = null;

    function jsonResponse(payload, status) {
        return new Response(JSON.stringify(payload), {
            status: status || 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            }
        });
    }

    function workerGet(action, params) {
        const url = new URL(API);
        url.searchParams.set('action', action);
        Object.keys(params || {}).forEach((key) => {
            url.searchParams.set(key, params[key]);
        });
        return originalFetch(url.toString(), {
            method: 'GET',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
    }

    function loadCatalog() {
        if (!catalogPromise) {
            catalogPromise = workerGet('catalog')
                .then((response) => {
                    if (!response.ok) throw new Error('catalog HTTP ' + response.status);
                    return response.json();
                })
                .catch((error) => {
                    catalogPromise = null;
                    throw error;
                });
        }
        return catalogPromise;
    }

    function rememberFolders(catalog) {
        const parents = {};
        const names = {};
        (catalog.folders || []).forEach((folder) => {
            parents[String(folder.id)] = folder.parent_id == null ? '' : String(folder.parent_id);
            names[String(folder.id)] = folder.name || '';
        });
        global.OnepageFolders = { parents: parents, names: names };
    }

    function ownerBundle(catalog) {
        rememberFolders(catalog);
        const folders = (catalog.folders || []).map((folder) => {
            const parentId = folder.parent_id == null ? '' : String(folder.parent_id);
            const item = {
                folder_id: String(folder.id),
                // В onepage2 у корневых папок parent_id пустой, в навигаторе3
                // они должны быть вложены в корень владельца.
                parent_id: parentId || OWNER_ID,
                name: folder.name || 'Папка',
                sort_order: Number(folder.sort_order) || 0
            };
            if (Array.isArray(folder.instructors) && folder.instructors.length) {
                item.instructors = folder.instructors;
            }
            return item;
        });

        const shop = global.OnepageShop;
        const routes = (catalog.routes || [])
            .filter((route) => route && route.m)
            .map((route) => {
                const folderId = route.folder_id == null ? '' : String(route.folder_id);
                const locked = shop && folderId ? shop.isLocked(folderId) : false;
                return {
                    m: String(route.m),
                    title: route.name || route.m,
                    name: route.name || route.m,
                    folder_id: folderId,
                    description: route.description || '',
                    premium: locked,
                    locked: locked,
                    viewed: false
                };
            });

        return {
            owner: { root_folder_id: OWNER_ID, name: OWNER_NAME },
            folders: folders,
            routes: routes,
            signs: []
        };
    }

    function handleOwners() {
        return loadCatalog().then((catalog) => jsonResponse({
            owners: [{
                root_folder_id: OWNER_ID,
                name: OWNER_NAME,
                routes_count: (catalog.routes || []).length,
                premium_count: 0
            }]
        }));
    }

    function handleCatalog() {
        const shopReady = global.OnepageShop && global.OnepageShop.ready
            ? global.OnepageShop.ready
            : Promise.resolve();
        return Promise.all([loadCatalog(), shopReady])
            .then(([catalog]) => jsonResponse(ownerBundle(catalog)));
    }

    function handleRoute(m) {
        if (!m) return Promise.resolve(jsonResponse({ error: 'missing_route_name' }, 400));
        return workerGet('get', { m: m }).then(async (response) => {
            let payload = null;
            try { payload = await response.json(); } catch (e) {}
            if (!response.ok) {
                return jsonResponse(
                    { error: (payload && payload.error) || 'route_not_found' },
                    response.status
                );
            }
            if (!payload || !Array.isArray(payload.data)) {
                return jsonResponse({ error: 'invalid_route' }, 502);
            }
            return jsonResponse({
                m: payload.m || m,
                name: payload.name || m,
                data: payload.data
            });
        });
    }

    global.fetch = function (input, init) {
        const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
        let url;
        try {
            url = new URL(rawUrl, global.location.href);
        } catch (e) {
            return originalFetch(input, init);
        }

        // Внешние запросы (тайлы, TTS, Telegram) не трогаем.
        if (url.origin !== global.location.origin) {
            return originalFetch(input, init);
        }

        switch (url.pathname) {
            case '/api/owners':
                return handleOwners();
            case '/api/catalog':
                return handleCatalog();
            case '/api/route':
                return handleRoute(url.searchParams.get('m'));
            case '/api/signs':
                return Promise.resolve(jsonResponse({ signs: [] }));
            case '/api/route/view':
                return Promise.resolve(jsonResponse({ status: 'ok', viewed: true }));
            case '/api/premium/status':
                return Promise.resolve(jsonResponse({
                    active: false,
                    price: '',
                    price_value: 0,
                    currency: 'RUB',
                    days: 0,
                    payments_available: false,
                    providers: [],
                    logged_in: false
                }));
            case '/api/me':
                return Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401));
            default:
                return originalFetch(input, init);
        }
    };
})(window);
