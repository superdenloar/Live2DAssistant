/**
 * Движок русских шашек.
 *  • Простые шашки ходят вперёд, бьют вперёд и назад.
 *  • Дамки «дальнобойные»: ходят и бьют на любое расстояние по диагонали.
 *  • Бить обязательно; начатое взятие нужно довести до конца (выбор серии — за игроком).
 *  • Шашка, дошедшая до последней горизонтали во время взятия, становится дамкой и продолжает бить как дамка.
 *  • «Турецкий удар»: побитые шашки снимаются после хода, через них нельзя перепрыгнуть второй раз.
 *  • Дамка после взятия может встать на любое поле за побитой шашкой, но если с какого-то из них
 *    можно бить дальше — обязана выбрать такое поле.
 * Поиск: negamax + alpha-beta, итеративное углубление, таблица транспозиций, продление на взятиях.
 * Работает и на странице, и в Web Worker.
 */
(function (root) {
    'use strict';

    // Клетки: индекс r*8+c, r=0 — верх (сторона чёрных). Значения: 1 белая шашка, 2 белая дамка, -1/-2 — чёрные.
    const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const FILES = 'abcdefgh';
    const sq = (r, c) => r * 8 + c;
    const rc = i => [i >> 3, i & 7];
    const onB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
    const name = i => FILES[i & 7] + (8 - (i >> 3));

    function initial() {
        const b = new Int8Array(64);
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) {
            if (r < 3) b[sq(r, c)] = -1; else if (r > 4) b[sq(r, c)] = 1;
        }
        return b;
    }

    // ----- Генерация ходов -----
    function genMoves(b, side) {
        const caps = [];
        for (let i = 0; i < 64; i++) if (b[i] * side > 0) genCaptures(b, i, side, caps);
        if (caps.length) return caps;
        const moves = [];
        for (let i = 0; i < 64; i++) {
            const p = b[i]; if (p * side <= 0) continue;
            const [r, c] = rc(i);
            if (Math.abs(p) === 1) {
                const dr = side === 1 ? -1 : 1;
                for (const dc of [-1, 1]) {
                    const nr = r + dr, nc = c + dc;
                    if (onB(nr, nc) && b[sq(nr, nc)] === 0) {
                        const to = sq(nr, nc);
                        moves.push({ from: i, to, path: [i, to], caps: [], promo: (side === 1 && nr === 0) || (side === -1 && nr === 7) });
                    }
                }
            } else {
                for (const [dr, dc] of DIRS) {
                    let nr = r + dr, nc = c + dc;
                    while (onB(nr, nc) && b[sq(nr, nc)] === 0) {
                        moves.push({ from: i, to: sq(nr, nc), path: [i, sq(nr, nc)], caps: [], promo: false });
                        nr += dr; nc += dc;
                    }
                }
            }
        }
        return moves;
    }

    function genCaptures(b, from, side, out) {
        const piece = b[from];
        const king = Math.abs(piece) === 2;
        b[from] = 0; // фигура «поднята» с доски во время серии
        walk(from, king, [from], [], new Set());
        b[from] = piece;

        function walk(pos, isKing, path, caps, taken) {
            const [r, c] = rc(pos);
            let found = false;
            for (const [dr, dc] of DIRS) {
                if (!isKing) {
                    const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
                    if (!onB(lr, lc)) continue;
                    const m = sq(mr, mc), l = sq(lr, lc);
                    if (b[m] * side < 0 && !taken.has(m) && b[l] === 0) {
                        found = true;
                        const promo = (side === 1 && lr === 0) || (side === -1 && lr === 7);
                        taken.add(m);
                        const before = out.length;
                        walk(l, promo, [...path, l], [...caps, m], taken);
                        if (out.length === before) out.push(mk(path.concat(l), caps.concat(m), promo));
                        taken.delete(m);
                    }
                } else {
                    let nr = r + dr, nc = c + dc;
                    while (onB(nr, nc) && b[sq(nr, nc)] === 0) { nr += dr; nc += dc; }
                    if (!onB(nr, nc)) continue;
                    const m = sq(nr, nc);
                    if (!(b[m] * side < 0) || taken.has(m)) continue;
                    // поля приземления за побитой шашкой
                    const lands = [];
                    let lr = nr + dr, lc = nc + dc;
                    while (onB(lr, lc) && b[sq(lr, lc)] === 0) { lands.push(sq(lr, lc)); lr += dr; lc += dc; }
                    if (!lands.length) continue;
                    found = true;
                    taken.add(m);
                    const cont = lands.filter(l => canCapture(l, taken));
                    const use = cont.length ? cont : lands;
                    for (const l of use) {
                        const before = out.length;
                        if (cont.length) walk(l, true, [...path, l], [...caps, m], taken);
                        if (out.length === before) out.push(mk(path.concat(l), caps.concat(m), false));
                    }
                    taken.delete(m);
                }
            }
            return found;
        }
        function canCapture(pos, taken) {
            const [r, c] = rc(pos);
            for (const [dr, dc] of DIRS) {
                let nr = r + dr, nc = c + dc;
                while (onB(nr, nc) && b[sq(nr, nc)] === 0) { nr += dr; nc += dc; }
                if (!onB(nr, nc)) continue;
                const m = sq(nr, nc);
                if (b[m] * side < 0 && !taken.has(m) && onB(nr + dr, nc + dc) && b[sq(nr + dr, nc + dc)] === 0) return true;
            }
            return false;
        }
        function mk(path, caps, promoDuring) {
            const to = path[path.length - 1];
            const lastRow = to >> 3;
            const promo = !king && (promoDuring || (side === 1 && lastRow === 0) || (side === -1 && lastRow === 7) || path.some(p => (side === 1 ? (p >> 3) === 0 : (p >> 3) === 7) && p !== path[0]));
            return { from, to, path, caps, promo };
        }
    }

    function apply(b, m) {
        const nb = new Int8Array(b);
        const p = nb[m.from];
        nb[m.from] = 0;
        for (const c of m.caps) nb[c] = 0;
        nb[m.to] = m.promo ? Math.sign(p) * 2 : p;
        return nb;
    }

    function notation(m) {
        return m.caps.length ? m.path.map(name).join(':') : name(m.from) + '-' + name(m.to);
    }

    // ----- Оценка позиции (с точки зрения белых) -----
    const CENTER = new Set([sq(3, 2), sq(3, 4), sq(4, 3), sq(4, 5), sq(3, 6), sq(4, 1)]);
    const MAIN_DIAG = new Set([sq(7, 0), sq(6, 1), sq(5, 2), sq(4, 3), sq(3, 4), sq(2, 5), sq(1, 6), sq(0, 7)]);
    function evaluate(b) {
        let s = 0, wm = 0, bm = 0, wk = 0, bk = 0;
        for (let i = 0; i < 64; i++) {
            const p = b[i]; if (!p) continue;
            const r = i >> 3;
            if (p === 1) { wm++; s += 100 + (7 - r) * (7 - r) * 0.9; if (CENTER.has(i)) s += 6; if (r === 7) s += 5; }
            else if (p === -1) { bm++; s -= 100 + r * r * 0.9; if (CENTER.has(i)) s -= 6; if (r === 0) s -= 5; }
            else if (p === 2) { wk++; s += 290 + (MAIN_DIAG.has(i) ? 18 : 0); }
            else if (p === -2) { bk++; s -= 290 + (MAIN_DIAG.has(i) ? 18 : 0); }
        }
        // Чем меньше фигур, тем ценнее перевес
        const total = wm + bm + wk + bk;
        if (total < 12) s *= 1 + (12 - total) * 0.04;
        if (wm + wk === 0) return -100000;
        if (bm + bk === 0) return 100000;
        return s;
    }

    // ----- Поиск -----
    const MATE = 100000;
    function search(b, side, opts = {}) {
        const timeLimit = opts.timeMs ?? 600;
        const maxDepth = opts.maxDepth ?? 30;
        const t0 = Date.now();
        let nodes = 0, stop = false;
        const tt = new Map();
        const key = (bb, sd) => { let h = sd === 1 ? 'w' : 'b'; for (let i = 0; i < 64; i++) if (bb[i]) h += i.toString(36) + (bb[i] + 3); return h; };

        function negamax(bb, sd, depth, alpha, beta, ply) {
            if ((++nodes & 1023) === 0 && Date.now() - t0 > timeLimit) stop = true;
            if (stop) return 0;
            const moves = genMoves(bb, sd);
            if (!moves.length) return -MATE + ply;
            const forced = moves[0].caps.length > 0;
            if (depth <= 0 && !forced) return sd * evaluate(bb);
            if (depth <= -6) return sd * evaluate(bb);
            const k = key(bb, sd);
            const hit = tt.get(k);
            if (hit && hit.depth >= depth) {
                if (hit.flag === 0) return hit.score;
                if (hit.flag === 1 && hit.score >= beta) return hit.score;
                if (hit.flag === -1 && hit.score <= alpha) return hit.score;
            }
            order(moves, hit && hit.best);
            let best = -Infinity, bestMove = null; const a0 = alpha;
            for (const m of moves) {
                const v = -negamax(apply(bb, m), -sd, depth - (forced && moves.length === 1 ? 0 : 1), -beta, -alpha, ply + 1);
                if (stop) return 0;
                if (v > best) { best = v; bestMove = notation(m); }
                if (v > alpha) alpha = v;
                if (alpha >= beta) break;
            }
            tt.set(k, { depth, score: best, flag: best <= a0 ? -1 : best >= beta ? 1 : 0, best: bestMove });
            return best;
        }
        function order(moves, hint) {
            moves.sort((x, y) => (notation(y) === hint) - (notation(x) === hint) || y.caps.length - x.caps.length || (y.promo ? 1 : 0) - (x.promo ? 1 : 0));
        }

        const root = genMoves(b, side);
        if (!root.length) return { best: null, score: -MATE, depth: 0, pv: [], scores: [] };
        let result = { best: root[0], score: 0, depth: 0, scores: root.map(m => ({ move: m, score: 0 })) };
        for (let d = 1; d <= maxDepth; d++) {
            const scored = [];
            let alpha = -Infinity;
            order(root, result.best && notation(result.best));
            for (const m of root) {
                // полное окно для каждого хода — нужна честная оценка всех ходов (для разбора ошибок)
                const v = -negamax(apply(b, m), -side, d - 1, -Infinity, Infinity, 1);
                if (stop) break;
                scored.push({ move: m, score: v });
                if (v > alpha) alpha = v;
            }
            if (stop && scored.length < root.length) break;
            scored.sort((x, y) => y.score - x.score);
            result = { best: scored[0].move, score: scored[0].score, depth: d, scores: scored };
            if (Math.abs(result.score) > MATE - 100) break;
            if (Date.now() - t0 > timeLimit * 0.45) break;
        }
        // Главный вариант из таблицы транспозиций
        const pv = [notation(result.best)];
        let bb = apply(b, result.best), sd = -side;
        for (let i = 0; i < 8; i++) {
            const e = tt.get(key(bb, sd)); if (!e || !e.best) break;
            const mv = genMoves(bb, sd).find(m => notation(m) === e.best); if (!mv) break;
            pv.push(e.best); bb = apply(bb, mv); sd = -sd;
        }
        result.pv = pv;
        result.nodes = nodes;
        result.ms = Date.now() - t0;
        return result;
    }

    const Engine = { initial, genMoves, apply, notation, name, evaluate, search, MATE, sq, rc };
    root.CheckersEngine = Engine;

    // ----- Режим Web Worker -----
    if (typeof window === 'undefined' && typeof self !== 'undefined') {
        self.onmessage = (e) => {
            const { id, board, side, opts } = e.data;
            const res = search(new Int8Array(board), side, opts);
            self.postMessage({
                id, depth: res.depth, score: res.score, pv: res.pv || [], ms: res.ms, nodes: res.nodes,
                best: res.best ? notation(res.best) : null,
                scores: (res.scores || []).map(s => ({ n: notation(s.move), score: s.score })),
            });
        };
    }
})(typeof self !== 'undefined' ? self : this);
