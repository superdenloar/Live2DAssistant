/* Общий JS кабинета: тосты, модальные окна, копирование, бейдж «ждут оператора». */
(function () {
    'use strict';

    const D = window.Dash = {};

    D.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    D.toast = function (text, kind = 'ok') {
        const box = document.getElementById('toasts');
        if (!box) return;
        const el = document.createElement('div');
        el.className = 'toast ' + kind;
        const iconPath = kind === 'err' ? '<path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/>' : '<path d="M20 6 9 17l-5-5"/>';
        el.innerHTML = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg><span></span>`;
        el.querySelector('span').textContent = text;
        box.appendChild(el);
        setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); }, 3200);
    };

    D.openModal = function (id) {
        const m = document.getElementById(id);
        if (!m) return;
        m.classList.add('open');
        const f = m.querySelector('[autofocus], input:not([type=hidden]), button.btn-primary');
        if (f) setTimeout(() => f.focus(), 40);
    };
    D.closeModal = function (id) {
        const m = typeof id === 'string' ? document.getElementById(id) : id;
        if (m) m.classList.remove('open');
    };

    document.addEventListener('click', (e) => {
        const opener = e.target.closest('[data-open]');
        if (opener) { e.preventDefault(); D.openModal(opener.dataset.open); return; }
        const closer = e.target.closest('[data-close]');
        if (closer) { e.preventDefault(); D.closeModal(closer.closest('.modal-backdrop')); return; }
        if (e.target.classList.contains('modal-backdrop')) D.closeModal(e.target);

        const copyBtn = e.target.closest('[data-copy]');
        if (copyBtn) {
            const target = copyBtn.dataset.copy ? document.querySelector(copyBtn.dataset.copy) : copyBtn.closest('.codebox')?.querySelector('pre');
            const text = target ? (target.value ?? target.innerText) : '';
            D.copy(text).then(() => {
                const old = copyBtn.innerHTML;
                copyBtn.innerHTML = 'Скопировано';
                setTimeout(() => { copyBtn.innerHTML = old; }, 1400);
            });
        }
        const soon = e.target.closest('[data-soon]');
        if (soon) { e.preventDefault(); D.toast(soon.dataset.soon || 'Эта функция в разработке'); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(m => D.closeModal(m));
    });

    D.copy = async function (text) {
        try { await navigator.clipboard.writeText(text); }
        catch (e) {
            const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (_) { }
            ta.remove();
        }
        D.toast('Скопировано в буфер обмена');
    };

    D.api = async function (url, opts = {}) {
        const init = { headers: {}, ...opts };
        if (opts.json !== undefined) {
            init.method = init.method || 'POST';
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.json);
        }
        const r = await fetch(url, init);
        let data = null;
        try { data = await r.json(); } catch (_) { }
        if (!r.ok) throw new Error((data && (data.error || data.message)) || ('Ошибка ' + r.status));
        return data;
    };

    D.timeAgo = function (iso) {
        if (!iso) return '';
        const d = new Date(iso), now = new Date();
        const diff = (now - d) / 1000;
        if (diff < 60) return 'сейчас';
        if (diff < 3600) return Math.floor(diff / 60) + ' мин';
        if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const y = new Date(now); y.setDate(now.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'вчера';
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    };

    // Простая подсветка HTML/JS в блоках .codebox[data-hl]
    D.highlight = function (root = document) {
        root.querySelectorAll('.codebox pre[data-hl]').forEach(pre => {
            const src = pre.textContent;
            let html = D.esc(src);
            if (pre.dataset.hl === 'html') {
                html = html
                    .replace(/(&lt;\/?)([a-z0-9-]+)/gi, '$1<span class="tok-tag">$2</span>')
                    .replace(/([a-z-]+)=(&quot;.*?&quot;)/gi, '<span class="tok-attr">$1</span>=<span class="tok-str">$2</span>')
                    .replace(/(&lt;!--.*?--&gt;)/g, '<span class="tok-com">$1</span>');
            } else {
                html = html
                    .replace(/(\/\/[^\n]*)/g, '<span class="tok-com">$1</span>')
                    .replace(/(&#39;.*?&#39;|&quot;.*?&quot;|`[^`]*`)/g, '<span class="tok-str">$1</span>')
                    .replace(/\b(const|let|await|async|function|return|new|window|fetch)\b/g, '<span class="tok-kw">$1</span>');
            }
            pre.innerHTML = html;
        });
    };

    // Мобильное меню
    const sb = document.getElementById('sidebar');
    document.getElementById('sidebar-open')?.addEventListener('click', () => sb?.classList.toggle('open'));
    document.addEventListener('click', (e) => {
        if (sb?.classList.contains('open') && !e.target.closest('#sidebar') && !e.target.closest('#sidebar-open')) sb.classList.remove('open');
    });

    // Счётчик «ждут оператора»
    let lastWaiting = parseInt(document.getElementById('nav-waiting')?.textContent || '0', 10) || 0;
    const baseTitle = document.title;
    async function pollSummary() {
        try {
            const s = await D.api('/api/admin/summary');
            const el = document.getElementById('nav-waiting');
            if (el) { el.textContent = s.waiting; el.hidden = !s.waiting; }
            document.title = s.waiting ? `(${s.waiting}) ${baseTitle}` : baseTitle;
            if (s.waiting > lastWaiting) {
                D.toast(`Новый клиент ждёт оператора (${s.waiting})`);
                document.dispatchEvent(new CustomEvent('dash:waiting', { detail: s }));
            }
            lastWaiting = s.waiting;
        } catch (_) { }
    }
    if (document.getElementById('nav-waiting')) setInterval(pollSummary, 8000);

    // Мелкие «в разработке» тумблеры, которые запоминаются в браузере
    document.querySelectorAll('[data-pref]').forEach(inp => {
        const key = 'l2a_pref_' + inp.dataset.pref;
        try {
            const v = localStorage.getItem(key);
            if (v !== null) { if (inp.type === 'checkbox') inp.checked = v === '1'; else inp.value = v; }
        } catch (_) { }
        inp.addEventListener('change', () => {
            try { localStorage.setItem(key, inp.type === 'checkbox' ? (inp.checked ? '1' : '0') : inp.value); } catch (_) { }
            D.toast('Настройка сохранена');
        });
    });

    document.addEventListener('DOMContentLoaded', () => D.highlight());
    if (document.readyState !== 'loading') D.highlight();
})();
