/* global Calc, api */
(function () {
  const $ = (s) => document.querySelector(s);
  const { CALCS } = Calc;
  const IDS = Object.keys(CALCS);
  const MOD = api.platform === 'darwin' ? '⌘' : 'Ctrl+';
  document.body.classList.add(api.platform === 'darwin' ? 'mac' : api.platform === 'win32' ? 'win' : 'linux');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const state = {
    calc: store.get('calc', 'profit'),
    values: store.get('values', {}),
    history: store.get('history', []),
    presets: store.get('presets', []),
    thread: [],
  };
  if (!CALCS[state.calc]) state.calc = 'profit';
  // 계산기별 값 객체는 항상 같은 객체를 유지한다(폼 핸들러가 이 객체를 직접 수정함)
  const valuesOf = (id) => {
    const cur = state.values[id] || (state.values[id] = {});
    const d = Calc.defaults(id);
    for (const k of Object.keys(d)) if (cur[k] === undefined) cur[k] = d[k];
    return cur;
  };

  // ───────── toast ─────────
  let toastTimer;
  function toast(msg, opts = {}) {
    const t = $('#toast');
    t.className = 'toast' + (opts.err ? ' err' : '');
    t.innerHTML = '';
    t.append(document.createTextNode(msg));
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action.label;
      b.onclick = () => { t.hidden = true; opts.action.run(); };
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, opts.ms || 3500);
  }

  // ───────── sidebar ─────────
  function renderSidebar() {
    const nav = $('#sidebar');
    nav.innerHTML = '';
    const groups = {};
    IDS.forEach((id, i) => { (groups[CALCS[id].group] = groups[CALCS[id].group] || []).push([id, i]); });
    for (const [g, items] of Object.entries(groups)) {
      const h = document.createElement('div'); h.className = 'nav-group'; h.textContent = g; nav.append(h);
      for (const [id, i] of items) {
        const b = document.createElement('button');
        b.className = 'nav-item' + (id === state.calc ? ' active' : '');
        b.innerHTML = `<span class="ico">${CALCS[id].icon}</span><span>${CALCS[id].name}</span><kbd>${MOD}${i < 9 ? i + 1 : 0}</kbd>`;
        b.onclick = () => selectCalc(id);
        nav.append(b);
      }
    }
  }

  function selectCalc(id) {
    state.calc = id; store.set('calc', id);
    renderSidebar(); renderForm(); compute();
  }

  // ───────── form ─────────
  const parseNum = (s) => String(s).replace(/[^0-9.\-]/g, '');
  const withCommas = (raw) => {
    if (raw === '' || raw === '-') return raw;
    const [i, d] = raw.split('.');
    const iv = i === '' || i === '-' ? i : Number(i).toLocaleString('ko-KR');
    return d !== undefined ? `${iv}.${d}` : iv;
  };

  function renderForm(aiFilled = []) {
    const calc = CALCS[state.calc];
    const v = valuesOf(state.calc);
    $('#calcTitle').textContent = `${calc.icon} ${calc.name} 계산기`;
    $('#calcDesc').textContent = calc.desc;
    const form = $('#form');
    form.innerHTML = '';
    const hasAdv = calc.fields.some((f) => f.advanced);
    $('#toggleAdvanced').hidden = !hasAdv;

    calc.fields.forEach((f) => {
      const wrap = document.createElement('div');
      wrap.className = 'field' + (f.type === 'text' ? ' full' : '') + (f.advanced ? ' advanced' : '') + (aiFilled.includes(f.key) ? ' filled-by-ai' : '');
      const label = document.createElement('label');
      label.htmlFor = 'f_' + f.key;
      label.textContent = f.label;
      if (f.hint) { const h = document.createElement('span'); h.className = 'help'; h.textContent = '?'; h.title = f.hint; label.append(h); }
      wrap.append(label);

      if (f.type === 'select' && f.options.length <= 4) {
        const seg = document.createElement('div'); seg.className = 'segmented';
        f.options.forEach((o) => {
          const b = document.createElement('button'); b.type = 'button';
          b.textContent = f.key === 'unit' ? (o === '1' ? '안 함' : `${Number(o).toLocaleString()}원`) : o;
          if (v[f.key] === o) b.className = 'on';
          b.onclick = () => { v[f.key] = o; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); saveValues(); compute(); };
          seg.append(b);
        });
        wrap.append(seg);
      } else if (f.type === 'select') {
        const s = document.createElement('select'); s.id = 'f_' + f.key;
        f.options.forEach((o) => { const op = document.createElement('option'); op.value = o; op.textContent = o; s.append(op); });
        s.value = v[f.key]; s.onchange = () => { v[f.key] = s.value; saveValues(); compute(); };
        wrap.append(s);
      } else {
        const iw = document.createElement('div'); iw.className = 'input-wrap';
        const input = document.createElement('input');
        input.id = 'f_' + f.key; input.dataset.key = f.key;
        input.placeholder = f.placeholder || '';
        if (f.type === 'text') { input.value = v[f.key] || ''; input.oninput = () => { v[f.key] = input.value; saveValues(); }; }
        else {
          input.inputMode = 'decimal';
          input.value = withCommas(v[f.key] || '');
          const unit = f.type === 'money' ? '원' : f.type === 'percent' ? '%' : '';
          if (unit) { input.classList.add('has-unit'); const u = document.createElement('span'); u.className = 'unit'; u.textContent = unit; iw.append(u); }
          input.oninput = () => {
            let raw = parseNum(input.value);
            const parts = raw.split('.'); if (parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
            v[f.key] = raw;
            const fromEnd = input.value.length - input.selectionStart;
            input.value = withCommas(raw);
            const pos = Math.max(0, input.value.length - fromEnd); input.setSelectionRange(pos, pos);
            saveValues(); compute();
          };
          input.onkeydown = (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const step = (f.type === 'money' ? (e.shiftKey ? 1000 : 100) : (e.shiftKey ? 1 : 0.5)) * (e.key === 'ArrowUp' ? 1 : -1);
              const nv = Math.round((Calc.num(v[f.key]) + step) * 100) / 100;
              v[f.key] = String(Math.max(f.type === 'number' ? -Infinity : 0, nv));
              input.value = withCommas(v[f.key]); saveValues(); compute();
            }
          };
        }
        input.onkeydown = ((prev) => (e) => {
          if (prev) prev(e);
          if (e.key === 'Enter') { e.preventDefault(); focusNext(input); }
        })(input.onkeydown);
        iw.prepend(input);
        wrap.append(iw);
      }
      form.append(wrap);
    });
    renderPresets();
  }

  function focusNext(el) {
    const inputs = [...document.querySelectorAll('#form input, #form select')].filter((x) => x.offsetParent);
    const i = inputs.indexOf(el);
    if (i >= 0 && inputs[i + 1]) inputs[i + 1].focus(); else el.blur();
  }

  function saveValues() { store.set('values', state.values); }

  $('#toggleAdvanced').onclick = () => {
    const on = $('#form').classList.toggle('show-advanced');
    $('#toggleAdvanced').textContent = on ? '고급 설정 숨기기' : '고급 설정 보기';
  };

  // ───────── channel presets (영업이익률) ─────────
  const PRESET_KEYS = ['feeRate', 'etcFeeRate', 'shipping', 'couponShare'];
  function renderPresets() {
    const box = $('#presets');
    if (state.calc !== 'profit') { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '<span class="muted">내 채널 프리셋:</span>';
    state.presets.forEach((p, idx) => {
      const b = document.createElement('button'); b.className = 'chip';
      b.title = `수수료 ${p.feeRate || 0}% · 기타 ${p.etcFeeRate || 0}% · 배송비 ${Number(p.shipping || 0).toLocaleString()}원`;
      b.innerHTML = `${escapeHtml(p.name)}<span class="x" title="삭제">✕</span>`;
      b.onclick = (e) => {
        if (e.target.classList.contains('x')) { state.presets.splice(idx, 1); store.set('presets', state.presets); renderPresets(); return; }
        const v = valuesOf('profit');
        PRESET_KEYS.forEach((k) => { if (p[k] !== undefined && p[k] !== '') v[k] = p[k]; });
        saveValues(); renderForm(PRESET_KEYS); compute(); toast(`"${p.name}" 프리셋을 적용했어요`);
      };
      box.append(b);
    });
    const add = document.createElement('button'); add.className = 'chip add'; add.textContent = '+ 현재 수수료·배송비 저장';
    add.onclick = () => {
      const inp = document.createElement('input');
      inp.className = 'chip'; inp.placeholder = '이름 입력 후 Enter (예: 스마트스토어)'; inp.style.minWidth = '230px';
      add.replaceWith(inp); inp.focus();
      let finished = false;
      const done = (save) => {
        if (finished) return; finished = true;
        const name = inp.value.trim();
        if (save && name) {
          const v = valuesOf('profit'); const p = { name };
          PRESET_KEYS.forEach((k) => { p[k] = v[k]; });
          state.presets.push(p); store.set('presets', state.presets); toast(`"${name}" 프리셋을 저장했어요`);
        }
        renderPresets();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(false);
    };
    box.append(add);
  }

  // ───────── compute & results ─────────
  function toneClass(o) {
    if (o.value === null || o.value === undefined || !isFinite(o.value)) return '';
    if (o.tone === 'sign') return o.value < 0 ? 'bad' : o.value > 0 ? 'good' : '';
    if (o.tone === 'margin') return o.value < 0 ? 'bad' : o.value < 0.1 ? 'warn' : 'good';
    if (o.tone === 'goal') return o.value >= 1 ? 'good' : o.value >= 0.7 ? 'warn' : 'bad';
    return '';
  }

  function compute() {
    const v = valuesOf(state.calc);
    const res = Calc.run(state.calc, v);
    const prim = $('#primaryResults'); prim.innerHTML = '';
    const list = $('#resultList'); list.innerHTML = '';
    res.forEach((o) => {
      if (o.primary) {
        const d = document.createElement('div'); d.className = 'big ' + toneClass(o);
        d.innerHTML = `<div class="lbl">${o.label}</div><div class="val">${o.text}</div>`;
        prim.append(d);
      } else {
        const dt = document.createElement('dt'); dt.textContent = o.label;
        if (o.hint) { const h = document.createElement('span'); h.className = 'help'; h.textContent = '?'; h.title = o.hint; dt.append(h); }
        const dd = document.createElement('dd'); dd.textContent = o.text;
        if (typeof o.value === 'number' && o.value < 0) dd.className = 'neg';
        list.append(dt, dd);
      }
    });
    renderBreakdown(res, v);
  }

  function renderBreakdown(res, v) {
    const box = $('#breakdown');
    if (state.calc !== 'profit') { box.hidden = true; return; }
    const r = Object.fromEntries(res.map((o) => [o.key, o.value]));
    const net = r.netSales;
    if (!net || net <= 0) { box.hidden = true; return; }
    const parts = [
      ['원가', Calc.num(v.cost), 'var(--c1)'],
      ['수수료', r.fee + r.etcFee, 'var(--c2)'],
      ['배송비', Calc.num(v.shipping), 'var(--c3)'],
      ['사은품·기타', Calc.num(v.gift) + Calc.num(v.otherCost), 'var(--c4)'],
      ['부가세', Math.max(0, r.vat), 'var(--c5)'],
      ['영업이익', Math.max(0, r.profit), 'var(--c6)'],
    ].filter((p) => p[1] > 0);
    const total = Math.max(net, parts.reduce((s, p) => s + p[1], 0));
    box.hidden = false;
    box.innerHTML = '<div class="bar">' + parts.map((p) => `<span style="width:${(p[1] / total) * 100}%;background:${p[2]}" title="${p[0]} ${Calc.fmt(p[1], 'money')}"></span>`).join('') + '</div>' +
      '<div class="legend">' + parts.map((p) => `<span><i style="background:${p[2]}"></i>${p[0]} ${((p[1] / net) * 100).toFixed(1)}%</span>`).join('') +
      (r.profit < 0 ? `<span style="color:var(--bad)">⚠ 적자 ${Calc.fmt(r.profit, 'money')}</span>` : '') + '</div>';
  }

  // ───────── actions ─────────
  function currentRecord() {
    return { calc: state.calc, values: { ...valuesOf(state.calc) }, memo: $('#memo').value.trim(), date: Date.now() };
  }

  async function record() {
    const rec = currentRecord();
    const btn = $('#btnRecord'); btn.disabled = true;
    const r = await api.appendLedger([rec]);
    btn.disabled = false;
    if (!r.ok) { toast(r.error, { err: true, ms: 6000 }); return; }
    state.history.unshift(rec); state.history = state.history.slice(0, 500); store.set('history', state.history);
    updateHistoryCount();
    $('#memo').value = '';
    toast(`장부 '${r.results[0].sheet}' 시트 ${r.results[0].row}행에 기록했어요`, { action: { label: '장부 열기', run: openLedger } });
  }

  async function openLedger() { const r = await api.openLedger(); if (!r.ok) toast(r.error, { err: true }); }

  function copyResult() {
    api.copy(Calc.summaryText(state.calc, valuesOf(state.calc)))
      .then(() => toast('결과를 복사했어요'), () => toast('복사하지 못했어요. 다시 시도해 주세요', { err: true }));
  }

  function reset() {
    state.values[state.calc] = Calc.defaults(state.calc); saveValues(); renderForm(); compute();
    const first = document.querySelector('#form input'); if (first) first.focus();
  }

  // ───────── AI: 자연어 입력 ─────────
  async function aiFill() {
    const input = $('#aiInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!(await ensureAI())) return;
    const bar = $('#aiBar'); bar.classList.add('loading'); $('#aiGo').disabled = true;
    const note = $('#aiNote'); note.hidden = false; note.className = 'ai-note'; note.textContent = 'AI가 입력을 해석하는 중…';
    const r = await api.parse(text, state.calc);
    bar.classList.remove('loading'); $('#aiGo').disabled = false;
    if (!r.ok) { note.className = 'ai-note err'; note.textContent = r.error; if (r.reason) showNoAI(); return; }
    if (r.calculator !== state.calc) { state.calc = r.calculator; store.set('calc', r.calculator); renderSidebar(); }
    const v = valuesOf(r.calculator);
    Object.assign(v, r.inputs); saveValues();
    renderForm(Object.keys(r.inputs)); compute();
    note.textContent = `✓ ${CALCS[r.calculator].name} 계산기에 ${Object.keys(r.inputs).length}개 값을 채웠어요. ${r.note || ''}`;
    input.value = '';
  }

  // ───────── AI: 분석 / 대화 ─────────
  let activeId = null;
  function openPanel() { $('#aiPanel').classList.add('open'); $('.layout').classList.add('panel-open'); $('#aiPanel').setAttribute('aria-hidden', 'false'); }
  function closePanel() { $('#aiPanel').classList.remove('open'); $('.layout').classList.remove('panel-open'); $('#aiPanel').setAttribute('aria-hidden', 'true'); }

  async function analyze() {
    if (!(await ensureAI())) return;
    state.thread = [];
    $('#aiThread').innerHTML = '';
    const summary = Calc.summaryText(state.calc, valuesOf(state.calc));
    send(`다음 계산 결과를 분석하고 개선 방안을 알려주세요.\n\n${summary}`, true);
  }

  function send(text, isContext) {
    if (activeId) return;
    openPanel();
    state.thread.push({ role: 'user', content: text });
    const u = document.createElement('div'); u.className = 'msg user' + (isContext ? ' context' : ''); u.textContent = text;
    $('#aiThread').append(u);
    const a = document.createElement('div'); a.className = 'msg assistant typing'; a.dataset.raw = '';
    $('#aiThread').append(a);
    activeId = 'c' + Date.now();
    a.dataset.id = activeId;
    setBusy(true);
    // 대화 중 계산값이 바뀌었으면 최신 수치를 함께 보낸다
    const msgs = state.thread.map((m) => ({ role: m.role, content: m.content }));
    if (!isContext && state.thread.length > 1) {
      msgs[msgs.length - 1].content = `${text}\n\n(참고: 현재 계산기 화면 값)\n${Calc.summaryText(state.calc, valuesOf(state.calc))}`;
    }
    api.chat(activeId, msgs);
    scrollThread();
  }

  function setBusy(b) { $('#aiSend').disabled = b; $('#aiStop').hidden = !b; $('#btnAnalyze').disabled = b; }
  function scrollThread() { const t = $('#aiThread'); t.scrollTop = t.scrollHeight; }

  api.onDelta(({ id, delta }) => {
    const el = document.querySelector(`.msg.assistant[data-id="${id}"]`); if (!el) return;
    el.dataset.raw += delta; el.innerHTML = md(el.dataset.raw); scrollThread();
  });
  api.onDone(({ id, error, reason }) => {
    if (reason) showNoAI();
    const el = document.querySelector(`.msg.assistant[data-id="${id}"]`);
    if (el) {
      el.classList.remove('typing');
      if (error) el.innerHTML += `<p class="err">⚠ ${escapeHtml(error)}</p>`;
      if (el.dataset.raw) state.thread.push({ role: 'assistant', content: el.dataset.raw });
      else state.thread.pop();
    }
    activeId = null; setBusy(false);
  });

  $('#aiCompose').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#aiAsk').value.trim(); if (!t) return;
    $('#aiAsk').value = ''; send(t, false);
  };
  $('#aiAsk').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#aiCompose').requestSubmit(); } };
  $('#aiStop').onclick = () => { if (activeId) api.abort(activeId); };
  $('#aiClose').onclick = closePanel;
  $('#aiClear').onclick = () => { if (activeId) api.abort(activeId); state.thread = []; $('#aiThread').innerHTML = '<div class="empty">계산 후 ✨ AI 분석을 누르거나, 아래에 질문을 입력하세요.</div>'; };

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function md(src) {
    const lines = escapeHtml(src).split('\n');
    let html = '', list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of lines) {
      let m;
      if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
      else if (line.trim() === '' || /^-{3,}$/.test(line.trim())) { close(); }
      else { close(); html += `<p>${inline(line)}</p>`; }
    }
    close();
    return html;
  }

  // ───────── history ─────────
  function updateHistoryCount() { $('#historyCount').textContent = state.history.length; }
  function renderHistory() {
    const box = $('#historyList'); box.innerHTML = '';
    if (!state.history.length) { box.innerHTML = '<div class="empty">아직 기록이 없어요. 계산 후 "📒 장부에 기록"을 눌러 보세요.</div>'; return; }
    state.history.forEach((rec) => {
      const calc = CALCS[rec.calc]; if (!calc) return;
      const res = Calc.run(rec.calc, rec.values);
      const main = res.filter((o) => o.primary).map((o) => `${o.label} ${o.text}`).join(' · ');
      const b = document.createElement('button'); b.className = 'history-item';
      const d = new Date(rec.date);
      b.innerHTML = `<span class="when">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span>` +
        `<span class="what">${escapeHtml(rec.values.name || rec.memo || calc.name)}</span><span class="tag">${calc.icon} ${calc.name}</span><span class="muted">${main}</span>`;
      b.onclick = () => {
        state.values[rec.calc] = { ...rec.values }; saveValues();
        state.calc = rec.calc; store.set('calc', rec.calc);
        $('#historyModal').hidden = true; renderSidebar(); renderForm(); compute();
      };
      box.append(b);
    });
  }
  $('#btnHistory').onclick = () => { renderHistory(); $('#historyModal').hidden = false; };
  $('#btnClearHistory').onclick = () => { state.history = []; store.set('history', []); updateHistoryCount(); renderHistory(); toast('앱 내 기록 내역을 비웠어요 (엑셀 장부 파일은 그대로예요)'); };
  async function exportAll() {
    const recs = state.history.length ? [...state.history].reverse() : [currentRecord()];
    const r = await api.exportLedger(recs);
    if (r.ok) toast('엑셀로 내보냈어요'); else if (!r.canceled) toast(r.error, { err: true });
  }
  $('#btnExport').onclick = exportAll;

  // ───────── AI 연결 상태 ─────────
  let lastSettings = null;
  async function refreshAIStatus() {
    lastSettings = await api.getSettings();
    const a = lastSettings.active, el = $('#aiStatus');
    el.classList.toggle('on', a.available); el.classList.toggle('off', !a.available);
    el.innerHTML = '<span class="dot"></span>' + (a.available
      ? `AI: ${escapeHtml(a.label)}${a.free ? ' · 무료' : ''}`
      : 'AI 연결 안 됨');
    el.title = a.available ? `${a.label} / 모델 ${a.model}${a.auto ? ' (자동 연결)' : ''} — 눌러서 설정` : 'AI 연결 방법 보기';
    return lastSettings;
  }
  async function ensureAI() {
    const s = await refreshAIStatus();
    if (s.active.available) return true;
    showNoAI(); return false;
  }
  function showNoAI() { $('#noAiModal').hidden = false; setTimeout(() => checkClipboardKey(), 0); }
  $('#aiStatus').onclick = async () => { const s = await refreshAIStatus(); if (s.active.available) openSettings(); else showNoAI(); };
  document.querySelectorAll('#noAiModal [data-url]').forEach((el) => { el.onclick = (e) => { e.preventDefault(); api.openExternal(el.dataset.url); }; });
  document.querySelectorAll('#noAiModal [data-setup]').forEach((el) => { el.onclick = () => { $('#noAiModal').hidden = true; openSettings(el.dataset.setup); }; });
  $('#btnRecheckAI').onclick = async () => {
    const s = await refreshAIStatus();
    if (s.active.available) { $('#noAiModal').hidden = true; toast(`✓ ${s.active.label}에 연결됐어요`); }
    else toast(s.ollama && !s.ollama.models.length ? 'Ollama는 실행 중이지만 모델이 없어요: ollama pull gemma3:4b' : '아직 연결된 AI가 없어요', { err: true });
  };
  // ── 복사한 API 키 자동 감지
  // 개인정보 보호: 사용자가 키 발급 링크를 누른 뒤 15분 동안, 또는 설정·AI 연결 창이 열려 있을 때만 확인
  let awaitingKeyUntil = 0, keyCheckBusy = false;
  const watchForKey = () => { awaitingKeyUntil = Date.now() + 15 * 60 * 1000; };
  const keyWatchActive = () => Date.now() < awaitingKeyUntil || !$('#settingsModal').hidden || !$('#noAiModal').hidden;
  async function checkClipboardKey() {
    if (keyCheckBusy || !$('#keyFoundModal').hidden) return;
    keyCheckBusy = true;
    try {
      const r = await api.detectKey();
      if (!r) return;
      $('#keyFoundText').innerHTML = `<b>${escapeHtml(r.label)}</b> 키 <code>${escapeHtml(r.masked)}</code> 를 복사하셨네요.<br>이 키로 AI를 연결할까요?${r.free ? ' <span class="muted">(무료 사용량 한도 내)</span>' : ''}`;
      $('#keyFoundErr').hidden = true;
      $('#btnKeyAccept').disabled = false; $('#btnKeyAccept').textContent = '이 키로 연결하기'; $('#btnKeyAccept').hidden = false;
      $('#btnKeyDecline').textContent = '아니요';
      $('#keyFoundModal').hidden = false;
    } finally { keyCheckBusy = false; }
  }
  $('#btnKeyAccept').onclick = async () => {
    const b = $('#btnKeyAccept'); b.disabled = true; b.textContent = '연결 확인 중…';
    const r = await api.acceptKey();
    if (!r.ok) {
      $('#keyFoundErr').textContent = r.error; $('#keyFoundErr').hidden = false;
      b.hidden = true; $('#btnKeyDecline').textContent = '닫기';
      return;
    }
    awaitingKeyUntil = 0;
    $('#keyFoundModal').hidden = true; $('#noAiModal').hidden = true;
    await refreshAIStatus();
    if (!$('#settingsModal').hidden) renderProviderFields();
    toast(`✓ ${r.label}에 연결됐어요${r.cleared ? ' · 보안을 위해 클립보드의 키는 지웠어요' : ''}`, { ms: 5000 });
  };
  $('#btnKeyDecline').onclick = () => { api.declineKey(); $('#keyFoundModal').hidden = true; };
  document.querySelectorAll('#noAiModal [data-url*="apikey"], #noAiModal [data-setup]').forEach((el) => el.addEventListener('click', watchForKey));

  // 창으로 돌아올 때: 복사한 키 확인 + (예: Ollama 설치 후) AI 상태 재확인
  window.addEventListener('focus', () => {
    if (keyWatchActive()) checkClipboardKey();
    refreshAIStatus().then((s) => { if (s.active.available && !$('#noAiModal').hidden) { $('#noAiModal').hidden = true; toast(`✓ ${s.active.label}에 자동 연결됐어요`); } });
  });

  // ───────── settings ─────────
  function renderProviderFields() {
    const s = lastSettings; const p = $('#aiProvider').value;
    const info = s.providers[p];
    const isAuto = p === 'auto';
    $('#rowKey').hidden = isAuto || p === 'local';
    $('#rowBase').hidden = p !== 'custom';
    $('#rowModel').hidden = isAuto;
    $('#btnDeleteKey').hidden = isAuto || p === 'local' || !s.keys[p];
    $('#btnSaveAI').textContent = isAuto ? '저장' : '연결 테스트 후 저장';
    if (!isAuto) {
      $('#keyState').textContent = s.keys[p] ? '— 저장됨 ✓ (바꿀 때만 입력)' : (p === 'custom' ? '— 선택' : '— 미설정');
      $('#keyLink').hidden = !info.keyUrl; $('#keyLink').dataset.url = info.keyUrl || '';
      $('#aiModel').value = s.ai.models[p] || '';
      $('#aiModel').placeholder = info.defaultModel || (p === 'local' ? '자동 (설치된 첫 모델)' : '예) llama-3.3-70b');
      $('#modelHint').textContent = p === 'local'
        ? (s.ollama ? `설치된 모델: ${s.ollama.models.join(', ') || '없음 — ollama pull gemma3:4b'}` : 'Ollama가 실행되고 있지 않습니다.')
        : `비워 두면 기본 모델(${info.defaultModel || '없음'})을 사용합니다.`;
      $('#aiBase').value = s.ai.baseURL || '';
    }
    const a = s.active;
    $('#aiActive').textContent = a.available ? `현재 연결: ${a.label} · ${a.model}${a.auto ? ' (자동)' : ''}` : '현재 연결된 AI 없음';
    $('#aiAutoInfo').innerHTML = isAuto
      ? '자동 모드: 저장된 키가 있으면 <b>Claude → OpenAI → Gemini</b> 순으로 사용하고, 키가 없으면 이 컴퓨터의 <b>무료 로컬 AI(Ollama)</b>에 자동 연결합니다.' +
        (s.ollama ? (s.ollama.models.length ? ` <br>✓ 로컬 AI 감지됨 (${escapeHtml(s.ollama.models[0])})` : ' <br>⚠ Ollama 실행 중 — 모델 없음: <code>ollama pull gemma3:4b</code>') : ' <br>로컬 AI 미설치 — <a href="#" data-url="https://ollama.com/download">Ollama 받기 ↗</a>')
      : (p === 'gemini' ? 'Google 계정으로 <a href="#" data-url="https://aistudio.google.com/apikey">무료 API 키</a>를 받을 수 있습니다 (무료 사용량 한도 내).' : '');
    $('#aiAutoInfo').querySelectorAll('[data-url]').forEach((el) => { el.onclick = (e) => { e.preventDefault(); if (/apikey/.test(el.dataset.url)) watchForKey(); api.openExternal(el.dataset.url); }; });
  }
  async function openSettings(provider) {
    const s = await refreshAIStatus();
    $('#aiProvider').value = provider || s.ai.provider || 'auto';
    $('#apiKey').value = '';
    renderProviderFields();
    $('#ledgerPath').textContent = s.ledgerPath + (s.ledgerExists ? '' : '  (첫 기록 시 생성)');
    $('#appVersion').textContent = s.version;
    $('#autoUpdate').checked = s.updateAuto;
    $('#settingsModal').hidden = false;
    if (!$('#rowKey').hidden) $('#apiKey').focus();
    checkClipboardKey();
  }
  $('#aiProvider').onchange = () => { $('#apiKey').value = ''; renderProviderFields(); };
  $('#keyLink').onclick = (e) => { e.preventDefault(); if (e.target.dataset.url) { watchForKey(); api.openExternal(e.target.dataset.url); } };
  $('#btnSaveAI').onclick = async () => {
    const provider = $('#aiProvider').value;
    const btn = $('#btnSaveAI'); btn.disabled = true; const label = btn.textContent; btn.textContent = '확인 중…';
    const opts = { provider };
    if (provider !== 'auto') { opts.model = $('#aiModel').value; opts.key = $('#apiKey').value.trim(); opts.baseURL = $('#aiBase').value; }
    if (provider !== 'auto' && provider !== 'local' && provider !== 'custom' && !opts.key && !lastSettings.keys[provider]) {
      btn.disabled = false; btn.textContent = label; toast('API 키를 입력해 주세요', { err: true }); return;
    }
    const r = await api.saveAI(opts);
    btn.disabled = false; btn.textContent = label;
    if (!r.ok) { toast(r.error, { err: true, ms: 7000 }); return; }
    await refreshAIStatus();
    $('#apiKey').value = ''; renderProviderFields();
    toast(lastSettings.active.available ? `✓ 저장했어요 — ${lastSettings.active.label} 사용 중` : '저장했어요 (아직 연결된 AI 없음)');
  };
  $('#btnDeleteKey').onclick = async () => {
    const provider = $('#aiProvider').value;
    await api.saveAI({ provider, deleteKey: true }); await refreshAIStatus(); renderProviderFields(); toast('API 키를 삭제했어요');
  };
  $('#btnChooseLedger').onclick = async () => { const p = await api.chooseLedger(); if (p) openSettings(); };
  $('#btnRevealLedger').onclick = () => api.revealLedger();

  // ───────── 자동 업데이트 ─────────
  const FILE_MGR = api.platform === 'win32' ? '탐색기' : 'Finder';
  let pendingUpdate = null;
  function showUpdate(r) {
    pendingUpdate = r;
    const m = $('#updateModal');
    delete m.dataset.busy;
    $('#updateTitle').textContent = '🎉 새 버전이 나왔어요';
    $('#updateText').innerHTML = '';
    $('#updateText').append(`현재 ${r.current} → 새 버전 `, Object.assign(document.createElement('b'), { textContent: r.version }),
      `${r.size ? ` (${Math.max(1, Math.round(r.size / 1048576))}MB)` : ''}. 지금 업데이트하면 내려받은 뒤 자동으로 다시 시작돼요. 입력값과 기록은 그대로 유지됩니다.`);
    $('#updateNotes').parentElement.hidden = false;
    $('#updateProgress').hidden = true; $('#updateErr').hidden = true;
    $('#updateFoot').hidden = false; $('#updateManualFoot').hidden = true;
    $('#btnUpdateNow').disabled = false; $('#btnUpdateNow').textContent = '지금 업데이트';
    $('#btnUpdateSkip').hidden = false; $('#btnUpdateLater').hidden = false;
    m.hidden = false;
  }
  async function checkUpdate(auto) {
    if (!auto) toast('업데이트 확인 중…', { ms: 1500 });
    const r = await api.checkUpdate({ auto });
    if (r.available) return showUpdate(r);
    if (auto) return;
    if (r.error) toast(r.error, { err: true, ms: 6000 });
    else if (r.disabled) toast('개발 모드에서는 업데이트를 확인하지 않아요');
    else toast(`✓ 최신 버전이에요 (${r.current})`);
  }
  api.onUpdateProgress((pct) => { $('#updateBar').style.width = pct + '%'; $('#updatePct').textContent = pct + '%'; });
  $('#btnUpdateNow').onclick = async () => {
    const m = $('#updateModal');
    m.dataset.busy = '1';
    $('#updateErr').hidden = true;
    $('#updateProgress').hidden = false; $('#updateBar').style.width = '0%'; $('#updatePct').textContent = '0%';
    $('#btnUpdateNow').disabled = true; $('#btnUpdateNow').textContent = '내려받는 중…';
    $('#btnUpdateSkip').hidden = true; $('#btnUpdateLater').hidden = true;
    const r = await api.installUpdate();
    if (r.ok && r.restarting) { $('#updateTitle').textContent = '✓ 설치 중'; $('#btnUpdateNow').textContent = '다시 시작하는 중…'; $('#updatePct').textContent = '100%'; return; }
    delete m.dataset.busy;
    if (r.ok && r.manual) {
      $('#updateTitle').textContent = '📦 새 버전을 준비했어요';
      $('#updateText').textContent = r.reason === 'NOT_IN_APPLICATIONS'
        ? `앱을 「응용 프로그램」 폴더가 아닌 곳에서 실행 중이라 자동으로 바꿀 수 없어요. 다운로드 폴더에 준비한 새 버전(${pendingUpdate.version})을 「응용 프로그램」 폴더로 옮겨 주세요. 옮긴 뒤부터는 자동으로 업데이트돼요.`
        : `앱 폴더에 쓸 권한이 없어 자동으로 바꿀 수 없어요. 다운로드 폴더에 준비한 새 버전(${pendingUpdate.version})을 기존 앱 자리에 덮어써 주세요.`;
      $('#updateNotes').parentElement.hidden = true; $('#updateProgress').hidden = true;
      $('#updateFoot').hidden = true; $('#updateManualFoot').hidden = false;
      return;
    }
    if (r.ok && r.dryRun) { $('#updateTitle').textContent = '✓ 설치 준비 완료 (테스트)'; return; }
    $('#updateErr').textContent = r.error || '업데이트에 실패했어요.'; $('#updateErr').hidden = false;
    $('#updateProgress').hidden = true;
    $('#btnUpdateNow').disabled = false; $('#btnUpdateNow').textContent = '다시 시도';
    $('#btnUpdateLater').hidden = false;
  };
  $('#btnUpdateLater').onclick = () => { $('#updateModal').hidden = true; };
  $('#btnUpdateSkip').onclick = async () => { await api.skipUpdate(pendingUpdate.version); $('#updateModal').hidden = true; toast(`${pendingUpdate.version} 버전 알림을 껐어요. 설정에서 언제든 직접 업데이트할 수 있어요.`); };
  $('#updateNotes').onclick = (e) => { e.preventDefault(); if (pendingUpdate) api.openExternal(pendingUpdate.notesUrl); };
  $('#btnUpdateReveal').textContent = `${FILE_MGR}에서 보기`;
  $('#btnUpdateReveal').onclick = () => { api.revealUpdate(); $('#updateModal').hidden = true; };
  $('#btnCheckUpdate').onclick = () => { $('#settingsModal').hidden = true; checkUpdate(false); };
  $('#autoUpdate').onchange = (e) => api.setAutoUpdate(e.target.checked);

  const closeModal = (m) => { if (m.dataset.busy) return; if (m.id === 'keyFoundModal') api.declineKey(); m.hidden = true; };
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closeModal(b.closest('.modal')); });
  document.querySelectorAll('.modal').forEach((m) => { m.onclick = (e) => { if (e.target === m) closeModal(m); }; });

  // ───────── wiring ─────────
  $('#aiGo').onclick = aiFill;
  $('#aiInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); aiFill(); } };
  $('#btnRecord').onclick = record;
  $('#btnAnalyze').onclick = analyze;
  $('#btnCopy').onclick = copyResult;
  $('#btnReset').onclick = reset;
  $('#btnOpenLedger').onclick = openLedger;
  $('#btnSettings').onclick = () => openSettings();

  api.onMenu((cmd) => {
    if (cmd.startsWith('calc:')) return selectCalc(cmd.slice(5));
    ({ settings: () => openSettings(), checkUpdate: () => checkUpdate(false), record, openLedger, export: exportAll, ai: () => $('#aiInput').focus(), analyze, reset }[cmd] || (() => {}))();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
  });

  renderSidebar(); renderForm(); compute(); updateHistoryCount();
  $('#aiClear').click();
  document.querySelectorAll('.hint-kbd').forEach((k) => { k.textContent = MOD + 'K'; });
  if (api.platform === 'win32') $('#btnRevealLedger').textContent = '탐색기에서 보기';
  refreshAIStatus();
  // 실행 4초 뒤, 그리고 켜 둔 동안 6시간마다 새 버전 확인
  setTimeout(() => checkUpdate(true), 4000);
  setInterval(() => { if ($('#updateModal').hidden) checkUpdate(true); }, 6 * 3600 * 1000);
})();
