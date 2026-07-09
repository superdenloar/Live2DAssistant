document.addEventListener('DOMContentLoaded', () => {
    const boardEl = document.getElementById('checkers-board');
    const turnLabel = document.getElementById('turn-label');
    const restartBtn = document.getElementById('restart-game-btn');
    const messagesEl = document.getElementById('assistant-messages');
    const inputEl = document.getElementById('assistant-input');
    const sendBtn = document.getElementById('assistant-send-btn');
    const recordBtn = document.getElementById('assistant-record-btn');
    const recordStatus = document.getElementById('record-status');
    const toggleBtn = document.getElementById('toggle-chat-btn');
    const chatBody = document.getElementById('assistant-chat-body');

    const chatId = window.CHECKERS_CONFIG?.default_chat_id || null;
    const bridgeSessionId = localStorage.getItem('checkersBridgeSessionId') || crypto.randomUUID();
    localStorage.setItem('checkersBridgeSessionId', bridgeSessionId);
    let board = [];
    let selected = null;
    let turn = 'w';
    let mediaRecorder = null;
    let chunks = [];

    function initBoard() {
        board = Array.from({ length: 8 }, () => Array(8).fill(null));
        for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = 'b';
        for (let r = 5; r < 8; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = 'w';
        selected = null;
        turn = 'w';
        renderBoard();
    }

    function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

    function getMoves(r, c) {
        const piece = board[r][c];
        if (!piece) return [];
        const dir = piece === 'w' ? -1 : 1;
        const enemy = piece === 'w' ? 'b' : 'w';
        const moves = [];

        for (const dc of [-1, 1]) {
            const nr = r + dir, nc = c + dc;
            if (inBounds(nr, nc) && !board[nr][nc]) moves.push({ r: nr, c: nc, capture: false });

            const cr = r + dir, cc = c + dc;
            const jr = r + dir * 2, jc = c + dc * 2;
            if (inBounds(jr, jc) && board[cr][cc] === enemy && !board[jr][jc]) {
                moves.push({ r: jr, c: jc, capture: true, captured: [cr, cc] });
            }
        }
        return moves;
    }

    function getAllMoves(side) {
        const all = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (board[r][c] === side) {
                    for (const m of getMoves(r, c)) all.push({ from: [r, c], ...m });
                }
            }
        }
        return all;
    }

    function renderBoard() {
        boardEl.innerHTML = '';
        turnLabel.textContent = turn === 'w' ? 'Ход: Белые (вы)' : 'Ход: Черные (бот)';

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const cell = document.createElement('button');
                cell.className = `cell ${(r + c) % 2 ? 'dark' : 'light'}`;
                cell.dataset.r = r;
                cell.dataset.c = c;
                if (selected && selected[0] === r && selected[1] === c) cell.classList.add('selected');

                const piece = board[r][c];
                if (piece) {
                    const p = document.createElement('span');
                    p.className = `piece ${piece === 'w' ? 'white' : 'black'}`;
                    cell.appendChild(p);
                }
                cell.addEventListener('click', onCellClick);
                boardEl.appendChild(cell);
            }
        }
    }

    function onCellClick(e) {
        if (turn !== 'w') return;
        const r = Number(e.currentTarget.dataset.r);
        const c = Number(e.currentTarget.dataset.c);

        if (board[r][c] === 'w') {
            selected = [r, c];
            return renderBoard();
        }

        if (!selected) return;
        const [sr, sc] = selected;
        const legal = getMoves(sr, sc).find(m => m.r === r && m.c === c);
        if (!legal) return;

        applyMove(sr, sc, legal);
        turn = 'b';
        selected = null;
        renderBoard();

        setTimeout(botMove, 400);
    }

    function applyMove(sr, sc, move) {
        const piece = board[sr][sc];
        board[sr][sc] = null;
        board[move.r][move.c] = piece;
        if (move.capture && move.captured) {
            const [cr, cc] = move.captured;
            board[cr][cc] = null;
        }
    }

    function botMove() {
        const moves = getAllMoves('b');
        if (!moves.length) {
            addMessage('Бот не может ходить. Вы победили!', 'system');
            turn = 'w';
            renderBoard();
            return;
        }
        const captures = moves.filter(m => m.capture);
        const pool = captures.length ? captures : moves;
        const move = pool[Math.floor(Math.random() * pool.length)];
        applyMove(move.from[0], move.from[1], move);
        turn = 'w';
        renderBoard();
    }

    function toCell([r, c]) {
        return String.fromCharCode(97 + c) + (8 - r);
    }

    function buildGameContext() {
        const whiteMoves = getAllMoves('w');
        const captures = whiteMoves.filter(m => m.capture);
        const best = (captures[0] || whiteMoves[0]);

        return {
            best_move: best ? `${toCell(best.from)}-${toCell([best.r, best.c])}` : 'нет ходов',
            max_captures_now: captures.length,
            position_fen: JSON.stringify(board),
            difficulty: 'normal'
        };
    }

    function addMessage(text, role = 'assistant') {
        const div = document.createElement('div');
        div.className = `assistant-msg ${role}`;
        div.textContent = text;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendToAssistant(message, audioBlob = null) {
        const gameContext = buildGameContext();

        try {
            let resp;
            if (audioBlob) {
                const fd = new FormData();
                if (chatId) fd.append('chat_id', String(chatId));
                fd.append('session_id', bridgeSessionId);
                fd.append('message', message || '');
                fd.append('game_context', JSON.stringify(gameContext));
                fd.append('audio_blob', audioBlob, 'voice.webm');
                resp = await fetch('/api/bridge/chat', { method: 'POST', body: fd });
            } else {
                resp = await fetch('/api/bridge/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, session_id: bridgeSessionId, message, game_context: gameContext })
                });
            }

            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Ошибка сервера');
            addMessage(data.ai_text || 'Ассистент не ответил', 'assistant');

            if (data.audio_url) {
                const audio = new Audio(data.audio_url);
                audio.play().catch(() => {});
            }
        } catch (err) {
            addMessage(`Ошибка связи с ассистентом: ${err.message}`, 'system');
        }
    }

    sendBtn.addEventListener('click', () => {
        const value = inputEl.value.trim();
        if (!value) return;
        addMessage(value, 'user');
        inputEl.value = '';
        sendToAssistant(value);
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendBtn.click();
    });

    toggleBtn.addEventListener('click', () => {
        const hidden = chatBody.style.display === 'none';
        chatBody.style.display = hidden ? 'block' : 'none';
        toggleBtn.textContent = hidden ? '—' : '+';
    });

    recordBtn.addEventListener('click', async () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            chunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
            mediaRecorder.onstop = () => {
                recordStatus.textContent = 'обработка...';
                const blob = new Blob(chunks, { type: 'audio/webm' });
                sendToAssistant('', blob).finally(() => {
                    recordStatus.textContent = 'не записывает';
                    stream.getTracks().forEach(t => t.stop());
                });
            };
            mediaRecorder.start();
            recordStatus.textContent = 'записывает...';
        } catch (err) {
            addMessage(`Нет доступа к микрофону: ${err.message}`, 'system');
        }
    });

    restartBtn.addEventListener('click', initBoard);

    initBoard();
    addMessage('Привет! Я могу подсказать ход по текущей позиции в шашках.', 'assistant');
});
