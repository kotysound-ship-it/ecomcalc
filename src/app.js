/* global Calc, Events, api */
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
  // v1.5: 목표 달성의 목표·실적은 원 → 100만원 단위 입력으로 바뀜. 예전에 저장한 값을 한 번 변환
  if (store.get('valuesVer', 1) < 2) {
    const conv = (vals) => {
      if (!vals) return;
      ['goal', 'actual'].forEach((k) => { if (vals[k] !== undefined && vals[k] !== '' && isFinite(Number(vals[k]))) vals[k] = String(Number(vals[k]) / Calc.MILLION); });
    };
    conv(state.values.target);
    state.history.forEach((r) => { if (r.calc === 'target') conv(r.values); });
    store.set('values', state.values); store.set('history', state.history); store.set('valuesVer', 2);
  }
  // AI 개인정보 보호: off(끄기) · name(상품명 가리기, 기본) · strict(상품명+금액 가리기)
  state.privacy = store.get('privacy', 'name');
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

  // ───────── 「?」 도움말 아이콘 + 말풍선 ─────────
  function helpIcon(text) {
    const h = document.createElement('span');
    h.className = 'help'; h.textContent = '?'; h.dataset.tip = text;
    h.tabIndex = 0; h.setAttribute('role', 'img'); h.setAttribute('aria-label', '도움말: ' + text);
    h.onclick = (e) => { e.preventDefault(); e.stopPropagation(); }; // 라벨/행 클릭으로 번지지 않게
    return h;
  }
  const tip = document.createElement('div'); tip.id = 'tip'; tip.hidden = true; document.body.append(tip);
  let tipFor = null;
  function showTip(el) {
    tipFor = el; tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2; x = Math.max(8, Math.min(x, innerWidth - w - 8));
    let y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tipFor = null; tip.hidden = true; }
  document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) { if (el !== tipFor) showTip(el); } else if (tipFor) hideTip(); });
  document.addEventListener('focusin', (e) => { if (e.target.dataset && e.target.dataset.tip) showTip(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target === tipFor) hideTip(); });
  document.addEventListener('scroll', hideTip, true);

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
      wrap.className = 'field' + (f.type === 'text' || f.type === 'channels' ? ' full' : '') + (f.advanced ? ' advanced' : '') + (aiFilled.includes(f.key) ? ' filled-by-ai' : '');
      const label = document.createElement('label');
      label.htmlFor = 'f_' + f.key;
      label.textContent = f.label;
      if (f.hint) label.append(helpIcon(f.hint));
      wrap.append(label);

      if (f.type === 'channels') {
        wrap.append(channelEditor(v));
      } else if (f.type === 'date') {
        const iw = document.createElement('div'); iw.className = 'input-wrap';
        const input = document.createElement('input');
        input.type = 'date'; input.id = 'f_' + f.key; input.dataset.key = f.key; input.value = v[f.key] || '';
        input.onchange = input.oninput = () => { v[f.key] = input.value; saveValues(); compute(); };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(input); } };
        iw.append(input); wrap.append(iw);
        if (f.key === 'asOfDate') {
          const t = document.createElement('button'); t.type = 'button'; t.className = 'link today-btn'; t.textContent = '오늘';
          t.onclick = (e) => { e.preventDefault(); v[f.key] = Calc.todayStr(); input.value = v[f.key]; saveValues(); compute(); };
          label.append(t);
        }
      } else if (f.type === 'select' && f.options.length <= 4) {
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
          const unit = f.unit || (f.type === 'money' ? '원' : f.type === 'bigmoney' ? '백만원' : f.type === 'percent' ? '%' : '');
          if (unit) { input.classList.add('has-unit'); if (unit.length > 1) input.classList.add('wide-unit'); const u = document.createElement('span'); u.className = 'unit'; u.textContent = unit; iw.append(u); }
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
              if (input.readOnly) return;
              const step = (f.type === 'money' ? (e.shiftKey ? 1000 : 100) : f.type === 'bigmoney' ? (e.shiftKey ? 10 : 1) : (e.shiftKey ? 1 : 0.5)) * (e.key === 'ArrowUp' ? 1 : -1);
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
        if (f.type === 'bigmoney') { const k = document.createElement('div'); k.className = 'kor'; k.id = 'k_' + f.key; wrap.append(k); }
      }
      form.append(wrap);
    });
    renderPresets();
  }

  // 숫자 입력칸 공통: 쉼표 표시, 커서 위치 유지
  function numericInput(input, get, set) {
    input.inputMode = 'decimal';
    input.value = withCommas(get() || '');
    input.oninput = () => {
      let raw = parseNum(input.value);
      const parts = raw.split('.'); if (parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
      set(raw);
      const fromEnd = input.value.length - input.selectionStart;
      input.value = withCommas(raw);
      const pos = Math.max(0, input.value.length - fromEnd); input.setSelectionRange(pos, pos);
    };
  }

  // ───────── 채널별 목표·실적 입력 (목표 달성) ─────────
  const CHANNEL_SUGGEST = ['스마트스토어', '쿠팡', '자사몰', '11번가', 'G마켓', '옥션', 'SSG닷컴', '롯데온', '카카오톡 선물하기', '오늘의집', '무신사', '29CM', '올리브영', '컬리', '홈쇼핑', '오프라인'];
  function channelEditor(v) {
    if (!Array.isArray(v.channels)) v.channels = [];
    const list = v.channels;
    const box = document.createElement('div'); box.className = 'channels';
    const dl = document.createElement('datalist'); dl.id = 'chSuggest';
    [...new Set([...state.presets.map((p) => p.name), ...CHANNEL_SUGGEST])].forEach((nm) => { const o = document.createElement('option'); o.value = nm; dl.append(o); });
    box.append(dl);
    if (list.length) {
      const head = document.createElement('div'); head.className = 'ch-row ch-head';
      head.innerHTML = '<span>채널</span><span>목표 (백만원)</span><span>실적 (백만원)</span><span></span>';
      box.append(head);
    }
    list.forEach((c, i) => {
      const row = document.createElement('div'); row.className = 'ch-row';
      const name = document.createElement('input'); name.className = 'ch-name'; name.placeholder = '예) 쿠팡'; name.value = c.name || '';
      name.setAttribute('list', 'chSuggest'); name.setAttribute('aria-label', `채널 ${i + 1} 이름`);
      name.oninput = () => { c.name = name.value; saveValues(); compute(); };
      row.append(name);
      ['goal', 'actual'].forEach((k) => {
        const inp = document.createElement('input'); inp.className = 'ch-num'; inp.placeholder = k === 'goal' ? '예) 100' : '예) 35';
        inp.setAttribute('aria-label', `채널 ${i + 1} ${k === 'goal' ? '목표' : '실적'} (백만원)`); inp.dataset.ch = `${i}.${k}`;
        numericInput(inp, () => c[k], (raw) => { c[k] = raw; saveValues(); compute(); });
        row.append(inp);
      });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'ghost small ch-del'; del.textContent = '✕'; del.title = '이 채널 삭제';
      del.onclick = () => { list.splice(i, 1); saveValues(); renderForm(); compute(); };
      row.append(del);
      box.append(row);
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'chip add'; add.id = 'btnAddChannel';
    add.textContent = list.length ? '+ 채널 추가' : '+ 채널별로 나눠 입력하기';
    add.onclick = () => {
      list.push({ name: '', goal: '', actual: '' });
      saveValues(); renderForm(); compute();
      const names = document.querySelectorAll('.ch-name'); if (names.length) names[names.length - 1].focus();
    };
    box.append(add);
    return box;
  }

  // 계산으로 정해지는 입력칸(채널 합계·기간으로 정한 일수)은 잠그고 값을 보여 준다
  function syncDerived() {
    if (state.calc !== 'target') return;
    const raw = valuesOf('target');
    const v = Calc.normalize('target', raw);
    const hasCh = Calc.channelRows(raw).length > 0;
    const res = Object.fromEntries(Calc.run('target', raw).map((o) => [o.key, o.value]));
    const s = Calc.dayNum(raw.startDate), e = Calc.dayNum(raw.endDate);
    const byDates = s !== null && e !== null && e >= s;
    const lock = (key, on, shown, why) => {
      const el = document.getElementById('f_' + key); if (!el) return;
      if (on) { el.readOnly = true; el.classList.add('derived'); el.value = withCommas(shown === null || shown === undefined ? '' : String(shown)); el.title = why; }
      else if (el.readOnly) { el.readOnly = false; el.classList.remove('derived'); el.value = withCommas(raw[key] || ''); el.title = ''; }
    };
    lock('goal', hasCh, v.goal, '채널별 목표의 합계예요. 아래 채널 표에서 고쳐 주세요');
    lock('actual', hasCh, v.actual, '채널별 실적의 합계예요. 아래 채널 표에서 고쳐 주세요');
    lock('daysPassed', byDates, res.elapsedDays, '기간과 실적 기준일로 자동 계산했어요');
    lock('daysTotal', byDates, res.periodDays, '기간으로 자동 계산했어요');
    ['goal', 'actual'].forEach((k) => {
      const el = document.getElementById('k_' + k); if (!el) return;
      const val = v[k];
      el.textContent = val === '' || val === undefined ? '' : `= ${Calc.korWon(Calc.num(val) * Calc.MILLION)}${hasCh ? ' · 채널 합계' : ''}`;
    });
    const rng = document.getElementById('f_endDate');
    if (rng) rng.classList.toggle('invalid', s !== null && e !== null && e < s);
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

  // 사용자가 ★로 고정한 결과 행 (계산기별, 없으면 기본값)
  const DEFAULT_PINS = { profit: ['bepPrice', 'bepRoas'] };
  state.pins = store.get('pins', {});
  const pinsOf = (id) => state.pins[id] || DEFAULT_PINS[id] || [];
  function togglePin(key) {
    const cur = pinsOf(state.calc);
    state.pins[state.calc] = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    store.set('pins', state.pins);
    compute();
  }

  function compute() {
    const v = valuesOf(state.calc);
    const res = Calc.run(state.calc, v);
    const pins = pinsOf(state.calc);
    const prim = $('#primaryResults'); prim.innerHTML = '';
    const pinBox = $('#pinnedResults'); pinBox.innerHTML = '';
    const list = $('#resultList'); list.innerHTML = '';
    res.forEach((o) => {
      if (o.primary) {
        const d = document.createElement('div'); d.className = 'big ' + toneClass(o);
        d.innerHTML = `<div class="lbl">${o.label}</div><div class="val">${o.text}</div>` + (o.sub ? `<div class="sub">${o.sub}</div>` : '');
        prim.append(d);
        return;
      }
      const pinned = pins.includes(o.key);
      const row = document.createElement('div');
      row.className = 'row' + (pinned ? ' pinned' : ''); row.dataset.key = o.key;
      const dt = document.createElement('dt');
      const name = document.createElement('span'); name.textContent = o.label; dt.append(name);
      if (o.hint) dt.append(helpIcon(o.hint));
      const dd = document.createElement('dd');
      const val = document.createElement('span'); val.className = 'v'; val.textContent = o.text;
      if (typeof o.value === 'number' && o.value < 0) val.classList.add('neg');

      const star = document.createElement('button');
      star.type = 'button'; star.className = 'star'; star.textContent = pinned ? '★' : '☆';
      star.setAttribute('aria-label', pinned ? `${o.label} 강조 해제` : `${o.label} 강조`);
      dd.append(val);
      if (o.sub) { const sb = document.createElement('span'); sb.className = 'v-sub'; sb.textContent = o.sub; dd.append(sb); }
      dd.append(star);
      row.append(dt, dd);
      row.onclick = () => togglePin(o.key);
      list.append(row);
      if (pinned) {
        const c = document.createElement('div'); c.className = 'pin-card ' + toneClass(o); c.dataset.key = o.key;
        c.innerHTML = `<div class="lbl"></div><div class="val"></div>`;
        c.querySelector('.lbl').textContent = '★ ' + o.label; c.querySelector('.val').textContent = o.text;
        if (typeof o.value === 'number' && o.value < 0) c.classList.add('neg');
        c.onclick = () => { const r = list.querySelector(`[data-key="${o.key}"]`); if (r) { r.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); } };
        pinBox.append(c);
      }
    });
    pinBox.hidden = !pinBox.children.length;
    renderBreakdown(res, v);
    syncDerived();
    renderChannelResults(v);
    renderCalendar();
  }

  // ───────── 판매 캘린더 (목표 달성) ─────────
  // 행사 날짜는 앱 데이터(events.js)에서만. 날짜를 누르면 그날의 판매 계획을 적는다
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  let calSel = null, calConfirming = null;
  const KIND_TAG = { holiday: '공휴일·연휴 · 확정', day: '기념일 · 확정', season: '판매 시즌', expected: '채널 행사 · 예상', channel: '채널 행사 · 내가 확정' };
  // 채널 행사: 내가 확정한 날짜와 보여 줄 채널 선택은 이 컴퓨터에 저장
  state.eventConfirm = store.get('eventConfirm', {});
  Events.setConfirmed(state.eventConfirm);
  const CH_KEYS = [['네이버(스마트스토어)', /네이버|스마트스토어|스스/], ['쿠팡', /쿠팡/], ['11번가', /11번가/], ['G마켓·옥션', /G마켓|지마켓|옥션/i], ['SSG닷컴', /SSG|쓱/i],
    ['롯데온', /롯데온/], ['카카오', /카카오/], ['올리브영', /올리브영|올영/], ['무신사', /무신사/], ['29CM', /29CM|이구/i], ['컬리', /컬리/]];
  function calChannels() {
    const saved = store.get('calChannels', null);
    if (Array.isArray(saved)) return saved.filter((c) => Events.CHANNELS.includes(c));
    // 처음에는 채널 프리셋·채널별 목표에 쓴 채널만 켜고, 하나도 없으면 전체를 켠다
    const names = state.presets.map((p) => p.name).concat(((state.values.target || {}).channels || []).map((c) => c && c.name || ''));
    const hit = CH_KEYS.filter(([, re]) => names.some((n) => re.test(n))).map(([c]) => c);
    return hit.length ? hit : Events.CHANNELS.slice();
  }
  function renderChannelFilter() {
    const box = $('#calChannels'); const on = calChannels();
    box.innerHTML = '<span class="muted">채널 행사 보기:</span>';
    Events.CHANNELS.forEach((c) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = c; b.className = on.includes(c) ? 'on' : '';
      b.setAttribute('aria-pressed', on.includes(c));
      b.onclick = () => { const cur = calChannels(); store.set('calChannels', cur.includes(c) ? cur.filter((x) => x !== c) : cur.concat(c)); renderCalendar(); };
      box.append(b);
    });
  }
  const evChip = (x) => `<span class="ev k-${x.kind}">${x.kind === 'expected' ? '<span class="exp">예상</span>' : ''}${escapeHtml(x.short || x.name)}</span>`;
  const md2 = (d) => { const t = Events.str(d); return `${+t.slice(5, 7)}/${+t.slice(8, 10)}(${WD[new Date(d * 86400000).getUTCDay()]})`; };
  function periodOf(v) {
    const s = Calc.dayNum(v.startDate), e = Calc.dayNum(v.endDate);
    return s !== null && e !== null && e >= s ? [s, e] : null;
  }
  function calDefaultMonth(v) {
    const p = periodOf(v);
    const a = Calc.dayNum(v.asOfDate);
    const t = a !== null ? a : Calc.dayNum(Calc.todayStr());
    return Events.str(p ? (t >= p[0] && t <= p[1] ? t : p[0]) : t).slice(0, 7);
  }
  function shiftMonth(ym, k) {
    let [y, m] = ym.split('-').map(Number); m += k;
    while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  function renderCalendar() {
    const box = $('#calendar');
    if (state.calc !== 'target') { box.hidden = true; return; }
    box.hidden = false;
    const v = valuesOf('target');
    if (!v.plans || typeof v.plans !== 'object' || Array.isArray(v.plans)) v.plans = {};
    const key = `${v.startDate}|${v.endDate}`;
    if (!state.calMonth || state.calKey !== key) { state.calMonth = calDefaultMonth(v); state.calKey = key; }
    const [y, m] = state.calMonth.split('-').map(Number);
    $('#calMonth').textContent = `${y}년 ${m}월`;
    const first = Events.parse(`${state.calMonth}-01`);
    const last = Events.parse(`${shiftMonth(state.calMonth, 1)}-01`) - 1;
    renderChannelFilter();
    const evs = Events.withChannels(first, last, calChannels());
    const p = periodOf(v);
    const today = Calc.dayNum(Calc.todayStr());
    const grid = $('#calGrid'); grid.innerHTML = '';
    WD.forEach((w, i) => { const h = document.createElement('div'); h.className = 'cal-wd' + (i === 0 ? ' red' : i === 6 ? ' sat' : ''); h.textContent = w; grid.append(h); });
    const lead = new Date(first * 86400000).getUTCDay();
    for (let i = 0; i < lead; i++) { const b = document.createElement('div'); b.className = 'cal-cell blank'; grid.append(b); }
    for (let d = first; d <= last; d++) {
      const ds = Events.str(d), dow = (lead + d - first) % 7;
      const on = evs.filter((x) => x.start <= d && x.end >= d);
      const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'cal-cell'; cell.dataset.date = ds;
      if (dow === 0 || on.some((x) => x.kind === 'holiday')) cell.classList.add('red'); else if (dow === 6) cell.classList.add('sat');
      if (on.some((x) => x.kind === 'holiday' && x.start !== x.end)) cell.classList.add('in-holiday');
      if (on.some((x) => x.kind === 'season')) cell.classList.add('in-season');
      if (on.some((x) => x.kind === 'expected' || x.kind === 'channel')) cell.classList.add('in-expected');
      if (p && (d < p[0] || d > p[1])) cell.classList.add('out');
      if (d === today) cell.classList.add('today');
      if (ds === calSel) cell.classList.add('sel');
      // 여러 날 걸친 구간은 시작일·매달 1일·매주 일요일에만 이름을 적는다
      const label = on.filter((x) => x.start === x.end || x.start === d || d === first || dow === 0);
      const shown = label.slice(0, 3), more = label.length - shown.length;
      cell.innerHTML = `<span class="num">${d - first + 1}</span>` + shown.map(evChip).join('') +
        (more > 0 ? `<span class="ev more">+${more}개</span>` : '') +
        (v.plans[ds] ? `<span class="ev k-plan">📝 ${escapeHtml(v.plans[ds])}</span>` : '');
      cell.title = on.map((x) => `${x.name} — ${KIND_TAG[x.kind]}${x.kind === 'expected' ? ' · ' + x.label : ''}${x.note ? '\n' + x.note : ''}`).join('\n');
      cell.onclick = () => { calSel = ds; renderCalendar(); $('#calPlanText').focus(); };
      grid.append(cell);
    }
    // 선택한 날짜의 계획 입력
    const planBox = $('#calPlan');
    const inMonth = calSel && calSel.slice(0, 7) === state.calMonth;
    planBox.hidden = !inMonth;
    if (inMonth) {
      const d = Events.parse(calSel);
      $('#calPlanLabel').textContent = `${md2(d)} 판매 계획`;
      $('#calPlanEvents').textContent = evs.filter((x) => x.start <= d && x.end >= d).map((x) => `${x.name}(${KIND_TAG[x.kind]})`).join(' · ');
      const ta = $('#calPlanText');
      if (document.activeElement !== ta) ta.value = v.plans[calSel] || '';
    }
    // 이번 달 주요 일정
    const list = evs.filter((x) => x.boost || x.kind === 'holiday');
    $('#calList').innerHTML = list.length ? '<div class="cal-list-title">이번 달 주요 일정</div>' + list.map((x) => {
      let h = `<div class="cal-item"><span class="when">${x.start === x.end ? md2(x.start) : `${md2(x.start)} ~ ${md2(x.end)}`}</span>` +
        evChip(x) + `<span class="tag">${KIND_TAG[x.kind]}${x.kind === 'expected' ? ` · ${escapeHtml(x.label)}<span class="conf c-${x.confidence}">신뢰도 ${x.confidence}</span>` : x.boost ? ' · 판매 증가' : ''}</span>` +
        (x.note ? `<small>${escapeHtml(x.note)}</small>` : '');
      if (x.kind === 'expected' || x.kind === 'channel') {
        h += '<div class="acts">' + (x.sources || []).map((u, i) => `<a href="#" data-url="${escapeHtml(u)}">출처${x.sources.length > 1 ? i + 1 : ''} ↗</a>`).join('') +
          (x.kind === 'expected' ? `<button type="button" class="small" data-confirm="${escapeHtml(x.key)}">실제 날짜로 확정</button>` : `<button type="button" class="small ghost" data-unconfirm="${escapeHtml(x.key)}">확정 취소</button>`) + '</div>';
        if (calConfirming === x.key) h += `<div class="confirm-form">채널 발표 날짜: <input type="date" id="cfStart" value="${Events.str(x.start)}"> ~ <input type="date" id="cfEnd" value="${Events.str(x.end)}"><button type="button" class="primary small" id="cfOk">확정</button><button type="button" class="small" id="cfCancel">취소</button></div>`;
      }
      return h + '</div>';
    }).join('') : '';
    const saveConfirm = () => { store.set('eventConfirm', state.eventConfirm); Events.setConfirmed(state.eventConfirm); renderCalendar(); };
    $('#calList').querySelectorAll('[data-url]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); api.openExternal(a.dataset.url); }; });
    $('#calList').querySelectorAll('[data-confirm]').forEach((b) => { b.onclick = () => { calConfirming = b.dataset.confirm; renderCalendar(); }; });
    $('#calList').querySelectorAll('[data-unconfirm]').forEach((b) => { b.onclick = () => { delete state.eventConfirm[b.dataset.unconfirm]; saveConfirm(); }; });
    if ($('#cfOk')) {
      $('#cfOk').onclick = () => {
        const a = $('#cfStart').value, b = $('#cfEnd').value;
        if (!a || !b || b < a) { toast('시작일과 종료일을 확인해 주세요', { err: true }); return; }
        state.eventConfirm[calConfirming] = { start: a, end: b }; calConfirming = null; saveConfirm();
        toast('확정했어요. 내년 예상 일정은 이 날짜를 기준으로 잡아요');
      };
      $('#cfCancel').onclick = () => { calConfirming = null; renderCalendar(); };
    }
    $('#calNote').textContent = Events.lunarCovered(y)
      ? '공휴일·명절 연휴는 우주항공청 월력요항 기준이에요. 판매 시즌은 확정된 날짜를 기준으로 잡은 참고 구간이에요. 채널 행사 「예상」은 지난 개최 기록으로 잡은 시기라 채널 공지로 꼭 확인하세요.'
      : `⚠ ${y}년 설·추석 날짜는 아직 앱에 없어요(월력요항 발표 후 업데이트로 추가). 양력 공휴일·기념일만 표시해요.`;
  }
  $('#calPrev').onclick = () => { state.calMonth = shiftMonth(state.calMonth, -1); renderCalendar(); };
  $('#calNext').onclick = () => { state.calMonth = shiftMonth(state.calMonth, 1); renderCalendar(); };
  $('#calPlanText').oninput = (e) => {
    const v = valuesOf('target'); const t = e.target.value;
    if (t.trim()) v.plans[calSel] = t; else delete v.plans[calSel];
    saveValues();
    const cell = document.querySelector(`.cal-cell[data-date="${calSel}"]`);
    if (cell) { let pl = cell.querySelector('.k-plan'); if (!t.trim()) { if (pl) pl.remove(); } else { if (!pl) { pl = document.createElement('span'); pl.className = 'ev k-plan'; cell.append(pl); } pl.textContent = '📝 ' + t; } }
  };
  $('#calPlanText').onblur = () => renderCalendar();

  function renderChannelResults(v) {
    const box = $('#channelResults');
    const rows = state.calc === 'target' ? Calc.channelRows(v) : [];
    if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
    const w = (x) => (x === null || x === undefined || !isFinite(x) ? '—' : Calc.korWon(x));
    const tone = (r) => (r === null ? '' : r >= 1 ? 'good' : r >= 0.7 ? 'warn' : 'bad');
    box.hidden = false;
    box.innerHTML = '<div class="ch-title">채널별 달성 현황</div><table><thead><tr><th>채널</th><th>목표</th><th>실적</th><th>달성률</th><th>마감 예상</th><th>일평균 필요</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td>${escapeHtml(r.name)}<small>${r.share === null ? '' : '목표의 ' + Calc.fmt(r.share, 'percent')}</small></td><td>${w(r.goal)}</td><td>${w(r.actual)}</td>` +
        `<td class="${tone(r.rate)}"><b>${Calc.fmt(r.rate, 'percent')}</b><i class="meter"><i style="width:${Math.max(0, Math.min(100, (r.rate || 0) * 100))}%"></i></i></td>` +
        `<td class="${tone(r.forecastRate)}">${Calc.fmt(r.forecastRate, 'percent')}</td><td>${w(r.dailyNeed)}</td></tr>`).join('') +
      '</tbody></table>';
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
      ['광고비', r.adCost || 0, 'var(--c7)'],
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
    const values = JSON.parse(JSON.stringify(valuesOf(state.calc)));
    // 실적 기준일을 비워 두면 오늘 날짜로 남긴다 (나중에 장부를 열어도 경과 일수가 바뀌지 않게)
    if (state.calc === 'target' && !values.asOfDate && values.startDate && values.endDate) values.asOfDate = Calc.todayStr();
    return { calc: state.calc, values, memo: $('#memo').value.trim(), date: Date.now() };
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
    const keep = state.values[state.calc] || {};
    Object.keys(keep).forEach((k) => delete keep[k]);
    Object.assign(keep, Calc.defaults(state.calc)); state.values[state.calc] = keep;
    saveValues(); renderForm(); compute();
    const first = document.querySelector('#form input'); if (first) first.focus();
  }

  // ───────── AI 개인정보 보호: 상품명 별칭 / 금액 숨기기 ─────────
  // 대화마다 실제 이름 ↔ 별칭(상품A, 상품B…) 표를 두고, 보낼 때 바꾸고 받은 답은 화면에서만 되돌린다
  state.aliases = [];
  const aliasFor = (real) => {
    let a = state.aliases.find((x) => x[0] === real);
    if (!a) { a = [real, '상품' + String.fromCharCode(65 + (state.aliases.length % 26))]; state.aliases.push(a); }
    return a[1];
  };
  const textValues = () => {
    const v = valuesOf(state.calc);
    return CALCS[state.calc].fields.filter((f) => f.type === 'text').map((f) => String(v[f.key] || '').trim()).filter((x) => x.length >= 2);
  };
  function privacyOpts() {
    if (state.privacy === 'off') return {};
    const nm = textValues()[0];
    return { alias: nm ? aliasFor(nm) : null, hideMoney: state.privacy === 'strict' };
  }
  function maskText(t) {
    if (state.privacy === 'off') return t;
    textValues().forEach(aliasFor);
    return [...state.aliases].sort((a, b) => b[0].length - a[0].length).reduce((s, [real, al]) => s.split(real).join(al), t);
  }
  function unmaskText(t) {
    return state.aliases.reduce((s, [real, al]) => s.split(al).join(real), t);
  }
  function aiSummary() { return Calc.summaryText(state.calc, valuesOf(state.calc), Object.assign(privacyOpts(), { channels: calChannels() })); }
  const PRIVACY_LABEL = { name: '🔒 상품명 가림', strict: '🔒 상품명·금액 가림', off: '' };
  function renderPrivacyBadge() {
    const b = $('#privacyBadge');
    b.textContent = PRIVACY_LABEL[state.privacy] || ''; b.hidden = !b.textContent;
  }

  // ───────── AI: 자연어 입력 ─────────
  async function aiFill() {
    const input = $('#aiInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!(await ensureAI())) return;
    const bar = $('#aiBar'); bar.classList.add('loading'); $('#aiGo').disabled = true;
    const note = $('#aiNote'); note.hidden = false; note.className = 'ai-note'; note.textContent = 'AI가 입력을 해석하는 중…';
    const r = await api.parse(maskText(text), state.calc);
    bar.classList.remove('loading'); $('#aiGo').disabled = false;
    if (!r.ok) { note.className = 'ai-note err'; note.textContent = r.error; if (r.reason) showNoAI(); return; }
    if (r.calculator !== state.calc) { state.calc = r.calculator; store.set('calc', r.calculator); renderSidebar(); }
    const v = valuesOf(r.calculator);
    for (const k of Object.keys(r.inputs)) { if (typeof r.inputs[k] === 'string') r.inputs[k] = unmaskText(r.inputs[k]); }
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
    send(`다음 계산 결과를 분석하고 개선 방안을 알려주세요.\n\n${aiSummary()}`, true);
  }

  // ───────── 첨부 자료: ＋ 버튼 / 끌어다 놓기 / 붙여넣기 ─────────
  // 이미지는 긴 변 1568px 이하로 줄여(AI가 읽는 최대 해상도) 보내고, 텍스트 파일은 본문에 합쳐 개인정보 가리기를 적용한다
  const ATT = { max: 5, imgEdge: 1568, imgBytes: 3.5 * 1024 * 1024, pdfBytes: 10 * 1024 * 1024, textBytes: 1024 * 1024, textChars: 30000 };
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const TEXT_EXT = /\.(txt|csv|tsv|md|json)$/i;
  state.pending = [];
  const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
  const readAs = (file, how) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r[how](file); });
  const b64 = (dataUrl) => String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);

  async function imageAttachment(file) {
    let url = await readAs(file, 'readAsDataURL');
    let mime = file.type;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, ATT.imgEdge / Math.max(bmp.width, bmp.height));
    if (scale < 1 || file.size > ATT.imgBytes) {
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      mime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
      url = c.toDataURL(mime, 0.88);
      if (b64(url).length * 0.75 > ATT.imgBytes) { mime = 'image/jpeg'; url = c.toDataURL(mime, 0.8); }
    }
    bmp.close && bmp.close();
    return { kind: 'image', mime, name: file.name || '스크린샷.png', data: b64(url), preview: url };
  }

  // 여러 번 연달아 넣어도 넣은 순서대로, 개수 제한을 지키며 처리
  let addQueue = Promise.resolve();
  function addFiles(files) { const list = [...files]; addQueue = addQueue.then(() => addFilesNow(list)); return addQueue; }
  async function addFilesNow(list) {
    if (!list.length) return;
    openPanel();
    for (const file of list) {
      if (state.pending.length >= ATT.max) { toast(`한 번에 ${ATT.max}개까지 첨부할 수 있어요`, { err: true }); break; }
      const name = file.name || '';
      try {
        if (IMG_TYPES.includes(file.type)) state.pending.push(await imageAttachment(file));
        else if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
          if (file.size > ATT.pdfBytes) { toast(`PDF는 ${kb(ATT.pdfBytes)}까지 첨부할 수 있어요 (${name})`, { err: true }); continue; }
          state.pending.push({ kind: 'pdf', mime: 'application/pdf', name, data: b64(await readAs(file, 'readAsDataURL')), size: file.size });
        } else if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(name)) {
          if (file.size > ATT.textBytes) { toast(`텍스트 파일은 ${kb(ATT.textBytes)}까지 첨부할 수 있어요 (${name})`, { err: true }); continue; }
          let text = await readAs(file, 'readAsText');
          const cut = text.length > ATT.textChars;
          if (cut) text = text.slice(0, ATT.textChars);
          state.pending.push({ kind: 'text', name, text, cut, size: file.size });
        } else {
          toast(`이미지·PDF·텍스트(CSV·TXT·MD·JSON) 파일만 첨부할 수 있어요${name ? ` (${name})` : ''}`, { err: true });
        }
      } catch (err) {
        toast(`파일을 읽지 못했어요${name ? ` (${name})` : ''}`, { err: true });
      }
    }
    renderPending();
    $('#aiAsk').focus();
  }

  function attChip(a, i) {
    const el = document.createElement('div'); el.className = 'att-chip ' + a.kind;
    const label = a.kind === 'image' ? '' : `<span class="att-ico">${a.kind === 'pdf' ? 'PDF' : 'TXT'}</span>`;
    el.innerHTML = (a.kind === 'image' ? `<img alt="" src="${a.preview}">` : label) +
      `<span class="att-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>` +
      (a.cut ? '<span class="att-cut" title="앞부분 3만 자만 보내요">일부</span>' : '') +
      (i !== undefined ? `<button type="button" class="att-x" data-i="${i}" title="첨부 빼기">✕</button>` : '');
    return el;
  }
  function renderPending() {
    const box = $('#aiAttachList'); box.innerHTML = '';
    box.hidden = !state.pending.length;
    state.pending.forEach((a, i) => box.append(attChip(a, i)));
    if (state.pending.some((a) => a.kind !== 'text') && state.privacy !== 'off') {
      const n = document.createElement('div'); n.className = 'att-note';
      n.textContent = '이미지·PDF 속 상품명·금액은 가려지지 않고 그대로 AI에 전달돼요';
      box.append(n);
    }
  }
  $('#aiAttachList').onclick = (e) => {
    const x = e.target.closest('.att-x'); if (!x) return;
    state.pending.splice(Number(x.dataset.i), 1); renderPending();
  };
  $('#aiAttach').onclick = () => $('#aiFile').click();
  $('#aiFile').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('#aiAsk').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  // 창 어디에 놓아도 첨부(파일을 놓으면 창이 그 파일로 바뀌는 기본 동작 차단)
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; openPanel(); $('#aiDrop').hidden = false; });
  document.addEventListener('dragover', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#aiDrop').hidden = true; });
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); dragDepth = 0; $('#aiDrop').hidden = true;
    addFiles(e.dataTransfer.files);
  });

  // 텍스트 파일은 질문 본문 뒤에 붙인다(가리기 적용 전 원문)
  function withTextFiles(text, atts) {
    const t = atts.filter((a) => a.kind === 'text');
    if (!t.length) return text;
    return text + t.map((a) => `\n\n[첨부 파일: ${a.name}${a.cut ? ' — 앞부분만' : ''}]\n\`\`\`\n${a.text}\n\`\`\``).join('');
  }

  function send(text, isContext) {
    if (activeId) return;
    openPanel();
    const atts = state.pending; state.pending = []; renderPending();
    if (!text && atts.length) text = '첨부한 자료를 확인하고, 현재 계산 결과와 연결해서 조언해 주세요.';
    // AI 회사로는 가린 내용을 보내고, 화면에는 사용자가 쓴 그대로(첫 요약은 실제로 보낸 내용) 보여 준다
    const out = maskText(withTextFiles(text, atts));
    const bin = atts.filter((a) => a.kind !== 'text').map(({ kind, mime, name, data }) => ({ kind, mime, name, data }));
    state.thread.push(Object.assign({ role: 'user', content: out }, bin.length ? { attachments: bin } : {}));
    const u = document.createElement('div'); u.className = 'msg user' + (isContext ? ' context' : ''); u.textContent = isContext ? maskText(text) : text;
    if (isContext) u.title = '실제로 AI에 보낸 내용이에요';
    if (atts.length) { const g = document.createElement('div'); g.className = 'msg-atts'; atts.forEach((a) => g.append(attChip(a))); $('#aiThread').append(g); }
    $('#aiThread').append(u);
    const a = document.createElement('div'); a.className = 'msg assistant typing'; a.dataset.raw = '';
    $('#aiThread').append(a);
    activeId = 'c' + Date.now();
    a.dataset.id = activeId;
    setBusy(true);
    // 대화 중 계산값이 바뀌었으면 최신 수치를 함께 보낸다
    const msgs = state.thread.map((m) => Object.assign({ role: m.role, content: m.content }, m.attachments ? { attachments: m.attachments } : {}));
    if (!isContext && state.thread.length > 1) {
      msgs[msgs.length - 1].content = `${out}\n\n(참고: 현재 계산기 화면 값)\n${aiSummary()}`;
    }
    api.chat(activeId, msgs);
    scrollThread();
  }

  function setBusy(b) { $('#aiSend').disabled = b; $('#aiStop').hidden = !b; $('#btnAnalyze').disabled = b; }
  function scrollThread() { const t = $('#aiThread'); t.scrollTop = t.scrollHeight; }

  api.onDelta(({ id, delta }) => {
    const el = document.querySelector(`.msg.assistant[data-id="${id}"]`); if (!el) return;
    el.dataset.raw += delta; el.innerHTML = md(unmaskText(el.dataset.raw)); scrollThread();
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
    const t = $('#aiAsk').value.trim(); if (!t && !state.pending.length) return;
    $('#aiAsk').value = ''; send(t, false);
  };
  $('#aiAsk').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#aiCompose').requestSubmit(); } };
  $('#aiStop').onclick = () => { if (activeId) api.abort(activeId); };
  $('#aiClose').onclick = closePanel;
  $('#aiClear').onclick = () => { if (activeId) api.abort(activeId); state.thread = []; state.aliases = []; state.pending = []; renderPending(); $('#aiThread').innerHTML = '<div class="empty">계산 후 ✨ AI 분석을 누르거나, 아래에 질문을 입력하세요.</div>'; };

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
        state.values[rec.calc] = JSON.parse(JSON.stringify(rec.values)); saveValues();
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
    $('#geminiWarn').hidden = !(p === 'gemini' || (isAuto && a.available && a.provider === 'gemini'));
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
    $('#privacyMode').value = state.privacy;
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
  $('#privacyMode').onchange = (e) => {
    state.privacy = e.target.value; store.set('privacy', state.privacy); renderPrivacyBadge();
    toast({ off: 'AI에 화면 값을 그대로 보내요', name: 'AI에 상품명을 별칭으로 바꿔 보내요', strict: 'AI에 상품명과 금액을 빼고 보내요' }[state.privacy]);
  };
  $('#privacyBadge').onclick = () => openSettings();
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

  renderSidebar(); renderForm(); compute(); updateHistoryCount(); renderPrivacyBadge();
  $('#aiClear').click();
  document.querySelectorAll('.hint-kbd').forEach((k) => { k.textContent = MOD + 'K'; });
  if (api.platform === 'win32') $('#btnRevealLedger').textContent = '탐색기에서 보기';
  refreshAIStatus();
  // 실행 4초 뒤, 그리고 켜 둔 동안 6시간마다 새 버전 확인
  setTimeout(() => checkUpdate(true), 4000);
  setInterval(() => { if ($('#updateModal').hidden) checkUpdate(true); }, 6 * 3600 * 1000);
})();
