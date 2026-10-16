/**
 * StarsDonate — универсальная кнопка донатов ⭐ для любого Telegram Mini App
 *
 * Встраивание (backend уже вшит по умолчанию):
 *   <script src="https://твой-cdn/donate-stars.js"></script>
 *   <div id="donate"></div>
 *   <script>StarsDonate.mount("#donate");</script>
 *
 * Работает с воркером из этого репо: POST {backend}/invoice
 * body: { product_id:"donate", amount, initData }
 */
(function (global) {
  const DEFAULT_BACKEND = "https://telegram-bot.ivan43103.workers.dev";
  const CSS = `
  .sd-root{font-family:var(--tg-font,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);max-width:320px}
  .sd-title{font-size:15px;font-weight:600;margin:0 0 8px;color:var(--tg-text,#111)}
  .sd-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .sd-btn{flex:1;min-width:72px;padding:10px 8px;border-radius:12px;border:0;cursor:pointer;font-size:14px;font-weight:600;background:var(--tg-button,#2AABEE);color:var(--tg-button-text,#fff);transition:opacity .15s,transform .1s}
  .sd-btn:active{transform:scale(.97)}
  .sd-btn:disabled{opacity:.5;cursor:wait}
  .sd-btn.sd-active{outline:2px solid var(--tg-button,#2AABEE);outline-offset:2px}
  .sd-custom{display:flex;gap:8px}
  .sd-input{flex:1;padding:10px;border-radius:12px;border:1px solid rgba(0,0,0,.15);font-size:14px;background:var(--tg-bg,#fff);color:var(--tg-text,#111);min-width:0}
  .sd-status{font-size:13px;margin-top:8px;min-height:18px;color:var(--tg-hint,#999)}
  .sd-status.sd-error{color:#e53935}
  .sd-status.sd-ok{color:#2e7d32}
  `;

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const s = document.createElement("style");
    s.setAttribute("data-stars-donate", "");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function applyTelegramTheme() {
    try {
      const tg = global.Telegram?.WebApp;
      if (!tg?.themeParams) return;
      const p = tg.themeParams;
      const root = document.documentElement.style;
      if (p.bg_color) root.setProperty("--tg-bg", p.bg_color);
      if (p.text_color) root.setProperty("--tg-text", p.text_color);
      if (p.hint_color) root.setProperty("--tg-hint", p.hint_color);
      if (p.button_color) root.setProperty("--tg-button", p.button_color);
      if (p.button_text_color) root.setProperty("--tg-button-text", p.button_text_color);
    } catch {}
  }

  function getInitData() {
    return global.Telegram?.WebApp?.initData || "";
  }

  function haptic(type) {
    try {
      global.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);
    } catch {}
  }

  const api = {
    /**
     * @param {string|HTMLElement} target — селектор или элемент
     * @param {object} opts
     * @param {string} opts.backend — URL воркера (по умолчанию вшит https://telegram-bot.ivan43103.workers.dev)
     * @param {number[]} opts.amounts — пресеты, default [1,5,10,50]
     * @param {string} opts.title — заголовок, default "Поддержать проект ❤️"
     * @param {boolean} opts.allowCustom — свой ввод суммы, default true
     * @param {function} opts.onPaid — callback(status, stars)
     * @param {function} opts.onError — callback(message)
     */
    mount(target, opts = {}) {
      injectCss();
      applyTelegramTheme();

      const el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) throw new Error("StarsDonate: target not found: " + target);

      const backend = (opts.backend || DEFAULT_BACKEND).replace(/\/$/, "");
      if (!backend) throw new Error("StarsDonate: opts.backend обязателен");

      const cfg = {
        amounts: opts.amounts || [1, 5, 10, 50],
        title: opts.title ?? "Поддержать проект ❤️",
        allowCustom: opts.allowCustom ?? true,
        backend,
        onPaid: opts.onPaid || (() => {}),
        onError: opts.onError || (() => {}),
      };

      el.innerHTML = "";
      const root = document.createElement("div");
      root.className = "sd-root";

      if (cfg.title) {
        const t = document.createElement("p");
        t.className = "sd-title";
        t.textContent = cfg.title;
        root.appendChild(t);
      }

      const row = document.createElement("div");
      row.className = "sd-row";
      root.appendChild(row);

      const status = document.createElement("div");
      status.className = "sd-status";

      function setStatus(msg, kind = "") {
        status.textContent = msg;
        status.className = "sd-status " + kind;
      }

      function setLoading(loading) {
        root.querySelectorAll("button").forEach((b) => (b.disabled = loading));
      }

      async function pay(stars) {
        stars = Math.floor(Number(stars));
        if (!Number.isFinite(stars) || stars < 1 || stars > 10000) {
          setStatus("Сумма: от 1 до 10000 ⭐", "sd-error");
          return;
        }
        const tg = global.Telegram?.WebApp;
        if (!tg) {
          const msg = "Открой страницу внутри Telegram";
          setStatus(msg, "sd-error");
          cfg.onError(msg);
          return;
        }
        setLoading(true);
        setStatus(`Создаём счёт на ${stars} ⭐…`);
        try {
          // text/plain вместо application/json — иначе браузер шлёт OPTIONS-префлайт,
          // а воркер без CORS-обработчика отвечает 404 и Safari/Telegram отдаёт "Load failed".
          // Воркер всё равно читает тело через request.json(), тип контента ему не важен.
          const resp = await fetch(cfg.backend + "/invoice", {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
            body: JSON.stringify({
              product_id: "donate",
              amount: stars,
              initData: getInitData(),
            }),
          });
          const raw = await resp.text();
          let res = null;
          try {
            res = raw ? JSON.parse(raw) : null;
          } catch {
            throw new Error("Сервер вернул не JSON (HTTP " + resp.status + "): " + String(raw).slice(0, 120));
          }

          if (!resp.ok || !res || res.ok !== true) throw new Error((res && res.error) || ("HTTP " + resp.status));

          setStatus("Открываем оплату…");
          tg.openInvoice(res.invoiceLink, (payStatus) => {
            setLoading(false);
            if (payStatus === "paid") {
              setStatus("Спасибо за поддержку! ❤️", "sd-ok");
              haptic("success");
              cfg.onPaid(payStatus, stars);
            } else if (payStatus === "cancelled") {
              setStatus("Оплата отменена");
            } else {
              setStatus("Не оплачено: " + payStatus, "sd-error");
            }
          });
        } catch (e) {
          setLoading(false);
          const msg = "Ошибка: " + (e.message || e);
          setStatus(msg, "sd-error");
          haptic("error");
          cfg.onError(msg);
        }
      }

      cfg.amounts.forEach((a) => {
        const b = document.createElement("button");
        b.className = "sd-btn";
        b.type = "button";
        b.textContent = `❤️ ${a} ⭐`;
        b.onclick = () => pay(a);
        row.appendChild(b);
      });

      if (cfg.allowCustom) {
        const box = document.createElement("div");
        box.className = "sd-custom";
        const input = document.createElement("input");
        input.className = "sd-input";
        input.type = "number";
        input.min = "1";
        input.max = "10000";
        input.placeholder = "Своя сумма";
        const btn = document.createElement("button");
        btn.className = "sd-btn";
        btn.type = "button";
        btn.textContent = "Отправить";
        btn.onclick = () => pay(input.value);
        box.appendChild(input);
        box.appendChild(btn);
        root.appendChild(box);
      }

      root.appendChild(status);
      el.appendChild(root);

      return { pay, destroy: () => el.removeChild(root) };
    },
  };

  global.StarsDonate = api;
})(typeof window !== "undefined" ? window : this);
