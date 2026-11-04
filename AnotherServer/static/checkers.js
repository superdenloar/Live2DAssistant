/**
 * Шашки с тренером: интерфейс, бот и передача анализа Live2D-ассистенту.
 * Ассистент получает в window.__ASSISTANT_CONTEXT__ точные данные движка (оценку, лучший ход,
 * главный вариант, разбор последнего хода), поэтому советует реальные ходы, а не выдумывает их.
 */
(function () {
    'use strict';
    const E = window.CheckersEngine;
    const $ = id => document.getElementById(id);
    const LEVELS = {
        novice: { name: 'Новичок', timeMs: 150, maxDepth: 2, blunder: 0.35 },
        amateur: { name: 'Любитель', timeMs: 450, maxDepth: 6, blunder: 0.08 },
        master: { name: 'Мастер', timeMs: 1600, maxDepth: 30, blunder: 0 },
    };

    // ---------- Движок в отдельном потоке ----------
    let worker = null, reqId = 0;
    const pending = new Map();
    try {
        worker = new Worker('engine.js');
        worker.onmessage = e => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
    } catch (_) { worker = null; }
    function think(board, side, opts) {
        return new Promise(res => {
            if (worker) { const id = ++reqId; pending.set(id, res); worker.postMessage({ id, board: Array.from(board), side, opts }); return; }
            setTimeout(() => {
                const r = E.search(board, side, opts);
                res({ depth: r.depth, score: r.score, pv: r.pv || [], ms: r.ms, best: r.best ? E.notation(r.best) : null, scores: (r.scores || []).map(s => ({ n: E.notation(s.move), score: s.score })) });
            }, 10);
        });
    }

    // ---------- Состояние ----------
    let level = 'amateur';
    try { level = localStorage.getItem('chk_level') || 'amateur'; } catch (_) { }
    let board, turn, history, selected, stepPath, lastMove, gameOver, analysis, hint, quietPlies, positions, lastQuality, botThinking, gen = 0;

    function newGame() {
        gen++;
        board = E.initial(); turn = 1; history = []; selected = null; stepPath = []; lastMove = null;
        gameOver = false; analysis = null; hint = null; quietPlies = 0; positions = new Map(); lastQuality = null; botThinking = false;
        $('overlay').hidden = true;
        $('moves').innerHTML = '';
        $('last-move').innerHTML = '<span class="muted">Партия только началась</span>';
        render(); afterMove();
    }

    // ---------- Отрисовка ----------
    const boardEl = $('board');
    function legal() { return gameOver || turn !== 1 ? [] : E.genMoves(board, 1); }

    function render() {
        const moves = legal();
        const movable = new Set(moves.map(m => m.from));
        const cands = selected === null ? [] : moves.filter(m => m.from === selected && stepPath.every((p, i) => m.path[i + 1] === p));
        const targets = new Set(cands.map(m => m.path[stepPath.length + 1]).filter(x => x !== undefined));
        const willCap = new Set(cands.flatMap(m => m.caps.slice(0, stepPath.length)));
        boardEl.innerHTML = '';
        for (let i = 0; i < 64; i++) {
            const r = i >> 3, c = i & 7, dark = (r + c) % 2 === 1;
            const cell = document.createElement('button');
            cell.className = 'cell ' + (dark ? 'dark' : 'light');
            cell.dataset.i = i;
            cell.setAttribute('aria-label', E.name(i));
            if (!dark) cell.tabIndex = -1;
            if (lastMove && (lastMove.path.includes(i))) cell.classList.add('last');
            if (hint && hint.path.includes(i)) cell.classList.add('hint');
            if (i === selected) cell.classList.add('selected');
            if (targets.has(i)) { cell.classList.add('target'); if (cands.some(m => m.caps.length)) cell.classList.add('cap'); }
            if (stepPath.includes(i)) cell.classList.add('step');
            const p = board[i];
            if (p) {
                const s = document.createElement('span');
                s.className = 'piece ' + (p > 0 ? 'white' : 'black') + (Math.abs(p) === 2 ? ' king' : '');
                if (willCap.has(i)) s.classList.add('doomed');
                if (movable.has(i) && selected === null) s.classList.add('can');
                if (movable.has(i) && moves[0]?.caps.length) s.classList.add('must');
                cell.appendChild(s);
            }
            boardEl.appendChild(cell);
        }
        const forced = moves.length && moves[0].caps.length;
        $('turn').className = 'turn' + (turn === -1 ? ' bot' : '') + (forced ? ' forced' : '');
        $('turn').textContent = gameOver ? 'Партия окончена' : turn === 1 ? (forced ? 'Ваш ход — бить обязательно!' : 'Ваш ход — белые') : `Бот думает… (${LEVELS[level].name})`;
        const w = count(1), b = count(-1);
        $('material').textContent = `${w.men + w.kings} : ${b.men + b.kings}`;
        $('material-sub').textContent = `дамки: ${w.kings} : ${b.kings}`;
        $('undo-btn').disabled = history.length < 1 || botThinking;
    }

    function count(side) {
        let men = 0, kings = 0;
        for (let i = 0; i < 64; i++) { if (board[i] === side) men++; if (board[i] === 2 * side) kings++; }
        return { men, kings };
    }

    boardEl.addEventListener('click', e => {
        const cell = e.target.closest('.cell'); if (!cell || turn !== 1 || gameOver || botThinking) return;
        const i = +cell.dataset.i;
        const moves = legal();
        if (board[i] > 0 && moves.some(m => m.from === i) && (stepPath.length === 0 || i === selected)) {
            selected = selected === i && !stepPath.length ? null : i; stepPath = []; hint = null; render(); return;
        }
        if (board[i] > 0 && !moves.some(m => m.from === i)) {
            if (moves.length && moves[0].caps.length) flashTurn();
            return;
        }
        if (selected === null) return;
        const prefix = [...stepPath, i];
        const cands = moves.filter(m => m.from === selected && prefix.every((p, k) => m.path[k + 1] === p));
        if (!cands.length) return;
        const done = cands.find(m => m.path.length === prefix.length + 1);
        if (done && cands.length === 1) { playerMove(done); return; }
        if (done && cands.every(m => m.path.length === prefix.length + 1)) { playerMove(done); return; }
        stepPath = prefix; render();
    });
    function flashTurn() { const t = $('turn'); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake'); }

    // ---------- Ходы ----------
    function pushHistory(move, side, quality) {
        history.push({ board: board, turn, lastMove, quietPlies, quality });
        const nb = E.apply(board, move);
        const pieceWasMan = Math.abs(board[move.from]) === 1;
        quietPlies = (move.caps.length || pieceWasMan) ? 0 : quietPlies + 1;
        board = nb; lastMove = move; turn = -side; selected = null; stepPath = []; hint = null;
        const key = Array.from(board).join(',') + turn;
        positions.set(key, (positions.get(key) || 0) + 1);
        logMove(move, side, quality);
    }

    function playerMove(m) {
        const q = judge(m);
        lastQuality = q;
        pushHistory(m, 1, q);
        showLast(m, q);
        render();
        coachComment(m, q);
        afterMove();
    }

    function judge(m) {
        if (!analysis || !analysis.scores || !analysis.scores.length) return null;
        const n = E.notation(m);
        const best = analysis.scores[0];
        const mine = analysis.scores.find(s => s.n === n);
        if (!mine) return null;
        const loss = Math.max(0, best.score - mine.score);
        const only = analysis.scores.length === 1;
        let label, cls;
        if (only) { label = 'Единственный ход'; cls = 'ok'; }
        else if (loss < 12) { label = 'Лучший ход'; cls = 'best'; }
        else if (loss < 40) { label = 'Хороший ход'; cls = 'ok'; }
        else if (loss < 90) { label = 'Неточность'; cls = 'inacc'; }
        else if (loss < 220) { label = 'Ошибка'; cls = 'mistake'; }
        else { label = 'Зевок'; cls = 'blunder'; }
        return { label, cls, loss, played: n, best: best.n, bestReason: analysis.reason };
    }

    async function botMove() {
        botThinking = true; render();
        const my = gen;
        const L = LEVELS[level];
        const t0 = Date.now();
        const res = await think(board, -1, { timeMs: L.timeMs, maxDepth: L.maxDepth });
        if (my !== gen) return;
        let pick = res.best;
        if (L.blunder && res.scores.length > 1 && Math.random() < L.blunder) {
            const pool = res.scores.slice(1, 4);
            pick = pool[Math.floor(Math.random() * pool.length)].n;
        }
        const wait = Math.max(0, 450 - (Date.now() - t0));
        await new Promise(r => setTimeout(r, wait));
        if (my !== gen) return;
        const m = E.genMoves(board, -1).find(x => E.notation(x) === pick) || E.genMoves(board, -1)[0];
        botThinking = false;
        pushHistory(m, -1, null);
        render();
        afterMove();
    }

    function afterMove() {
        if (checkEnd()) return;
        if (turn === -1) { botMove(); return; }
        analyze();
    }

    async function analyze() {
        const my = gen;
        $('best-reason').textContent = 'Движок считает варианты…';
        const res = await think(board, 1, { timeMs: 700 });
        if (my !== gen || turn !== 1) return;
        analysis = res;
        analysis.reason = explain(res);
        updateCoach();
        exportContext();
    }

    // ---------- Объяснения ----------
    const plural = (n, a, b, c) => n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c;
    function explain(res) {
        if (!res.best) return '';
        const moves = E.genMoves(board, 1);
        const m = moves.find(x => E.notation(x) === res.best);
        const parts = [];
        if (m.caps.length) parts.push(`бьёт ${m.caps.length} ${plural(m.caps.length, 'шашку', 'шашки', 'шашек')}`);
        if (m.promo) parts.push('проходит в дамки');
        if (moves.length === 1) parts.push('других ходов нет');
        const second = res.scores[1];
        if (second && res.scores[0].score - second.score > 120) parts.push('остальные ходы теряют материал');
        // Уводит ли ход шашку из-под удара
        const threatsNow = E.genMoves(board, -1).filter(x => x.caps.length);
        if (!m.caps.length && threatsNow.length) {
            const after = E.genMoves(E.apply(board, m), -1).filter(x => x.caps.length);
            if (!after.length) parts.push('убирает шашку из-под удара');
        }
        const reply = res.pv[1];
        if (reply && reply.includes(':')) {
            if (res.pv[2] && res.pv[2].includes(':')) parts.push(`после ответа ${reply} белые бьют ${res.pv[2]} — выгодный размен`);
            else if (!m.caps.length) parts.push(`соперник ответит ${reply}, но это лучшее, что есть в позиции`);
        }
        if (!parts.length) {
            const to = m.to, r = to >> 3, c = to & 7;
            if (r >= 3 && r <= 4 && c >= 2 && c <= 5) parts.push('укрепляет центр');
            else if (Math.abs(board[m.from]) === 2) parts.push('дамка занимает активную позицию');
            else parts.push('сохраняет строй и не даёт противнику ударов');
        }
        return parts.join(', ');
    }

    function evalText(score) {
        if (Math.abs(score) > E.MATE - 200) return score > 0 ? 'форсированный выигрыш белых' : 'форсированный выигрыш чёрных';
        const v = score / 100;
        if (Math.abs(v) < 0.3) return 'равная позиция';
        const who = v > 0 ? 'белых' : 'чёрных';
        if (Math.abs(v) < 0.8) return 'небольшое преимущество ' + who;
        if (Math.abs(v) < 2) return 'заметное преимущество ' + who;
        return 'решающее преимущество ' + who;
    }
    const chanceOf = s => Math.abs(s) > E.MATE - 200 ? (s > 0 ? 99 : 1) : Math.round(100 / (1 + Math.exp(-s / 170)));
    const fmtEval = s => Math.abs(s) > E.MATE - 200 ? (s > 0 ? '+М' : '−М') : (s >= 0 ? '+' : '−') + Math.abs(s / 100).toFixed(1);

    function updateCoach() {
        const a = analysis;
        $('best-move').textContent = a.best || '—';
        $('best-reason').textContent = a.reason ? a.reason[0].toUpperCase() + a.reason.slice(1) + '.' : '';
        $('pv').innerHTML = a.pv.length > 1 ? 'Вариант: ' + a.pv.slice(0, 6).map((m, i) => `<span class="${i % 2 ? 'b' : 'w'}">${m}</span>`).join(' ') : '';
        $('engine-meta').textContent = `глубина ${a.depth} · ${a.ms} мс`;
        const ch = chanceOf(a.score);
        $('chance').textContent = ch + '%';
        $('eval-text').textContent = evalText(a.score);
        $('eval-num').textContent = fmtEval(a.score);
        $('eval-fill').style.height = ch + '%';
        // угроза: что бот бьёт, если бы ходил сейчас
        const thr = E.genMoves(board, -1).filter(x => x.caps.length);
        const t = $('threat');
        if (thr.length) {
            const worst = thr.sort((x, y) => y.caps.length - x.caps.length)[0];
            t.hidden = false;
            t.textContent = `Внимание: у бота есть удар ${E.notation(worst)} (${worst.caps.length} ${plural(worst.caps.length, 'шашка', 'шашки', 'шашек')}).`;
        } else t.hidden = true;
    }

    function showLast(m, q) {
        $('last-move').innerHTML = `<b>${E.notation(m)}</b>` + (q ? ` <span class="q ${q.cls}">${q.label}</span>` +
            (q.loss >= 40 && q.best !== q.played ? `<div class="sub">Лучше было <b>${q.best}</b>${q.bestReason ? ' — ' + q.bestReason : ''}.</div>` : '') : '');
    }

    function logMove(m, side, q) {
        const list = $('moves');
        if (side === 1) {
            const li = document.createElement('li');
            li.innerHTML = `<span class="w">${E.notation(m)}${q ? ` <i class="q ${q.cls}" title="${q.label}">${{ best: '!!', ok: '!', inacc: '?!', mistake: '?', blunder: '??' }[q.cls]}</i>` : ''}</span><span class="b"></span>`;
            list.appendChild(li);
        } else {
            let li = list.lastElementChild;
            if (!li || li.querySelector('.b').textContent) { li = document.createElement('li'); li.innerHTML = '<span class="w">…</span><span class="b"></span>'; list.appendChild(li); }
            li.querySelector('.b').textContent = E.notation(m);
        }
        list.scrollTop = list.scrollHeight;
    }

    // ---------- Конец партии ----------
    function checkEnd() {
        const moves = E.genMoves(board, turn);
        let title = null, text = '', emoji = '';
        if (!moves.length) {
            if (turn === 1) { title = 'Бот победил'; text = 'У белых не осталось ходов. Попробуйте ещё раз — тренер подскажет!'; emoji = '🤖'; }
            else { title = 'Победа!'; text = `Вы обыграли бота уровня «${LEVELS[level].name}».`; emoji = '🎉'; }
        } else if (quietPlies >= 30) { title = 'Ничья'; text = '15 ходов одними дамками без взятий.'; emoji = '🤝'; }
        else if ([...positions.values()].some(v => v >= 3)) { title = 'Ничья'; text = 'Позиция повторилась трижды.'; emoji = '🤝'; }
        if (!title) return false;
        gameOver = true; render();
        $('r-title').textContent = title; $('r-text').textContent = text; $('r-emoji').textContent = emoji;
        setTimeout(() => { $('overlay').hidden = false; }, 500);
        exportContext(title);
        say(title === 'Победа!' ? 'Поздравляю с победой! Отличная партия.' : title === 'Ничья' ? 'Ничья — достойный результат!' : 'Бот победил, но это поправимо. Давай разберём ошибки и сыграем ещё.');
        return true;
    }

    // ---------- Связь с ассистентом ----------
    let lastSay = 0;
    function say(text) {
        if (!$('coach-toggle').checked || !window.LW) return;
        if (Date.now() - lastSay < 5000) return;
        lastSay = Date.now();
        window.LW.say(text);
    }
    function coachComment(m, q) {
        if (!q) return;
        if (q.cls === 'blunder') say(`Ой, ${q.played} — это зевок. Сильнее было ${q.best}: ${q.bestReason || 'так ты сохраняешь материал'}.`);
        else if (q.cls === 'mistake') say(`${q.played} — ошибка. Лучше было ${q.best}${q.bestReason ? ', потому что ' + q.bestReason : ''}.`);
        else if (q.cls === 'best' && m.caps.length >= 2) say(`Красивая серия! ${q.played} — лучший ход.`);
    }

    function describeMaterial() {
        const w = count(1), b = count(-1);
        const f = o => `${o.men} ${plural(o.men, 'шашка', 'шашки', 'шашек')}` + (o.kings ? ` и ${o.kings} ${plural(o.kings, 'дамка', 'дамки', 'дамок')}` : '');
        return `белые: ${f(w)}; чёрные: ${f(b)}`;
    }
    function exportContext(result) {
        const a = analysis;
        const ctx = {
            'Игра': 'Русские шашки. Пользователь играет белыми (снизу) против бота, уровень «' + LEVELS[level].name + '». Поля обозначаются как в шахматах: a–h слева направо, 1–8 снизу вверх; «-» — тихий ход, «:» — взятие.',
            'Номер хода': Math.floor(history.length / 2) + 1,
            'Чей ход': gameOver ? 'партия окончена' : turn === 1 ? 'пользователя (белые)' : 'бота (чёрные)',
            'Материал': describeMaterial(),
        };
        if (result) ctx['Итог партии'] = result;
        if (a && !gameOver) {
            ctx['Оценка движка'] = `${fmtEval(a.score)} — ${evalText(a.score)}, шансы белых около ${chanceOf(a.score)}%`;
            ctx['Лучший ход для белых'] = a.best + (a.reason ? ` (${a.reason})` : '');
            if (a.scores.length > 1) ctx['Другие хорошие ходы'] = a.scores.slice(1, 3).filter(s => a.scores[0].score - s.score < 60).map(s => s.n).join(', ') || 'нет, остальные заметно хуже';
            ctx['Главный вариант'] = a.pv.slice(0, 6).join(' ');
            const forced = E.genMoves(board, 1);
            ctx['Обязательное взятие'] = forced[0]?.caps.length ? 'да — сейчас белые обязаны бить' : 'нет';
            ctx['Все допустимые ходы белых'] = forced.map(E.notation).join(', ');
        }
        if (lastQuality) ctx['Разбор последнего хода пользователя'] = `${lastQuality.played} — ${lastQuality.label.toLowerCase()}` + (lastQuality.loss >= 40 ? `; лучше было ${lastQuality.best}` : '');
        const botLast = history.length && history[history.length - 1].turn === -1 ? E.notation(lastMove) : null;
        if (botLast) ctx['Последний ход бота'] = botLast;
        const thr = E.genMoves(board, -1).filter(x => x.caps.length);
        if (thr.length && !gameOver) ctx['Угроза'] = 'у бота есть удар ' + thr.map(E.notation).slice(0, 2).join(' или ');
        ctx['Как отвечать'] = 'Ты тренер по шашкам. Советуй только ходы из этих данных, объясняй коротко и по-человечески, без выдуманных вариантов.';
        window.__ASSISTANT_CONTEXT__ = () => ctx;
    }

    // ---------- Кнопки ----------
    $('new-btn').addEventListener('click', newGame);
    $('r-btn').addEventListener('click', newGame);
    $('undo-btn').addEventListener('click', () => {
        if (!history.length || botThinking) return;
        gen++;
        // откатываем до последнего хода пользователя
        let h;
        do { h = history.pop(); } while (history.length && h.turn !== 1);
        board = h.board; turn = h.turn; lastMove = h.lastMove; quietPlies = h.quietPlies; gameOver = false; selected = null; stepPath = []; hint = null;
        $('overlay').hidden = true;
        const list = $('moves'); const last = list.lastElementChild; if (last) last.remove();
        lastQuality = null;
        $('last-move').innerHTML = '<span class="muted">Ход отменён</span>';
        render(); afterMove();
    });
    $('hint-btn').addEventListener('click', () => {
        if (!analysis || turn !== 1) return;
        hint = E.genMoves(board, 1).find(m => E.notation(m) === analysis.best) || null;
        render();
    });
    $('ask-btn').addEventListener('click', () => {
        if (!window.LW) { alert('Ассистент не загрузился. Запустите основной сервер (run.bat) на порту 5000.'); return; }
        window.LW.open();
        window.LW.ask('Какой ход мне сейчас лучше сделать и почему?');
    });
    document.querySelectorAll('#levels button').forEach(b => {
        b.classList.toggle('active', b.dataset.level === level);
        b.addEventListener('click', () => {
            level = b.dataset.level;
            try { localStorage.setItem('chk_level', level); } catch (_) { }
            document.querySelectorAll('#levels button').forEach(x => x.classList.toggle('active', x === b));
            exportContext();
        });
    });

    newGame();
})();
