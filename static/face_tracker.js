/**
 * Захват лица с веб-камеры (MediaPipe Face Landmarker) — «по приколу», как у VTuber'ов.
 * Возвращает поворот головы, открытие рта и моргание; всё отражено как в зеркале.
 *
 *   const { startFaceTracking } = await import('/static/face_tracker.js');
 *   const stop = await startFaceTracking(face => { ... face.yaw, face.pitch, face.roll, face.jaw, face.blinkL, face.blinkR });
 *   stop();
 */
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarkerPromise = null;
async function getLandmarker() {
    if (!landmarkerPromise) {
        landmarkerPromise = (async () => {
            const vision = await import(VISION + '/vision_bundle.mjs');
            const files = await vision.FilesetResolver.forVisionTasks(VISION + '/wasm');
            return vision.FaceLandmarker.createFromOptions(files, {
                baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
                runningMode: 'VIDEO', numFaces: 1,
                outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
            });
        })().catch(e => { landmarkerPromise = null; throw e; });
    }
    return landmarkerPromise;
}

function previewBox(video, onStop) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;width:200px;border-radius:16px;overflow:hidden;background:#1E1838;box-shadow:0 20px 50px -20px rgba(0,0,0,.6);font:600 12px system-ui,sans-serif;color:#fff';
    video.style.cssText = 'width:100%;display:block;transform:scaleX(-1)';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px';
    bar.innerHTML = '<span>● Камера: отслеживаю лицо</span>';
    const btn = document.createElement('button');
    btn.textContent = 'Стоп';
    btn.style.cssText = 'border:0;border-radius:8px;padding:4px 10px;background:#FF6FAE;color:#fff;font:inherit;cursor:pointer';
    btn.onclick = onStop;
    bar.appendChild(btn);
    box.appendChild(video); box.appendChild(bar);
    document.body.appendChild(box);
    return box;
}

export async function startFaceTracking(onFace, opts = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play();
    let running = true, raf = 0, lastT = -1;
    const stop = () => {
        running = false; cancelAnimationFrame(raf);
        stream.getTracks().forEach(t => t.stop());
        box.remove();
        onFace(null);
        opts.onStop && opts.onStop();
    };
    const box = previewBox(video, stop);
    const lm = await getLandmarker();
    const smooth = { yaw: 0, pitch: 0, roll: 0, jaw: 0, blinkL: 0, blinkR: 0 };
    const k = 0.45;
    function loop() {
        if (!running) return;
        raf = requestAnimationFrame(loop);
        if (video.currentTime === lastT) return;
        lastT = video.currentTime;
        const res = lm.detectForVideo(video, performance.now());
        if (!res.faceBlendshapes || !res.faceBlendshapes.length) return;
        const bs = {};
        res.faceBlendshapes[0].categories.forEach(c => { bs[c.categoryName] = c.score; });
        const m = res.facialTransformationMatrixes[0].data; // 4x4, по столбцам
        const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9])));
        const yaw = Math.atan2(m[8], m[10]);
        const roll = Math.atan2(m[1], m[5]);
        // Зеркально: повернулся вправо — персонаж поворачивается туда же на экране
        const raw = {
            yaw: -yaw, pitch: pitch, roll: -roll,
            jaw: Math.min(1, (bs.jawOpen || 0) * 1.6),
            blinkL: Math.min(1, (bs.eyeBlinkRight || 0) * 1.25),
            blinkR: Math.min(1, (bs.eyeBlinkLeft || 0) * 1.25),
        };
        for (const key in raw) smooth[key] += (raw[key] - smooth[key]) * k;
        onFace(Object.assign({}, smooth));
    }
    loop();
    return stop;
}
