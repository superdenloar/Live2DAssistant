document.addEventListener('DOMContentLoaded', () => {
    console.log("[DEBUG] Скрипт для редактора ассистента загружен.");

    // --- ЭЛЕМЕНТЫ DOM ---
    const canvas = document.getElementById('live2d-canvas-editor');
    const modelSelect = document.getElementById('live2d-model-select');
    const ttsModelSelect = document.getElementById('silero-model-select');
    const ttsSpeakerSelect = document.getElementById('silero-speaker-select');
    const ttsTestInput = document.getElementById('tts-test-input');
    const ttsTestBtn = document.getElementById('tts-test-btn');
    const scaleSlider = document.getElementById('model-scale');
    const posXSlider = document.getElementById('model-pos-x');
    const posYSlider = document.getElementById('model-pos-y');
    const mouthMinInput = document.getElementById('mouth-min');
    const mouthMaxInput = document.getElementById('mouth-max');
    const jitterStrInput = document.getElementById('mouth-jitter-str');
    const jitterSpeedInput = document.getElementById('mouth-jitter-speed');
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.getElementById('sidebar');
    const closeSidebarButton = document.getElementById('sidebar-close-btn');

    // Элементы модального окна аватара
    const avatarEditor = document.querySelector('.avatar-editor');
    const mainEditorAvatar = document.querySelector('.editor-avatar');
    const avatarModal = document.getElementById('avatar-modal');
    const cropperImage = document.getElementById('avatar-cropper-image');
    const avatarUploadInput = document.getElementById('avatar-upload-input');
    const chooseFileBtn = document.getElementById('avatar-choose-file-btn');
    const saveAvatarBtn = document.getElementById('save-avatar-btn');
    const setDefaultAvatarBtn = document.getElementById('set-default-avatar-btn');
    
    // Элементы системы скуки
    const addPhraseInput = document.getElementById('new-boredom-phrase-input');
    const addPhraseBtn = document.getElementById('add-boredom-phrase-btn');
    const phrasesList = document.getElementById('boredom-phrases-list');

    // Элементы системы поглаживания
    const pattingEnabledCheckbox = document.getElementById('patting-enabled');
    const pattingTiltSlider = document.getElementById('patting-tilt');
    const pattingEyeSlider = document.getElementById('patting-eye');
    const pattingFollowSlider = document.getElementById('patting-follow');

    // --- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ---
    let live2dApp = null, currentModel = null, audioContext = null, analyser = null;
    let isLipSyncRunning = false, cropper = null;
    let isPatting = false;

    // --- ФУНКЦИЯ ЗАГРУЗКИ LIVE2D МОДЕЛИ ---
    async function loadLive2DModel(modelPath) {
        if (!modelPath || modelPath === "") {
            if (live2dApp && currentModel) { live2dApp.stage.removeChild(currentModel); currentModel = null; }
            return;
        }
        try {
            if (!live2dApp) {
                live2dApp = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: canvas.parentElement, backgroundColor: 0x000000, backgroundAlpha: 0 });
            }
            if (currentModel) { live2dApp.stage.removeChild(currentModel); }
            currentModel = await PIXI.live2d.Live2DModel.from(modelPath);
            currentModel.originalHeight = currentModel.height;
            live2dApp.stage.addChild(currentModel);
            updateModelTransform();
            currentModel.motion('Idle');
        } catch (error) { console.error("ОШИБКА LIVE2D:", error); }
    }
    
    // --- ФУНКЦИЯ ОБНОВЛЕНИЯ МАСШТАБА И ПОЗИЦИИ ---
    function updateModelTransform() {
        if (!currentModel) return;
        const scale = parseFloat(scaleSlider.value);
        const posX = parseInt(posXSlider.value);
        const posY = parseInt(posYSlider.value);
        const newScale = (canvas.parentElement.clientHeight / currentModel.originalHeight) * scale;
        currentModel.scale.set(newScale);
        currentModel.x = (canvas.parentElement.clientWidth / 2) - (currentModel.width / 2) + posX;
        currentModel.y = posY;
    }
    
    // --- ПРОДВИНУТАЯ ФУНКЦИЯ АНИМАЦИИ РТА ---
    function updateLipSync() {
        if (!isLipSyncRunning || !currentModel || !analyser) {
             if (currentModel?.internalModel) {
                 currentModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0);
             }
            return;
        }
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        let sum = 0; for (let i = 0; i < dataArray.length; i++) { sum += dataArray[i]; }
        let average = sum / dataArray.length;
        const minOpen = parseFloat(mouthMinInput.value);
        const maxOpen = parseFloat(mouthMaxInput.value);
        const jitterStrength = parseFloat(jitterStrInput.value);
        const jitterSpeed = parseFloat(jitterSpeedInput.value);
        let mouthOpenY = minOpen + (average / 255) * (maxOpen - minOpen);
        if (average > 10) { const jitter = Math.sin(Date.now() / jitterSpeed) * jitterStrength; mouthOpenY += jitter; }
        mouthOpenY = Math.max(0, Math.min(1.0, mouthOpenY));
        currentModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', mouthOpenY);
        requestAnimationFrame(updateLipSync);
    }
    
    // --- ФУНКЦИЯ ВОСПРОИЗВЕДЕНИЯ ТЕСТОВОГО АУДИО ---
    function playTestAudio(audioUrl) {
        if (!currentModel) { alert("Сначала выберите Live2D модель для превью анимации."); return; }
        if (!audioContext) { try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; } catch (e) { return; } }
        const audio = new Audio(audioUrl);
        const source = audioContext.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        audio.play().catch(e => console.error("Ошибка воспроизведения тестового аудио:", e));
        audio.onplay = () => { isLipSyncRunning = true; updateLipSync(); };
        audio.onended = () => { isLipSyncRunning = false; };
    }

    // --- ФУНКЦИЯ ДЛЯ ОБНОВЛЕНИЯ СПИСКА СПИКЕРОВ ---
    function updateSpeakerList() {
        const selectedModel = ttsModelSelect.value;
        const speakers = ALL_SPEAKERS[selectedModel] || [];
        const currentSpeaker = ttsSpeakerSelect.value;
        ttsSpeakerSelect.innerHTML = '';
        if (speakers.length === 0) {
            ttsSpeakerSelect.innerHTML = '<option value="">-- Выберите файл --</option>';
            return;
        }
        speakers.forEach(speaker => {
            const option = document.createElement('option');
            option.value = speaker;
            option.textContent = speaker;
            if (speaker === currentSpeaker) { option.selected = true; }
            ttsSpeakerSelect.appendChild(option);
        });
    }

    // --- ФУНКЦИЯ ДЛЯ СОЗДАНИЯ ЭЛЕМЕНТА СПИСКА ФРАЗ ---
    function createPhraseElement(id, text) {
        const item = document.createElement('div');
        item.className = 'dynamic-list-item';
        item.dataset.id = id;
        item.innerHTML = `<span>${text}</span>
                          <div class="item-controls">
                              <button type="button" class="icon-btn test-phrase-btn" title="Озвучить"><img src="/static/Img/play_icon.png"></button>
                              <button type="button" class="icon-btn delete-phrase-btn" title="Удалить"><img src="/static/Img/trash_can.png"></button>
                          </div>`;
        return item;
    }

    // --- ОБРАБОТЧИКИ СОБЫТИЙ ---

    if (modelSelect && modelSelect.value) { loadLive2DModel(modelSelect.value); }
    if (modelSelect) { modelSelect.addEventListener('change', () => { loadLive2DModel(modelSelect.value); }); }

    if (ttsModelSelect) { ttsModelSelect.addEventListener('change', updateSpeakerList); }

    if(ttsTestBtn) {
        ttsTestBtn.addEventListener('click', async () => {
            const text = ttsTestInput.value.trim();
            const ttsModelFile = ttsModelSelect.value;
            const ttsSpeaker = ttsSpeakerSelect.value;
            if (!text || !ttsModelFile || !ttsSpeaker) { alert("Пожалуйста, введите текст, выберите файл модели и голос спикера."); return; }
            ttsTestBtn.textContent = "Генерация...";
            ttsTestBtn.disabled = true;
            try {
                const response = await fetch('/assistant/test_tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text, model_name: ttsModelFile, speaker_name: ttsSpeaker })
                });
                if (!response.ok) throw new Error('Ошибка на сервере.');
                const data = await response.json();
                if (data.audio_url) { playTestAudio(data.audio_url); } 
                else { throw new Error('Сервер не вернул URL аудиофайла.'); }
            } catch (error) { console.error("Ошибка тестирования TTS:", error); alert("Не удалось сгенерировать речь.");
            } finally { ttsTestBtn.textContent = "Озвучить"; ttsTestBtn.disabled = false; }
        });
    }

    // "Двусторонняя связь" для слайдеров и полей ввода
    document.querySelectorAll('.setting-item').forEach(item => {
        const slider = item.querySelector('input[type="range"]');
        const numberInput = item.querySelector('input[type="number"]');
        if (slider && numberInput) {
            slider.addEventListener('input', () => {
                numberInput.value = slider.value;
                if (['model-scale', 'model-pos-x', 'model-pos-y'].includes(slider.id)) {
                    updateModelTransform();
                }
            });
            numberInput.addEventListener('input', () => {
                slider.value = numberInput.value;
                if (['model-scale', 'model-pos-x', 'model-pos-y'].includes(slider.id)) {
                    updateModelTransform();
                }
            });
        }
    });

    // --- ЛОГИКА РЕДАКТОРА АВАТАРА ---
    if (avatarEditor) {
        avatarEditor.addEventListener('click', () => {
            if (cropper) cropper.destroy();
            cropperImage.src = '';
            avatarUploadInput.value = '';
            avatarModal.style.display = 'flex';
        });
    }
    if (chooseFileBtn) { chooseFileBtn.addEventListener('click', () => avatarUploadInput.click()); }
    if (avatarUploadInput) {
        avatarUploadInput.addEventListener('change', (event) => {
            const files = event.target.files;
            if (files && files.length > 0) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (cropper) { cropper.destroy(); }
                    cropperImage.src = e.target.result;
                    cropper = new Cropper(cropperImage, { aspectRatio: 1 / 1, viewMode: 1, background: false, autoCropArea: 0.8 });
                };
                reader.readAsDataURL(files[0]);
            }
        });
    }
    if (saveAvatarBtn) {
        saveAvatarBtn.addEventListener('click', () => {
            if (!cropper) { alert("Пожалуйста, сначала выберите файл."); return; }
            const canvas = cropper.getCroppedCanvas({ width: 256, height: 256 });
            canvas.toBlob(async (blob) => {
                const assistantId = window.location.pathname.split('/').pop();
                const formData = new FormData();
                formData.append('avatar', blob, 'avatar.png');
                saveAvatarBtn.textContent = "Сохранение...";
                saveAvatarBtn.disabled = true;
                try {
                    const response = await fetch(`/assistant/${assistantId}/upload_avatar`, { method: 'POST', body: formData });
                    if (!response.ok) throw new Error("Ошибка при загрузке файла.");
                    const data = await response.json();
                    mainEditorAvatar.src = data.new_photo_url;
                    avatarModal.style.display = 'none';
                } catch (error) { console.error("Ошибка сохранения аватара:", error); alert("Не удалось сохранить аватар.");
                } finally { saveAvatarBtn.textContent = "Сохранить"; saveAvatarBtn.disabled = false; }
            }, 'image/png');
        });
    }
    if (setDefaultAvatarBtn) {
        setDefaultAvatarBtn.addEventListener('click', async () => {
            const assistantId = window.location.pathname.split('/').pop();
            try {
                const response = await fetch(`/assistant/${assistantId}/set_default_avatar`, { method: 'POST' });
                if (!response.ok) throw new Error("Ошибка при сбросе аватара.");
                const data = await response.json();
                mainEditorAvatar.src = data.new_photo_url;
                if (cropper) cropper.destroy();
                cropperImage.src = '';
                avatarModal.style.display = 'none';
            } catch (error) { console.error("Ошибка сброса аватара:", error); alert("Не удалось установить аватар по умолчанию."); }
        });
    }
    if (avatarModal) {
        const cancelBtn = avatarModal.querySelector('.btn-secondary:not(#set-default-avatar-btn):not(#avatar-choose-file-btn)');
        if(cancelBtn) cancelBtn.addEventListener('click', () => avatarModal.style.display = 'none');
        avatarModal.addEventListener('click', (e) => { if(e.target === avatarModal) avatarModal.style.display = 'none' });
    }
    
    // --- ЛОГИКА СПИСКА ФРАЗ СКУКИ ---
    if (addPhraseBtn) {
        addPhraseBtn.addEventListener('click', async () => {
            const text = addPhraseInput.value.trim();
            if (!text) return;
            const assistantId = window.location.pathname.split('/').pop();
            try {
                const response = await fetch(`/assistant/boredom/add/${assistantId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) });
                if (!response.ok) throw new Error('Ошибка сервера');
                const data = await response.json();
                phrasesList.appendChild(createPhraseElement(data.id, data.text));
                addPhraseInput.value = '';
            } catch (error) { console.error("Ошибка добавления фразы:", error); }
        });
    }
    if (phrasesList) {
        phrasesList.addEventListener('click', async (event) => {
            const target = event.target.closest('button');
            if (!target) return;
            const listItem = target.closest('.dynamic-list-item');
            const phraseId = listItem.dataset.id;
            if (target.classList.contains('delete-phrase-btn')) {
                try {
                    await fetch(`/assistant/boredom/delete/${phraseId}`, { method: 'POST' });
                    listItem.remove();
                } catch (error) { console.error("Ошибка удаления фразы:", error); }
            }
            if (target.classList.contains('test-phrase-btn')) {
                const phraseText = listItem.querySelector('span').textContent;
                ttsTestInput.value = phraseText;
                ttsTestBtn.click();
            }
        });
    }
        // --- ФИНАЛЬНАЯ, ПЛАВНАЯ ЛОГИКА СИСТЕМЫ ПОГЛАЖИВАНИЯ ---
    if (canvas) {
        let targetParameters = { x: 0, z: 0, bodyX: 0, eyeL: 1.0, eyeR: 1.0 };
        let currentParameters = { ...targetParameters };
        
        // Добавляем постоянный "тикер" для плавной анимации
        live2dApp.ticker.add(() => {
            if (!currentModel || isPatting) return;

            // Коэффициент плавности (чем меньше, тем плавнее)
            const lerpFactor = 0.1;

            // Плавно двигаем каждый параметр к его целевому значению (0 или 1)
            currentParameters.x += (targetParameters.x - currentParameters.x) * lerpFactor;
            currentParameters.z += (targetParameters.z - currentParameters.z) * lerpFactor;
            currentParameters.bodyX += (targetParameters.bodyX - currentParameters.bodyX) * lerpFactor;
            currentParameters.eyeL += (targetParameters.eyeL - currentParameters.eyeL) * lerpFactor;
            currentParameters.eyeR += (targetParameters.eyeR - currentParameters.eyeR) * lerpFactor;
            
            const coreModel = currentModel.internalModel.coreModel;
            coreModel.setParameterValueById('ParamAngleX', currentParameters.x);
            coreModel.setParameterValueById('ParamBodyAngleX', currentParameters.bodyX);
            coreModel.setParameterValueById('ParamAngleZ', currentParameters.z);
            coreModel.setParameterValueById('ParamEyeLOpen', currentParameters.eyeL);
            coreModel.setParameterValueById('ParamEyeROpen', currentParameters.eyeR);
        });

        // НАЖАТИЕ МЫШИ: Начинаем поглаживание
        canvas.addEventListener('mousedown', (e) => { 
            if (pattingEnabledCheckbox.checked && currentModel?.internalModel && e.offsetY < canvas.height / 3) {
                isPatting = true;
                currentModel.motionManager.stopAllMotions();
            }
        });

        // ДВИЖЕНИЕ МЫШИ: Следуем за курсором
        canvas.addEventListener('mousemove', (event) => {
            if (isPatting && currentModel?.internalModel) {
                const tiltAngle = parseFloat(pattingTiltSlider.value);
                const eyeClose = parseFloat(pattingEyeSlider.value);
                const followStrength = parseFloat(pattingFollowSlider.value);
                
                const bounds = canvas.getBoundingClientRect();
                const modelX = event.clientX - bounds.left - currentModel.x;
                const normalizedX = (modelX / currentModel.width) * 2 - 1;

                const coreModel = currentModel.internalModel.coreModel;
                
                // Устанавливаем параметры НАПРЯМУЮ, пока гладим
                coreModel.setParameterValueById('ParamAngleX', -tiltAngle); 
                coreModel.setParameterValueById('ParamBodyAngleX', -tiltAngle / 2);
                coreModel.setParameterValueById('ParamEyeLOpen', 1.0 - eyeClose);
                coreModel.setParameterValueById('ParamEyeROpen', 1.0 - eyeClose);
                coreModel.setParameterValueById('ParamAngleZ', normalizedX * (tiltAngle * 0.7) * followStrength);
                
                // Сохраняем текущие значения, чтобы знать, откуда начинать плавный возврат
                currentParameters = {
                    x: -tiltAngle,
                    z: normalizedX * (tiltAngle * 0.7) * followStrength,
                    bodyX: -tiltAngle / 2,
                    eyeL: 1.0 - eyeClose,
                    eyeR: 1.0 - eyeClose
                };
            }
        });

        // ОТПУСКАНИЕ МЫШИ: Заканчиваем поглаживание
        const stopPatting = () => {
            if (isPatting) {
                isPatting = false;
                // Запускаем стандартную idle анимацию
                currentModel.motion('Idle', 0, 3);
                
                // И говорим нашему тикеру, что теперь нужно плавно вернуть все в ноль
                targetParameters = { x: 0, z: 0, bodyX: 0, eyeL: 1.0, eyeR: 1.0 };
            }
        };
        
        window.addEventListener('mouseup', stopPatting);
    }

    // Общая логика сайдбара
    if (menuToggleBtn && sidebar) { menuToggleBtn.addEventListener('click', () => { sidebar.classList.add('open'); }); }
    if (closeSidebarButton && sidebar) { closeSidebarButton.addEventListener('click', () => { sidebar.classList.remove('open'); }); }
});