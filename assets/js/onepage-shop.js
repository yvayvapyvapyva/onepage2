/* Платные папки onepage2 для интерфейса навигатора3.
 *
 * Загружает замки и доступы покупателя, показывает экран оплаты в стиле
 * навигатора3 и открывает счёт Telegram Stars.
 */
(function (global) {
    'use strict';

    const API = 'https://nav-api.ivan43103.workers.dev';

    const state = {
        locks: {},          // folderId -> price
        access: new Set(),  // lock folder ids
        unlimited: false,
        loaded: false
    };

    let readyPromise = null;

    function tg() {
        return (global.Telegram && global.Telegram.WebApp) || null;
    }

    function initData() {
        const app = tg();
        return app && app.initData ? app.initData : '';
    }

    function worker(action, body) {
        const url = new URL(API);
        url.searchParams.set('action', action);
        const options = {
            method: body ? 'POST' : 'GET',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        };
        if (body) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        return fetch(url.toString(), options).then(async (response) => {
            let payload = null;
            try { payload = await response.json(); } catch (e) {}
            if (!response.ok) {
                const error = new Error((payload && payload.error) || ('HTTP ' + response.status));
                error.payload = payload;
                throw error;
            }
            return payload || {};
        });
    }

    function waitForTelegram() {
        if (global.__tgReady) {
            return global.__tgReady.then(() => true).catch(() => false);
        }
        return Promise.resolve(false);
    }

    function load() {
        if (readyPromise) return readyPromise;
        readyPromise = waitForTelegram()
            .then(() => worker('locks'))
            .then((data) => {
                state.locks = {};
                (data.locks || []).forEach((lock) => {
                    state.locks[String(lock.id)] = Number(lock.price) || 0;
                });
                const data2 = initData();
                if (!data2) return null;
                return worker('my_access', { initData: data2 }).catch(() => null);
            })
            .then((access) => {
                if (access) {
                    state.access = new Set((access.ids || []).map(String));
                    state.unlimited = !!access.unlimited;
                }
                state.loaded = true;
                return state;
            })
            .catch(() => {
                state.loaded = true;
                return state;
            });
        return readyPromise;
    }

    function price(folderId) {
        return state.locks[String(folderId)] || 0;
    }

    function hasAccess(lockId) {
        return state.unlimited || state.access.has(String(lockId));
    }

    function folderParents() {
        return (global.OnepageFolders && global.OnepageFolders.parents) || {};
    }

    function lockedAncestor(folderId) {
        let current = folderId == null ? '' : String(folderId);
        const parents = folderParents();
        const seen = new Set();
        while (current && !seen.has(current)) {
            if (Object.prototype.hasOwnProperty.call(state.locks, current) && !hasAccess(current)) {
                return current;
            }
            seen.add(current);
            current = parents[current] || '';
        }
        return null;
    }

    function isLocked(folderId) {
        return lockedAncestor(folderId) !== null;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function folderPath(folderId) {
        const parents = folderParents();
        const names = (global.OnepageFolders && global.OnepageFolders.names) || {};
        const parts = [];
        let current = folderId == null ? '' : String(folderId);
        const seen = new Set();
        while (current && !seen.has(current)) {
            seen.add(current);
            if (names[current]) parts.unshift(names[current]);
            current = parents[current] || '';
        }
        return parts.join(' / ');
    }

    function ensureModal() {
        let modal = document.getElementById('opPaywall');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'opPaywall';
        modal.className = 'hidden screen-modal';
        modal.innerHTML = `
            <div class="screen-panel">
                <header class="screen-head">
                    <h1 class="screen-title">Доступ к папке</h1>
                    <button type="button" class="screen-close" aria-label="Закрыть">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                    </button>
                </header>
                <div id="opPaywallBody" style="padding:0 18px 24px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('.screen-close').addEventListener('click', hidePaywall);
        modal.addEventListener('click', (event) => {
            if (event.target === modal) hidePaywall();
        });
        return modal;
    }

    function toast(text, kind) {
        if (typeof global.showToast === 'function') {
            global.showToast(text, kind || 'info');
        }
    }

    function hidePaywall() {
        const modal = document.getElementById('opPaywall');
        if (modal) modal.classList.add('hidden');
    }

    function openPaywall(folderId) {
        load().then(() => {
            const lockId = lockedAncestor(folderId);
            if (!lockId) {
                toast('Доступ уже открыт', 'success');
                refreshMenu();
                return;
            }
            const cost = price(lockId);
            const path = folderPath(lockId) || folderPath(folderId) || 'папка';
            const modal = ensureModal();
            const body = document.getElementById('opPaywallBody');
            body.innerHTML = '';

            const text = document.createElement('div');
            text.style.cssText = 'color:var(--text-muted,#5B6B80);font-size:14px;line-height:1.4;';
            text.textContent = 'Папка «' + path + '» доступна после оплаты. Доступ на 30 дней.';
            body.appendChild(text);

            const priceEl = document.createElement('div');
            priceEl.style.cssText = 'font-size:26px;font-weight:800;';
            priceEl.textContent = '★ ' + cost;
            body.appendChild(priceEl);

            if (initData()) {
                const buy = document.createElement('button');
                buy.type = 'button';
                buy.className = 'premium-buy-btn';
                buy.textContent = 'Открыть за ' + cost + ' ★';
                buy.addEventListener('click', () => buyFolder(lockId, buy));
                body.appendChild(buy);

                const claim = document.createElement('button');
                claim.type = 'button';
                claim.className = 'premium-buy-btn';
                claim.style.background = 'transparent';
                claim.style.color = 'var(--text, #12203A)';
                claim.style.border = '1px solid var(--line, rgba(18,28,46,0.12))';
                claim.textContent = 'Я уже оплатил — обновить';
                claim.addEventListener('click', () => claimPurchases(lockId, claim));
                body.appendChild(claim);
            } else {
                const hint = document.createElement('div');
                hint.style.cssText = 'color:var(--text-muted,#5B6B80);font-size:14px;';
                hint.textContent = 'Открой приложение в Telegram, чтобы получить доступ за звёзды.';
                body.appendChild(hint);
            }

            modal.classList.remove('hidden');
        });
    }

    function buyFolder(lockId, button) {
        const data = initData();
        if (!data) return;
        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Создаём счёт…';
        worker('shop_invoice', { initData: data, folder_id: Number(lockId) })
            .then((invoice) => {
                if (invoice.owned) {
                    return load().then(() => {
                        hidePaywall();
                        refreshMenu();
                        toast('Доступ уже куплен', 'success');
                    });
                }
                if (!invoice.invoiceLink) throw new Error('Нет ссылки на оплату');
                const app = tg();
                if (!app || !app.openInvoice) throw new Error('Оплата доступна только в Telegram');
                app.openInvoice(invoice.invoiceLink, (status) => {
                    button.disabled = false;
                    button.textContent = label;
                    if (status === 'paid') {
                        claimPurchases(lockId, null);
                    } else if (status !== 'cancelled') {
                        toast('Не оплачено: ' + status, 'error');
                    }
                });
            })
            .catch((error) => {
                button.disabled = false;
                button.textContent = label;
                toast('Ошибка: ' + error.message, 'error');
            });
    }

    function claimPurchases(lockId, button) {
        const data = initData();
        if (!data) return;
        const label = button ? button.textContent : '';
        if (button) {
            button.disabled = true;
            button.textContent = 'Проверяем оплату…';
        }
        const delays = button ? [0] : [0, 1500, 3000, 5000];
        let index = 0;

        function attempt() {
            worker('shop_claim', { initData: data })
                .then((result) => {
                    state.access = new Set((result.ids || []).map(String));
                    state.unlimited = !!result.unlimited;
                    if (hasAccess(lockId)) {
                        hidePaywall();
                        refreshMenu();
                        toast('Доступ открыт! 🎉', 'success');
                        return;
                    }
                    index += 1;
                    if (index < delays.length) {
                        setTimeout(attempt, delays[index]);
                        return;
                    }
                    if (button) {
                        button.disabled = false;
                        button.textContent = label;
                    }
                    toast('Оплата не найдена', 'error');
                })
                .catch((error) => {
                    if (button) {
                        button.disabled = false;
                        button.textContent = label;
                    }
                    toast('Ошибка: ' + error.message, 'error');
                });
        }

        attempt();
    }

    function refreshMenu() {
        const menu = global.MenuModule;
        if (!menu) return;
        try {
            if (typeof menu._resetCatalog === 'function') menu._resetCatalog();
            if (typeof menu._loadOwners === 'function') menu._loadOwners();
        } catch (e) {}
    }

    global.OnepageShop = {
        ready: load(),
        reload: function () {
            readyPromise = null;
            return load().then(() => {
                refreshMenu();
                return state;
            });
        },
        openPaywall: openPaywall,
        isLocked: isLocked,
        lockedAncestor: lockedAncestor,
        price: price,
        hasAccess: hasAccess,
        state: state
    };
})(window);
