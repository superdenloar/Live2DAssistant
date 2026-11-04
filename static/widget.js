/**
 * Live2D Assistant — виджет для любого сайта.
 *
 * <script src="http://127.0.0.1:5000/static/widget.js"
 *         data-server="http://127.0.0.1:5000"
 *         data-assistant-id="1"></script>
 *
 * Режимы: popup — классическое полупрозрачное окно с персонажем на фоне,
 *         card  — карточка: персонаж сверху, чат снизу,
 *         novel — визуальная новелла: персонаж стоит поверх сайта, диалоговое окно внизу.
 * Необязательно: data-open="true", data-mode="popup|card|novel".
 * Контекст страницы: window.__ASSISTANT_CONTEXT__ = () => ({ ... })
 * JS API: window.LW.open() / close() / ask(text) / say(text) / setContext(obj) / callOperator() / on(event, fn)
 */
(function () {
    'use strict';
    if (window.LW && window.LW.__ready) return;

    const script = document.currentScript;
    const SERVER = (script?.getAttribute('data-server') || 'http://127.0.0.1:5000').replace(/\/$/, '');
    const ASSISTANT_ID = script?.getAttribute('data-assistant-id') || '1';
    const OPEN_ON_LOAD = script?.getAttribute('data-open') === 'true';
    const PREVIEW = script?.getAttribute('data-preview') === 'true';
    const FORCE_MODE = script?.getAttribute('data-mode');
    const SESSION_KEY = 'l2a_session_' + ASSISTANT_ID;
    let sessionId;
    try {
        sessionId = PREVIEW ? 'preview' : localStorage.getItem(SESSION_KEY);
        if (!sessionId) { sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); localStorage.setItem(SESSION_KEY, sessionId); }
    } catch (_) { sessionId = 'anon-' + Date.now(); }

    // Расположение и размеры по умолчанию (переопределяются в редакторе ассистента)
    const DEFAULT_LAYOUT = {
        popup: { side: 'right', width: 380, height: 560, offset_x: 24, offset_y: 24, model_scale: 1, model_x: 0, model_y: 0 },
        card: { side: 'right', width: 380, height: 620, offset_x: 24, offset_y: 24, stage_height: 230, model_scale: 1, model_x: 0, model_y: 0 },
        novel: { side: 'right', char_height: 92, char_width: 46, char_x: 2, char_bottom: 0, model_scale: 1, model_x: 0, model_y: 0,
            box_width: 72, box_max: 1100, box_height: 190, box_bottom: 20, box_opacity: 0.86, dim: 0.15, typewriter: true, speed: 28 },
        trigger: { side: 'right', size: 64, offset_x: 24, offset_y: 24 },
    };
    const mergeLayout = (l) => {
        const out = {};
        for (const k in DEFAULT_LAYOUT) out[k] = Object.assign({}, DEFAULT_LAYOUT[k], (l && l[k]) || {});
        return out;
    };

    // ── Состояние ──
    let cfg = null, mode = 'popup', avatarType = 'live2d', layout = mergeLayout({});
    let live2dApp = null, live2dModel = null, gifAvatar = null, model3d = null;
    let audioCtx = null, analyser = null, lipRunning = false;
    let isOpen = false, isMuted = false, isHidden = false, isSending = false, isRecording = false;
    let mediaRecorder = null, chunks = [];
    let boredomTimer = null, pollTimer = null, slowPoll = null;
    let status = 'ai', lastId = 0, showingHistory = false;
    let isPatting = false, isFollowing = false;
    let target = base(), cur = base();
    let staticContext = null, typeTimer = null, typeFull = '';
    const listeners = {};
    function base() { return { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 }; }
    const emit = (ev, data) => (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.warn('[Widget]', e); } });

    const ICON = {
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
        mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
        sound: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
        mute: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="m22 9-6 6M16 9l6 6"/>',
        eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/>',
        history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
        chat: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.5-4.6A8 8 0 1 1 21 12Z"/>',
        headset: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2Zm-18 0a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2Z"/><path d="M18 17v1a3 3 0 0 1-3 3h-3"/>',
    };
    const svg = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
    const clean = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/【.*?】/g, '').trim();
    const $ = id => document.getElementById(id);

    // ── Загрузка ──
    function loadCSS() {
        if (document.querySelector('link[data-l2a]')) return;
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.dataset.l2a = '1';
        l.href = SERVER + '/static/widget.css'; document.head.appendChild(l);
    }
    function loadScript(src) {
        return new Promise((ok, fail) => {
            if (document.querySelector(`script[src="${src}"]`)) { ok(); return; }
            const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s);
        });
    }
    async function loadConfig() {
        try {
            const r = await fetch(SERVER + '/api/widget/config/' + ASSISTANT_ID);
            if (!r.ok) throw new Error(r.status);
            cfg = await r.json();
        } catch (e) {
            console.warn('[Widget] Не удалось загрузить настройки ассистента:', e);
            cfg = { id: ASSISTANT_ID, name: 'Ассистент', avatar_type: 'text', greeting_phrase: 'Привет! Чем могу помочь?', widget_primary_color: '#6E56F8' };
        }
        avatarType = cfg.avatar_type || 'live2d';
        if (avatarType === 'live2d' && !cfg.live2d_model_path) avatarType = 'text';
        layout = mergeLayout(cfg.widget_layout);
        mode = FORCE_MODE || cfg.widget_mode || 'popup';
        if (!['popup', 'card', 'novel'].includes(mode)) mode = 'popup';
        if (avatarType === 'text' && mode !== 'card') mode = 'card';
    }

    // ── DOM ──
    function toolsHtml() {
        return `<button class="lw-ico" id="lw-op-btn" title="Позвать оператора" aria-label="Позвать оператора">${svg('headset')}</button>
            ${mode === 'novel' ? `<button class="lw-ico" id="lw-history-btn" title="История" aria-label="История">${svg('history')}</button>` : ''}
            <button class="lw-ico" id="lw-mute-btn" title="Звук" aria-label="Звук">${svg('sound')}</button>
            ${avatarType !== 'text' ? `<button class="lw-ico" id="lw-hide-btn" title="Скрыть персонажа" aria-label="Скрыть персонажа">${svg('eye')}</button>` : ''}
            <button class="lw-ico lw-x" id="lw-close-btn" title="Свернуть" aria-label="Свернуть">${svg('close')}</button>`;
    }
    const inputHtml = () => `<form class="lw-input" id="lw-form">
            <button type="button" class="lw-ico" id="lw-rec-btn" title="Голосовое сообщение" aria-label="Голосовое сообщение">${svg('mic')}</button>
            <input id="lw-input" type="text" placeholder="Напишите сообщение…" autocomplete="off" aria-label="Сообщение">
            <button type="submit" class="lw-send" aria-label="Отправить">${svg('send', 17)}</button>
        </form>`;

    function build() {
        document.getElementById('lw-root')?.remove();
        document.getElementById('lw-trigger')?.remove();
        document.getElementById('lw-teaser')?.remove();
        if (model3d) { model3d.destroy(); model3d = null; }
        live2dApp = null; live2dModel = null; gifAvatar = null; avatarInited = false;

        const root = document.createElement('div');
        root.id = 'lw-root'; root.dataset.mode = mode; root.dataset.avatar = avatarType; root.dataset.status = status;
        root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Чат с ассистентом ' + (cfg.name || ''));
        const photo = cfg.photo_url ? SERVER + cfg.photo_url : '';
        const avatarImg = photo ? `<img class="lw-avatar" src="${photo}" alt="">` : '<span class="lw-avatar lw-avatar-ph"></span>';
        const stage = avatarType !== 'text' ? '<div class="lw-stage" id="lw-stage"><canvas id="lw-canvas"></canvas></div>' : '';

        if (mode === 'novel') {
            root.innerHTML = `
                <div class="lw-dim"></div>
                ${stage}
                <div class="lw-vn-box" id="lw-vn-box">
                    <div class="lw-plate"><span class="lw-name"></span><span class="lw-status" id="lw-status"><i></i>онлайн</span></div>
                    <div class="lw-tools">${toolsHtml()}</div>
                    <div class="lw-banner" id="lw-banner" hidden></div>
                    <div class="lw-vn" id="lw-vn" aria-live="polite"></div>
                    <span class="lw-next" id="lw-next">▼</span>
                    <div class="lw-ctx" id="lw-ctx" hidden></div>
                    ${inputHtml()}
                </div>
                <div class="lw-backlog lw-hidden" id="lw-backlog">
                    <div class="lw-backlog-head"><b>История разговора</b><button class="lw-ico" id="lw-backlog-close" aria-label="Закрыть историю">${svg('close')}</button></div>
                    <div class="lw-messages" id="lw-messages"></div>
                </div>`;
        } else {
            root.innerHTML = `
                ${stage}
                <div class="lw-card">
                    <div class="lw-head" id="lw-head">
                        ${avatarImg}
                        <div class="lw-who"><b class="lw-name"></b><span class="lw-status" id="lw-status"><i></i>онлайн</span></div>
                        <div class="lw-tools">${toolsHtml()}</div>
                    </div>
                    <div class="lw-banner" id="lw-banner" hidden></div>
                    <div class="lw-messages" id="lw-messages"></div>
                    <div class="lw-ctx" id="lw-ctx" hidden></div>
                    ${inputHtml()}
                </div>`;
        }
        document.body.appendChild(root);
        root.querySelectorAll('.lw-name').forEach(n => n.textContent = cfg.name || 'Ассистент');

        const trigger = document.createElement('button');
        trigger.id = 'lw-trigger'; trigger.className = 'lw-trigger';
        trigger.setAttribute('aria-label', 'Открыть чат с ассистентом');
        trigger.innerHTML = (photo ? `<img src="${photo}" alt="">` : svg('chat', 26)) + '<i class="lw-online"></i>';
        document.body.appendChild(trigger);

        const teaser = document.createElement('div');
        teaser.id = 'lw-teaser'; teaser.className = 'lw-teaser';
        teaser.textContent = clean(cfg.greeting_phrase) || 'Привет! Чем могу помочь?';
        document.body.appendChild(teaser);

        const vars = { '--lw-primary': cfg.widget_primary_color || '#6E56F8', '--lw-bg': cfg.widget_bg_color || 'rgba(15,15,30,.92)',
            '--lw-text': cfg.widget_text_color || '#E0E0F0', '--lw-user': cfg.widget_user_bubble_color || cfg.widget_primary_color || '#6E56F8' };
        [root, trigger, teaser].forEach(el => Object.entries(vars).forEach(([k, v]) => el.style.setProperty(k, v)));
        applyLayout();

        trigger.addEventListener('click', toggle);
        teaser.addEventListener('click', open);
        $('lw-close-btn').addEventListener('click', close);
        $('lw-form').addEventListener('submit', e => { e.preventDefault(); const i = $('lw-input'); const t = i.value.trim(); if (t) { i.value = ''; ask(t); } });
        $('lw-mute-btn').addEventListener('click', () => { isMuted = !isMuted; $('lw-mute-btn').innerHTML = svg(isMuted ? 'mute' : 'sound'); });
        $('lw-hide-btn')?.addEventListener('click', () => { isHidden = !isHidden; root.classList.toggle('lw-no-avatar', isHidden); $('lw-hide-btn').innerHTML = svg(isHidden ? 'eyeOff' : 'eye'); });
        $('lw-history-btn')?.addEventListener('click', toggleHistory);
        $('lw-backlog-close')?.addEventListener('click', toggleHistory);
        $('lw-rec-btn').addEventListener('click', toggleRecording);
        $('lw-op-btn').addEventListener('click', () => status === 'ai' ? callOperator() : cancelOperator());
        // Новелла: клик по тексту — дописать фразу сразу
        $('lw-vn')?.addEventListener('click', finishTyping);

        if (mode !== 'novel') enableDrag(root, $('lw-head'));
        if (!PREVIEW && !OPEN_ON_LOAD) {
            try {
                if (!sessionStorage.getItem('l2a_teased_' + ASSISTANT_ID)) {
                    setTimeout(() => { if (!isOpen) teaser.classList.add('show'); sessionStorage.setItem('l2a_teased_' + ASSISTANT_ID, '1'); }, 2500);
                    setTimeout(() => teaser.classList.remove('show'), 11000);
                }
            } catch (_) { }
        }
    }

    // Размеры и позиция из настроек — через CSS-переменные, без пересборки
    function applyLayout() {
        const root = $('lw-root'), trigger = $('lw-trigger'), teaser = $('lw-teaser');
        if (!root) return;
        const L = layout[mode], T = layout.trigger;
        const set = (el, k, v) => el && el.style.setProperty(k, v);
        root.dataset.side = L.side || 'right';
        if (mode === 'novel') {
            set(root, '--vn-char-h', L.char_height + 'vh');
            set(root, '--vn-char-w', L.char_width + 'vw');
            set(root, '--vn-char-x', L.char_x + 'vw');
            set(root, '--vn-char-b', L.char_bottom + 'px');
            set(root, '--vn-box-w', L.box_width + 'vw');
            set(root, '--vn-box-max', L.box_max + 'px');
            set(root, '--vn-box-h', L.box_height + 'px');
            set(root, '--vn-box-b', L.box_bottom + 'px');
            set(root, '--vn-box-op', L.box_opacity);
            set(root, '--vn-dim', L.dim);
        } else {
            set(root, '--lw-w', L.width + 'px');
            set(root, '--lw-h', L.height + 'px');
            set(root, '--lw-ox', L.offset_x + 'px');
            set(root, '--lw-oy', L.offset_y + 'px');
            if (mode === 'card') set(root, '--lw-stage-h', L.stage_height + 'px');
            root.style.left = root.style.top = ''; // сбрасываем перетаскивание
        }
        [trigger, teaser].forEach(el => {
            if (!el) return;
            el.dataset.side = T.side || 'right';
            set(el, '--lw-t-size', T.size + 'px');
            set(el, '--lw-t-ox', T.offset_x + 'px');
            set(el, '--lw-t-oy', T.offset_y + 'px');
        });
        requestAnimationFrame(fit);
        if (gifAvatar) gifAvatar.update(gifCfg());
        if (model3d) model3d.update(m3Cfg());
    }

    function enableDrag(root, handle) {
        if (!handle) return;
        let drag = null;
        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            const r = root.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            root.style.transition = 'none';
        });
        addEventListener('mousemove', e => {
            if (!drag) return;
            root.style.left = Math.max(0, Math.min(innerWidth - 120, e.clientX - drag.x)) + 'px';
            root.style.top = Math.max(0, Math.min(innerHeight - 80, e.clientY - drag.y)) + 'px';
            root.style.right = 'auto'; root.style.bottom = 'auto';
        });
        addEventListener('mouseup', () => { if (drag) { drag = null; root.style.transition = ''; } });
    }

    // ── Открытие ──
    function open() {
        if (isOpen) return;
        isOpen = true;
        $('lw-root').classList.add('open');
        $('lw-trigger').classList.add('hidden');
        $('lw-teaser').classList.remove('show');
        initAvatar();
        updateCtx();
        startBoredom();
        if (!PREVIEW) { clearInterval(slowPoll); slowPoll = setInterval(poll, 9000); }
        if (!PREVIEW) setTimeout(() => $('lw-input')?.focus(), 250);
        emit('open');
    }
    function close() {
        if (!isOpen) return;
        isOpen = false;
        $('lw-root').classList.remove('open');
        $('lw-trigger').classList.remove('hidden');
        clearTimeout(boredomTimer); clearInterval(slowPoll);
        emit('close');
    }
    function toggle() { isOpen ? close() : open(); }
    function toggleHistory() {
        showingHistory = !showingHistory;
        $('lw-backlog')?.classList.toggle('lw-hidden', !showingHistory);
        if (showingHistory) scrollDown();
    }

    // ── Сообщения ──
    function addMsg(text, role, opts = {}) {
        const box = $('lw-messages');
        const d = document.createElement('div');
        d.className = 'lw-msg ' + role;
        if (role === 'operator') d.innerHTML = '<span class="lw-op-label">Оператор</span>';
        if (mode === 'novel' && (role === 'assistant' || role === 'user')) d.innerHTML = `<span class="lw-op-label">${role === 'user' ? 'Вы' : (cfg.name || 'Ассистент')}</span>`;
        const body = document.createElement('span'); body.textContent = role === 'assistant' ? clean(text) || text : text;
        d.appendChild(body);
        box.appendChild(d); scrollDown();
        if (mode === 'novel' && (role === 'assistant' || role === 'operator' || opts.vn)) setVN(text, role);
        return d;
    }
    function scrollDown() { const b = $('lw-messages'); if (b) b.scrollTop = b.scrollHeight; }

    // Новелла: текст печатается по буквам, клик — дописать сразу
    function setVN(text, role = 'assistant') {
        const vn = $('lw-vn'); if (!vn) return;
        clearInterval(typeTimer);
        vn.dataset.role = role;
        const plate = $('lw-root').querySelector('.lw-plate .lw-name');
        if (plate) plate.textContent = role === 'operator' ? 'Оператор' : (cfg.name || 'Ассистент');
        typeFull = role === 'assistant' ? clean(text) || text : text;
        const L = layout.novel;
        $('lw-next')?.classList.remove('on');
        if (!L.typewriter || PREVIEW) { vn.textContent = typeFull; $('lw-next')?.classList.add('on'); return; }
        let i = 0; vn.textContent = '';
        typeTimer = setInterval(() => {
            i += 1; vn.textContent = typeFull.slice(0, i);
            if (i >= typeFull.length) finishTyping();
        }, Math.max(5, L.speed || 28));
    }
    function finishTyping() {
        clearInterval(typeTimer);
        const vn = $('lw-vn'); if (vn && typeFull) vn.textContent = typeFull;
        $('lw-next')?.classList.add('on');
    }
    function thinking(on) {
        $('lw-root').classList.toggle('lw-thinking', on);
        if (mode === 'novel') {
            if (on) { clearInterval(typeTimer); const vn = $('lw-vn'); vn.dataset.role = 'assistant'; vn.innerHTML = '<span class="lw-dots"><i></i><i></i><i></i></span>'; $('lw-next')?.classList.remove('on'); }
            return;
        }
        let t = $('lw-typing');
        if (on && !t) { t = document.createElement('div'); t.id = 'lw-typing'; t.className = 'lw-msg assistant'; t.innerHTML = '<span class="lw-dots"><i></i><i></i><i></i></span>'; $('lw-messages').appendChild(t); scrollDown(); }
        if (!on && t) t.remove();
    }

    // ── Контекст страницы ──
    function getContext() {
        if (staticContext) return staticContext;
        const c = window.__ASSISTANT_CONTEXT__;
        if (typeof c === 'function') { try { return c() || {}; } catch (_) { return {}; } }
        return (c && typeof c === 'object') ? c : {};
    }
    function updateCtx() {
        const ctx = getContext(), el = $('lw-ctx');
        const keys = Object.keys(ctx || {});
        el.hidden = !keys.length;
        if (keys.length) el.textContent = 'Вижу страницу: ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '');
    }

    // ── Отправка ──
    async function ask(text, voiceBlob) {
        if (isSending) return null;
        isSending = true;
        clearTimeout(boredomTimer);
        if (text) addMsg(text, 'user'); else addMsg('🎤 Голосовое сообщение', 'user');
        updateCtx();
        emit('message', { role: 'user', text });
        if (status === 'ai') thinking(true);
        try {
            let r;
            if (voiceBlob) {
                const fd = new FormData();
                fd.append('audio_blob', voiceBlob, 'voice.webm'); fd.append('assistant_id', ASSISTANT_ID);
                fd.append('session_id', sessionId); fd.append('game_context', JSON.stringify(getContext()));
                r = await fetch(SERVER + '/api/bridge/chat', { method: 'POST', body: fd });
            } else {
                r = await fetch(SERVER + '/api/bridge/chat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assistant_id: parseInt(ASSISTANT_ID, 10), session_id: sessionId, message: text, game_context: getContext() }),
                });
            }
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || ('ошибка ' + r.status));
            thinking(false);
            lastId = Math.max(lastId, d.ai_message_id || d.user_message_id || 0);
            if (d.status && d.status !== status) setStatus(d.status);
            if (d.ai_text) {
                addMsg(d.ai_text, 'assistant');
                runCommands(d.ai_text);
                if (d.audio_url) playAudio(SERVER + d.audio_url); else fakeTalk(clean(d.ai_text));
                emit('message', { role: 'assistant', text: clean(d.ai_text) });
            } else if (status !== 'ai' && mode === 'novel') {
                setVN(status === 'waiting' ? 'Сообщение передано. Оператор скоро ответит.' : 'Оператор получил сообщение.', 'system');
            }
            return { text: clean(d.ai_text), audio_url: d.audio_url ? SERVER + d.audio_url : '', status: d.status || status };
        } catch (e) {
            thinking(false);
            addMsg('Не получилось отправить: ' + e.message, 'system', { vn: true });
            return null;
        } finally { isSending = false; startBoredom(); }
    }

    async function say(text) {
        if (!text) return;
        addMsg(text, 'assistant');
        runCommands(text);
        if (isMuted) return;
        try {
            const r = await fetch(SERVER + '/api/widget/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistant_id: cfg.id, text }) });
            const d = await r.json();
            if (d.audio_url) playAudio(SERVER + d.audio_url); else fakeTalk(text);
        } catch (_) { fakeTalk(text); }
    }

    // ── Оператор ──
    function setStatus(s) {
        status = s;
        const st = $('lw-status'), banner = $('lw-banner'), btn = $('lw-op-btn');
        $('lw-root').dataset.status = s;
        if (s === 'ai') { st.innerHTML = '<i></i>онлайн'; banner.hidden = true; btn.title = 'Позвать оператора'; btn.classList.remove('on'); }
        if (s === 'waiting') { st.innerHTML = '<i></i>ищем оператора…'; banner.hidden = false; banner.innerHTML = 'Подключаем живого оператора. Можно писать — он увидит всё сообщение. <button type="button" id="lw-cancel-op">Отменить</button>'; btn.classList.add('on'); btn.title = 'Вернуться к ассистенту'; }
        if (s === 'operator') { st.innerHTML = '<i></i>на связи оператор'; banner.hidden = false; banner.innerHTML = 'Вам отвечает оператор поддержки.'; btn.classList.add('on'); btn.title = 'Вернуться к ассистенту'; }
        $('lw-cancel-op')?.addEventListener('click', cancelOperator);
        clearInterval(pollTimer);
        if (s !== 'ai') pollTimer = setInterval(poll, 2500);
        emit('status', s);
    }
    async function callOperator() {
        try {
            const r = await fetch(SERVER + '/api/widget/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistant_id: parseInt(ASSISTANT_ID, 10), session_id: sessionId }) });
            const d = await r.json();
            lastId = Math.max(lastId, (d.last_id || 0));
            setStatus(d.status || 'waiting');
            addMsg('Вы позвали оператора', 'system', { vn: true });
        } catch (e) { addMsg('Не удалось позвать оператора', 'system', { vn: true }); }
    }
    async function cancelOperator() {
        try {
            const r = await fetch(SERVER + '/api/widget/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistant_id: parseInt(ASSISTANT_ID, 10), session_id: sessionId, cancel: true }) });
            const d = await r.json(); lastId = Math.max(lastId, d.last_id || 0);
            setStatus('ai'); addMsg('Снова отвечает ' + (cfg.name || 'ассистент'), 'system', { vn: true });
        } catch (_) { }
    }
    async function poll() {
        try {
            const r = await fetch(`${SERVER}/api/widget/poll?assistant_id=${ASSISTANT_ID}&session_id=${encodeURIComponent(sessionId)}&after=${lastId}`);
            const d = await r.json();
            (d.messages || []).forEach(m => {
                if (m.role === 'operator') { addMsg(m.content, 'operator'); emit('message', { role: 'operator', text: m.content }); ping(); }
                else if (m.role === 'system') addMsg(m.content, 'system');
            });
            lastId = Math.max(lastId, d.last_id || 0);
            if (d.status && d.status !== status) setStatus(d.status);
        } catch (_) { }
    }
    function ping() {
        if (isMuted) return;
        try {
            ensureAudio();
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.frequency.value = 880; g.gain.setValueAtTime(0.06, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
            o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.25);
        } catch (_) { }
    }

    async function loadHistory() {
        const greet = cfg.greeting_phrase || 'Привет! Чем могу помочь?';
        if (PREVIEW) {
            addMsg('Здравствуйте! Есть доставка в Казань?', 'user');
            addMsg(greet, 'assistant');
            return;
        }
        try {
            const r = await fetch(`${SERVER}/api/widget/history?assistant_id=${ASSISTANT_ID}&session_id=${encodeURIComponent(sessionId)}`);
            const d = await r.json();
            const msgs = (d.messages || []).filter(m => m.role !== 'system');
            if (msgs.length) msgs.forEach(m => addMsg(m.content, m.role));
            else addMsg(greet, 'assistant');
            lastId = d.last_id || 0;
            if (d.status && d.status !== 'ai') setStatus(d.status);
        } catch (_) { addMsg(greet, 'assistant'); }
    }

    // ── Голосовой ввод ──
    async function toggleRecording() {
        const btn = $('lw-rec-btn');
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' }); chunks = [];
                mediaRecorder.ondataavailable = e => chunks.push(e.data);
                mediaRecorder.onstop = () => { const b = new Blob(chunks, { type: 'audio/webm' }); stream.getTracks().forEach(t => t.stop()); if (b.size) ask('', b); };
                mediaRecorder.start(); isRecording = true; btn.classList.add('rec'); btn.innerHTML = svg('stop');
            } catch (e) { addMsg('Нет доступа к микрофону', 'system', { vn: true }); }
        } else {
            mediaRecorder.stop(); isRecording = false; btn.classList.remove('rec'); btn.innerHTML = svg('mic');
        }
    }

    // ── Команды движений ──
    const CMD = {
        'Посмотреть влево': 'LOOK_LEFT', 'Посмотреть вправо': 'LOOK_RIGHT', 'Посмотреть вверх': 'LOOK_UP', 'Посмотреть вниз': 'LOOK_DOWN',
        'Слежу за курсором': 'FOLLOW_CURSOR', 'Голова влево': 'HEAD_TILT_LEFT', 'Голова вправо': 'HEAD_TILT_RIGHT',
        'Закрыть левый глаз': 'CLOSE_LEFT_EYE', 'Закрыть правый глаз': 'CLOSE_RIGHT_EYE', 'Киваю головой': 'NOD_HEAD', 'Махаю головой': 'SHAKE_HEAD',
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function runCommands(text) {
        const found = (String(text).match(/【(.*?)】/g) || []).map(m => CMD[m.slice(1, -1).trim()]).filter(Boolean);
        if (!found.length) return;
        if (gifAvatar) { found.forEach(c => gifAvatar.command(c)); return; }
        if (model3d) { found.forEach(c => model3d.command(c)); return; }
        if (!live2dModel?.internalModel) return;
        target = base(); isFollowing = false;
        for (const c of found) {
            if (c === 'NOD_HEAD') { (async () => { for (const y of [30, -20, 25, 0]) { target.ParamAngleY = y; await sleep(380); } })(); continue; }
            if (c === 'SHAKE_HEAD') { (async () => { for (const x of [-30, 30, -20, 0]) { target.ParamAngleX = x; await sleep(320); } })(); continue; }
            if (c === 'FOLLOW_CURSOR') isFollowing = true;
            if (c === 'LOOK_LEFT') target.ParamAngleX = -30;
            if (c === 'LOOK_RIGHT') target.ParamAngleX = 30;
            if (c === 'LOOK_UP') target.ParamAngleY = 30;
            if (c === 'LOOK_DOWN') target.ParamAngleY = -30;
            if (c === 'HEAD_TILT_LEFT') target.ParamAngleZ = -30;
            if (c === 'HEAD_TILT_RIGHT') target.ParamAngleZ = 30;
            if (c === 'CLOSE_LEFT_EYE') target.ParamEyeLOpen = 0;
            if (c === 'CLOSE_RIGHT_EYE') target.ParamEyeROpen = 0;
        }
        clearTimeout(runCommands._t);
        runCommands._t = setTimeout(() => { target = base(); }, 7000);
    }

    // ── Инициатива ──
    function startBoredom() {
        clearTimeout(boredomTimer);
        if (PREVIEW || !isOpen || !cfg?.boredom_enabled || status !== 'ai') return;
        const min = (cfg.boredom_min_time || 30) * 1000, max = (cfg.boredom_max_time || 120) * 1000;
        boredomTimer = setTimeout(async () => {
            try {
                const r = await fetch(SERVER + '/boredom_phrase/' + cfg.id);
                if (r.ok) { const d = await r.json(); addMsg(d.text, 'assistant'); runCommands(d.text); if (d.audio_url) playAudio(SERVER + d.audio_url); }
            } catch (_) { }
            startBoredom();
        }, Math.random() * (max - min) + min);
    }

    // ── Звук и губы ──
    function ensureAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
            analyser.connect(audioCtx.destination);
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }
    function playAudio(url) {
        if (isMuted) return;
        try { ensureAudio(); } catch (_) { new Audio(url).play().catch(() => { }); return; }
        const a = new Audio(); a.crossOrigin = 'anonymous'; a.src = url;
        try { audioCtx.createMediaElementSource(a).connect(analyser); } catch (_) { }
        if (gifAvatar) gifAvatar.attachAnalyser(analyser);
        if (model3d) model3d.attachAnalyser(analyser);
        a.onplay = () => { lipRunning = true; lipSync(); };
        a.onended = () => { lipRunning = false; };
        a.play().catch(() => { });
    }
    function lipSync() {
        if (!live2dModel?.internalModel || !analyser) return;
        const cm = live2dModel.internalModel.coreModel;
        if (!lipRunning) { cm.setParameterValueById('ParamMouthOpenY', 0); return; }
        const d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d);
        let s = 0; for (let i = 0; i < d.length; i++) s += d[i];
        const avg = s / d.length;
        const mn = cfg.mouth_min_open ?? 0.05, mx = cfg.mouth_max_open ?? 0.8, js = cfg.mouth_jitter_strength ?? 0.05, jv = cfg.mouth_jitter_speed || 50;
        let m = mn + (avg / 255) * (mx - mn) * 2.2;
        if (avg > 10) m += Math.sin(Date.now() / jv) * js;
        cm.setParameterValueById('ParamMouthOpenY', Math.max(0, Math.min(1, m)));
        requestAnimationFrame(lipSync);
    }
    // Без голоса (TTS выключен) рот всё равно двигается, пока «звучит» реплика
    function fakeTalk(text) {
        if (!text) return;
        const dur = Math.min(6000, 500 + text.length * 55), t0 = performance.now();
        (function step() {
            const t = performance.now() - t0, lvl = t < dur ? Math.abs(Math.sin(t / 85)) * (0.4 + 0.6 * Math.abs(Math.sin(t / 330))) : 0;
            if (gifAvatar) gifAvatar.setLevel(t < dur ? lvl : null);
            if (model3d) model3d.setLevel(t < dur ? lvl : null);
            if (live2dModel?.internalModel) live2dModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', lvl);
            if (t < dur) requestAnimationFrame(step);
        })();
    }

    // ── Аватар ──
    let avatarInited = false;
    function gifCfg() {
        const L = layout[mode];
        return Object.assign({}, cfg.gif || {}, { scale: (cfg.gif?.scale || 1) * (L.model_scale || 1), offset_y: (cfg.gif?.offset_y || 0) - (L.model_y || 0), offset_x: L.model_x || 0, fallback_url: cfg.photo_url || '' });
    }
    function m3Cfg() {
        const L = layout[mode], m = cfg.model3d || {};
        return Object.assign({}, m, { scale: (m.scale || 1) * (L.model_scale || 1), offset_y: (m.offset_y || 0) - (L.model_y || 0) / 4, offset_x: (L.model_x || 0) / 4 });
    }
    async function initAvatar() {
        if (avatarInited) return; avatarInited = true;
        const stage = $('lw-stage');
        if (!stage) return;
        if (avatarType === '3d') {
            try {
                $('lw-canvas')?.remove();
                const mod = await import(SERVER + '/static/model3d_avatar.js');
                model3d = await mod.createModel3DAvatar(stage, m3Cfg(), { base: SERVER });
            } catch (e) { console.warn('[Widget] 3D-аватар не загрузился:', e); }
            return;
        }
        if (avatarType === 'gif') {
            try {
                await loadScript(SERVER + '/static/gif_avatar.js');
                $('lw-canvas')?.remove();
                gifAvatar = new window.GifAvatar(stage, gifCfg(), { base: SERVER });
            } catch (e) { console.warn('[Widget] GIF-аватар не загрузился:', e); }
            return;
        }
        try {
            await loadScript(SERVER + '/static/libs/live2dcubismcore.min.js');
            await loadScript(SERVER + '/static/libs/pixi.min.js');
            await loadScript(SERVER + '/static/libs/cubism4.min.js');
            const canvas = $('lw-canvas');
            live2dApp = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: stage, backgroundAlpha: 0 });
            live2dModel = await PIXI.live2d.Live2DModel.from(SERVER + cfg.live2d_model_path, { autoInteract: false });
            live2dModel.baseH = live2dModel.height;
            live2dApp.stage.addChild(live2dModel);
            fit(); live2dModel.motion('Idle');
            live2dApp.ticker.add(() => {
                if (!live2dModel?.internalModel || isPatting) return;
                const cm = live2dModel.internalModel.coreModel;
                for (const k in target) { cur[k] += (target[k] - cur[k]) * 0.1; cm.setParameterValueById(k, cur[k]); }
            });
            stage.addEventListener('mousemove', e => {
                if (!live2dModel?.internalModel) return;
                const b = stage.getBoundingClientRect();
                if (isFollowing && !isPatting) {
                    target.ParamAngleX = ((e.clientX - b.left) / b.width * 2 - 1) * 30;
                    target.ParamAngleY = -((e.clientY - b.top) / b.height * 2 - 1) * 30;
                }
                if (isPatting) {
                    const tilt = cfg.patting_tilt_angle || 15, eye = cfg.patting_eye_close || 0.8, f = cfg.patting_follow_strength || 0.1;
                    const nx = ((e.clientX - b.left - live2dModel.x) / live2dModel.width) * 2 - 1;
                    const vals = { ParamAngleX: -tilt, ParamBodyAngleX: -tilt / 2, ParamEyeLOpen: 1 - eye, ParamEyeROpen: 1 - eye, ParamAngleZ: nx * tilt * 0.7 * f };
                    const cm = live2dModel.internalModel.coreModel;
                    for (const k in vals) { cm.setParameterValueById(k, vals[k]); cur[k] = vals[k]; }
                }
            });
            stage.addEventListener('mousedown', e => {
                if (!cfg.patting_enabled || !live2dModel?.internalModel) return;
                const b = stage.getBoundingClientRect();
                if (e.clientY - b.top < b.height / 3) { isPatting = true; live2dModel.motionManager.stopAllMotions(); }
            });
            addEventListener('mouseup', () => { if (isPatting) { isPatting = false; live2dModel?.motion('Idle', 0, 3); } });
            addEventListener('resize', fit);
        } catch (e) { console.warn('[Widget] Live2D не загрузился:', e); }
    }
    function fit() {
        if (!live2dModel) return;
        const z = $('lw-stage'); if (!z) return;
        if (live2dApp) live2dApp.resize();
        const L = layout[mode];
        live2dModel.scale.set((z.clientHeight / live2dModel.baseH) * (cfg.scale || 2.4) * (L.model_scale || 1));
        live2dModel.x = z.clientWidth / 2 - live2dModel.width / 2 + (cfg.posX || 0) + (L.model_x || 0);
        live2dModel.y = (cfg.posY ?? 50) + (L.model_y || 0);
    }

    // ── Публичный API ──
    window.LW = {
        __ready: true,
        open, close, toggle,
        ask: (text) => { open(); return ask(String(text || '')); },
        say: (text) => { open(); return say(String(text || '')); },
        setContext: (obj) => { staticContext = obj || null; updateCtx(); },
        callOperator: () => { open(); return callOperator(); },
        on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        /** Для живого предпросмотра в редакторе: новый режим или расположение без перезагрузки. */
        setLayout: async (newLayout, newMode, extra) => {
            if (newLayout) layout = mergeLayout(newLayout);
            // Пересобираем виджет только когда меняется вид, тип аватара, модель, цвета или приветствие;
            // размеры и сдвиги персонажа применяем на лету
            const HEAVY = ['greeting_phrase', 'widget_primary_color', 'widget_user_bubble_color', 'widget_text_color', 'widget_bg_color', 'avatar_type', 'live2d_model_path'];
            const heavy = !!extra && HEAVY.some(k => k in extra && extra[k] !== cfg[k]);
            if (extra) {
                Object.assign(cfg, extra);
                if ('avatar_type' in extra) {
                    avatarType = cfg.avatar_type || 'live2d';
                    if (avatarType === 'live2d' && !cfg.live2d_model_path) avatarType = 'text';
                }
            }
            if (avatarType === 'text' && (newMode || mode) !== 'card') newMode = 'card';
            if ((newMode && newMode !== mode) || heavy) {
                mode = newMode || mode; isOpen = false; showingHistory = false;
                build(); await loadHistory(); open();
            } else applyLayout();
        },
        get status() { return status; },
        get mode() { return mode; },
        get layout() { return layout; },
        get session() { return sessionId; },
    };

    async function boot() {
        loadCSS();
        await loadConfig();
        build();
        await loadHistory();
        emit('ready');
        if (OPEN_ON_LOAD) open();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
