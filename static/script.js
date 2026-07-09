document.addEventListener('DOMContentLoaded', () => {
    // --- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ---
    let activeChatId = APP_CONFIG.active_chat_id;
    let activeAssistantConfig = { ...APP_CONFIG };
    let live2dApp = null;
    let live2dModel = null;
    let audioContext = null;
    let analyser = null;
    let isLipSyncRunning = false;
    let abortController = null;
    let isPatting = false; // Глобальный флаг состояния поглаживания
    let pattingReactionFlag = false; // Глобальный флаг для отправки на сервер
    let boredomTimer = null;

    // === ПЕРЕМЕННЫЕ ДЛЯ УПРАВЛЕНИЯ МОДЕЛЬЮ ===
    let targetParameters = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
    let poseLifetimeCounter = 0;
    let isFollowingCursor = false;

    // --- ЭЛЕМЕНТЫ DOM ---
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.getElementById('sidebar');
    const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
    const navButtons = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');
    const chatLog = document.getElementById('chat-log');
    const canvas = document.getElementById('live2d-canvas');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const recordBtn = document.getElementById('record-btn');
    const resetBtn = document.getElementById('reset-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const thinkingOverlay = document.getElementById('thinking-overlay');
    const createChatBtn = document.getElementById('create-chat-btn');
    const createChatModal = document.getElementById('create-chat-modal');
    const cancelCreateChatBtn = document.getElementById('cancel-create-chat-btn');
    const chatsList = document.getElementById('chats-list');
    const deleteConfirmModal = document.getElementById('delete-confirm-modal');
    const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
    const deleteConfirmText = document.getElementById('delete-confirm-text');
    const deleteConfirmForm = document.getElementById('delete-confirm-form');
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const closeChatSettingsModalBtn = chatSettingsModal ? chatSettingsModal.querySelector('.close-modal-btn') : null;
    const chatSettingsForm = document.getElementById('chat-settings-form');
    const editChatNameInput = document.getElementById('edit-chat-name-input');
    const editChatAssistantSelect = document.getElementById('edit-chat-assistant-select');
    const clearConfirmModal = document.getElementById('clear-confirm-modal');
    const cancelClearBtn = document.getElementById('cancel-clear-btn');
    const confirmClearBtn = document.getElementById('confirm-clear-btn');
    const saveProfileBtn = document.getElementById('save-profile-btn');

    // --- ЛОГИКА САЙДБАРА ---
    if (menuToggleBtn) menuToggleBtn.addEventListener('click', () => sidebar.classList.add('open'));
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', () => sidebar.classList.remove('open'));
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (views.length > 0) {
                navButtons.forEach(btn => btn.classList.remove('active'));
                views.forEach(view => view.classList.remove('active'));
                button.classList.add('active');
                const viewId = button.getAttribute('data-view');
                const targetView = document.getElementById(viewId);
                if (targetView) targetView.classList.add('active');
            }
        });
    });

    // --- ИНИЦИАЛИЗАЦИЯ LIVE2D И АНИМАЦИЙ ---
    async function initLive2DApp() {
        if (!canvas || live2dApp) return;
        live2dApp = new PIXI.Application({ view: canvas, autoStart: true, resizeTo: canvas.parentElement, backgroundColor: 0x000000, backgroundAlpha: 0 });
        
        // === ВСЯ ЛОГИКА ПОГЛАЖИВАНИЯ ТЕПЕРЬ НАДЕЖНО ИНКАПСУЛИРОВАНА ЗДЕСЬ ===
        let pattingTimer = null; // Локальный таймер, видимый только здесь

        const stopPatting = () => {
            clearTimeout(pattingTimer); // Теперь эта функция гарантированно видит таймер
            if (isPatting) {
                isPatting = false;
                if (live2dModel) {
                    live2dModel.motion('Idle', 0, 3);
                }
            }
        };
        // Привязываем слушатель к окну один раз при инициализации
        window.addEventListener('mouseup', stopPatting);
        
        // "Движок" модели
        let currentParameters = { ...targetParameters };
        live2dApp.ticker.add(() => {
            if (!live2dModel || isPatting || !live2dModel.internalModel) return;
            const lerpFactor = 0.1;
            for (const key in targetParameters) {
                if (currentParameters[key] === undefined) currentParameters[key] = targetParameters[key];
                currentParameters[key] += (targetParameters[key] - currentParameters[key]) * lerpFactor;
            }
            const coreModel = live2dModel.internalModel.coreModel;
            for (const key in currentParameters) {
                coreModel.setParameterValueById(key, currentParameters[key]);
            }
        });

        // Обработчики событий для canvas
        canvas.addEventListener('mousemove', (event) => {
            if (isFollowingCursor && live2dModel?.internalModel) {
                const bounds = canvas.getBoundingClientRect();
                const normalizedX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
                const normalizedY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
                targetParameters.ParamAngleX = normalizedX * 30;
                targetParameters.ParamAngleY = normalizedY * -30;
            }
        });
        
        canvas.addEventListener('mousedown', (e) => { 
            if (activeAssistantConfig.patting_enabled && live2dModel?.internalModel && e.offsetY < canvas.height / 3) {
                isPatting = true;
                live2dModel.motionManager.stopAllMotions();
                clearTimeout(pattingTimer);
                pattingTimer = setTimeout(() => {
                    pattingReactionFlag = true; // Устанавливаем глобальный флаг
                    console.log("Реакция на поглаживание активирована!");
                }, 3000);
            }
        });
        
        canvas.addEventListener('mousemove', (event) => {
            if (isPatting && live2dModel?.internalModel) {
                const tiltAngle = activeAssistantConfig.patting_tilt_angle; const eyeClose = activeAssistantConfig.patting_eye_close; const followStrength = activeAssistantConfig.patting_follow_strength;
                const bounds = canvas.getBoundingClientRect(); const modelX = event.clientX - bounds.left - live2dModel.x; const normalizedX = (modelX / live2dModel.width) * 2 - 1;
                const coreModel = live2dModel.internalModel.coreModel;
                coreModel.setParameterValueById('ParamAngleX', -tiltAngle); coreModel.setParameterValueById('ParamBodyAngleX', -tiltAngle / 2); coreModel.setParameterValueById('ParamEyeLOpen', 1.0 - eyeClose);
                coreModel.setParameterValueById('ParamEyeROpen', 1.0 - eyeClose); coreModel.setParameterValueById('ParamAngleZ', normalizedX * (tiltAngle * 0.7) * followStrength);
            }
        });
    }
    
    async function loadLive2DModel(modelPath) {
        await initLive2DApp();
        try {
            if (live2dModel) {
                live2dApp.stage.removeChild(live2dModel);
                live2dModel.destroy();
                live2dModel = null;
            }
            live2dApp.stage.removeChildren();
            if (!modelPath) return;
            live2dModel = await PIXI.live2d.Live2DModel.from(modelPath);
            live2dApp.stage.addChild(live2dModel);
            updateModelTransform();
            live2dModel.motion('Idle');
        } catch (error) { console.error("!!! ОШИБКА LIVE2D:", error); }
    }

    function updateModelTransform() {
        if (!live2dModel) return;
        const scale = (canvas.parentElement.clientHeight / live2dModel.height) * activeAssistantConfig.scale;
        live2dModel.scale.set(scale);
        live2dModel.x = (canvas.parentElement.clientWidth / 2) - (live2dModel.width / 2) + activeAssistantConfig.posX;
        live2dModel.y = activeAssistantConfig.posY;
    }
    
    // --- Система скуки ---
    function startBoredomTimer() {
        if (boredomTimer) clearTimeout(boredomTimer);
        if (activeAssistantConfig.boredom_enabled) {
            const minTime = activeAssistantConfig.boredom_min_time * 1000; const maxTime = activeAssistantConfig.boredom_max_time * 1000;
            const randomTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
            boredomTimer = setTimeout(triggerBoredomPhrase, randomTime);
        }
    }

    async function triggerBoredomPhrase() {
        try {
            let response;
            if (activeAssistantConfig.boredom_use_llm) {
                response = await fetch('/boredom_phrase/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        assistant_id: activeAssistantConfig.id,
                        chat_id: activeChatId 
                    })
                });
            } else {
                response = await fetch(`/boredom_phrase/${activeAssistantConfig.id}`);
            }
            if (!response.ok) return;
            const data = await response.json();
            const msgWrapper = addMessage(data.text, 'ai');
            if (msgWrapper && data.audio_url) {
                playAudioWithLipSync(data.audio_url);
            }
        } catch (error) {
            console.error("Ошибка при получении фразы скуки:", error);
        } finally {
            startBoredomTimer();
        }
    }

    // --- УПРАВЛЕНИЕ ЧАТОМ ---
    async function setActiveChat(chatId) {
        if (!chatId) { 
            if (chatLog) chatLog.innerHTML = '';
            await loadLive2DModel(null);
            return;
        }
        addMessage(`Загрузка чата...`, 'system');
        activeChatId = chatId;
        document.querySelectorAll('#chats-list .list-item').forEach(item => item.classList.remove('active'));
        const activeChatItem = document.querySelector(`#chats-list .list-item[data-chat-id='${chatId}']`);
        if (activeChatItem) activeChatItem.classList.add('active');
        try {
            lockUI();
            const response = await fetch(`/chat/${chatId}/load`);
            if (!response.ok) throw new Error("Не удалось загрузить данные чата.");
            const data = await response.json();
            activeAssistantConfig = { ...APP_CONFIG, ...data.assistant };
            renderChatHistory(data.messages);
            await loadLive2DModel(data.assistant.live2d_model_path);
            startBoredomTimer();
        } catch (error) { 
            console.error("!!! КРИТИЧЕСКАЯ ОШИБКА загрузки чата:", error);
            chatLog.innerHTML = '';
            addMessage(`Не удалось загрузить чат: ${error.message}`, "system error");
        } finally {
            unlockUI();
        }
    }
    
    function renderChatHistory(messages) {
        if (!chatLog) return;
        chatLog.innerHTML = '';
        messages.forEach(msg => addMessage(msg.content, msg.role, msg.id, msg.audio_url));
    }
    
    async function sendDataToServer(formData, voiceMessageElement = null, userMessageWrapper = null) {
        if (pattingReactionFlag) {
            formData.append('patting_reaction', 'true');
            pattingReactionFlag = false;
        }
        if (boredomTimer) clearTimeout(boredomTimer);
        formData.append('chat_id', activeChatId);
        abortController = new AbortController();
        const signal = abortController.signal;
        lockUI();
        const thinkingMessageWrapper = addMessage('...', 'ai');
        if (thinkingMessageWrapper) { thinkingMessageWrapper.id = 'temp-thinking-message'; }
        try {
            const response = await fetch('/chat', { method: 'POST', body: formData, signal: signal });
            if (!response.ok) throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
            const data = await response.json();
            if (userMessageWrapper && data.user_message_id) {
                userMessageWrapper.dataset.messageId = data.user_message_id;
            }
            const wrapperToUpdate = document.getElementById('temp-thinking-message');
            if (wrapperToUpdate) {
                if (data.ai_message_id) {
                    wrapperToUpdate.dataset.messageId = data.ai_message_id;
                }
                const thinkingBubble = wrapperToUpdate.querySelector('.message');
                const cleanAiText = data.ai_text.replace(/【.*?】/g, '').trim();
                if (cleanAiText) {
                    thinkingBubble.textContent = cleanAiText;
                    thinkingBubble.dataset.originalText = data.ai_text;
                } else {
                    wrapperToUpdate.remove();
                }
                wrapperToUpdate.removeAttribute('id');
            }
            if (voiceMessageElement) {
                const existingAudioPlayer = voiceMessageElement.querySelector('audio');
                voiceMessageElement.innerHTML = ''; voiceMessageElement.appendChild(existingAudioPlayer);
                if(data.user_text) {
                    const cleanUserText = data.user_text.replace(/【.*?】/g, '').trim();
                    const transcriptionText = document.createElement('p');
                    transcriptionText.className = 'transcription'; transcriptionText.textContent = `Распознано: "${cleanUserText}"`;
                    voiceMessageElement.appendChild(transcriptionText);
                }
            }
            executeLive2DCommand(data.live2d_commands);
            if (data.audio_url) playAudioWithLipSync(data.audio_url);
        } catch (error) {
            const wrapperToUpdate = document.getElementById('temp-thinking-message');
            if (wrapperToUpdate) { wrapperToUpdate.remove(); }
            if (error.name === 'AbortError') { console.log("Запрос отменен."); }
            else { console.error("FETCH ERROR:", error); addMessage(`Произошла ошибка: ${error.message}`, 'ai'); }
        } finally {
            startBoredomTimer();
            unlockUI();
            abortController = null;
        }
    }

    // --- ОБРАБОТЧИКИ СОБЫТИЙ ---
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const userName = document.getElementById('user-name').value;
            const userDesc = document.getElementById('user-desc').value;
            const formData = new FormData();
            formData.append('name', userName);
            formData.append('description', userDesc);
            try {
                const response = await fetch('/profile/update', {
                    method: 'POST',
                    body: formData
                });
                if (!response.ok) throw new Error('Ошибка сервера при сохранении.');
                const data = await response.json();
                if (data.success) {
                    saveProfileBtn.textContent = 'Сохранено!';
                    setTimeout(() => { saveProfileBtn.textContent = 'Сохранить'; }, 2000);
                } else { throw new Error(data.message); }
            } catch (error) {
                console.error(error);
                alert(`Не удалось сохранить профиль: ${error.message}`);
            }
        });
    }

    if(sendBtn) sendBtn.addEventListener('click', () => { 
        const text = userInput.value.trim(); 
        if (text) { 
            const userMessageWrapper = addMessage(text, 'user'); 
            const formData = new FormData(); 
            formData.append('text', text); 
            sendDataToServer(formData, null, userMessageWrapper); 
            userInput.value = ''; 
        } 
    });
    if(userInput) userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });
    
    if(resetBtn) resetBtn.addEventListener('click', () => {
        if (activeChatId && clearConfirmModal) clearConfirmModal.style.display = 'flex';
    });
    if(confirmClearBtn) confirmClearBtn.addEventListener('click', async () => {
        if (!activeChatId) return;
        try {
            const response = await fetch(`/chat/${activeChatId}/clear`, { method: 'POST' });
            if (response.ok) {
                if (chatLog) chatLog.innerHTML = '';
                addMessage("Чат очищен.", "system");
            } else { throw new Error('Не удалось очистить чат на сервере.'); }
        } catch (error) {
            console.error(error);
            addMessage(`Ошибка: ${error.message}`, "system error");
        } finally {
            if (clearConfirmModal) clearConfirmModal.style.display = 'none';
        }
    });
    if(cancelClearBtn) cancelClearBtn.addEventListener('click', () => { if (clearConfirmModal) clearConfirmModal.style.display = 'none'; });

    if(cancelBtn) cancelBtn.addEventListener('click', () => { if (abortController) { abortController.abort(); } });

    let isRecording = false, mediaRecorder, audioChunks = [];
    if(recordBtn) recordBtn.addEventListener('click', async () => {
        startBoredomTimer();
        if (audioContext && audioContext.state === 'suspended') { await audioContext.resume(); }
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                audioChunks = [];
                mediaRecorder.ondataavailable = event => { audioChunks.push(event.data); };
                mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    if (audioBlob.size > 0) {
                        const audioUrl = URL.createObjectURL(audioBlob);
                        const { wrapper: voiceMessageWrapper, messageDiv: voiceMessageElement } = addUserVoiceMessage(audioUrl);
                        const formData = new FormData();
                        formData.append('audio_blob', audioBlob, 'voice_message.webm');
                        sendDataToServer(formData, voiceMessageElement, voiceMessageWrapper);
                    }
                };
                mediaRecorder.start();
                recordBtn.textContent = 'Стоп'; recordBtn.classList.add('recording'); isRecording = true;
            } catch (err) { console.error(err); alert("Не удалось получить доступ к микрофону."); }
        } else {
            mediaRecorder.stop();
            recordBtn.textContent = 'Запись'; recordBtn.classList.remove('recording'); isRecording = false;
        }
    });

    if (createChatBtn) createChatBtn.addEventListener('click', () => createChatModal.style.display = 'flex');
    if (cancelCreateChatBtn) cancelCreateChatBtn.addEventListener('click', () => createChatModal.style.display = 'none');
    if (createChatModal) createChatModal.addEventListener('click', (e) => { if (e.target === createChatModal) createChatModal.style.display = 'none'; });
    
    if (chatsList) {
        chatsList.addEventListener('click', (event) => {
            const chatItem = event.target.closest('.list-item');
            const targetButton = event.target.closest('button');
            if (chatItem && !targetButton) { setActiveChat(chatItem.dataset.chatId); }
            if (targetButton && targetButton.classList.contains('chat-load-btn')) { setActiveChat(chatItem.dataset.chatId); }
        });
    }

    document.querySelectorAll('.chat-settings-btn').forEach(button => {
        button.addEventListener('click', async (event) => {
            event.preventDefault(); event.stopPropagation(); const chatId = button.closest('.list-item').dataset.chatId;
            try {
                const response = await fetch(`/chat/${chatId}/settings_data`); const data = await response.json();
                chatSettingsForm.action = `/chat/${chatId}/update_settings`; editChatNameInput.value = data.chat_name; editChatAssistantSelect.innerHTML = '';
                data.assistants.forEach(assistant => {
                    const option = document.createElement('option'); option.value = assistant.id; option.textContent = assistant.name;
                    if (assistant.id === data.current_assistant_id) { option.selected = true; }
                    editChatAssistantSelect.appendChild(option);
                });
                chatSettingsModal.style.display = 'flex';
            } catch (error) { console.error("Ошибка загрузки настроек чата:", error); }
        });
    });
    if (closeChatSettingsModalBtn) closeChatSettingsModalBtn.addEventListener('click', () => chatSettingsModal.style.display = 'none');
    if (chatSettingsModal) chatSettingsModal.addEventListener('click', (e) => { if(e.target === chatSettingsModal) chatSettingsModal.style.display = 'none'; });

    document.querySelectorAll('.delete-btn-in-list, .delete-chat-btn').forEach(button => {
        button.addEventListener('click', (event) => {
            event.preventDefault(); event.stopPropagation();
            const id = button.closest('.list-item').dataset.id || button.closest('.list-item').dataset.chatId;
            const name = button.dataset.name; const isChat = button.classList.contains('delete-chat-btn');
            deleteConfirmText.textContent = `Вы уверены, что хотите удалить ${isChat ? 'чат' : 'ассистента'} "${name}"?`;
            deleteConfirmForm.action = isChat ? `/chat/${id}/delete` : `/assistant/${id}/delete`;
            deleteConfirmModal.style.display = 'flex';
        });
    });
    if (cancelDeleteBtn) { cancelDeleteBtn.addEventListener('click', () => { deleteConfirmModal.style.display = 'none'; }); }
    if (deleteConfirmModal) { deleteConfirmModal.addEventListener('click', (event) => { if (event.target === deleteConfirmModal) { deleteConfirmModal.style.display = 'none'; } }); }

    if (chatLog) {
        chatLog.addEventListener('click', (e) => {
            const optionsBtn = e.target.closest('.message-options-btn');
            if (optionsBtn) {
                e.preventDefault();
                const wrapper = optionsBtn.closest('.message-wrapper');
                const messageId = wrapper.dataset.messageId;
                if (messageId) {
                    createContextMenu(e.clientX, e.clientY, messageId, wrapper);
                }
            }
        });
    }

    // --- Вспомогательные функции ---
    function lockUI() { if (thinkingOverlay) thinkingOverlay.style.display = 'flex'; }
    function unlockUI() { if (thinkingOverlay) thinkingOverlay.style.display = 'none'; }
    function playAudioWithLipSync(audioUrl) { if (!live2dModel) return; if (!audioContext) { try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; } catch (e) { return; } } const audio = new Audio(audioUrl); const source = audioContext.createMediaElementSource(audio); source.connect(analyser); analyser.connect(audioContext.destination); const playPromise = audio.play(); if (playPromise !== undefined) { playPromise.catch(error => { addMessage("Браузер заблокировал звук. Кликните по странице и отправьте сообщение еще раз.", "ai"); }); } audio.onplay = () => { isLipSyncRunning = true; updateLipSync(); }; audio.onended = () => { isLipSyncRunning = false; }; }
    
    function addMessage(text, sender, msgId = null, audioUrl = null) {
        const senderClass = (sender === 'assistant' || sender === 'system error') ? 'ai' : sender;
        const displayText = text.replace(/【.*?】/g, '').trim();
        if (!displayText && sender !== 'system' && sender !== 'system error') {
            return null;
        }
        const wrapper = document.createElement('div'); 
        wrapper.className = `message-wrapper ${senderClass}`; 
        if(sender === 'system' || sender === 'system error') wrapper.classList.add('system-message');
        if (msgId) wrapper.dataset.messageId = msgId;
        const messageDiv = document.createElement('div'); 
        messageDiv.classList.add('message', senderClass);
        messageDiv.dataset.originalText = text;
        if (audioUrl && senderClass === 'user') { 
            messageDiv.classList.add('user-voice'); const audioPlayer = document.createElement('audio'); audioPlayer.src = audioUrl; audioPlayer.controls = true; messageDiv.appendChild(audioPlayer); const transcriptionText = document.createElement('p'); transcriptionText.className = 'transcription'; transcriptionText.textContent = displayText; messageDiv.appendChild(transcriptionText); 
        } else { 
            messageDiv.textContent = displayText; 
        }
        const optionsBtn = document.createElement('button'); 
        optionsBtn.className = 'message-options-btn'; optionsBtn.textContent = '…'; 
        optionsBtn.style.display = (senderClass === 'user' || senderClass === 'ai') ? 'block' : 'none';
        if (senderClass === 'user') { wrapper.appendChild(messageDiv); wrapper.appendChild(optionsBtn); } 
        else { wrapper.appendChild(optionsBtn); wrapper.appendChild(messageDiv); }
        if(chatLog) { chatLog.appendChild(wrapper); chatLog.scrollTop = chatLog.scrollHeight; }
        return wrapper;
    }

    function addUserVoiceMessage(audioURL) { 
        const wrapper = document.createElement('div'); wrapper.className = 'message-wrapper user';
        const messageDiv = document.createElement('div'); messageDiv.classList.add('message', 'user', 'user-voice'); 
        const audioPlayer = document.createElement('audio'); audioPlayer.src = audioURL; audioPlayer.controls = true; 
        messageDiv.appendChild(audioPlayer);
        wrapper.appendChild(messageDiv);
        if(chatLog) { chatLog.appendChild(wrapper); chatLog.scrollTop = chatLog.scrollHeight; } 
        return { wrapper, messageDiv };
    }
    
    function updateLipSync() { if (!isLipSyncRunning || !live2dModel || !analyser) { if (live2dModel?.internalModel) { live2dModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0); } return; } const dataArray = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(dataArray); let sum = 0; for (let i = 0; i < dataArray.length; i++) { sum += dataArray[i]; } let average = sum / dataArray.length; const mouthOpenY = Math.min(1.0, (average / 128) * 1.5); live2dModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', mouthOpenY); requestAnimationFrame(updateLipSync); }
    
    async function executeLive2DCommand(commands) {
        if (poseLifetimeCounter > 0) {
            poseLifetimeCounter--;
            if (poseLifetimeCounter === 0) {
                targetParameters = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
                isFollowingCursor = false;
            }
        }
        const hasNewCommands = commands && commands.length > 0;
        if (!hasNewCommands) {
            return;
        }
        poseLifetimeCounter = 2;
        targetParameters = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 };
        isFollowingCursor = false;
        for (const command of commands) {
            if (command === 'NOD_HEAD') {
                await playNodAnimation();
                continue;
            }
            if (command === 'SHAKE_HEAD') {
                await playShakeAnimation();
                continue;
            }
            switch (command) {
                case 'FOLLOW_CURSOR': isFollowingCursor = true; break;
                case 'LOOK_LEFT':       targetParameters.ParamAngleX = -30; break;
                case 'LOOK_RIGHT':      targetParameters.ParamAngleX = 30; break;
                case 'LOOK_UP':         targetParameters.ParamAngleY = 30; break;
                case 'LOOK_DOWN':       targetParameters.ParamAngleY = -30; break;
                case 'HEAD_TILT_LEFT':  targetParameters.ParamAngleZ = -30; break;
                case 'HEAD_TILT_RIGHT': targetParameters.ParamAngleZ = 30; break;
                case 'CLOSE_LEFT_EYE':  targetParameters.ParamEyeLOpen = 0; break;
                case 'CLOSE_RIGHT_EYE': targetParameters.ParamEyeROpen = 0; break;
            }
        }
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    async function playNodAnimation() {
        const originalTarget = { ...targetParameters };
        targetParameters.ParamAngleY = 30; targetParameters.ParamAngleX = 0; await sleep(700);
        targetParameters.ParamAngleY = -30; await sleep(700);
        targetParameters.ParamAngleY = 30; await sleep(700);
        targetParameters.ParamAngleY = -30; await sleep(700);
        targetParameters = originalTarget;
    }
    async function playShakeAnimation() {
        const originalTarget = { ...targetParameters };
        targetParameters.ParamAngleX = -30; targetParameters.ParamAngleY = 0; await sleep(600);
        targetParameters.ParamAngleX = 30; await sleep(600);
        targetParameters.ParamAngleX = -30; await sleep(600);
        targetParameters.ParamAngleX = 30; await sleep(600);
        targetParameters = originalTarget;
    }

    function createContextMenu(x, y, messageId, wrapper) {
        const existingMenu = document.querySelector('.context-menu');
        if (existingMenu) existingMenu.remove();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.innerHTML = `
            <div class="context-menu-item" data-action="edit">
                <img src="/static/img/edit.png" alt="Редактировать">
                <span>Редактирование</span>
            </div>
            <div class="context-menu-item" data-action="delete">
                <img src="/static/img/trash_can.png" alt="Удалить">
                <span>Удаление</span>
            </div>
        `;
        document.body.appendChild(menu);
        const menuWidth = menu.offsetWidth; const menuHeight = menu.offsetHeight;
        const windowWidth = window.innerWidth; const windowHeight = window.innerHeight;
        let finalX = x; let finalY = y;
        if (x + menuWidth > windowWidth) { finalX = x - menuWidth; }
        if (y + menuHeight > windowHeight) { finalY = y - menuHeight; }
        menu.style.left = `${finalX}px`; menu.style.top = `${finalY}px`;
        menu.addEventListener('click', (e) => {
            const actionItem = e.target.closest('.context-menu-item');
            if (!actionItem) return;
            const action = actionItem.dataset.action;
            if (action === 'delete') handleDeleteMessage(messageId, wrapper);
            if (action === 'edit') handleEditMessage(wrapper);
            menu.remove();
        });
        setTimeout(() => { document.addEventListener('click', () => menu.remove(), { once: true }); }, 0);
    }

    async function handleDeleteMessage(messageId, wrapper) {
        try {
            const response = await fetch(`/message/delete/${messageId}`, { method: 'POST' });
            if (!response.ok) throw new Error('Не удалось удалить сообщение');
            wrapper.remove();
        } catch (error) { console.error(error); }
    }

    function handleEditMessage(wrapper) {
        const messageDiv = wrapper.querySelector('.message:not(.user-voice)');
        if (!messageDiv) return;
        const originalText = messageDiv.dataset.originalText || messageDiv.textContent;
        messageDiv.textContent = originalText;
        messageDiv.setAttribute('contenteditable', 'true');
        messageDiv.focus();
        const saveBtn = document.createElement('button'); saveBtn.textContent = 'Сохранить';
        const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Отмена';
        const actionDiv = document.createElement('div');
        actionDiv.className = 'edit-actions';
        actionDiv.appendChild(saveBtn); actionDiv.appendChild(cancelBtn);
        wrapper.appendChild(actionDiv);
        const cleanup = () => {
            messageDiv.setAttribute('contenteditable', 'false');
            actionDiv.remove();
        };
        saveBtn.onclick = async () => {
            const newText = messageDiv.textContent.trim();
            cleanup();
            if (newText && newText !== originalText) {
                try {
                    const response = await fetch(`/message/update/${wrapper.dataset.messageId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newText })
                    });
                    if (!response.ok) throw new Error('Ошибка обновления');
                    messageDiv.dataset.originalText = newText;
                    messageDiv.textContent = newText.replace(/【.*?】/g, '').trim();
                } catch (error) {
                    console.error(error);
                    messageDiv.textContent = originalText.replace(/【.*?】/g, '').trim();
                }
            } else {
                messageDiv.textContent = originalText.replace(/【.*?】/g, '').trim();
            }
        };
        cancelBtn.onclick = () => {
            cleanup();
            messageDiv.textContent = originalText.replace(/【.*?】/g, '').trim();
        };
    }
    
    // --- ПЕРВЫЙ ЗАПУСК ---
    setActiveChat(activeChatId);
});