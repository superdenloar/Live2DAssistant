/* Лендинг: живой персонаж в макете сайта и сценка разговора с передачей оператору. */
(function () {
    'use strict';
    const nav = document.querySelector('.l-nav');
    addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });

    const stage = document.getElementById('hero-stage');
    const canvas = document.getElementById('hero-canvas');
    const log = document.getElementById('hero-log');
    const typing = document.getElementById('hero-typing');
    const speaker = document.getElementById('hero-speaker');
    const tag = document.getElementById('hero-tag');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const name = SHOWCASE.name || 'Лила';

    let model = null, gif = null, mouth = 0;
    const target = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0 };
    const cur = { ...target };

    async function initCharacter() {
        if (SHOWCASE.model && window.PIXI && PIXI.live2d) {
            try {
                const app = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: stage, backgroundAlpha: 0, antialias: true });
                model = await PIXI.live2d.Live2DModel.from(SHOWCASE.model, { autoInteract: false });
                app.stage.addChild(model);
                const baseH = model.height;
                const fit = () => {
                    const s = (stage.clientHeight / baseH) * Math.min(2.2, SHOWCASE.scale || 2.2);
                    model.scale.set(s);
                    model.x = stage.clientWidth / 2 - model.width / 2;
                    model.y = 0;
                };
                fit(); addEventListener('resize', fit);
                model.motion('Idle');
                app.ticker.add(() => {
                    const cm = model.internalModel.coreModel;
                    for (const k in target) { cur[k] += (target[k] - cur[k]) * 0.08; cm.setParameterValueById(k, cur[k]); }
                    cm.setParameterValueById('ParamMouthOpenY', mouth);
                });
                // Персонаж поглядывает на курсор
                addEventListener('mousemove', e => {
                    const b = stage.getBoundingClientRect();
                    target.ParamAngleX = Math.max(-30, Math.min(30, ((e.clientX - b.left) / b.width * 2 - 1) * 30));
                    target.ParamAngleY = Math.max(-30, Math.min(30, -((e.clientY - b.top) / b.height * 2 - 1) * 20));
                });
                return;
            } catch (err) { console.warn('Live2D на лендинге недоступен:', err); canvas.remove(); }
        }
        // Нет Live2D-модели — показываем аватар ассистента
        if (SHOWCASE.photo) {
            const img = document.createElement('img');
            img.src = SHOWCASE.photo; img.alt = name; img.className = 'hero-photo';
            stage.appendChild(img);
        }
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function add(text, cls) {
        const el = document.createElement('div');
        el.className = 'w-msg ' + cls; el.textContent = text;
        log.appendChild(el);
        while (log.children.length > 6) log.firstChild.remove();
        return el;
    }
    async function type(text) {
        typing.parentElement.classList.add('active');
        for (let i = 1; i <= text.length; i++) { typing.textContent = text.slice(0, i); await sleep(reduce ? 0 : 38); }
        await sleep(350);
        typing.textContent = 'Напишите сообщение…';
        typing.parentElement.classList.remove('active');
        add(text, 'u');
    }
    async function say(text, cls = 'a', cmd) {
        const t = add('', cls + ' typing');
        await sleep(900);
        t.classList.remove('typing'); t.textContent = text;
        if (cmd === 'nod') { target.ParamAngleY = -25; setTimeout(() => target.ParamAngleY = 15, 300); setTimeout(() => target.ParamAngleY = 0, 650); gif?.command('NOD_HEAD'); }
        if (cmd === 'tilt') { target.ParamAngleZ = 18; setTimeout(() => target.ParamAngleZ = 0, 2200); gif?.command('HEAD_TILT_RIGHT'); }
        // Губы шевелятся, пока «звучит» реплика
        const dur = 500 + text.length * 55, t0 = performance.now();
        await new Promise(res => (function step() {
            const t = performance.now() - t0;
            mouth = t < dur ? Math.abs(Math.sin(t / 85)) * (0.45 + 0.55 * Math.abs(Math.sin(t / 330))) : 0;
            gif?.setLevel(t < dur ? mouth : null);
            t < dur ? requestAnimationFrame(step) : res();
        })());
        mouth = 0;
    }

    async function scene() {
        while (true) {
            log.innerHTML = '';
            speaker.textContent = name; tag.textContent = 'ассистент'; tag.classList.remove('op');
            await say('Привет! Подсказать с выбором чая?', 'a', 'tilt');
            await sleep(900);
            await type('Есть доставка в Казань?');
            await say('Да! Привезём за 2 дня, а от 3 000 ₽ — бесплатно.', 'a', 'nod');
            await sleep(1100);
            await type('Позовите оператора, хочу поменять адрес');
            await say('Конечно, подключаю живого оператора.', 'a');
            await sleep(700);
            add('Оператор Анна подключилась', 's');
            speaker.textContent = 'Анна'; tag.textContent = 'оператор'; tag.classList.add('op');
            await sleep(800);
            const o = add('', 'o typing'); await sleep(1300);
            o.classList.remove('typing'); o.textContent = 'Здравствуйте! Сейчас поменяем — напишите новый адрес.';
            await sleep(4200);
        }
    }

    initCharacter();
    if (reduce) { add('Привет! Подсказать с выбором чая?', 'a'); add('Есть доставка в Казань?', 'u'); add('Да! Привезём за 2 дня.', 'a'); }
    else setTimeout(scene, 600);
})();
