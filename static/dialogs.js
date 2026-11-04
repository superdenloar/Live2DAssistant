/* Диалоги: список разговоров, просмотр переписки и ответы живого оператора. */
(function () {
    'use strict';
    const esc = Dash.esc;
    const listEl = document.getElementById('conv-list');
    const thread = document.getElementById('thread');
    const search = document.getElementById('dlg-search');
    let chats = [], filter = 'all', activeId = null, lastMsgId = 0, threadTimer = null;

    const STATUS = {
        ai: { label: 'Ассистент', cls: '' },
        waiting: { label: 'Ждёт оператора', cls: 'pink' },
        operator: { label: 'Оператор', cls: 'mint' },
    };
    const SOURCE = { widget: 'Сайт', studio: 'Студия' };

    function avatarHtml(c) {
        if (c.source === 'widget') {
            const letter = (c.name.match(/#(\w)/) || [, 'П'])[1];
            const hue = (c.id * 47) % 360;
            return `<span class="avatar" style="background:hsl(${hue} 80% 93%);color:hsl(${hue} 50% 35%)">${esc(letter)}</span>`;
        }
        return `<img class="avatar" src="${esc(c.assistant?.photo_url || '')}" alt="">`;
    }

    function counts() {
        const c = { all: chats.length, waiting: 0, operator: 0, ai: 0 };
        chats.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
        document.querySelectorAll('#dlg-filters i[data-c]').forEach(i => { i.textContent = c[i.dataset.c] || ''; });
    }

    function renderList() {
        const q = search.value.trim().toLowerCase();
        const items = chats.filter(c => (filter === 'all' || c.status === filter) &&
            (!q || c.name.toLowerCase().includes(q) || (c.last_message?.content || '').toLowerCase().includes(q) || (c.assistant?.name || '').toLowerCase().includes(q)));
        counts();
        if (!items.length) {
            listEl.innerHTML = `<div class="empty" style="padding:32px 16px"><p>${q ? 'Ничего не нашлось' : filter === 'waiting' ? 'Никто не ждёт оператора — отлично!' : 'Здесь пока пусто'}</p></div>`;
            return;
        }
        listEl.innerHTML = items.map(c => {
            const st = STATUS[c.status] || STATUS.ai;
            const lastRole = c.last_message?.role;
            const prefix = lastRole === 'operator' ? 'Вы: ' : lastRole === 'assistant' ? (c.assistant?.name || 'ИИ') + ': ' : '';
            return `<div class="conv ${c.id === activeId ? 'active' : ''} ${c.status === 'waiting' ? 'waiting' : ''}" data-id="${c.id}" tabindex="0">
                ${avatarHtml(c)}
                <div class="c-main">
                    <div class="c-top"><span class="c-name">${esc(c.name)}</span><span class="c-time">${Dash.timeAgo(c.updated_at)}</span></div>
                    <div class="c-last">${esc(prefix + (c.last_message?.content || 'Нет сообщений'))}</div>
                    <div class="c-meta">
                        ${c.status !== 'ai' ? `<span class="badge ${st.cls}">${c.status === 'waiting' ? '<span class="dot pulse"></span>' : ''}${st.label}</span>` : ''}
                        <span class="badge grey">${SOURCE[c.source] || c.source}</span>
                        <span class="small faint">${esc(c.assistant?.name || '')}</span>
                    </div>
                </div>
                ${c.unread ? `<span class="unread">${c.unread}</span>` : ''}
            </div>`;
        }).join('');
    }

    async function loadList() {
        try { chats = await Dash.api('/api/admin/dialogs'); renderList(); } catch (e) { }
    }

    function msgHtml(m, chat) {
        const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
        if (m.role === 'system') return `<div class="msg system" data-id="${m.id}"><div class="bubble">${esc(m.content)} · ${time}</div></div>`;
        const who = m.role === 'user' ? (chat.source === 'widget' ? 'Посетитель' : 'Вы (тест)') : m.role === 'operator' ? 'Оператор' : (chat.assistant?.name || 'Ассистент');
        return `<div class="msg ${m.role}" data-id="${m.id}"><div class="bubble">${esc(m.content)}</div><div class="meta">${esc(who)} · ${time}</div></div>`;
    }

    function threadHead(c) {
        const st = STATUS[c.status] || STATUS.ai;
        const actions = [];
        if (c.status === 'operator') actions.push(`<button class="btn btn-soft btn-sm" data-act="ai">✦ Вернуть ассистенту</button>`);
        else actions.push(`<button class="btn btn-primary btn-sm" data-act="operator">🎧 Подключиться как оператор</button>`);
        if (c.source === 'studio') actions.push(`<a class="btn btn-ghost btn-sm" href="/studio?chat=${c.id}">Открыть в студии</a>`);
        actions.push(`<button class="btn btn-icon" data-act="delete" title="Удалить диалог" aria-label="Удалить диалог">🗑</button>`);
        let banner = '';
        if (c.status === 'waiting') banner = `<div class="handoff-banner"><span class="dot pulse"></span><b>Клиент ждёт живого человека. Ответьте — и диалог перейдёт к вам.</b></div>`;
        if (c.status === 'operator') banner = `<div class="handoff-banner operator"><b>Вы отвечаете вместо ассистента. Посетитель видит ваши сообщения в виджете.</b></div>`;
        return `<div class="thread-head">
                ${avatarHtml(c)}
                <div class="who"><b>${esc(c.name)}</b><span>${esc(c.assistant?.name || '')} · ${SOURCE[c.source] || c.source} · ${c.messages_count} сообщ.</span></div>
                <span class="badge ${st.cls}">${st.label}</span>
                ${actions.join('')}
            </div>${banner}`;
    }

    const QUICK = ['Здравствуйте! Я оператор, сейчас помогу.', 'Уточните, пожалуйста, номер заказа.', 'Минуту, проверяю информацию.', 'Спасибо за обращение! Хорошего дня.'];

    async function openChat(id) {
        activeId = id; lastMsgId = 0;
        history.replaceState(null, '', '/app/dialogs/' + id);
        renderList();
        thread.innerHTML = '<div class="empty" style="margin:auto"><p>Загружаю…</p></div>';
        let data;
        try { data = await Dash.api(`/api/admin/dialogs/${id}`); }
        catch (e) { thread.innerHTML = `<div class="empty" style="margin:auto"><h3>Диалог не найден</h3><p>${esc(e.message)}</p></div>`; return; }
        const c = data.chat;
        thread.innerHTML = `${threadHead(c)}
            <div class="messages" id="messages">${data.messages.map(m => msgHtml(m, c)).join('') || '<div class="empty"><p>Сообщений пока нет</p></div>'}</div>
            <div class="quick-replies">${QUICK.map(q => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
            <form class="composer" id="composer">
                <textarea id="reply" rows="1" placeholder="${c.status === 'operator' ? 'Ответ от имени оператора…' : 'Напишите — и вы подключитесь как оператор'}"></textarea>
                <button class="btn btn-primary" type="submit">Отправить</button>
            </form>
            <div class="composer-note">Enter — отправить, Shift+Enter — новая строка</div>`;
        lastMsgId = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
        scrollDown();
        bindThread(c);
        const i = chats.findIndex(x => x.id === id);
        if (i >= 0) { chats[i] = c; renderList(); }
        clearInterval(threadTimer);
        threadTimer = setInterval(() => pollThread(c), 2500);
    }

    function scrollDown() { const m = document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight; }

    async function pollThread(c) {
        if (activeId !== c.id) return;
        try {
            const data = await Dash.api(`/api/admin/dialogs/${c.id}?after=${lastMsgId}`);
            if (data.messages.length) {
                const box = document.getElementById('messages');
                box.querySelector('.empty')?.remove();
                data.messages.forEach(m => { if (!box.querySelector(`[data-id="${m.id}"]`)) box.insertAdjacentHTML('beforeend', msgHtml(m, data.chat)); });
                lastMsgId = data.messages[data.messages.length - 1].id;
                scrollDown();
            }
            if (data.chat.status !== c.status) { openChat(c.id); }
        } catch (_) { }
    }

    function bindThread(c) {
        thread.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
            const act = b.dataset.act;
            if (act === 'delete') {
                if (!confirm('Удалить диалог вместе с историей?')) return;
                await Dash.api(`/api/admin/dialogs/${c.id}`, { method: 'DELETE' });
                chats = chats.filter(x => x.id !== c.id); activeId = null;
                thread.innerHTML = '<div class="empty" style="margin:auto"><h3>Диалог удалён</h3></div>';
                renderList(); return;
            }
            await Dash.api(`/api/admin/dialogs/${c.id}/status`, { json: { status: act } });
            Dash.toast(act === 'operator' ? 'Вы подключились к диалогу' : 'Диалог возвращён ассистенту');
            await loadList(); openChat(c.id);
        }));
        const ta = document.getElementById('reply');
        const form = document.getElementById('composer');
        thread.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { ta.value = b.dataset.q; ta.focus(); }));
        ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const text = ta.value.trim(); if (!text) return;
            ta.value = ''; ta.style.height = '';
            try {
                const wasOperator = c.status === 'operator';
                await Dash.api(`/api/admin/dialogs/${c.id}/reply`, { json: { text } });
                if (!wasOperator) { await loadList(); openChat(c.id); } else pollThread(c);
            } catch (err) { Dash.toast(err.message, 'err'); ta.value = text; }
        });
    }

    listEl.addEventListener('click', e => { const el = e.target.closest('.conv'); if (el) openChat(+el.dataset.id); });
    listEl.addEventListener('keydown', e => { if (e.key === 'Enter') { const el = e.target.closest('.conv'); if (el) openChat(+el.dataset.id); } });
    search.addEventListener('input', renderList);
    document.querySelectorAll('#dlg-filters button').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('#dlg-filters button').forEach(x => x.classList.toggle('active', x === b));
        filter = b.dataset.f; renderList();
    }));
    document.addEventListener('dash:waiting', loadList);

    (async () => {
        await loadList();
        const initial = +document.getElementById('inbox').dataset.initial;
        if (initial) openChat(initial);
        else if (chats.length && chats[0].status === 'waiting') openChat(chats[0].id);
        setInterval(loadList, 6000);
    })();
})();
