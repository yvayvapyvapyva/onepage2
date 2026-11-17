/* Инструкторы onepage2 в интерфейсе навигатора3.
 * Список приходит вместе с папкой каталога (поле instructors).
 */
(function (global) {
    'use strict';

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function ensureModal() {
        let modal = document.getElementById('opInstructors');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'opInstructors';
        modal.className = 'hidden screen-modal';
        modal.innerHTML = `
            <div class="screen-panel">
                <header class="screen-head">
                    <h1 class="screen-title" id="opInstructorsTitle">Инструкторы</h1>
                    <button type="button" class="screen-close" aria-label="Закрыть">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                    </button>
                </header>
                <div id="opInstructorsBody" style="padding:0 16px 24px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('.screen-close').addEventListener('click', close);
        modal.addEventListener('click', (event) => {
            if (event.target === modal) close();
        });
        return modal;
    }

    function close() {
        const modal = document.getElementById('opInstructors');
        if (modal) modal.classList.add('hidden');
    }

    function photo(instructor) {
        const photos = instructor.photos || {};
        const avatar = photos.avatar || photos.car;
        return avatar && avatar.url ? avatar.url : '';
    }

    function card(instructor) {
        const el = document.createElement('div');
        el.style.cssText = 'border:1px solid rgba(18,28,46,0.12);border-radius:16px;padding:14px;display:flex;gap:12px;align-items:flex-start;background:var(--surface,#fff);';

        const avatarUrl = photo(instructor);
        const avatar = document.createElement('div');
        avatar.style.cssText = 'flex:0 0 56px;width:56px;height:56px;border-radius:50%;overflow:hidden;background:#E9EEF5;display:flex;align-items:center;justify-content:center;font-weight:700;color:#5B6B80;font-size:20px;';
        if (avatarUrl) {
            avatar.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="" style="width:100%;height:100%;object-fit:cover;">';
        } else {
            avatar.textContent = (instructor.name || '?').trim().charAt(0).toUpperCase();
        }

        const body = document.createElement('div');
        body.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;';

        const name = document.createElement('div');
        name.style.cssText = 'font-weight:700;font-size:15px;overflow-wrap:anywhere;';
        name.textContent = instructor.name || 'Инструктор';
        body.appendChild(name);

        if (instructor.car_model) {
            const car = document.createElement('div');
            car.style.cssText = 'font-size:13px;color:#5B6B80;';
            car.textContent = instructor.car_model;
            body.appendChild(car);
        }

        if (instructor.text) {
            const text = document.createElement('div');
            text.style.cssText = 'font-size:13px;color:#5B6B80;white-space:pre-line;';
            text.textContent = instructor.text;
            body.appendChild(text);
        }

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;';

        if (instructor.phone) {
            const call = document.createElement('a');
            call.href = 'tel:' + String(instructor.phone).replace(/[^\d+]/g, '');
            call.textContent = '📞 ' + instructor.phone;
            call.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;background:#1876B5;color:#fff;text-decoration:none;font-weight:600;font-size:13px;';
            actions.appendChild(call);
        }

        if (instructor.url) {
            const link = document.createElement('a');
            link.href = instructor.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'Профиль';
            link.style.cssText = 'display:inline-flex;align-items:center;padding:8px 12px;border-radius:999px;border:1px solid rgba(18,28,46,0.12);color:inherit;text-decoration:none;font-weight:600;font-size:13px;';
            actions.appendChild(link);
        }

        if (actions.children.length) body.appendChild(actions);

        el.append(avatar, body);
        return el;
    }

    function open(list, folderName) {
        if (!Array.isArray(list) || !list.length) return;
        const modal = ensureModal();
        const title = document.getElementById('opInstructorsTitle');
        if (title) {
            title.textContent = folderName ? 'Инструкторы · ' + folderName : 'Инструкторы';
        }
        const body = document.getElementById('opInstructorsBody');
        body.innerHTML = '';
        list.forEach((instructor) => body.appendChild(card(instructor)));
        modal.classList.remove('hidden');
    }

    global.OnepageInstructors = { open: open, close: close };
})(window);
