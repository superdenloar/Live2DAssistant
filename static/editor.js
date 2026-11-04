/* Редактор ассистента: живое превью (Live2D / GIF), голос, фразы, аватар и сохранение без перезагрузки. */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const ID = EDITOR.id;
    const form = $('#editor-form');

    // ---------- Вкладки ----------
    $$('.editor-tabs button').forEach(b => b.addEventListener('click', () => {
        $$('.editor-tabs button').forEach(x => x.classList.toggle('active', x === b));
        $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === b.dataset.tab));
        try { sessionStorage.setItem('l2a_editor_tab', b.dataset.tab); } catch (_) { }
    }));
    try {
        const saved = new URLSearchParams(location.search).get('tab') || sessionStorage.getItem('l2a_editor_tab');
        if (saved) $(`.editor-tabs button[data-tab="${saved}"]`)?.click();
    } catch (_) { }

    // ---------- Ползунки + числовые поля ----------
    $$('input[data-mirror]').forEach(num => {
        const range = document.getElementById(num.dataset.mirror);
        range.addEventListener('input', () => { num.value = range.value; onSlider(range); });
        num.addEventListener('input', () => { stretchRange(range, num.value); range.value = num.value; onSlider(range); });
        stretchRange(range, num.value);
    });
    // Число вне рамок ползунка — расширяем ползунок, а не обрезаем значение
    function stretchRange(range, v) {
        v = parseFloat(v); if (isNaN(v)) return;
        if (v < parseFloat(range.min)) range.min = v;
        if (v > parseFloat(range.max)) range.max = v;
    }
    function onSlider(range) {
        if (['model-scale', 'model-pos-x', 'model-pos-y'].includes(range.id)) updateModelTransform();
        if (range.id.startsWith('gif-')) refreshGif();
    }

    // ---------- Отслеживание изменений и сохранение ----------
    const state = $('#save-state');
    let dirty = false;
    function setDirty(v) {
        dirty = v;
        state.classList.toggle('dirty', v);
        state.innerHTML = v ? '● Есть несохранённые изменения' : '✓ Все изменения сохранены';
    }
    form.addEventListener('input', () => setDirty(true));
    form.addEventListener('change', () => setDirty(true));
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#save-btn');
        btn.disabled = true; btn.textContent = 'Сохраняю…';
        try {
            const r = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { 'X-Requested-With': 'fetch' } });
            if (!r.ok) throw new Error('Сервер ответил ' + r.status);
            setDirty(false);
            Dash.toast('Ассистент сохранён');
        } catch (err) { Dash.toast('Не удалось сохранить: ' + err.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
    });
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); form.requestSubmit(); } });
    if (new URLSearchParams(location.search).get('saved')) Dash.toast('Ассистент сохранён');

    // ---------- Тип аватара ----------
    const typeInput = $('#avatar-type');
    function applyType(t) {
        typeInput.value = t;
        $$('#type-switch .type-opt').forEach(o => o.classList.toggle('selected', o.dataset.type === t));
        $$('.look-section').forEach(s => { s.style.display = s.dataset.for === t ? '' : 'none'; });
        $('#live2d-canvas-editor').style.display = t === 'live2d' ? '' : 'none';
        $('#gif-stage').style.display = t === 'gif' ? '' : 'none';
        $('#stage-empty').style.display = t === 'text' ? '' : 'none';
        $('#gif-empty').style.display = 'none';
        $('#model3d-stage').style.display = t === '3d' ? '' : 'none';
        $('#stage-tag').textContent = { live2d: 'Live2D', gif: 'GIF / PNG-тубер', text: 'Чат-бот', '3d': '3D-модель · бета' }[t] || 'Превью';
        if (t === 'gif') ensureGif();
        if (t === '3d') ensure3d();
        if (t === 'live2d' && !currentModel && modelSelect.value) loadLive2DModel(modelSelect.value);
    }
    $$('#type-switch .type-opt').forEach(o => o.addEventListener('click', () => {
        if (o.classList.contains('soon')) { Dash.toast(o.querySelector('b').textContent + ' — в разработке'); return; }
        applyType(o.dataset.type); setDirty(true);
    }));

    // ---------- Live2D превью ----------
    const canvas = $('#live2d-canvas-editor');
    const stage = $('#stage');
    const modelSelect = $('#live2d-model-select');
    let live2dApp = null, currentModel = null, isPatting = false;
    let target = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
    let cur = { ...target };

    function ensureApp() {
        if (live2dApp || !window.PIXI) return;
        live2dApp = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: stage, backgroundAlpha: 0 });
        live2dApp.ticker.add(() => {
            if (!currentModel?.internalModel || isPatting) return;
            const cm = currentModel.internalModel.coreModel;
            for (const k in target) { cur[k] += (target[k] - cur[k]) * 0.1; cm.setParameterValueById(k, cur[k]); }
        });
    }
    async function loadLive2DModel(path) {
        ensureApp();
        if (!live2dApp) return;
        if (currentModel) { live2dApp.stage.removeChild(currentModel); currentModel.destroy(); currentModel = null; }
        if (!path) return;
        try {
            currentModel = await PIXI.live2d.Live2DModel.from(path);
            currentModel.originalHeight = currentModel.height;
            live2dApp.stage.addChild(currentModel);
            updateModelTransform();
            currentModel.motion('Idle');
        } catch (err) { console.error('Live2D:', err); Dash.toast('Не удалось загрузить Live2D-модель', 'err'); }
    }
    function updateModelTransform() {
        if (!currentModel) return;
        const scale = parseFloat($('#model-scale').value), x = parseInt($('#model-pos-x').value), y = parseInt($('#model-pos-y').value);
        currentModel.scale.set((stage.clientHeight / currentModel.originalHeight) * scale);
        currentModel.x = stage.clientWidth / 2 - currentModel.width / 2 + x;
        currentModel.y = y;
    }
    window.addEventListener('resize', updateModelTransform);
    modelSelect.addEventListener('change', () => loadLive2DModel(modelSelect.value));

    // Поглаживание
    canvas.addEventListener('mousedown', e => {
        if ($('#patting-enabled').checked && currentModel?.internalModel && e.offsetY < canvas.clientHeight / 3) {
            isPatting = true; currentModel.motionManager.stopAllMotions();
        }
    });
    canvas.addEventListener('mousemove', e => {
        if (!isPatting || !currentModel?.internalModel) return;
        const tilt = parseFloat($('#patting-tilt').value), eye = parseFloat($('#patting-eye').value), f = parseFloat($('#patting-follow').value);
        const b = canvas.getBoundingClientRect();
        const nx = ((e.clientX - b.left - currentModel.x) / currentModel.width) * 2 - 1;
        const cm = currentModel.internalModel.coreModel;
        const vals = { ParamAngleX: -tilt, ParamBodyAngleX: -tilt / 2, ParamEyeLOpen: 1 - eye, ParamEyeROpen: 1 - eye, ParamAngleZ: nx * tilt * 0.7 * f };
        for (const k in vals) { cm.setParameterValueById(k, vals[k]); cur[k] = vals[k]; }
    });
    window.addEventListener('mouseup', () => { if (isPatting) { isPatting = false; currentModel?.motion('Idle', 0, 3); } });

    // ---------- GIF превью ----------
    let gif = null;
    function gifCfg() {
        const a = EDITOR.avatar.gif;
        return Object.assign({}, a, {
            mode: $('input[name=gif_mode]:checked')?.value || 'frames',
            scale: parseFloat($('#gif-scale').value),
            offset_y: parseInt($('#gif-offset').value),
            noise_floor: parseFloat($('#gif-noise').value),
            smoothing: parseFloat($('#gif-smooth').value),
            breathing: $('#gif-breathing').checked,
        });
    }
    function hasGifImages() {
        const g = EDITOR.avatar.gif, mode = $('input[name=gif_mode]:checked')?.value || 'frames';
        return mode === 'swap' ? !!(g.idle_url || g.talk_url) : !!((g.frames || []).length || g.source_url);
    }
    function ensureGif() {
        if (!gif) gif = new GifAvatar($('#gif-stage'), gifCfg(), { onFrame: i => highlightFrame(i) });
        refreshGif();
    }
    function refreshGif() {
        const mode = $('input[name=gif_mode]:checked')?.value || 'frames';
        $$('.gif-mode').forEach(el => { el.style.display = el.dataset.mode === mode ? '' : 'none'; });
        $('#gif-mode-hint').textContent = mode === 'frames'
            ? 'Первый кадр GIF — рот закрыт, последний — открыт полностью. Чем громче говорит ассистент, тем дальше кадр.'
            : 'Пока ассистент молчит — первая картинка, во время речи — вторая.';
        if (gif) gif.update(gifCfg());
        if (typeInput.value === 'gif') $('#gif-empty').style.display = hasGifImages() ? 'none' : '';
        renderFrames();
        renderAssets();
    }
    $$('input[name=gif_mode]').forEach(r => r.addEventListener('change', () => { refreshGif(); loadSample(); }));
    $('#gif-breathing').addEventListener('change', refreshGif);

    function renderFrames() {
        const strip = $('#frames-strip');
        const g = EDITOR.avatar.gif, all = g.all_frames || g.frames || [], off = new Set(g.disabled || []);
        strip.innerHTML = all.length
            ? all.map((u, i) => `<div class="fr ${off.has(i) ? 'off' : ''}" data-i="${i}" title="Кадр ${i + 1}: нажмите, чтобы ${off.has(i) ? 'включить' : 'отключить'}"><img src="${u}" alt=""><span>${i + 1}</span></div>`).join('')
            : (g.source_url ? '<span class="hint">Кадры раскладываются в браузере…</span>' : '');
        $('#frames-bar').hidden = !all.length;
        $('#frames-enabled').textContent = `Включено ${all.length - off.size} из ${all.length}. Нажмите на кадр, чтобы отключить его.`;
        $('#frames-all').hidden = !off.size;
        $('#frames-count').textContent = all.length ? `${all.length} кадров · первый — тишина, последний — максимум громкости` : (g.source_url ? '' : 'Перетащите GIF сюда или нажмите «Загрузить»');
    }
    // Номера включённых кадров (в порядке анимации)
    const enabledIdx = () => { const g = EDITOR.avatar.gif, off = new Set(g.disabled || []); return (g.all_frames || []).map((_, i) => i).filter(i => !off.has(i)); };
    async function saveDisabled(list) {
        try { setGif(await Dash.api(`/assistant/${ID}/gif/disabled`, { json: { disabled: list } })); }
        catch (err) { Dash.toast(err.message, 'err'); }
    }
    $('#frames-strip').addEventListener('click', e => {
        const fr = e.target.closest('.fr'); if (!fr) return;
        const i = +fr.dataset.i, off = new Set(EDITOR.avatar.gif.disabled || []);
        off.has(i) ? off.delete(i) : off.add(i);
        saveDisabled([...off]);
    });
    $('#frames-all').addEventListener('click', () => saveDisabled([]));

    function renderAssets() {
        const g = EDITOR.avatar.gif;
        $$('.asset').forEach(box => {
            const slot = box.dataset.slot;
            const url = slot === 'source' ? g.source_url : g[slot + '_url'];
            const th = box.querySelector('.asset-thumb');
            th.hidden = !url; if (url) th.src = url;
            box.querySelector('[data-clear]').hidden = !url;
            const rev = box.querySelector('[data-reverse]'); if (rev) rev.hidden = !(g.frames || []).length;
            box.querySelector('[data-pick] span').textContent = url ? (slot === 'source' ? 'Заменить GIF' : 'Заменить') : (slot === 'source' ? 'Загрузить GIF' : 'Загрузить');
            if (slot === 'source') box.querySelector('.asset-title').textContent = url ? 'GIF загружен' : 'GIF ещё не загружен';
        });
    }
    function highlightFrame(i) {
        const real = enabledIdx()[i];
        $$('#frames-strip .fr').forEach(el => el.classList.toggle('on', +el.dataset.i === real));
        $$('#frames-strip .fr img').forEach(im => im.classList.toggle('on', +im.parentElement.dataset.i === real));
    }
    // Наведение на кадр — показать его в превью
    $('#frames-strip').addEventListener('mouseover', e => {
        const fr = e.target.closest('.fr'); if (!fr || !gif) return;
        const pos = enabledIdx().indexOf(+fr.dataset.i), n = enabledIdx().length;
        if (pos >= 0) gif.setLevel(n > 1 ? pos / (n - 1) : 0);
    });
    $('#frames-strip').addEventListener('mouseleave', () => gif && gif.setLevel(null));

    // ---------- Хромакей ----------
    const ch = Object.assign({ enabled: false, color: '#00ff00', tolerance: 25, softness: 10, despill: true }, EDITOR.avatar.gif.chroma || {});
    for (const k of ['color', 'tolerance', 'softness']) if (ch[k] == null) ch[k] = { color: '#00ff00', tolerance: 25, softness: 10 }[k];
    if (ch.despill == null) ch.despill = true;
    const cOn = $('#chroma-on'), cColor = $('#chroma-color'), cTol = $('#chroma-tol'), cSoft = $('#chroma-soft'), cDes = $('#chroma-despill');
    const before = $('#chroma-before'), after = $('#chroma-after');
    cOn.checked = !!ch.enabled; cColor.value = ch.color; cTol.value = ch.tolerance; cSoft.value = ch.softness; cDes.checked = !!ch.despill;
    let sample = null;
    function sampleUrl() {
        const g = EDITOR.avatar.gif, mode = $('input[name=gif_mode]:checked')?.value || 'frames';
        if (mode === 'swap') return g.idle_original || g.talk_original || '';
        const orig = g.original_frames || [];
        return orig[orig.length - 1] || g.source_url || '';
    }
    function loadSample() {
        const url = sampleUrl();
        if (!url) { sample = null; drawChroma(); return; }
        const img = new Image();
        img.onload = () => { sample = img; drawChroma(); };
        img.src = url.split('?')[0] + '?s=' + Date.now();
    }
    function hexRgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
    function drawChroma() {
        $('#chroma-body').classList.toggle('off', !cOn.checked);
        $('#chroma-tol-v').textContent = cTol.value; $('#chroma-soft-v').textContent = cSoft.value;
        [before, after].forEach(c => { c.width = 240; c.height = 240; c.getContext('2d').clearRect(0, 0, 240, 240); });
        if (!sample) return;
        const k = Math.min(240 / sample.width, 240 / sample.height), w = Math.round(sample.width * k), h = Math.round(sample.height * k);
        const x = (240 - w) / 2, y = (240 - h) / 2;
        before.getContext('2d').drawImage(sample, x, y, w, h);
        const ctx = after.getContext('2d');
        ctx.drawImage(sample, x, y, w, h);
        if (!cOn.checked) return;
        // Тот же алгоритм, что на сервере: расстояние до цвета фона -> прозрачность
        const d = ctx.getImageData(0, 0, 240, 240), px = d.data;
        const [kr, kg, kb] = hexRgb(cColor.value), tol = cTol.value / 100 * 441.7, soft = Math.max(1, cSoft.value / 100 * 441.7);
        const key = [kr, kg, kb], dom = key.indexOf(Math.max(...key)), sorted = [...key].sort((a, b) => b - a), despill = cDes.checked && sorted[0] - sorted[1] > 40;
        for (let i = 0; i < px.length; i += 4) {
            const dist = Math.hypot(px[i] - kr, px[i + 1] - kg, px[i + 2] - kb);
            const a = Math.min(1, Math.max(0, (dist - tol) / soft));
            if (despill) {
                const others = [0, 1, 2].filter(c => c !== dom), limit = Math.max(px[i + others[0]], px[i + others[1]]);
                const edge = Math.min(1, Math.max(0, 1 - (dist - tol - soft) / (2 * soft + 1)));
                if (px[i + dom] > limit) px[i + dom] -= (px[i + dom] - limit) * edge;
            }
            px[i + 3] *= a;
        }
        ctx.putImageData(d, 0, 0);
    }
    before.addEventListener('click', e => {
        if (!sample) return;
        const r = before.getBoundingClientRect();
        const p = before.getContext('2d').getImageData(Math.floor((e.clientX - r.left) * 240 / r.width), Math.floor((e.clientY - r.top) * 240 / r.height), 1, 1).data;
        if (!p[3]) return;
        cColor.value = '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
        if (!cOn.checked) cOn.checked = true;
        drawChroma();
    });
    [cColor, cTol, cSoft, cDes].forEach(el => el.addEventListener('input', drawChroma));
    $$('.swatch').forEach(b => b.addEventListener('click', () => { cColor.value = b.dataset.color; drawChroma(); }));
    cOn.addEventListener('change', async () => {
        drawChroma();
        if (!cOn.checked && EDITOR.avatar.gif.chroma?.enabled) applyChroma(false);
    });
    async function applyChroma(enabled = true) {
        const btn = $('#chroma-apply');
        btn.disabled = true; btn.textContent = enabled ? 'Обрабатываю кадры…' : 'Отключаю…';
        try {
            setGif(await Dash.api(`/assistant/${ID}/gif/chroma`, { json: { enabled, color: cColor.value, tolerance: +cTol.value, softness: +cSoft.value, despill: cDes.checked } }));
            Dash.toast(enabled ? 'Фон убран со всех кадров' : 'Хромакей выключен — показываются исходные кадры');
        } catch (err) { Dash.toast(err.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = 'Применить ко всем кадрам'; }
    }
    $('#chroma-apply').addEventListener('click', () => applyChroma(true));

    // Загрузка, замена и удаление картинок
    function setGif(data) { EDITOR.avatar.gif = data.gif; refreshGif(); loadSample(); reloadPreviewSoon(); }
    $$('.asset').forEach(box => {
        const input = box.querySelector('input[type=file]');
        box.querySelector('[data-pick]').addEventListener('click', () => input.click());
        input.addEventListener('change', () => { if (input.files[0]) uploadGif(box, input.files[0]); input.value = ''; });
        box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('over'); });
        box.addEventListener('dragleave', () => box.classList.remove('over'));
        box.addEventListener('drop', e => { e.preventDefault(); box.classList.remove('over'); e.dataTransfer.files[0] && uploadGif(box, e.dataTransfer.files[0]); });
        box.querySelector('[data-clear]').addEventListener('click', async () => {
            if (!confirm('Удалить эту картинку?')) return;
            try { setGif(await Dash.api(`/assistant/${ID}/gif/clear`, { json: { slot: box.dataset.slot } })); Dash.toast('Удалено'); }
            catch (err) { Dash.toast(err.message, 'err'); }
        });
        box.querySelector('[data-reverse]')?.addEventListener('click', async () => {
            try { setGif(await Dash.api(`/assistant/${ID}/gif/reverse`, { method: 'POST' })); Dash.toast('Порядок кадров развёрнут'); }
            catch (err) { Dash.toast(err.message, 'err'); }
        });
    });
    async function uploadGif(box, file) {
        const fd = new FormData();
        fd.append('slot', box.dataset.slot); fd.append('file', file);
        box.classList.add('busy');
        try {
            let data = await Dash.api(`/assistant/${ID}/gif`, { method: 'POST', body: fd });
            if (box.dataset.slot === 'source' && !(data.gif.frames || []).length && 'ImageDecoder' in window) {
                // На сервере нет Pillow: раскладываем GIF сами и отправляем кадры
                const urls = await GifAvatar.decodeGif(data.gif.source_url);
                const fd2 = new FormData();
                for (let i = 0; i < urls.length; i++) fd2.append('frames', await (await fetch(urls[i])).blob(), `f${i}.png`);
                data = await Dash.api(`/assistant/${ID}/gif/frames`, { method: 'POST', body: fd2 });
            }
            setGif(data);
            Dash.toast(box.dataset.slot === 'source' ? `GIF загружен: ${(data.gif.frames || []).length} кадров` : 'Картинка загружена');
        } catch (err) { Dash.toast(err.message, 'err'); }
        finally { box.classList.remove('busy'); }
    }

    // ---------- Виджет: вид, расположение, живой предпросмотр ----------
    const DEFAULTS = {
        popup: { side: 'right', width: 380, height: 560, offset_x: 24, offset_y: 24, model_scale: 1, model_x: 0, model_y: 0 },
        card: { side: 'right', width: 380, height: 620, offset_x: 24, offset_y: 24, stage_height: 230, model_scale: 1, model_x: 0, model_y: 0 },
        novel: { side: 'right', char_height: 92, char_width: 46, char_x: 2, char_bottom: 0, model_scale: 1, model_x: 0, model_y: 0,
            box_width: 72, box_max: 1100, box_height: 190, box_bottom: 20, box_opacity: 0.86, dim: 0.15, typewriter: true, speed: 28 },
        trigger: { side: 'right', size: 64, offset_x: 24, offset_y: 24 },
    };
    const SCHEMA = {
        popup: [['g', 'Окно'], ['side', 'Сторона экрана', ['left', 'right']], ['width', 'Ширина, px', 280, 760, 1], ['height', 'Высота, px', 360, 960, 1],
            ['offset_x', 'Отступ от края, px', 0, 300, 1], ['offset_y', 'Отступ снизу, px', 0, 300, 1],
            ['g', 'Персонаж внутри окна'], ['model_scale', 'Масштаб', 0.1, 10, 0.05], ['model_x', 'Сдвиг по горизонтали', -2000, 2000, 1], ['model_y', 'Сдвиг по вертикали', -3000, 3000, 1]],
        card: [['g', 'Карточка'], ['side', 'Сторона экрана', ['left', 'right']], ['width', 'Ширина, px', 280, 760, 1], ['height', 'Высота, px', 360, 960, 1],
            ['offset_x', 'Отступ от края, px', 0, 300, 1], ['offset_y', 'Отступ снизу, px', 0, 300, 1], ['stage_height', 'Высота сцены с персонажем, px', 100, 480, 1],
            ['g', 'Персонаж'], ['model_scale', 'Масштаб', 0.1, 10, 0.05], ['model_x', 'Сдвиг по горизонтали', -2000, 2000, 1], ['model_y', 'Сдвиг по вертикали', -3000, 3000, 1]],
        novel: [['g', 'Персонаж'], ['side', 'Где стоит', ['left', 'center', 'right']], ['char_height', 'Высота сцены, % экрана', 30, 130, 1], ['char_width', 'Ширина сцены, % экрана', 15, 90, 1],
            ['char_x', 'Отступ от края, % экрана', -30, 50, 0.5], ['char_bottom', 'Подъём от низа, px', -400, 400, 1],
            ['model_scale', 'Масштаб модели', 0.1, 10, 0.05], ['model_x', 'Сдвиг модели по горизонтали', -2000, 2000, 1], ['model_y', 'Сдвиг модели по вертикали', -3000, 3000, 1],
            ['g', 'Диалоговое окно'], ['box_width', 'Ширина, % экрана', 40, 100, 1], ['box_max', 'Максимальная ширина, px', 500, 1800, 10], ['box_height', 'Высота, px', 120, 420, 1],
            ['box_bottom', 'Отступ снизу, px', 0, 200, 1], ['box_opacity', 'Плотность фона', 0.3, 1, 0.01], ['dim', 'Затемнение сайта снизу', 0, 0.8, 0.01],
            ['typewriter', 'Печатать текст по буквам'], ['speed', 'Скорость печати, мс на букву', 5, 80, 1]],
        trigger: [['side', 'Сторона', ['left', 'right']], ['size', 'Размер, px', 40, 110, 1], ['offset_x', 'Отступ от края, px', 0, 300, 1], ['offset_y', 'Отступ снизу, px', 0, 300, 1]],
    };
    const SIDE_NAMES = { left: 'Слева', center: 'По центру', right: 'Справа' };
    const MODE_NAMES = { popup: 'Окно', card: 'Карточка', novel: 'Новелла' };
    const layout = {};
    for (const k in DEFAULTS) layout[k] = Object.assign({}, DEFAULTS[k], (EDITOR.avatar.layout || {})[k] || {});
    const layoutInput = $('#widget-layout');
    const curMode = () => $('input[name=widget_mode]:checked')?.value || 'popup';

    function controlsHtml(section) {
        const L = layout[section];
        return '<div class="lc-grid">' + SCHEMA[section].map(row => {
            const [key, label] = row;
            if (key === 'g') return `<div class="lc-group">${label}</div>`;
            if (Array.isArray(row[2])) return `<div class="field"><span class="label">${label}</span><div class="segmented">${row[2].map(v =>
                `<button type="button" data-lc="${section}.${key}" data-v="${v}" class="${L[key] === v ? 'active' : ''}">${SIDE_NAMES[v]}</button>`).join('')}</div></div>`;
            if (row.length === 2) return `<div class="field"><label class="switch"><input type="checkbox" data-lc="${section}.${key}" ${L[key] ? 'checked' : ''}><span class="track"></span><span>${label}</span></label></div>`;
            const [, , min, max, step] = row;
            const lo = Math.min(min, L[key]), hi = Math.max(max, L[key]);
            return `<div class="field"><label>${label}</label><div class="range-row"><input type="range" min="${lo}" max="${hi}" step="${step}" value="${L[key]}" data-lc="${section}.${key}"><input type="number" class="input" step="any" value="${L[key]}" data-lc="${section}.${key}" aria-label="${label}"></div></div>`;
        }).join('') + '</div>';
    }
    function renderLayoutControls() {
        $('#layout-title').textContent = `Настройки вида «${MODE_NAMES[curMode()]}». Остальные виды сохраняют свои значения.`;
        $('#layout-controls').innerHTML = controlsHtml(curMode());
        $('#trigger-controls').innerHTML = controlsHtml('trigger');
    }
    function syncLayoutInput() { layoutInput.value = JSON.stringify(layout); }
    document.addEventListener('input', e => {
        const el = e.target.closest('[data-lc]'); if (!el) return;
        const [sec, key] = el.dataset.lc.split('.');
        layout[sec][key] = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
        const row = el.closest('.range-row');
        if (row) row.querySelectorAll('input').forEach(i => { if (i !== el) { if (i.type === 'range') stretchRange(i, el.value); i.value = el.value; } });
        syncLayoutInput(); pushPreview(); setDirty(true);
    });
    document.addEventListener('click', e => {
        const b = e.target.closest('button[data-lc]'); if (!b) return;
        const [sec, key] = b.dataset.lc.split('.');
        layout[sec][key] = b.dataset.v;
        b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        syncLayoutInput(); pushPreview(); setDirty(true);
    });
    $('#layout-reset').addEventListener('click', () => {
        const m = curMode(); layout[m] = Object.assign({}, DEFAULTS[m]); layout.trigger = Object.assign({}, DEFAULTS.trigger);
        renderLayoutControls(); syncLayoutInput(); pushPreview(); setDirty(true);
    });
    $$('input[name=widget_mode]').forEach(r => r.addEventListener('change', () => { renderLayoutControls(); pushPreview(true); }));

    // Предпросмотр: настоящий виджет в iframe, масштабированный под ширину панели
    const frame = $('#preview-frame'), pbox = $('#preview-box');
    let device = 'desktop';
    function sizeFrame() {
        const W = device === 'desktop' ? 1280 : 390, H = device === 'desktop' ? 720 : 780;
        const boxW = pbox.clientWidth, boxH = device === 'desktop' ? boxW * 9 / 16 : pbox.clientHeight;
        const k = Math.min(boxW / W, boxH / H, 1);
        frame.style.width = W + 'px'; frame.style.height = H + 'px';
        frame.style.transform = device === 'desktop' ? `scale(${k})` : `translateX(-50%) scale(${k})`;
        frame.style.transformOrigin = device === 'desktop' ? '0 0' : '50% 0';
    }
    $$('#device-switch button').forEach(b => b.addEventListener('click', () => {
        device = b.dataset.device;
        $$('#device-switch button').forEach(x => x.classList.toggle('active', x === b));
        pbox.classList.toggle('mobile', device === 'mobile'); sizeFrame();
    }));
    addEventListener('resize', sizeFrame);
    // Всё несохранённое из редактора тоже уходит в предпросмотр: цвета, тип аватара, модель, масштаб и сдвиги
    function extras() {
        const g = gifCfg();
        return {
            greeting_phrase: $('#greeting-phrase').value,
            widget_primary_color: $('#widget-primary-color').value, widget_user_bubble_color: $('#widget-user-bubble-color').value,
            widget_text_color: $('#widget-text-color').value, widget_bg_color: $('#widget-bg-color').value,
            avatar_type: typeInput.value,
            live2d_model_path: modelSelect.value,
            scale: parseFloat($('#model-scale').value), posX: parseInt($('#model-pos-x').value), posY: parseInt($('#model-pos-y').value),
            gif: Object.assign({}, EDITOR.avatar.gif, { mode: g.mode, scale: g.scale, offset_y: g.offset_y, noise_floor: g.noise_floor, smoothing: g.smoothing, breathing: g.breathing }),
            model3d: m3cfg(),
            mouth_min_open: parseFloat($('#mouth-min').value), mouth_max_open: parseFloat($('#mouth-max').value),
        };
    }
    let pushT = null;
    function pushPreview(rebuild) {
        clearTimeout(pushT);
        pushT = setTimeout(() => {
            const LW = frame.contentWindow && frame.contentWindow.LW;
            if (LW && LW.setLayout) LW.setLayout(layout, curMode(), extras());
        }, rebuild ? 250 : 40);
    }
    // Любая правка в редакторе (внешность, тип, модель) сразу видна в предпросмотре
    form.addEventListener('input', e => { if (!e.target.closest('[data-lc]')) pushPreview(); });
    form.addEventListener('change', e => { if (!e.target.closest('[data-lc]')) pushPreview(); });
    $$('#type-switch .type-opt').forEach(o => o.addEventListener('click', () => pushPreview(true)));
    ['#greeting-phrase', '#widget-primary-color', '#widget-user-bubble-color', '#widget-text-color', '#widget-bg-color'].forEach(sel =>
        $(sel).addEventListener('input', () => pushPreview(true)));
    frame.addEventListener('load', () => setTimeout(() => pushPreview(true), 400));
    let reloadT = null;
    function reloadPreviewSoon() { clearTimeout(reloadT); reloadT = setTimeout(() => frame.contentWindow?.location.reload(), 300); }
    $('#preview-reload').addEventListener('click', () => frame.contentWindow?.location.reload());
    // При переходе на вкладку «Виджет» пересчитываем размер
    $$('.editor-tabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab === 't-widget') requestAnimationFrame(sizeFrame); }));
    renderLayoutControls(); syncLayoutInput(); sizeFrame(); loadSample();

    // ---------- 3D-модель ----------
    let m3d = null, m3dLoading = null;
    const m3cfg = () => ({
        url: $('#model3d-select').value, scale: parseFloat($('#m3-scale').value), offset_y: parseFloat($('#m3-offset').value),
        rotate_y: parseFloat($('#m3-rotate').value), follow: $('#m3-follow').checked,
    });
    async function ensure3d() {
        if (m3d) { m3d.update(m3cfg()); return; }
        if (m3dLoading) return;
        m3dLoading = import('/static/model3d_avatar.js')
            .then(mod => mod.createModel3DAvatar($('#model3d-stage'), m3cfg(), {}))
            .then(av => { m3d = av; autoSnapshot(); })
            .catch(err => Dash.toast('3D не загрузилась: ' + err.message, 'err'));
    }
    ['#model3d-select', '#m3-scale', '#m3-offset', '#m3-rotate', '#m3-follow'].forEach(sel => $(sel).addEventListener('input', () => m3d && m3d.update(m3cfg())));
    $$('input[data-mirror^="m3-"]').forEach(n => n.addEventListener('input', () => m3d && m3d.update(m3cfg())));
    $('#model3d-select').addEventListener('change', () => m3d && m3d.update(m3cfg()));
    $('#model3d-upload-btn').addEventListener('click', () => $('#model3d-file').click());
    $('#model3d-file').addEventListener('change', async () => {
        const f = $('#model3d-file').files[0]; if (!f) return;
        const btn = $('#model3d-upload-btn'); btn.disabled = true; btn.textContent = `Загружаю ${(f.size / 1048576).toFixed(1)} МБ…`;
        try {
            const fd = new FormData(); fd.append('file', f);
            const d = await Dash.api(`/assistant/${ID}/model3d`, { method: 'POST', body: fd });
            const sel = $('#model3d-select');
            sel.innerHTML = '<option value="">— Не выбрано —</option>' + d.models.map(m => `<option value="${m.path}">${m.name} · ${m.size_mb} МБ</option>`).join('');
            sel.value = d.model3d.url;
            m3d && m3d.update(m3cfg()); setDirty(true);
            Dash.toast('Модель загружена — не забудьте сохранить');
        } catch (err) { Dash.toast(err.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = 'Загрузить .glb'; $('#model3d-file').value = ''; }
    });
    async function uploadSnapshot(silent) {
        if (!m3d) return;
        await new Promise(r => setTimeout(r, 600));
        const c = m3d.snapshot(320); if (!c) return;
        c.toBlob(async blob => {
            const fd = new FormData(); fd.append('avatar', blob, 'avatar.png');
            try {
                const d = await Dash.api(`/assistant/${ID}/upload_avatar`, { method: 'POST', body: fd });
                $('.editor-avatar').src = d.new_photo_url + '?v=' + Date.now();
                if (!silent) Dash.toast('Аватар сделан из 3D-модели');
            } catch (err) { if (!silent) Dash.toast(err.message, 'err'); }
        }, 'image/png');
    }
    // Если у 3D-ассистента стоит стандартная картинка — сделаем аватар сами
    function autoSnapshot() { if (/default_avatar/i.test($('.editor-avatar').src)) uploadSnapshot(true); }
    $('#model3d-snap-btn').addEventListener('click', () => uploadSnapshot(false));

    // ---------- Захват лица с веб-камеры ----------
    let stopFace = null;
    const camBtn = $('#face-cam-btn');
    function applyFace(face) {
        const t = typeInput.value;
        if (t === '3d' && m3d) m3d.setFace(face);
        if (t === 'gif' && gif) gif.setLevel(face ? face.jaw : null);
        if (t === 'live2d' && currentModel?.internalModel) {
            if (!face) { target = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 }; return; }
            const deg = r => Math.max(-30, Math.min(30, r * 57.3));
            target = { ParamAngleX: deg(face.yaw), ParamAngleY: deg(-face.pitch), ParamAngleZ: deg(face.roll), ParamBodyAngleX: deg(face.yaw) / 3,
                ParamEyeLOpen: 1 - face.blinkL, ParamEyeROpen: 1 - face.blinkR };
            cur.ParamEyeLOpen = target.ParamEyeLOpen; cur.ParamEyeROpen = target.ParamEyeROpen;
            currentModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', face.jaw);
        }
    }
    camBtn.addEventListener('click', async () => {
        if (stopFace) { stopFace(); return; }
        camBtn.disabled = true; camBtn.textContent = 'Включаю камеру…';
        try {
            const mod = await import('/static/face_tracker.js');
            stopFace = await mod.startFaceTracking(applyFace, { onStop: () => { stopFace = null; camBtn.textContent = 'Управлять с веб-камеры'; } });
            camBtn.textContent = 'Остановить камеру';
        } catch (err) {
            Dash.toast('Камера недоступна: ' + (err.message || err), 'err');
            camBtn.textContent = 'Управлять с веб-камеры';
        } finally { camBtn.disabled = false; }
    });

    // ---------- Голос и тест ----------
    const ttsModel = $('#silero-model-select'), ttsSpeaker = $('#silero-speaker-select');
    ttsModel.addEventListener('change', () => {
        const list = ALL_SPEAKERS[ttsModel.value] || [];
        const was = ttsSpeaker.value;
        ttsSpeaker.innerHTML = list.map(s => `<option ${s === was ? 'selected' : ''}>${s}</option>`).join('') || '<option value="">—</option>';
    });

    let audioCtx = null, analyser = null, lipRunning = false;
    function ensureAudio() {
        if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; analyser.connect(audioCtx.destination); }
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }
    function speak(text, url) {
        ensureAudio();
        const bubble = $('#stage-speech');
        bubble.textContent = text; bubble.classList.add('on');
        const audio = new Audio(url);
        audioCtx.createMediaElementSource(audio).connect(analyser);
        if (gif) gif.attachAnalyser(analyser);
        if (m3d) m3d.attachAnalyser(analyser);
        audio.onplay = () => { lipRunning = true; lipSync(); };
        audio.onended = () => { lipRunning = false; setTimeout(() => bubble.classList.remove('on'), 1200); };
        audio.play().catch(() => Dash.toast('Браузер заблокировал звук — кликните по странице', 'err'));
    }
    function lipSync() {
        if (!currentModel?.internalModel) return;
        const cm = currentModel.internalModel.coreModel;
        if (!lipRunning) { cm.setParameterValueById('ParamMouthOpenY', 0); return; }
        const d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d);
        let avg = 0; for (const v of d) avg += v; avg /= d.length;
        const mn = +$('#mouth-min').value, mx = +$('#mouth-max').value, js = +$('#mouth-jitter-str').value, jv = +$('#mouth-jitter-speed').value;
        let m = mn + (avg / 255) * (mx - mn) * 2.2;
        if (avg > 10) m += Math.sin(Date.now() / jv) * js;
        cm.setParameterValueById('ParamMouthOpenY', Math.max(0, Math.min(1, m)));
        requestAnimationFrame(lipSync);
    }
    const ttsBtn = $('#tts-test-btn'), ttsInput = $('#tts-test-input');
    ttsBtn.addEventListener('click', async () => {
        const text = ttsInput.value.trim();
        if (!text) return;
        if (!ttsModel.value || !ttsSpeaker.value) { Dash.toast('Выберите голосовую модель на вкладке «Голос»', 'err'); return; }
        ensureAudio();
        ttsBtn.disabled = true; ttsBtn.textContent = 'Генерирую…';
        try {
            const d = await Dash.api('/assistant/test_tts', { json: { text, model_name: ttsModel.value, speaker_name: ttsSpeaker.value } });
            speak(text, d.audio_url);
        } catch (err) {
            Dash.toast('Голос недоступен: ' + err.message, 'err');
            // Без TTS всё равно покажем анимацию рта, чтобы было видно, как работает аватар
            fakeSpeak(text);
        } finally { ttsBtn.disabled = false; ttsBtn.innerHTML = '▶ Озвучить'; }
    });
    function fakeSpeak(text) {
        const bubble = $('#stage-speech');
        bubble.textContent = text; bubble.classList.add('on');
        const t0 = performance.now(), dur = Math.min(6000, 600 + text.length * 70);
        (function step() {
            const t = performance.now() - t0;
            const lvl = t < dur ? Math.abs(Math.sin(t / 90)) * (0.5 + 0.5 * Math.abs(Math.sin(t / 370))) : 0;
            if (gif) gif.setLevel(lvl);
            if (m3d) m3d.setLevel(t < dur ? lvl : null);
            if (currentModel?.internalModel) currentModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', lvl);
            if (t < dur) requestAnimationFrame(step);
            else { if (gif) gif.setLevel(null); setTimeout(() => bubble.classList.remove('on'), 800); }
        })();
    }

    // ---------- Команды движений ----------
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function runCommand(cmd) {
        if (typeInput.value === 'gif') { gif?.command(cmd); return; }
        if (typeInput.value === '3d') { m3d?.command(cmd); return; }
        const base = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
        if (cmd === 'RESET') { target = base; return; }
        if (cmd === 'NOD_HEAD') { for (const y of [30, -30, 30, 0]) { target = { ...base, ParamAngleY: y }; await sleep(380); } return; }
        if (cmd === 'SHAKE_HEAD') { for (const x of [-30, 30, -30, 0]) { target = { ...base, ParamAngleX: x }; await sleep(340); } return; }
        const map = { LOOK_LEFT: { ParamAngleX: -30 }, LOOK_RIGHT: { ParamAngleX: 30 }, HEAD_TILT_LEFT: { ParamAngleZ: -30 } };
        target = { ...base, ...(map[cmd] || {}) };
    }
    $$('#cmd-test [data-cmd]').forEach(b => b.addEventListener('click', () => runCommand(b.dataset.cmd)));

    // ---------- Промпт ----------
    const prompt = $('#system-prompt-textarea');
    $$('#cmd-grid [data-insert]').forEach(chip => chip.addEventListener('click', () => {
        const ins = chip.dataset.insert;
        const s = prompt.selectionStart ?? prompt.value.length, e = prompt.selectionEnd ?? s;
        prompt.value = prompt.value.slice(0, s) + ins + prompt.value.slice(e);
        prompt.focus(); prompt.selectionStart = prompt.selectionEnd = s + ins.length;
        setDirty(true);
    }));
    $('#load-default-prompt-btn').addEventListener('click', async () => {
        if (prompt.value.trim() && !confirm('Заменить текущий промпт шаблоном из system_prompt.txt?')) return;
        const d = await Dash.api('/assistant/default_prompt');
        prompt.value = d.prompt || ''; setDirty(true); Dash.toast('Шаблон загружен');
    });
    $('#insert-commands-btn').addEventListener('click', () => {
        if (prompt.value.includes('【Киваю головой】')) { Dash.toast('Команды уже есть в промпте'); return; }
        prompt.value += '\n\n[Управление движениями]\nОживляй слова движениями, добавляя команды в скобках 【Команда】:\n' +
            '【Киваю головой】 — согласие\n【Махаю головой】 — несогласие\n【Посмотреть влево】, 【Посмотреть вправо】, 【Посмотреть вверх】, 【Посмотреть вниз】 — взгляд\n' +
            '【Слежу за курсором】 — следить за мышью\n【Голова влево】, 【Голова вправо】 — наклон головы\n【Закрыть левый глаз】, 【Закрыть правый глаз】 — подмигнуть\n' +
            'Команды не озвучиваются. Используй их по смыслу, не в каждой фразе.';
        setDirty(true); Dash.toast('Команды добавлены в конец промпта');
    });
    const mSel = $('#assistant-model-select'), mName = $('#assistant-model-name');
    mSel.addEventListener('change', () => { if (mSel.value !== 'custom') mName.value = mSel.value; });
    mName.addEventListener('input', () => {
        const opt = Array.from(mSel.options).find(o => o.value === mName.value);
        mSel.value = opt ? opt.value : (mName.value ? 'custom' : '');
    });

    // ---------- Фразы инициативы ----------
    const list = $('#boredom-phrases-list'), phraseInput = $('#new-boredom-phrase-input');
    function phraseEl(id, text) {
        const d = document.createElement('div');
        d.className = 'phrase'; d.dataset.id = id;
        d.innerHTML = `<span></span><button type="button" class="btn btn-icon test-phrase-btn" title="Озвучить">▶</button><button type="button" class="btn btn-icon delete-phrase-btn" title="Удалить">✕</button>`;
        d.querySelector('span').textContent = text;
        return d;
    }
    async function addPhrase() {
        const text = phraseInput.value.trim(); if (!text) return;
        const d = await Dash.api(`/assistant/boredom/add/${ID}`, { json: { text } });
        list.appendChild(phraseEl(d.id, d.text)); phraseInput.value = '';
    }
    $('#add-boredom-phrase-btn').addEventListener('click', addPhrase);
    phraseInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPhrase(); } });
    list.addEventListener('click', async e => {
        const b = e.target.closest('button'); if (!b) return;
        const item = b.closest('.phrase');
        if (b.classList.contains('delete-phrase-btn')) { await fetch(`/assistant/boredom/delete/${item.dataset.id}`, { method: 'POST' }); item.remove(); }
        if (b.classList.contains('test-phrase-btn')) { ttsInput.value = item.querySelector('span').textContent; ttsBtn.click(); }
    });

    // ---------- Аватар (кадрирование) ----------
    let cropper = null;
    const cropImg = $('#avatar-cropper-image'), fileInput = $('#avatar-upload-input');
    $('#avatar-edit').addEventListener('click', () => { if (cropper) { cropper.destroy(); cropper = null; } cropImg.src = ''; fileInput.value = ''; Dash.openModal('avatar-modal'); });
    $('#avatar-choose-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const f = fileInput.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = ev => { if (cropper) cropper.destroy(); cropImg.src = ev.target.result; cropper = new Cropper(cropImg, { aspectRatio: 1, viewMode: 1, background: false, autoCropArea: .85 }); };
        rd.readAsDataURL(f);
    });
    $('#save-avatar-btn').addEventListener('click', () => {
        if (!cropper) { fileInput.click(); return; }
        cropper.getCroppedCanvas({ width: 256, height: 256 }).toBlob(async blob => {
            const fd = new FormData(); fd.append('avatar', blob, 'avatar.png');
            try {
                const d = await Dash.api(`/assistant/${ID}/upload_avatar`, { method: 'POST', body: fd });
                $('.editor-avatar').src = d.new_photo_url + '?v=' + Date.now();
                Dash.closeModal('avatar-modal'); Dash.toast('Аватар обновлён');
            } catch (err) { Dash.toast(err.message, 'err'); }
        }, 'image/png');
    });
    $('#set-default-avatar-btn').addEventListener('click', async () => {
        const d = await Dash.api(`/assistant/${ID}/set_default_avatar`, { method: 'POST' });
        $('.editor-avatar').src = d.new_photo_url; Dash.closeModal('avatar-modal');
    });

    $('#embed-open').addEventListener('click', () => Dash.openModal('embed-modal'));

    // ---------- Старт ----------
    applyType(typeInput.value || 'live2d');
    setDirty(false);
});
