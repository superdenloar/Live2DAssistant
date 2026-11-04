/**
 * Model3DAvatar — 3D-ассистент из файла .glb / .gltf (бета).
 *
 * Модель без скелета (например, из генератора), поэтому «оживляем» её целиком:
 *  • дыхание и лёгкое покачивание в покое;
 *  • поворот к курсору;
 *  • подпрыгивание в такт речи (громкость считается как у GIF-аватара);
 *  • кивок, покачивание, наклоны и взгляды по командам 【...】;
 *  • модель можно покрутить мышью.
 * Three.js загружается с CDN при первом использовании.
 *
 *   const { createModel3DAvatar } = await import('/static/model3d_avatar.js');
 *   const av = await createModel3DAvatar(container, cfg.model3d, { base: '' });
 */
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0';
let libsPromise = null;
function loadLibs() {
    if (!libsPromise) {
        libsPromise = Promise.all([
            import(CDN + '/+esm'),
            import(CDN + '/examples/jsm/loaders/GLTFLoader.js/+esm'),
            import(CDN + '/examples/jsm/libs/meshopt_decoder.module.js/+esm'),
            import(CDN + '/examples/jsm/utils/SkeletonUtils.js/+esm'),
        ]).then(([THREE, gltf, meshopt, skel]) => ({ THREE, GLTFLoader: gltf.GLTFLoader, MeshoptDecoder: meshopt.MeshoptDecoder, SkeletonUtils: skel }));
    }
    return libsPromise;
}

const NOISE_FLOOR = 0.008, INITIAL_MAX_VOL = 0.03, SMOOTHING = 0.35;
const modelCache = new Map(); // одна загрузка файла на страницу

function abs(base, url) {
    if (!url) return '';
    if (/^(https?:|data:|blob:)/.test(url)) return url;
    return (base || '') + url;
}

export class Model3DAvatar {
    constructor(container, cfg, opts = {}) {
        this.container = container;
        this.base = opts.base || '';
        this.onProgress = opts.onProgress || null;
        this.cfg = {};
        this.level = 0; this.raw = 0; this.smooth = 0; this.maxVol = INITIAL_MAX_VOL;
        this.manualLevel = null; this.analyser = null; this.buf = null;
        this.look = { x: 0, y: 0 }; this.pose = { x: 0, y: 0, z: 0 }; this.poseUntil = 0;
        this.anim = null; this.dragY = 0; this.dragging = false;
        this.t0 = performance.now();

        this.wrap = document.createElement('div');
        this.wrap.style.cssText = 'position:absolute;inset:0;touch-action:none;cursor:grab';
        this.status = document.createElement('div');
        this.status.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 13px system-ui,sans-serif;color:rgba(120,110,160,.9);background:rgba(255,255,255,.75);padding:8px 14px;border-radius:12px;pointer-events:none';
        this.status.textContent = 'Загружаю 3D-модель…';
        this.wrap.appendChild(this.status);
        container.appendChild(this.wrap);
        this.ready = this._init(cfg);
    }

    async _init(cfg) {
        const { THREE, GLTFLoader, MeshoptDecoder } = await loadLibs();
        this.THREE = THREE;
        const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.05;
        r.domElement.style.cssText = 'width:100%;height:100%;display:block';
        this.wrap.prepend(r.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(28, 1, 0.01, 50);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a8ff, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2, 2.5); this.scene.add(key);
        const rim = new THREE.DirectionalLight(0xffb3d6, 1.4); rim.position.set(-2, 1.5, -2); this.scene.add(rim);

        // pivot (повороты, дыхание) -> holder (масштаб, сдвиг) -> модель
        this.pivot = new THREE.Group(); this.holder = new THREE.Group();
        this.pivot.add(this.holder); this.scene.add(this.pivot);

        this.cfg = Object.assign({ url: '', scale: 1, offset_y: 0, rotate_y: 0, follow: true }, cfg || {});
        await this._loadModel(GLTFLoader, MeshoptDecoder);
        this._bindPointer();
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.container);
        this._resize();
        this._tick = this._tick.bind(this);
        this._raf = requestAnimationFrame(this._tick);
        return this;
    }

    async _loadModel(GLTFLoader, MeshoptDecoder) {
        const THREE = this.THREE;
        const url = abs(this.base, this.cfg.url);
        if (!url) { this.status.textContent = 'Выберите или загрузите 3D-модель (.glb)'; return; }
        try {
            if (!modelCache.has(url)) {
                const loader = new GLTFLoader();
                loader.setMeshoptDecoder(MeshoptDecoder);
                modelCache.set(url, new Promise((ok, fail) => loader.load(url, ok, (e) => {
                    if (e.total) { const p = Math.round(e.loaded / e.total * 100); this.status.textContent = `Загружаю 3D-модель… ${p}%`; this.onProgress && this.onProgress(p); }
                }, fail)));
            }
            const gltf = await modelCache.get(url);
            const { SkeletonUtils } = await loadLibs();
            const model = SkeletonUtils.clone(gltf.scene); // корректная копия со скелетом
            // Нормируем: высота 1, ноги на нуле, центр по X/Z
            model.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(model, true); // точный бокс (учитывает скиннинг)
            const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
            const k = 1 / (size.y || 1);
            model.scale.setScalar(k);
            model.position.set(-center.x * k, -box.min.y * k, -center.z * k);
            model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; if (o.material) o.material.side = THREE.FrontSide; } });
            this.holder.clear();
            this.holder.add(model);
            this.model = model;
            // Риг: кости головы/шеи/корпуса и морфы лица (моргание, рот)
            this.bones = {};
            ['hips', 'spine', 'chest', 'neck', 'head'].forEach(n => {
                const b = model.getObjectByName(n);
                if (b && b.isBone) this.bones[n] = { bone: b, rest: b.quaternion.clone() };
            });
            this.morphMeshes = [];
            model.traverse(o => {
                if (o.isMesh && o.morphTargetDictionary) {
                    this.morphMeshes.push(o);
                    // веки/рот — тонкие накладки, их нельзя отсекать по обратной стороне
                    if (o.material) o.material.side = THREE.DoubleSide;
                    // в открытом состоянии накладка сложена, нормали из файла бессмысленны → смотрим «вперёд»
                    const nrm = o.geometry.attributes.normal;
                    if (nrm) { for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 0, 1); nrm.needsUpdate = true; }
                }
            });
            this.rigged = !!this.bones.head;
            this.headRot = { x: 0, y: 0, z: 0 };
            this.blinkState = { next: performance.now() + 1500, start: 0, double: false };
            this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
            if (gltf.animations && gltf.animations.length) {
                this.mixer = new THREE.AnimationMixer(model);
                this.mixer.clipAction(gltf.animations[0]).play();
            }
            this.status.remove();
            this._applyCfg();
        } catch (e) {
            console.warn('[3D] Модель не загрузилась:', e);
            this.status.textContent = 'Не удалось загрузить 3D-модель';
            modelCache.delete(url);
        }
    }

    _applyCfg() {
        if (!this.holder) return;
        const c = this.cfg;
        this.holder.scale.setScalar(c.scale || 1);
        this.holder.position.y = (c.offset_y || 0) / 100;
        this.holder.position.x = (c.offset_x || 0) / 100;
        this.baseRotY = (c.rotate_y || 0) * Math.PI / 180;
    }

    async update(cfg) {
        const prev = this.cfg.url;
        this.cfg = Object.assign({}, this.cfg, cfg || {});
        if (!this.THREE) { await this.ready; }
        if (this.cfg.url !== prev) {
            const { GLTFLoader, MeshoptDecoder } = await loadLibs();
            if (!this.status.isConnected) { this.status.textContent = 'Загружаю 3D-модель…'; this.wrap.appendChild(this.status); }
            await this._loadModel(GLTFLoader, MeshoptDecoder);
        }
        this._applyCfg();
    }

    _resize() {
        if (!this.renderer) return;
        const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        // Камера смотрит на модель высотой 1 так, чтобы она помещалась целиком
        const fov = this.camera.fov * Math.PI / 180;
        const dist = 0.62 / Math.tan(fov / 2) * Math.max(1, 0.45 / this.camera.aspect);
        this.camera.position.set(0, 0.55, dist);
        this.camera.lookAt(0, 0.5, 0);
        this.camera.updateProjectionMatrix();
    }

    _bindPointer() {
        const el = this.wrap;
        let lastX = 0;
        this._onMove = (e) => {
            const b = this.container.getBoundingClientRect();
            this.look.x = Math.max(-1, Math.min(1, ((e.clientX - b.left) / b.width) * 2 - 1));
            this.look.y = Math.max(-1, Math.min(1, ((e.clientY - b.top) / b.height) * 2 - 1));
            if (this.dragging) { this.dragY += (e.clientX - lastX) * 0.01; lastX = e.clientX; }
        };
        el.addEventListener('pointerdown', e => { this.dragging = true; lastX = e.clientX; el.style.cursor = 'grabbing'; });
        this._onUp = () => { this.dragging = false; el.style.cursor = 'grab'; };
        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
    }

    _setMorph(name, v) {
        for (const m of this.morphMeshes) {
            const i = m.morphTargetDictionary[name];
            if (i !== undefined) m.morphTargetInfluences[i] = v;
        }
    }
    _rot(name, x, y, z) {
        const b = this.bones[name]; if (!b) return;
        this._e.set(x, y, z, 'YXZ');
        b.bone.quaternion.copy(b.rest).multiply(this._q.setFromEuler(this._e));
    }
    /** Данные лица с веб-камеры (или null, чтобы вернуть обычную анимацию). */
    setFace(face) { this.face = face; }

    attachAnalyser(analyser) { this.analyser = analyser; this.buf = new Float32Array(analyser.fftSize); this.maxVol = INITIAL_MAX_VOL; }
    detach() { this.analyser = null; }
    setLevel(l) { this.manualLevel = l; }

    _volume() {
        if (!this.analyser) return 0;
        this.analyser.getFloatTimeDomainData(this.buf);
        let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
        return Math.sqrt(s / this.buf.length);
    }

    command(cmd) {
        const now = performance.now();
        const poses = { LOOK_LEFT: { y: -0.45 }, LOOK_RIGHT: { y: 0.45 }, LOOK_UP: { x: -0.18 }, LOOK_DOWN: { x: 0.18 },
            HEAD_TILT_LEFT: { z: 0.12 }, HEAD_TILT_RIGHT: { z: -0.12 } };
        if (cmd === 'NOD_HEAD' || cmd === 'NOD') { this.anim = { type: 'nod', t: now }; return; }
        if (cmd === 'SHAKE_HEAD' || cmd === 'SHAKE') { this.anim = { type: 'shake', t: now }; return; }
        if (cmd === 'RESET') { this.pose = { x: 0, y: 0, z: 0 }; this.poseUntil = 0; return; }
        if (poses[cmd]) { this.pose = Object.assign({ x: 0, y: 0, z: 0 }, poses[cmd]); this.poseUntil = now + 4000; }
    }

    _tick(now) {
        this._raf = requestAnimationFrame(this._tick);
        if (!this.model) { this.renderer && this.renderer.render(this.scene, this.camera); return; }
        const t = (now - this.t0) / 1000;
        // громкость речи -> уровень 0..1 (как в GIF-аватаре и example.py)
        let lvl;
        if (this.manualLevel !== null) lvl = this.manualLevel;
        else {
            this.raw = this._volume();
            const k = this.raw > this.smooth ? Math.min(1, SMOOTHING * 1.5) : SMOOTHING;
            this.smooth += (this.raw - this.smooth) * k;
            if (this.smooth > this.maxVol && this.smooth > NOISE_FLOOR) this.maxVol = this.smooth;
            lvl = this.smooth <= NOISE_FLOOR ? 0 : Math.min(1, (this.smooth - NOISE_FLOOR) / Math.max(0.0001, this.maxVol - NOISE_FLOOR));
        }
        this.level += (lvl - this.level) * 0.4;

        if (now > this.poseUntil) this.pose = { x: 0, y: 0, z: 0 };
        const follow = this.cfg.follow !== false;
        let nodX = 0, shakeY = 0;
        if (this.anim) {
            const a = (now - this.anim.t) / 1000;
            if (a > 1) this.anim = null;
            else if (this.anim.type === 'nod') nodX = Math.sin(a * Math.PI * 4) * 0.22 * (1 - a);
            else shakeY = Math.sin(a * Math.PI * 4) * 0.4 * (1 - a);
        }
        if (!this.dragging) this.dragY *= 0.985; // после вращения мышью плавно возвращается
        const p = this.pivot, face = this.face;

        if (this.rigged) {
            // --- Лицо: моргание и рот ---
            let bl, br, mouth;
            if (face) { bl = face.blinkL; br = face.blinkR; mouth = face.jaw; }
            else {
                const b = this.blinkState;
                if (now >= b.next && !b.start) b.start = now;
                let v = 0;
                if (b.start) {
                    const e = (now - b.start) / 150;           // 150 мс на моргание
                    v = e < 0.5 ? e * 2 : Math.max(0, 2 - e * 2);
                    if (e >= 1) { b.start = 0; b.next = now + (b.double ? 180 : 2200 + Math.random() * 3800); b.double = !b.double && Math.random() < 0.2; }
                }
                bl = br = v;
                mouth = Math.min(1, this.level * 1.15);
            }
            this._setMorph('blinkLeft', bl); this._setMorph('blinkRight', br); this._setMorph('mouthOpen', mouth);

            // --- Голова и шея ---
            let tx, ty, tz;
            if (face) { tx = face.pitch; ty = face.yaw; tz = face.roll; }
            else {
                tx = this.pose.x * 1.6 + (follow ? this.look.y * 0.22 : 0) + Math.sin(t * 0.7) * 0.02 - this.level * 0.04 * Math.sin(t * 7);
                ty = this.pose.y * 1.3 + (follow ? this.look.x * 0.5 : 0) + Math.sin(t * 0.45) * 0.04;
                tz = this.pose.z * 1.6 + Math.sin(t * 0.6 + 1) * 0.03;
            }
            tx += nodX; ty += shakeY;
            const hk = face ? 0.5 : 0.12, h = this.headRot;
            h.x += (tx - h.x) * hk; h.y += (ty - h.y) * hk; h.z += (tz - h.z) * hk;
            this._rot('head', h.x * 0.7, h.y * 0.7, h.z * 0.7);
            this._rot('neck', h.x * 0.3, h.y * 0.3, h.z * 0.3);
            // --- Корпус: дыхание и лёгкое покачивание ---
            this._rot('chest', Math.sin(t * 2.2) * 0.018 - this.level * 0.02, h.y * 0.12, Math.sin(t * 0.9) * 0.01);
            this._rot('spine', 0, h.y * 0.06, Math.sin(t * 0.9 + 0.5) * 0.012);
            const ry = this.baseRotY + this.dragY + (follow && !face ? this.look.x * 0.08 : 0);
            p.rotation.y += (ry - p.rotation.y) * 0.08;
            p.rotation.x += (0 - p.rotation.x) * 0.08;
            p.rotation.z += (0 - p.rotation.z) * 0.08;
            p.scale.set(1, 1, 1);
            p.position.y = 0;
        } else {
            let ry = this.baseRotY + this.dragY + this.pose.y + shakeY + (follow ? this.look.x * 0.35 : 0);
            let rx = this.pose.x + nodX * 0.5 + (follow ? this.look.y * 0.08 : 0);
            let rz = this.pose.z + Math.sin(t * 0.9) * 0.015;
            if (face) { ry = this.baseRotY + face.yaw * 0.6; rx = face.pitch * 0.4; rz = face.roll * 0.5; }
            p.rotation.y += (ry - p.rotation.y) * 0.08;
            p.rotation.x += (rx - p.rotation.x) * 0.08;
            p.rotation.z += (rz - p.rotation.z) * 0.08;
            const lv = face ? face.jaw : this.level;
            p.scale.set(1 + lv * 0.012, 1 + Math.sin(t * 2.2) * 0.006 + lv * 0.02, 1);
            p.position.y = lv * 0.025 + Math.abs(Math.sin(t * 9)) * lv * 0.012;
        }
        if (this.mixer) this.mixer.update(1 / 60);
        this.renderer.render(this.scene, this.camera);
    }

    /** Снимок текущего кадра (для аватарки ассистента). */
    snapshot(size = 320) {
        if (!this.renderer || !this.model) return null;
        this.renderer.render(this.scene, this.camera);
        const src = this.renderer.domElement, c = document.createElement('canvas');
        c.width = c.height = size;
        const s = Math.min(src.width, src.height * 0.62);
        c.getContext('2d').drawImage(src, (src.width - s) / 2, src.height * 0.02, s, s, 0, 0, size, size);
        return c;
    }

    destroy() {
        cancelAnimationFrame(this._raf);
        this._ro && this._ro.disconnect();
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        this.renderer && this.renderer.dispose();
        this.wrap.remove();
    }
}

export async function createModel3DAvatar(container, cfg, opts) {
    const av = new Model3DAvatar(container, cfg, opts);
    try { await av.ready; } catch (e) { console.warn('[3D]', e); av.status.textContent = 'Не удалось загрузить 3D (нужен интернет для three.js)'; }
    return av;
}
