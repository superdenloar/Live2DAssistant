/**
 * =============================================
 *  Шашки с ботом + аналитика для Live2D ассистента
 * =============================================
 *  Вычисляет и экспортирует в window.__ASSISTANT_CONTEXT__:
 *  - best_move: лучший ход
 *  - max_captures_chain: макс. цепочка взятий
 *  - white_count / black_count: счёт
 *  - advantage: преимущество
 *  - move_number: номер хода
 */
document.addEventListener('DOMContentLoaded', () => {
    const boardEl = document.getElementById('checkers-board');
    const turnLabel = document.getElementById('turn-indicator');
    const restartBtn = document.getElementById('restart-btn');

    // Analytics DOM
    const statCaptures = document.getElementById('stat-captures');
    const statAdvantage = document.getElementById('stat-advantage');
    const statBestMove = document.getElementById('stat-best-move');
    const statMoveNum = document.getElementById('stat-move-num');
    const gameLog = document.getElementById('game-log');

    let board = [];
    let selected = null;
    let turn = 'w';
    let moveNumber = 0;
    let gameOver = false;

    // --- Board init ---
    function initBoard() {
        board = Array.from({ length: 8 }, () => Array(8).fill(null));
        for (let r = 0; r < 3; r++)
            for (let c = 0; c < 8; c++)
                if ((r + c) % 2 === 1) board[r][c] = { side: 'b', king: false };
        for (let r = 5; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if ((r + c) % 2 === 1) board[r][c] = { side: 'w', king: false };
        selected = null;
        turn = 'w';
        moveNumber = 0;
        gameOver = false;
        if (gameLog) gameLog.innerHTML = '';
        removeGameOverOverlay();
        renderBoard();
        updateAnalytics();
    }

    function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

    function toCell(r, c) {
        return String.fromCharCode(97 + c) + (8 - r);
    }

    // --- Moves (with multi-capture chains) ---
    function getCaptures(r, c, boardState, visited = []) {
        const piece = boardState[r][c];
        if (!piece) return [];
        const enemy = piece.side === 'w' ? 'b' : 'w';
        const dirs = piece.king ? [-1, 1] : [piece.side === 'w' ? -1 : 1];
        const chains = [];

        for (const dr of dirs) {
            for (const dc of [-1, 1]) {
                const mr = r + dr, mc = c + dc;
                const jr = r + dr * 2, jc = c + dc * 2;
                if (!inBounds(jr, jc)) continue;
                if (!boardState[mr][mc] || boardState[mr][mc].side !== enemy) continue;
                if (boardState[jr][jc] !== null) continue;
                const captureKey = mr + ',' + mc;
                if (visited.includes(captureKey)) continue;

                // simulate
                const newBoard = boardState.map(row => row.map(cell => cell ? { ...cell } : null));
                newBoard[jr][jc] = { ...newBoard[r][c] };
                newBoard[r][c] = null;
                newBoard[mr][mc] = null;

                // check king promotion
                if ((newBoard[jr][jc].side === 'w' && jr === 0) || (newBoard[jr][jc].side === 'b' && jr === 7)) {
                    newBoard[jr][jc].king = true;
                }

                const subChains = getCaptures(jr, jc, newBoard, [...visited, captureKey]);
                if (subChains.length === 0) {
                    chains.push([{ from: [r, c], to: [jr, jc], captured: [mr, mc] }]);
                } else {
                    for (const sub of subChains) {
                        chains.push([{ from: [r, c], to: [jr, jc], captured: [mr, mc] }, ...sub]);
                    }
                }
            }
        }
        return chains;
    }

    function getSimpleMoves(r, c) {
        const piece = board[r][c];
        if (!piece) return [];
        const dirs = piece.king ? [-1, 1] : [piece.side === 'w' ? -1 : 1];
        const moves = [];
        for (const dr of dirs) {
            for (const dc of [-1, 1]) {
                const nr = r + dr, nc = c + dc;
                if (inBounds(nr, nc) && board[nr][nc] === null) {
                    moves.push({ from: [r, c], to: [nr, nc], capture: false });
                }
            }
        }
        return moves;
    }

    function getAllMoves(side) {
        // If any captures exist, MUST capture (forced capture rule)
        let allCaptures = [];
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (board[r][c] && board[r][c].side === side) {
                    const chains = getCaptures(r, c, board);
                    allCaptures.push(...chains);
                }

        if (allCaptures.length > 0) {
            // Return longest chains (mandatory max capture)
            const maxLen = Math.max(...allCaptures.map(c => c.length));
            return allCaptures.filter(c => c.length === maxLen).map(chain => ({
                chain,
                from: chain[0].from,
                to: chain[chain.length - 1].to,
                captures: chain.map(s => s.captured),
                isCapture: true,
            }));
        }

        // Simple moves
        const simple = [];
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (board[r][c] && board[r][c].side === side)
                    simple.push(...getSimpleMoves(r, c).map(m => ({ ...m, isCapture: false, chain: null, captures: [] })));
        return simple;
    }

    // --- Apply move ---
    function applyMove(move) {
        if (move.isCapture && move.chain) {
            for (const step of move.chain) {
                const piece = board[step.from[0]][step.from[1]];
                board[step.from[0]][step.from[1]] = null;
                board[step.to[0]][step.to[1]] = piece;
                board[step.captured[0]][step.captured[1]] = null;
                // King promotion
                if ((piece.side === 'w' && step.to[0] === 0) || (piece.side === 'b' && step.to[0] === 7)) {
                    piece.king = true;
                }
            }
        } else {
            const piece = board[move.from[0]][move.from[1]];
            board[move.from[0]][move.from[1]] = null;
            board[move.to[0]][move.to[1]] = piece;
            if ((piece.side === 'w' && move.to[0] === 0) || (piece.side === 'b' && move.to[0] === 7)) {
                piece.king = true;
            }
        }
    }

    // --- Render ---
    function renderBoard() {
        boardEl.innerHTML = '';
        turnLabel.textContent = turn === 'w' ? '⚪ Ваш ход (белые)' : '🔴 Ход бота (чёрные)';
        turnLabel.className = 'turn-indicator' + (turn === 'b' ? ' bot-turn' : '');

        const legalMoves = turn === 'w' ? getAllMoves('w') : [];
        const moveTargets = new Set();
        let selectedMoves = [];
        if (selected && turn === 'w') {
            selectedMoves = legalMoves.filter(m =>
                m.from[0] === selected[0] && m.from[1] === selected[1]
            );
            selectedMoves.forEach(m => moveTargets.add(m.to[0] + ',' + m.to[1]));
        }

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const cell = document.createElement('button');
                cell.className = `cell ${(r + c) % 2 ? 'dark' : 'light'}`;
                cell.dataset.r = r;
                cell.dataset.c = c;

                if (selected && selected[0] === r && selected[1] === c) {
                    cell.classList.add('selected');
                }

                const key = r + ',' + c;
                if (moveTargets.has(key)) {
                    const isCapture = selectedMoves.some(m => m.to[0] === r && m.to[1] === c && m.isCapture);
                    cell.classList.add(isCapture ? 'capture-hint' : 'move-hint');
                }

                const piece = board[r][c];
                if (piece) {
                    const p = document.createElement('span');
                    p.className = `piece ${piece.side === 'w' ? 'white' : 'black'}${piece.king ? ' king' : ''}`;
                    cell.appendChild(p);
                }

                cell.addEventListener('click', onCellClick);
                boardEl.appendChild(cell);
            }
        }
    }

    // --- Click handler ---
    function onCellClick(e) {
        if (turn !== 'w' || gameOver) return;
        const r = Number(e.currentTarget.dataset.r);
        const c = Number(e.currentTarget.dataset.c);

        if (board[r][c] && board[r][c].side === 'w') {
            selected = [r, c];
            renderBoard();
            return;
        }

        if (!selected) return;
        const moves = getAllMoves('w');
        const legal = moves.find(m =>
            m.from[0] === selected[0] && m.from[1] === selected[1] &&
            m.to[0] === r && m.to[1] === c
        );
        if (!legal) return;

        moveNumber++;
        applyMove(legal);
        logMove('Белые', legal);
        selected = null;
        turn = 'b';
        renderBoard();
        updateAnalytics();
        checkGameOver();
        if (!gameOver) setTimeout(botMove, 500);
    }

    // --- Bot AI ---
    function evaluateBoard() {
        let score = 0;
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (!p) continue;
                const val = p.king ? 3 : 1;
                const posBonus = p.side === 'b' ? r * 0.1 : (7 - r) * 0.1;
                score += p.side === 'b' ? (val + posBonus) : -(val + posBonus);
            }
        return score;
    }

    function botMove() {
        if (gameOver) return;
        const moves = getAllMoves('b');
        if (moves.length === 0) {
            showGameOver('Вы победили! 🎉', 'Бот не может сделать ход.');
            return;
        }

        // Evaluate each move
        let bestScore = -Infinity;
        let bestMoves = [];
        for (const move of moves) {
            const backup = board.map(row => row.map(cell => cell ? { ...cell } : null));
            applyMove(move);
            const score = evaluateBoard();
            board.splice(0, 8, ...backup);

            if (score > bestScore) {
                bestScore = score;
                bestMoves = [move];
            } else if (score === bestScore) {
                bestMoves.push(move);
            }
        }

        const chosen = bestMoves[Math.floor(Math.random() * bestMoves.length)];
        moveNumber++;
        applyMove(chosen);
        logMove('Чёрные', chosen);
        turn = 'w';
        renderBoard();
        updateAnalytics();
        checkGameOver();
    }

    // --- Game over ---
    function checkGameOver() {
        const whiteMoves = getAllMoves('w');
        const blackMoves = getAllMoves('b');
        const whiteCount = countPieces('w');
        const blackCount = countPieces('b');

        if (whiteCount === 0 || (turn === 'w' && whiteMoves.length === 0)) {
            showGameOver('Бот победил 🤖', 'Не расстраивайтесь, попробуйте ещё!');
        }
        if (blackCount === 0 || (turn === 'b' && blackMoves.length === 0)) {
            showGameOver('Вы победили! 🎉', 'Отличная игра!');
        }
    }

    function showGameOver(title, subtitle) {
        gameOver = true;
        const overlay = document.createElement('div');
        overlay.className = 'game-over-overlay';
        overlay.id = 'game-over-overlay';
        overlay.innerHTML = `
            <div class="game-over-card">
                <h2>${title}</h2>
                <p>${subtitle}</p>
                <button onclick="document.getElementById('game-over-overlay').remove(); document.getElementById('restart-btn').click();">Новая игра</button>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function removeGameOverOverlay() {
        const old = document.getElementById('game-over-overlay');
        if (old) old.remove();
    }

    // --- Analytics ---
    function countPieces(side) {
        let count = 0;
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (board[r][c] && board[r][c].side === side) count++;
        return count;
    }

    function getAnalytics() {
        const whiteMoves = getAllMoves('w');
        const whiteCount = countPieces('w');
        const blackCount = countPieces('b');

        // Max capture chain
        let maxChain = 0;
        let allCaptures = [];
        for (let r = 0; r < 8; r++)
            for (let c = 0; c < 8; c++)
                if (board[r][c] && board[r][c].side === 'w') {
                    const chains = getCaptures(r, c, board);
                    allCaptures.push(...chains);
                    for (const ch of chains) maxChain = Math.max(maxChain, ch.length);
                }

        // Best move
        let bestMove = 'нет ходов';
        if (whiteMoves.length > 0) {
            // Prefer captures, then choose by simple evaluation
            const captureMoves = whiteMoves.filter(m => m.isCapture);
            const pool = captureMoves.length > 0 ? captureMoves : whiteMoves;

            let bestScore = Infinity;
            let best = pool[0];
            for (const move of pool) {
                const backup = board.map(row => row.map(cell => cell ? { ...cell } : null));
                applyMove(move);
                const score = evaluateBoard(); // Lower is better for white
                board.splice(0, 8, ...backup);
                if (score < bestScore) {
                    bestScore = score;
                    best = move;
                }
            }
            bestMove = toCell(best.from[0], best.from[1]) + ' → ' + toCell(best.to[0], best.to[1]);
            if (best.isCapture) bestMove += ` (×${best.captures.length})`;
        }

        return {
            best_move: bestMove,
            max_captures_chain: maxChain,
            white_count: whiteCount,
            black_count: blackCount,
            advantage: whiteCount - blackCount,
            move_number: moveNumber,
            total_moves_available: whiteMoves.length,
        };
    }

    function updateAnalytics() {
        const data = getAnalytics();

        if (statCaptures) statCaptures.textContent = data.max_captures_chain;
        if (statAdvantage) {
            const adv = data.advantage;
            statAdvantage.textContent = (adv > 0 ? '+' : '') + adv;
            statAdvantage.style.color = adv > 0 ? '#66eea0' : adv < 0 ? '#ff5555' : '#667eea';
        }
        if (statBestMove) statBestMove.textContent = data.best_move;
        if (statMoveNum) statMoveNum.textContent = data.move_number;

        // Export to widget context
        window.__ASSISTANT_CONTEXT__ = () => data;
    }

    function logMove(side, move) {
        if (!gameLog) return;
        const from = toCell(move.from[0], move.from[1]);
        const to = toCell(move.to[0], move.to[1]);
        const captures = move.isCapture ? ` (взятие ×${move.captures.length})` : '';
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="move-num">#${moveNumber}</span> ${side}: ${from} → ${to}${captures}`;
        gameLog.prepend(entry);
    }

    // --- Events ---
    if (restartBtn) restartBtn.addEventListener('click', initBoard);

    // --- Start ---
    initBoard();
});
