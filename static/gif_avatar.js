/**
 * GifAvatar — «говорящая картинка» для Live2D Assistant.
 *
 * Работает так же, как example.py (GIF-VTuber), только в браузере и от голоса ассистента:
 *  • режим "frames": GIF раскладывается на кадры; кадр 0 — рот закрыт, последний — открыт.
 *    Громкость речи (RMS) сглаживается и переводится в номер кадра, потолок громкости
 *    подстраивается сам.
 *  • режим "swap": две картинки — «молчит» и «говорит» (можно анимированный GIF).
 * Плюс лёгкое «дыхание» и реакции на команды 【Киваю головой】 и т.п., как у Live2D.
 *
 *   const av = new GifAvatar(containerEl, cfg.gif, { base: 'http://127.0.0.1:5000' });
 *   av.attachAnalyser(analyserNode);  // во время воспроизведения речи
 *   av.command('NOD_HEAD');
 */
(function (global) {
    'use strict';

    const STYLE_ID = 'gav-style';
    const CSS = `
.gav{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.gav-body{position:absolute;left:50%;bottom:0;transform-origin:50% 100%;width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center}
.gav-head{transform-origin:50% 85%;transition:transform .45s cubic-bezier(.3,.9,.3,1.1);display:flex;align-items:flex-end;justify-content:center;height:92%;width:100%}
.gav-breath{display:flex;align-items:flex-end;justify-content:center;height:100%;width:100%;transform-origin:50% 100%}
.gav.breathing .gav-breath{animation:gav-breath 3.6s ease-in-out infinite}
.gav-img{max-width:100%;max-height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;filter:drop-shadow(0 18px 24px rgba(40,20,90,.18))}
.gav.nod .gav-head{animation:gav-nod .9s ease-in-out}
.gav.shake .gav-head{animation:gav-shake .9s ease-in-out}
@keyframes gav-breath{0%,100%{transform:scale(1,1)}50%{transform:scale(1.006,1.018)}}
@keyframes gav-nod{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(10px) rotate(2deg)}50%{transform:translateY(0)}75%{transform:translateY(8px) rotate(1deg)}}
@keyframes gav-shake{0%,100%{transform:translateX(0) rotate(0)}20%{transform:translateX(-10px) rotate(-3deg)}40%{transform:translateX(10px) rotate(3deg)}60%{transform:translateX(-8px) rotate(-2deg)}80%{transform:translateX(6px) rotate(1deg)}}
`;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID; s.textContent = CSS;
        document.head.appendChild(s);
    }

    // Те же константы, что в example.py
    const NOISE_FLOOR = 0.008;      // порог тишины
    const INITIAL_MAX_VOL = 0.03;   // стартовый потолок громкости (растёт сам, когда звук громче)
    const SMOOTHING = 0.35;         // плавность смены кадров

    function abs(base, url) {
        if (!url) return '';
        if (/^(https?:|data:|blob:)/.test(url)) return url;
        return (base || '') + url;
    }

    class GifAvatar {
        constructor(container, cfg, opts = {}) {
            injectStyle();
            this.container = container;
            this.base = opts.base || '';
            this.cfg = {};
            this.frames = [];          // массив URL кадров
            this.frameImgs = [];
            this.analyser = null;
            this.buf = null;
            this.raw = 0; this.smooth = 0;
            this.maxVol = INITIAL_MAX_VOL;
            this.curFrame = -1;
            this.speakingSince = 0;
            this.lastLoud = 0;
            this.manualLevel = null;   // для превью ползунков
            this.onFrame = opts.onFrame || null;

            this.root = document.createElement('div');
            this.root.className = 'gav';
            this.root.innerHTML = '<div class="gav-body"><div class="gav-head"><div class="gav-breath"></div></div></div>';
            this.body = this.root.querySelector('.gav-body');
            this.head = this.root.querySelector('.gav-head');
            this.breath = this.root.querySelector('.gav-breath');
            this.img = document.createElement('img');
            this.img.className = 'gav-img';
            this.img.alt = '';
            container.appendChild(this.root);

            this._tick = this._tick.bind(this);
            this.update(cfg || {});
            this._raf = requestAnimationFrame(this._tick);
        }

        update(cfg) {
            this.cfg = Object.assign({ mode: 'frames', frames: [], scale: 1, offset_x: 0, offset_y: 0, noise_floor: NOISE_FLOOR, smoothing: SMOOTHING, breathing: true }, cfg || {});
            this.root.classList.toggle('breathing', !!this.cfg.breathing);
            this.body.style.transform = `translateX(calc(-50% + ${this.cfg.offset_x || 0}px)) translateY(${-(this.cfg.offset_y || 0)}px) scale(${this.cfg.scale || 1})`;
            this.frames = (this.cfg.frames || []).map(u => abs(this.base, u));
            this.frameImgs = this.frames.map(u => { const i = new Image(); i.src = u; return i; });
            this.curFrame = -1;
            this._mountVisual();
            if (this.cfg.mode === 'frames' && !this.frames.length && this.cfg.source_url) {
                // Сервер не смог разложить GIF (нет Pillow) — пробуем сами
                GifAvatar.decodeGif(abs(this.base, this.cfg.source_url)).then(list => {
                    if (list.length) { this.frames = list; this.frameImgs = list.map(u => { const i = new Image(); i.src = u; return i; }); this._mountVisual(); }
                }).catch(() => { });
            }
        }

        hasImage() {
            if (this.cfg.mode === 'swap') return !!(this.cfg.idle_url || this.cfg.talk_url);
            return this.frames.length > 0 || !!this.cfg.source_url;
        }

        _mountVisual() {
            this.breath.innerHTML = '';
            this.empty = false;
            if (!this.hasImage()) {
                // Картинок нет: показываем аватар ассистента (если передан), иначе ничего
                if (this.cfg.fallback_url) { this.breath.appendChild(this.img); this.img.src = abs(this.base, this.cfg.fallback_url); }
                this.empty = true;
                return;
            }
            this.breath.appendChild(this.img);
            if (this.cfg.mode === 'swap') {
                this.img.src = abs(this.base, this.cfg.idle_url || this.cfg.talk_url);
                this.swapState = 'idle';
            } else if (this.frames.length) {
                this.img.src = this.frames[0]; this.curFrame = 0;
            } else {
                this.img.src = abs(this.base, this.cfg.source_url); // пока кадры не готовы — показываем GIF как есть
            }
        }

        attachAnalyser(analyser) {
            this.analyser = analyser;
            this.buf = new Float32Array(analyser.fftSize);
            this.maxVol = INITIAL_MAX_VOL; // как сброс рекорда в example.py — для каждой новой реплики
        }
        detach() { this.analyser = null; }

        // Уровень 0..1 задаётся вручную (например, для превью без звука)
        setLevel(level) { this.manualLevel = level; }

        _volume() {
            if (!this.analyser) return 0;
            this.analyser.getFloatTimeDomainData(this.buf);
            let s = 0;
            for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
            return Math.sqrt(s / this.buf.length);
        }

        _tick() {
            this._raf = requestAnimationFrame(this._tick);
            const noise = Number(this.cfg.noise_floor ?? NOISE_FLOOR);
            const k = Number(this.cfg.smoothing ?? SMOOTHING);
            let ratio;
            if (this.manualLevel !== null) {
                ratio = this.manualLevel;
            } else {
                this.raw = this._volume();
                // Рот открывается быстро, закрывается плавно — как в example.py
                const kk = this.raw > this.smooth ? Math.min(1, k * 1.5) : k;
                this.smooth += (this.raw - this.smooth) * kk;
                if (this.smooth > this.maxVol && this.smooth > noise) this.maxVol = this.smooth;
                ratio = this.smooth <= noise ? 0 : Math.max(0, Math.min(1, (this.smooth - noise) / Math.max(0.0001, this.maxVol - noise)));
            }
            this.level = ratio;
            // Лёгкое «подпрыгивание» в такт речи
            this.breath.style.translate = ratio > 0 ? `0 ${-ratio * 4}px` : '';

            if (this.empty) return;
            if (this.cfg.mode === 'swap') {
                const now = performance.now();
                if (ratio > 0.08) this.lastLoud = now;
                const talking = now - this.lastLoud < 140; // держим «говорит» чуть дольше, чтобы не мерцало
                const want = talking ? 'talk' : 'idle';
                if (want !== this.swapState) {
                    this.swapState = want;
                    const url = want === 'talk' ? (this.cfg.talk_url || this.cfg.idle_url) : (this.cfg.idle_url || this.cfg.talk_url);
                    this.img.src = abs(this.base, url);
                }
                return;
            }
            if (this.frames.length) {
                const target = Math.round(ratio * (this.frames.length - 1));
                if (target !== this.curFrame) {
                    this.curFrame = target;
                    this.img.src = this.frames[target];
                    if (this.onFrame) this.onFrame(target);
                }
            }
        }

        command(cmd) {
            const h = this.head;
            const pose = { LOOK_LEFT: 'translateX(-8px) rotate(-4deg)', LOOK_RIGHT: 'translateX(8px) rotate(4deg)',
                LOOK_UP: 'translateY(-6px)', LOOK_DOWN: 'translateY(6px) rotate(1deg)',
                HEAD_TILT_LEFT: 'rotate(-8deg)', HEAD_TILT_RIGHT: 'rotate(8deg)' };
            if (cmd === 'NOD_HEAD' || cmd === 'NOD') return this._flash('nod');
            if (cmd === 'SHAKE_HEAD' || cmd === 'SHAKE') return this._flash('shake');
            if (cmd === 'RESET') { h.style.transform = ''; return; }
            if (pose[cmd]) {
                h.style.transform = pose[cmd];
                clearTimeout(this._poseT);
                this._poseT = setTimeout(() => { h.style.transform = ''; }, 4000);
            }
        }
        _flash(cls) {
            this.root.classList.remove('nod', 'shake');
            void this.root.offsetWidth;
            this.root.classList.add(cls);
            setTimeout(() => this.root.classList.remove(cls), 950);
        }

        destroy() {
            cancelAnimationFrame(this._raf);
            this.root.remove();
        }

        /** Раскладывает GIF на кадры прямо в браузере (WebCodecs ImageDecoder). Возвращает blob-URL. */
        static async decodeGif(url, max = 48) {
            if (!('ImageDecoder' in window)) return [];
            const resp = await fetch(url);
            const decoder = new ImageDecoder({ data: resp.body, type: 'image/gif' });
            await decoder.tracks.ready;
            const count = decoder.tracks.selectedTrack.frameCount;
            const step = Math.max(1, Math.ceil(count / max));
            const out = [];
            for (let i = 0; i < count; i += step) {
                const { image } = await decoder.decode({ frameIndex: i });
                const c = document.createElement('canvas');
                c.width = image.displayWidth; c.height = image.displayHeight;
                c.getContext('2d').drawImage(image, 0, 0);
                image.close();
                const blob = await new Promise(r => c.toBlob(r, 'image/png'));
                out.push(URL.createObjectURL(blob));
            }
            return out;
        }
    }

    global.GifAvatar = GifAvatar;
})(window);
