/* Аналитика: KPI и графики на чистом SVG. */
(function () {
    'use strict';
    const $ = s => document.querySelector(s);
    const C = { ai: '#6E56F8', user: '#FF6FAE', op: '#1FAF8B', grid: '#ECE7F7', text: '#8C86A6' };
    let days = 14, demo = false, real = null;
    try { demo = localStorage.getItem('l2a_demo') === '1'; } catch (_) { }
    $('#demo-toggle').checked = demo;

    const fmt = n => new Intl.NumberFormat('ru-RU').format(n);

    // Псевдослучайные, но стабильные демо-данные
    function demoData(d) {
        let seed = 7;
        const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
        const series = [];
        const today = new Date();
        for (let i = d - 1; i >= 0; i--) {
            const dt = new Date(today); dt.setDate(today.getDate() - i);
            const wd = dt.getDay(), weekend = wd === 0 || wd === 6;
            const base = (weekend ? 140 : 210) + (d - i) * 3;
            const user = Math.round(base * (0.85 + rnd() * 0.3));
            const op = Math.round(user * (0.04 + rnd() * 0.04));
            series.push({ date: dt.toISOString().slice(0, 10), user, assistant: user - op + Math.round(rnd() * 12), operator: op });
        }
        const hours = Array.from({ length: 24 }, (_, h) => Math.round((h < 7 ? 6 : h < 10 ? 40 + h * 6 : h < 14 ? 110 : h < 18 ? 95 : h < 23 ? 120 - (h - 18) * 12 : 30) * (0.8 + rnd() * 0.4)));
        const sum = k => series.reduce((a, s) => a + s[k], 0);
        const u = sum('user'), a = sum('assistant'), o = sum('operator');
        return {
            kpi: { dialogs: Math.round(u / 4.3), messages: u + a + o, user_messages: u, ai_messages: a, operator_messages: o,
                handoffs: Math.round(u / 4.3 * 0.061), automation: Math.round(100 * a / (a + o)), avg_len: 8.6, widget_share: 92 },
            series, hours,
            by_assistant: [{ name: 'Лила — продажи', value: Math.round(u * 1.1) }, { name: 'Дора — поддержка', value: Math.round(u * 0.6) }, { name: 'Плюш — детский раздел', value: Math.round(u * 0.25) }],
        };
    }

    async function load() {
        try { real = await Dash.api('/api/admin/analytics?days=' + days); } catch (e) { real = null; }
        render();
    }

    function render() {
        const empty = !real || real.kpi.messages < 10;
        $('#demo-note').hidden = demo || !empty;
        $('#demo-on').hidden = !demo;
        const data = demo ? demoData(days) : real;
        if (!data) return;
        const k = data.kpi;
        $('#k-dialogs').textContent = fmt(k.dialogs);
        $('#k-dialogs-sub').textContent = `в среднем ${String(k.avg_len).replace('.', ',')} сообщ. в диалоге`;
        $('#k-ai').textContent = fmt(k.ai_messages);
        $('#k-ai-sub').textContent = `на ${fmt(k.user_messages)} вопросов посетителей`;
        $('#k-auto').textContent = (k.ai_messages + k.operator_messages) ? k.automation + '%' : '—';
        $('#k-handoff').textContent = fmt(k.handoffs);
        $('#k-handoff-sub').textContent = k.dialogs ? `${Math.round(100 * k.handoffs / Math.max(1, k.dialogs))}% диалогов · ${fmt(k.operator_messages)} ответов` : 'запросов живого человека';
        lineChart($('#chart-days'), data.series);
        donut($('#donut'), k.ai_messages, k.operator_messages);
        bars($('#by-assistant'), data.by_assistant);
        heat($('#heat'), data.hours);
    }

    function lineChart(el, series) {
        const W = el.clientWidth || 600, H = el.clientHeight || 260, P = { l: 36, r: 8, t: 10, b: 26 };
        const max = Math.max(4, ...series.map(s => Math.max(s.user, s.assistant, s.operator)));
        const nice = Math.ceil(max / 4 / (max > 40 ? 10 : 1)) * (max > 40 ? 10 : 1) * 4;
        const x = i => P.l + (series.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (series.length - 1));
        const y = v => P.t + (H - P.t - P.b) * (1 - v / nice);
        const path = key => series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join('');
        const area = key => `${path(key)}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
        let g = '';
        for (let i = 0; i <= 4; i++) {
            const v = nice * i / 4, yy = y(v);
            g += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="${C.grid}" ${i ? 'stroke-dasharray="3 4"' : ''}/>`;
            g += `<text x="${P.l - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${C.text}">${fmt(v)}</text>`;
        }
        const step = Math.ceil(series.length / 7);
        series.forEach((s, i) => {
            if (i % step === 0 || i === series.length - 1) {
                const d = new Date(s.date);
                g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${C.text}">${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')}</text>`;
            }
        });
        el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Сообщения по дням">
            <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.ai}" stop-opacity=".22"/><stop offset="1" stop-color="${C.ai}" stop-opacity="0"/></linearGradient></defs>
            ${g}
            <path d="${area('assistant')}" fill="url(#ga)"/>
            <path d="${path('assistant')}" fill="none" stroke="${C.ai}" stroke-width="2.5" stroke-linejoin="round"/>
            <path d="${path('user')}" fill="none" stroke="${C.user}" stroke-width="2" stroke-linejoin="round"/>
            <path d="${path('operator')}" fill="none" stroke="${C.op}" stroke-width="2" stroke-linejoin="round"/>
            <line id="hover-line" y1="${P.t}" y2="${H - P.b}" stroke="${C.text}" stroke-dasharray="2 3" opacity="0"/>
            <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" id="hover-zone"/>
        </svg><div class="chart-tip" id="tip"></div>`;
        const zone = el.querySelector('#hover-zone'), line = el.querySelector('#hover-line'), tip = el.querySelector('#tip');
        zone.addEventListener('mousemove', e => {
            const r = el.getBoundingClientRect();
            const px = (e.clientX - r.left) * (W / r.width);
            const i = Math.max(0, Math.min(series.length - 1, Math.round((px - P.l) / ((W - P.l - P.r) / Math.max(1, series.length - 1)))));
            const s = series[i];
            line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('opacity', 1);
            tip.style.opacity = 1;
            tip.style.left = (x(i) * r.width / W) + 'px';
            tip.style.top = (y(Math.max(s.user, s.assistant)) * r.height / H) + 'px';
            tip.innerHTML = `<b>${new Date(s.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</b><br>Ассистент: ${s.assistant} · Посетители: ${s.user} · Оператор: ${s.operator}`;
        });
        zone.addEventListener('mouseleave', () => { line.setAttribute('opacity', 0); tip.style.opacity = 0; });
    }

    function donut(el, ai, op) {
        const total = ai + op;
        const pct = total ? ai / total : 0;
        const R = 54, L = 2 * Math.PI * R;
        el.innerHTML = `<svg viewBox="0 0 140 140" role="img" aria-label="Доля ответов ассистента">
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="#E2F7F1" stroke-width="16"/>
            <circle cx="70" cy="70" r="${R}" fill="none" stroke="${C.ai}" stroke-width="16" stroke-linecap="round"
                stroke-dasharray="${(L * pct).toFixed(1)} ${L}" transform="rotate(-90 70 70)"/>
            <text x="70" y="68" text-anchor="middle" font-family="Unbounded, sans-serif" font-size="24" font-weight="600" fill="#1E1838">${total ? Math.round(pct * 100) + '%' : '—'}</text>
            <text x="70" y="88" text-anchor="middle" font-size="11" fill="${C.text}">ассистентом</text>
        </svg>
        <div class="legend" style="flex-direction:column;gap:10px">
            <span><i style="background:${C.ai}"></i>Ассистент — ${fmt(ai)}</span>
            <span><i style="background:${C.op}"></i>Операторы — ${fmt(op)}</span>
            <span class="small faint" style="max-width:24ch">Чем выше доля ассистента, тем меньше нагрузка на поддержку.</span>
        </div>`;
    }

    function bars(el, items) {
        if (!items.length) { el.innerHTML = '<p class="muted small">Пока нет диалогов за выбранный период.</p>'; return; }
        const max = Math.max(...items.map(i => i.value));
        el.innerHTML = items.map(i => `<div class="bar-h"><div class="bh-top"><span>${Dash.esc(i.name)}</span><b>${fmt(i.value)}</b></div>
            <div class="bh-track"><i style="width:${(100 * i.value / max).toFixed(1)}%"></i></div></div>`).join('');
    }

    function heat(el, hours) {
        const max = Math.max(1, ...hours);
        el.innerHTML = hours.map((v, h) => `<div title="${h}:00 — ${v} сообщ." style="background:${v ? `rgba(110,86,248,${(0.12 + 0.88 * v / max).toFixed(2)})` : 'var(--violet-soft)'}"></div>`).join('');
        const peak = hours.indexOf(Math.max(...hours));
        $('#peak').textContent = Math.max(...hours) ? `Пик обращений — с ${peak}:00 до ${peak + 1}:00. В это время полезно держать оператора на связи.` : 'Сообщений посетителей за период пока нет.';
    }

    document.querySelectorAll('#period button').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('#period button').forEach(x => x.classList.toggle('active', x === b));
        days = +b.dataset.d; load();
    }));
    $('#demo-toggle').addEventListener('change', e => {
        demo = e.target.checked;
        try { localStorage.setItem('l2a_demo', demo ? '1' : '0'); } catch (_) { }
        render();
    });
    window.addEventListener('resize', () => render());
    load();
})();
