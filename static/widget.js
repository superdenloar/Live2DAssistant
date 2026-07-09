/**
 * Live2D Assistant Widget — Novel + Popup Modes
 *
 * <script src="http://127.0.0.1:5000/static/widget.js"
 *         data-server="http://127.0.0.1:5000"
 *         data-assistant-id="1"></script>
 */
(function () {
    'use strict';

    const currentScript = document.currentScript;
    const SERVER = currentScript?.getAttribute('data-server') || 'http://127.0.0.1:5000';
    const ASSISTANT_ID = currentScript?.getAttribute('data-assistant-id') || '1';
    const SESSION_KEY = 'live2d_widget_session_' + ASSISTANT_ID;
    let sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) { sessionId = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, sessionId); }

    // ── State ──
    let cfg = null, widgetMode = 'novel';
    let live2dApp = null, live2dModel = null, audioContext = null, analyser = null;
    let isLipSyncRunning = false, isPatting = false, pattingTimer = null;
    let boredomTimer = null, isSending = false, isMuted = false;
    let isWidgetOpen = false, isHidden = false, isRecording = false;
    let mediaRecorder = null, audioChunks = [];
    let isDragging = false, dragOffset = { x: 0, y: 0 };
    let isFollowingCursor = false;  // OFF by default! Only via command 【Слежу за курсором】
    let targetParams = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
    let curParams = { ...targetParams };
    let showingHistory = false;

    // ── Load CSS ──
    function loadCSS() {
        const l = document.createElement('link'); l.rel = 'stylesheet';
        l.href = SERVER + '/static/widget.css'; document.head.appendChild(l);
    }

    // ── Load Config ──
    async function loadConfig() {
        try {
            const r = await fetch(SERVER + '/api/widget/config/' + ASSISTANT_ID);
            if (!r.ok) throw 0;
            cfg = await r.json();
            widgetMode = cfg.widget_mode || 'novel';
        } catch (e) {
            cfg = {
                name: 'Ассистент', scale: 2.4, posX: 0, posY: 50, widget_mode: 'novel',
                greeting_phrase: 'Привет!', widget_primary_color: '#667eea',
                widget_text_color: '#e0e0f0', widget_bg_color: 'rgba(15,15,30,0.92)',
                widget_user_bubble_color: '#667eea'
            };
        }
    }

    // ── Apply CSS Variables from config ──
    function applyCSSVars() {
        const root = document.getElementById('lw-root');
        if (!root || !cfg) return;
        root.style.setProperty('--lw-primary', cfg.widget_primary_color || '#667eea');
        root.style.setProperty('--lw-bg', cfg.widget_bg_color || 'rgba(15,15,30,0.92)');
        root.style.setProperty('--lw-text', cfg.widget_text_color || '#e0e0f0');
        root.style.setProperty('--lw-user-bubble', cfg.widget_user_bubble_color || '#667eea');
        // Also set on trigger
        const trigger = document.getElementById('lw-trigger');
        if (trigger) trigger.style.setProperty('--lw-primary', cfg.widget_primary_color || '#667eea');
    }

    // ── Build DOM ──
    function buildWidget() {
        const root = document.createElement('div');
        root.id = 'lw-root';
        root.dataset.mode = widgetMode;
        document.body.appendChild(root);

        if (widgetMode === 'novel') {
            buildNovelMode(root);
        } else {
            buildPopupMode(root);
        }

        // Trigger FAB
        const trigger = document.createElement('button');
        trigger.className = 'lw-trigger'; trigger.id = 'lw-trigger';
        if (cfg?.photo_url) {
            const img = document.createElement('img');
            img.src = SERVER + cfg.photo_url; img.alt = cfg.name || '';
            trigger.appendChild(img);
        } else { trigger.innerHTML = '<span>💬</span>'; }
        document.body.appendChild(trigger);

        applyCSSVars();

        // Events
        trigger.addEventListener('click', toggleWidget);
        document.getElementById('lw-close-btn')?.addEventListener('click', toggleWidget);
        document.getElementById('lw-send-btn')?.addEventListener('click', sendMessage);
        document.getElementById('lw-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
        document.getElementById('lw-mute-btn')?.addEventListener('click', toggleMute);
        document.getElementById('lw-hide-btn')?.addEventListener('click', toggleHide);
        document.getElementById('lw-record-btn')?.addEventListener('click', toggleRecording);
        document.getElementById('lw-history-btn')?.addEventListener('click', toggleHistory);

        // Drag (popup)
        if (widgetMode === 'popup') {
            const hdr = document.getElementById('lw-header');
            if (hdr) {
                hdr.style.cursor = 'grab';
                hdr.addEventListener('mousedown', startDrag);
                document.addEventListener('mousemove', onDrag);
                document.addEventListener('mouseup', stopDrag);
            }
        }
    }

    // ── NOVEL MODE BUILD (VN-style) ──
    function buildNovelMode(root) {
        root.innerHTML = `
            <!-- Live2D fills the whole panel -->
            <div class="lw-live2d-zone" id="lw-live2d-zone">
                <canvas id="lw-canvas"></canvas>
            </div>
            <!-- VN dialog box at bottom -->
            <div class="lw-vn-dialog" id="lw-vn-dialog">
                <div class="lw-vn-header">
                    <div class="lw-vn-name-plate">
                        <img class="lw-avatar" id="lw-avatar" src="" alt="">
                        <span class="lw-name" id="lw-name"></span>
                    </div>
                    <div class="lw-header-buttons">
                        <div class="lw-context-badge" id="lw-context-badge" style="display:none">📊</div>
                        <button class="lw-btn-icon" id="lw-history-btn" title="История">📜</button>
                        <button class="lw-btn-icon" id="lw-mute-btn" title="Звук">🔊</button>
                        <button class="lw-btn-icon" id="lw-hide-btn" title="Скрыть модель">👁</button>
                        <button class="lw-btn-icon lw-close-btn" id="lw-close-btn" title="Закрыть">✕</button>
                    </div>
                </div>
                <!-- Latest message text (VN style) -->
                <div class="lw-vn-text" id="lw-vn-text"></div>
                <!-- Hidden full history -->
                <div class="lw-messages lw-hidden" id="lw-messages"></div>
                <!-- Input -->
                <div class="lw-input-area">
                    <button class="lw-btn-icon lw-record-btn" id="lw-record-btn" title="Голос">🎙</button>
                    <input class="lw-input" id="lw-input" type="text" placeholder="Напишите сообщение..." autocomplete="off">
                    <button class="lw-send-btn" id="lw-send-btn">➤</button>
                </div>
            </div>
        `;
        // Fill info
        if (cfg?.photo_url) document.getElementById('lw-avatar').src = SERVER + cfg.photo_url;
        document.getElementById('lw-name').textContent = cfg?.name || 'Ассистент';

        // Show greeting as VN text
        const vnText = document.getElementById('lw-vn-text');
        vnText.textContent = cfg?.greeting_phrase || 'Привет!';
        // Also add to history
        addHistoryMsg(cfg?.greeting_phrase || 'Привет!', 'assistant');
    }

    // ── POPUP MODE BUILD ──
    function buildPopupMode(root) {
        root.innerHTML = `
            <div class="lw-live2d-zone" id="lw-live2d-zone">
                <canvas id="lw-canvas"></canvas>
            </div>
            <div class="lw-chat-zone" id="lw-chat-zone">
                <div class="lw-header" id="lw-header">
                    <img class="lw-avatar" id="lw-avatar" src="" alt="">
                    <div class="lw-header-info">
                        <span class="lw-name" id="lw-name"></span>
                        <span class="lw-status">онлайн</span>
                    </div>
                    <div class="lw-header-buttons">
                        <div class="lw-context-badge" id="lw-context-badge" style="display:none">📊</div>
                        <button class="lw-btn-icon" id="lw-mute-btn" title="Звук">🔊</button>
                        <button class="lw-btn-icon" id="lw-hide-btn" title="Скрыть модель">👁</button>
                        <button class="lw-btn-icon lw-close-btn" id="lw-close-btn" title="Закрыть">✕</button>
                    </div>
                </div>
                <div class="lw-messages" id="lw-messages"></div>
                <div class="lw-input-area">
                    <button class="lw-btn-icon lw-record-btn" id="lw-record-btn" title="Голос">🎙</button>
                    <input class="lw-input" id="lw-input" type="text" placeholder="Напишите сообщение..." autocomplete="off">
                    <button class="lw-send-btn" id="lw-send-btn">➤</button>
                </div>
            </div>
        `;
        if (cfg?.photo_url) document.getElementById('lw-avatar').src = SERVER + cfg.photo_url;
        document.getElementById('lw-name').textContent = cfg?.name || 'Ассистент';
        addMsg(cfg?.greeting_phrase || 'Привет!', 'assistant');
    }

    // ── Toggle Widget ──
    function toggleWidget() {
        isWidgetOpen = !isWidgetOpen;
        const root = document.getElementById('lw-root');
        const trigger = document.getElementById('lw-trigger');
        if (isWidgetOpen) {
            root.classList.add('open'); trigger.classList.add('hidden');
            if (widgetMode === 'novel') document.body.classList.add('lw-novel-active');
            initLive2D(); updateContextBadge(); startBoredomTimer();
        } else {
            root.classList.remove('open'); trigger.classList.remove('hidden');
            if (widgetMode === 'novel') document.body.classList.remove('lw-novel-active');
            if (boredomTimer) clearTimeout(boredomTimer);
        }
    }
    function toggleMute() { isMuted = !isMuted; document.getElementById('lw-mute-btn').textContent = isMuted ? '🔇' : '🔊'; }
    function toggleHide() {
        isHidden = !isHidden;
        const z = document.getElementById('lw-live2d-zone');
        z.style.opacity = isHidden ? '0' : '1';
        z.style.pointerEvents = isHidden ? 'none' : 'auto';
        document.getElementById('lw-hide-btn').textContent = isHidden ? '👁‍🗨' : '👁';
    }
    function toggleHistory() {
        showingHistory = !showingHistory;
        const msgs = document.getElementById('lw-messages');
        const vnText = document.getElementById('lw-vn-text');
        if (showingHistory) { msgs?.classList.remove('lw-hidden'); vnText?.classList.add('lw-hidden'); }
        else { msgs?.classList.add('lw-hidden'); vnText?.classList.remove('lw-hidden'); }
        document.getElementById('lw-history-btn').textContent = showingHistory ? '💬' : '📜';
    }

    // ── Drag (popup) ──
    function startDrag(e) { if (e.target.closest('.lw-btn-icon')) return; isDragging = true; const r = document.getElementById('lw-root').getBoundingClientRect(); dragOffset = { x: e.clientX - r.left, y: e.clientY - r.top }; document.getElementById('lw-root').style.transition = 'none'; }
    function onDrag(e) { if (!isDragging) return; const r = document.getElementById('lw-root'); r.style.left = (e.clientX - dragOffset.x) + 'px'; r.style.top = (e.clientY - dragOffset.y) + 'px'; r.style.right = 'auto'; r.style.bottom = 'auto'; }
    function stopDrag() { if (isDragging) { isDragging = false; document.getElementById('lw-root').style.transition = ''; } }

    // ── Messages ──
    function addMsg(text, role) {
        const c = document.getElementById('lw-messages');
        if (!c) return null;
        const d = document.createElement('div');
        d.className = 'lw-msg ' + ((role === 'assistant' || role === 'ai') ? 'assistant' : role);
        d.textContent = text.replace(/【.*?】/g, '').trim() || text;
        c.appendChild(d); c.scrollTop = c.scrollHeight;
        return d;
    }
    function addHistoryMsg(text, role) {
        addMsg(text, role);
    }

    // ── Update VN text (novel mode) ──
    function updateVNText(text) {
        const vnText = document.getElementById('lw-vn-text');
        if (vnText) vnText.textContent = text.replace(/【.*?】/g, '').trim() || text;
    }

    // ── Game Context ──
    function getGameContext() {
        if (typeof window.__ASSISTANT_CONTEXT__ === 'function') { try { return window.__ASSISTANT_CONTEXT__(); } catch (e) { return {}; } }
        if (typeof window.__ASSISTANT_CONTEXT__ === 'object' && window.__ASSISTANT_CONTEXT__) return window.__ASSISTANT_CONTEXT__;
        return {};
    }
    function updateContextBadge() {
        const ctx = getGameContext(), b = document.getElementById('lw-context-badge');
        const has = ctx && Object.keys(ctx).length > 0;
        b.style.display = has ? 'inline-flex' : 'none';
        if (has) b.textContent = '📊 ' + Object.entries(ctx).map(([k, v]) => `${k}: ${v}`).join(' | ').substring(0, 60);
    }

    // ── Voice Recording ──
    async function toggleRecording() {
        const btn = document.getElementById('lw-record-btn');
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                audioChunks = [];
                mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
                mediaRecorder.onstop = () => { const blob = new Blob(audioChunks, { type: 'audio/webm' }); if (blob.size > 0) sendVoiceMessage(blob); stream.getTracks().forEach(t => t.stop()); };
                mediaRecorder.start(); btn.textContent = '⏹'; btn.classList.add('recording'); isRecording = true;
            } catch (e) { addMsg('Нет доступа к микрофону.', 'system'); }
        } else {
            mediaRecorder.stop(); btn.textContent = '🎙'; btn.classList.remove('recording'); isRecording = false;
        }
    }
    async function sendVoiceMessage(blob) {
        if (isSending) return; isSending = true;
        if (boredomTimer) clearTimeout(boredomTimer);
        addHistoryMsg('🎤 Голосовое...', 'user');
        const fd = new FormData();
        fd.append('audio_blob', blob, 'voice.webm'); fd.append('assistant_id', ASSISTANT_ID);
        fd.append('session_id', sessionId); fd.append('game_context', JSON.stringify(getGameContext()));
        try {
            const r = await fetch(SERVER + '/api/bridge/chat', { method: 'POST', body: fd });
            const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Error');
            const clean = (d.ai_text || '').replace(/【.*?】/g, '').trim();
            if (widgetMode === 'novel') updateVNText(clean || d.ai_text);
            addHistoryMsg(clean || d.ai_text || '...', 'assistant');
            executeLive2DCommands(d.ai_text || '');
            if (d.audio_url && !isMuted) playAudioWithLipSync(SERVER + d.audio_url);
        } catch (e) { if (widgetMode === 'novel') updateVNText('Ошибка: ' + e.message); else addMsg('Ошибка: ' + e.message, 'system'); }
        finally { isSending = false; startBoredomTimer(); }
    }

    // ── Send Message ──
    async function sendMessage() {
        const input = document.getElementById('lw-input');
        const text = input.value.trim(); if (!text || isSending) return;
        input.value = ''; isSending = true;
        if (boredomTimer) clearTimeout(boredomTimer);

        addHistoryMsg(text, 'user');
        updateContextBadge();

        if (widgetMode === 'novel') updateVNText('...');
        const thinkMsg = widgetMode === 'popup' ? addMsg('...', 'assistant') : null;

        try {
            const r = await fetch(SERVER + '/api/bridge/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistant_id: parseInt(ASSISTANT_ID), session_id: sessionId, message: text, game_context: getGameContext() }),
            });
            const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Error');
            const clean = (d.ai_text || '').replace(/【.*?】/g, '').trim();

            if (widgetMode === 'novel') { updateVNText(clean || d.ai_text); addHistoryMsg(clean || d.ai_text || '...', 'assistant'); }
            else if (thinkMsg) thinkMsg.textContent = clean || d.ai_text || '...';

            executeLive2DCommands(d.ai_text || '');
            if (d.audio_url && !isMuted) playAudioWithLipSync(SERVER + d.audio_url);
        } catch (e) {
            const errTxt = 'Ошибка: ' + e.message;
            if (widgetMode === 'novel') updateVNText(errTxt); else if (thinkMsg) { thinkMsg.textContent = errTxt; thinkMsg.className = 'lw-msg system'; }
        } finally { isSending = false; startBoredomTimer(); }
    }

    // ── Live2D Commands 【】 ──
    const CMD = {
        'Посмотреть влево': 'LOOK_LEFT', 'Посмотреть вправо': 'LOOK_RIGHT',
        'Посмотреть вверх': 'LOOK_UP', 'Посмотреть вниз': 'LOOK_DOWN',
        'Слежу за курсором': 'FOLLOW_CURSOR',
        'Голова влево': 'HEAD_TILT_LEFT', 'Голова вправо': 'HEAD_TILT_RIGHT',
        'Закрыть левый глаз': 'CLOSE_LEFT_EYE', 'Закрыть правый глаз': 'CLOSE_RIGHT_EYE',
        'Киваю головой': 'NOD', 'Махаю головой': 'SHAKE',
    };
    function executeLive2DCommands(text) {
        const matches = text.match(/【(.*?)】/g);
        if (!matches || !live2dModel?.internalModel) return;
        targetParams = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
        isFollowingCursor = false; // reset
        for (const m of matches) {
            const cmd = CMD[m.slice(1, -1)];
            if (!cmd) continue;
            if (cmd === 'NOD') { playNod(); continue; }
            if (cmd === 'SHAKE') { playShake(); continue; }
            if (cmd === 'FOLLOW_CURSOR') { isFollowingCursor = true; continue; }
            if (cmd === 'LOOK_LEFT') targetParams.ParamAngleX = -30;
            if (cmd === 'LOOK_RIGHT') targetParams.ParamAngleX = 30;
            if (cmd === 'LOOK_UP') targetParams.ParamAngleY = 30;
            if (cmd === 'LOOK_DOWN') targetParams.ParamAngleY = -30;
            if (cmd === 'HEAD_TILT_LEFT') targetParams.ParamAngleZ = -30;
            if (cmd === 'HEAD_TILT_RIGHT') targetParams.ParamAngleZ = 30;
            if (cmd === 'CLOSE_LEFT_EYE') targetParams.ParamEyeLOpen = 0;
            if (cmd === 'CLOSE_RIGHT_EYE') targetParams.ParamEyeROpen = 0;
        }
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async function playNod() { const o = { ...targetParams }; targetParams.ParamAngleY = 30; await sleep(400); targetParams.ParamAngleY = -20; await sleep(400); targetParams = o; }
    async function playShake() { const o = { ...targetParams }; targetParams.ParamAngleX = -30; await sleep(300); targetParams.ParamAngleX = 30; await sleep(300); targetParams.ParamAngleX = -20; await sleep(300); targetParams = o; }

    // ── Boredom ──
    function startBoredomTimer() {
        if (boredomTimer) clearTimeout(boredomTimer);
        if (!isWidgetOpen || !cfg?.boredom_enabled) return;
        const min = (cfg.boredom_min_time || 30) * 1000, max = (cfg.boredom_max_time || 120) * 1000;
        boredomTimer = setTimeout(triggerBoredom, Math.random() * (max - min) + min);
    }
    async function triggerBoredom() {
        try {
            const r = cfg.boredom_use_llm
                ? await fetch(SERVER + '/boredom_phrase/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistant_id: cfg.id, chat_id: null }) })
                : await fetch(SERVER + '/boredom_phrase/' + cfg.id);
            if (!r.ok) return;
            const d = await r.json();
            if (widgetMode === 'novel') updateVNText(d.text);
            addHistoryMsg(d.text, 'assistant');
            executeLive2DCommands(d.text);
            if (d.audio_url && !isMuted) playAudioWithLipSync(SERVER + d.audio_url);
        } catch (e) { } finally { startBoredomTimer(); }
    }

    // ── Audio + Lip-sync ──
    function playAudioWithLipSync(url) {
        if (isMuted) return;
        if (!live2dModel) { new Audio(url).play().catch(() => { }); return; }
        if (!audioContext) { try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; } catch (e) { return; } }
        const a = new Audio(url); a.crossOrigin = 'anonymous';
        const src = audioContext.createMediaElementSource(a); src.connect(analyser); analyser.connect(audioContext.destination);
        a.play().catch(() => { });
        a.onplay = () => { isLipSyncRunning = true; lipSync(); };
        a.onended = () => { isLipSyncRunning = false; if (live2dModel?.internalModel) live2dModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0); };
    }
    function lipSync() {
        if (!isLipSyncRunning || !live2dModel?.internalModel || !analyser) return;
        const d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d);
        let s = 0; for (let i = 0; i < d.length; i++) s += d[i];
        live2dModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', Math.min(1, (s / d.length / 128) * 1.5));
        requestAnimationFrame(lipSync);
    }

    // ── Live2D Init ──
    let inited = false;
    async function initLive2D() {
        if (inited || !cfg?.live2d_model_path) return; inited = true;
        try {
            await loadScript(SERVER + '/static/libs/live2dcubismcore.min.js');
            await loadScript(SERVER + '/static/libs/pixi.min.js');
            await loadScript(SERVER + '/static/libs/cubism4.min.js');
            const canvas = document.getElementById('lw-canvas'), zone = document.getElementById('lw-live2d-zone');
            if (!canvas || !zone) return;
            live2dApp = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: zone, backgroundColor: 0x000000, backgroundAlpha: 0 });
            live2dModel = await PIXI.live2d.Live2DModel.from(SERVER + cfg.live2d_model_path);
            live2dApp.stage.addChild(live2dModel);
            updateModelTransform();
            live2dModel.motion('Idle');

            // Ticker
            live2dApp.ticker.add(() => {
                if (!live2dModel?.internalModel || isPatting) return;
                for (const k in targetParams) { curParams[k] = (curParams[k] ?? targetParams[k]) + (targetParams[k] - (curParams[k] ?? 0)) * 0.1; }
                const cm = live2dModel.internalModel.coreModel;
                for (const k in curParams) cm.setParameterValueById(k, curParams[k]);
            });

            // Mouse — follows ONLY if isFollowingCursor is true
            zone.addEventListener('mousemove', e => {
                if (!live2dModel?.internalModel) return;
                if (isFollowingCursor && !isPatting) {
                    const b = zone.getBoundingClientRect();
                    targetParams.ParamAngleX = (((e.clientX - b.left) / b.width) * 2 - 1) * 30;
                    targetParams.ParamAngleY = (((e.clientY - b.top) / b.height) * 2 - 1) * -30;
                }
                if (isPatting) {
                    const tilt = cfg.patting_tilt_angle || 15, eye = cfg.patting_eye_close || 0.8, f = cfg.patting_follow_strength || 0.1;
                    const b = zone.getBoundingClientRect(), nx = ((e.clientX - b.left - live2dModel.x) / live2dModel.width) * 2 - 1;
                    const cm = live2dModel.internalModel.coreModel;
                    cm.setParameterValueById('ParamAngleX', -tilt); cm.setParameterValueById('ParamBodyAngleX', -tilt / 2);
                    cm.setParameterValueById('ParamEyeLOpen', 1 - eye); cm.setParameterValueById('ParamEyeROpen', 1 - eye);
                    cm.setParameterValueById('ParamAngleZ', nx * tilt * 0.7 * f);
                }
            });

            // Patting
            zone.addEventListener('mousedown', e => {
                if (!cfg.patting_enabled || !live2dModel?.internalModel) return;
                const b = zone.getBoundingClientRect();
                if ((e.clientY - b.top) < b.height / 3) {
                    isPatting = true; live2dModel.motionManager.stopAllMotions();
                    clearTimeout(pattingTimer); pattingTimer = setTimeout(() => { }, 3000);
                }
            });
            const stopPat = () => { clearTimeout(pattingTimer); if (isPatting) { isPatting = false; if (live2dModel) live2dModel.motion('Idle', 0, 3); } };
            window.addEventListener('mouseup', stopPat);
            window.addEventListener('resize', () => { if (live2dModel) updateModelTransform(); });
        } catch (e) { console.warn('[Widget] Live2D failed:', e); }
    }

    function updateModelTransform() {
        if (!live2dModel) return;
        const z = document.getElementById('lw-live2d-zone');
        const scale = (z.clientHeight / live2dModel.height) * (cfg.scale || 2.4);
        live2dModel.scale.set(scale);
        live2dModel.x = (z.clientWidth / 2) - (live2dModel.width / 2) + (cfg.posX || 0);
        live2dModel.y = cfg.posY ?? 50;
    }

    function loadScript(src) {
        return new Promise((ok, fail) => {
            if (document.querySelector(`script[src="${src}"]`)) { ok(); return; }
            const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s);
        });
    }

    // ── Boot ──
    async function boot() { loadCSS(); await loadConfig(); buildWidget(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
