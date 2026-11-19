const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const Calc = require('./src/calc');
const Excel = require('./src/excel');
const AI = require('./src/ai');
const Updater = require('./src/updater');

const IS_MAC = process.platform === 'darwin';
// 테스트/개발용: 사용자 데이터와 분리된 프로필
if (process.env.ECOM_USERDATA) app.setPath('userData', process.env.ECOM_USERDATA);

let win;
const updater = Updater.create({ app });
let manualUpdatePath = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const keysFile = () => path.join(app.getPath('userData'), 'keys.json');
const legacyKeyFile = () => path.join(app.getPath('userData'), 'apikey.bin');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function defaultLedger() { return path.join(app.getPath('documents'), '이커머스계산기_장부.xlsx'); }
function ledgerPath() { return readSettings().ledgerPath || defaultLedger(); }

// ───────── API 키: 공급자별로 OS 보안 저장소(macOS 키체인 / Windows DPAPI)로 암호화 ─────────
function readKeys() {
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(keysFile(), 'utf8')); } catch { /* none */ }
  // 1.0 버전의 Anthropic 키 이전
  if (!keys.anthropic && fs.existsSync(legacyKeyFile())) {
    try { keys.anthropic = fs.readFileSync(legacyKeyFile()).toString('base64'); fs.writeFileSync(keysFile(), JSON.stringify(keys)); fs.unlinkSync(legacyKeyFile()); } catch { /* ignore */ }
  }
  return keys;
}
function getKey(provider) {
  const enc = readKeys()[provider];
  if (enc) { try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { /* ignore */ } }
  const envName = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[provider];
  return (envName && process.env[envName]) || '';
}
function setKey(provider, key) {
  const keys = readKeys();
  if (key) keys[provider] = safeStorage.encryptString(key.trim()).toString('base64');
  else delete keys[provider];
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(keys));
}

function aiSettings() {
  const s = readSettings().ai || {};
  return { provider: s.provider || 'auto', models: s.models || {}, baseURL: s.baseURL || '' };
}
function cfgFor(provider, s = aiSettings()) {
  return {
    provider,
    key: getKey(provider),
    model: s.models[provider] || AI.PROVIDERS[provider].defaultModel,
    baseURL: s.baseURL,
  };
}

// 사용할 AI 결정. auto: 저장된 키(Claude→OpenAI→Gemini) → 직접 입력 서버 → 로컬 Ollama 자동 연결
async function resolveAI() {
  const s = aiSettings();
  const order = s.provider === 'auto' ? ['anthropic', 'openai', 'gemini', 'custom', 'local'] : [s.provider];
  let ollama;
  for (const p of order) {
    const cfg = cfgFor(p, s);
    if (p === 'custom') { if (cfg.baseURL && cfg.model) return { ok: true, cfg }; continue; }
    if (p === 'local') {
      ollama = await AI.detectOllama();
      if (ollama && ollama.models.length) {
        if (!s.models.local || !ollama.models.includes(s.models.local)) cfg.model = ollama.models[0];
        return { ok: true, cfg, auto: s.provider === 'auto' };
      }
      continue;
    }
    if (cfg.key) return { ok: true, cfg };
  }
  let reason = 'NO_AI';
  if (ollama && !ollama.models.length) reason = 'OLLAMA_NO_MODEL';
  else if (s.provider !== 'auto' && s.provider !== 'local' && s.provider !== 'custom') reason = 'NO_KEY';
  return { ok: false, reason, provider: s.provider };
}

function describe(r) {
  if (!r.ok) return { available: false, reason: r.reason, provider: r.provider };
  const p = AI.PROVIDERS[r.cfg.provider];
  return { available: true, provider: r.cfg.provider, label: p.label, model: r.cfg.model, free: p.free, auto: !!r.auto };
}

function noAiMessage(r) {
  if (r.reason === 'OLLAMA_NO_MODEL') return '로컬 AI(Ollama)는 실행 중이지만 설치된 모델이 없습니다. 터미널에서 "ollama pull gemma3:4b"를 실행해 주세요.';
  if (r.reason === 'NO_KEY') return `설정에서 ${AI.PROVIDERS[r.provider].label} API 키를 입력해 주세요.`;
  return 'AI가 연결되지 않았습니다. 설정에서 API 키를 넣거나 무료 로컬 AI를 설치해 주세요.';
}

// 복사한 키 형식: Gemini(AIza…), Claude(sk-ant-…), OpenAI(sk-…)
const KEY_PATTERNS = [
  ['gemini', /^AIza[0-9A-Za-z_-]{35}$/],
  ['anthropic', /^sk-ant-[A-Za-z0-9_-]{20,}$/],
  ['openai', /^sk-(?!ant-)[A-Za-z0-9_-]{20,}$/],
];
let pendingKey = null;
const declinedKeys = new Set();
const fingerprint = (k) => require('crypto').createHash('sha256').update(k).digest('hex');

// ───────── AI: 자연어 → 계산기 입력 ─────────
function calcCatalog() {
  return Object.entries(Calc.CALCS).map(([id, c]) => {
    const fields = c.fields.map((f) => {
      const t = f.type === 'percent' ? '퍼센트 숫자(5.5% → "5.5")' : f.type === 'money' ? '원 단위 숫자' : f.type === 'select' ? `다음 중 하나: ${f.options.join(' / ')}` : f.type === 'text' ? '텍스트' : '숫자';
      return `    - ${f.key}: ${f.label} — ${t}${f.hint ? ` (${f.hint})` : ''}`;
    }).join('\n');
    return `- ${id} (${c.name} 계산기: ${c.desc})\n${fields}`;
  }).join('\n');
}

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    calculator: { type: 'string', enum: Object.keys(Calc.CALCS) },
    inputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, value: { type: 'string' } },
        required: ['field', 'value'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['calculator', 'inputs', 'note'],
  additionalProperties: false,
};

const PARSE_SYSTEM = () => `당신은 한국 이커머스 셀러용 계산기 앱의 입력 도우미입니다. 사용자의 자연어 문장을 읽고 가장 알맞은 계산기 하나를 고른 뒤, 문장에 언급된 값만 해당 계산기의 필드에 채웁니다.

계산기 목록과 필드:
${calcCatalog()}

출력 형식: {"calculator": 계산기 id, "inputs": [{"field": 필드 key, "value": 값 문자열}], "note": 안내 문장}

규칙:
- "8천원" → "8000", "2.99만" → "29900", "5.5%" → "5.5" 처럼 숫자 문자열로 변환합니다.
- 언급되지 않은 필드는 inputs에 넣지 않습니다. 값을 지어내지 않습니다.
- 사용자가 플랫폼명(예: 스마트스토어, 쿠팡)만 말하고 수수료율을 말하지 않았다면 수수료를 추측해 채우지 말고 note에 "수수료율을 입력해 주세요"라고 안내합니다.
- 사용자가 지금 보고 있는 계산기와 관련된 후속 입력이면 같은 계산기를 유지합니다.
- note에는 무엇을 채웠는지, 빠진 중요한 값이 무엇인지 한국어 한두 문장으로 적습니다.`;

function sanitizeParsed(parsed) {
  const calcId = Calc.CALCS[parsed && parsed.calculator] ? parsed.calculator : null;
  if (!calcId) throw new AI.AIError('어떤 계산기인지 판단하지 못했습니다. 조금 더 구체적으로 적어 주세요.', 'BAD_JSON');
  const calc = Calc.CALCS[calcId];
  const valid = {};
  for (const item of Array.isArray(parsed.inputs) ? parsed.inputs : []) {
    if (!item) continue;
    const f = calc.fields.find((x) => x.key === item.field);
    if (!f) continue;
    const value = String(item.value === undefined || item.value === null ? '' : item.value);
    if (f.type === 'select') { if (f.options.includes(value)) valid[f.key] = value; }
    else if (f.type === 'text') valid[f.key] = value;
    else { const num = Number(value.replace(/[^0-9.\-]/g, '')); if (value.trim() !== '' && isFinite(num)) valid[f.key] = String(num); }
  }
  return { calculator: calcId, inputs: valid, note: typeof parsed.note === 'string' ? parsed.note : '' };
}

async function aiParse(_e, { text, current }) {
  const r = await resolveAI();
  if (!r.ok) return { ok: false, error: noAiMessage(r), reason: r.reason };
  try {
    const parsed = await AI.IMPL[r.cfg.provider].json(r.cfg, {
      system: PARSE_SYSTEM(), schema: PARSE_SCHEMA,
      user: `현재 보고 있는 계산기: ${current || '없음'}\n\n입력: ${text}`,
    });
    return { ok: true, ...sanitizeParsed(parsed), via: describe(r) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ───────── AI: 결과 해석 / 상담 (스트리밍) ─────────
const ADVISOR_SYSTEM = `당신은 한국 이커머스(스마트스토어, 쿠팡, 자사몰, 오픈마켓 등) 운영 15년 차 수익성 컨설턴트입니다. 셀러가 계산기로 얻은 숫자를 보고 실무적으로 조언합니다.

원칙:
- 계산 결과 숫자는 앱이 정확히 계산한 값입니다. 다시 계산하거나 수치를 바꾸지 말고 그대로 인용합니다. 새 수치를 제시할 때는 어떻게 나왔는지 간단한 근거를 붙입니다.
- 결론을 먼저: 첫 줄에 이 상품/수치의 상태를 한 문장으로 진단합니다.
- 그다음 개선 액션 3개 이내를 우선순위대로 제시합니다(가격, 원가, 수수료/채널, 쿠폰·프로모션, 광고 ROAS, 배송비 등 해당되는 것만). 각 액션에 기대 효과를 구체적으로 적습니다.
- 마지막에 놓치기 쉬운 리스크나 확인할 점 1~2개.
- 마크다운 소제목·굵게·목록을 사용하되 전체 400자~700자 내외로 간결하게. 한국어 존댓말.
- 플랫폼 수수료율 등 외부 정보는 변동될 수 있으니 확정적으로 단정하지 말고 "확인 필요"를 붙입니다.`;

const streams = new Map();
async function aiChat(e, { id, messages }) {
  const sender = e.sender;
  const send = (ch, d) => { if (!sender.isDestroyed()) sender.send(ch, d); };
  const r = await resolveAI();
  if (!r.ok) { send('ai:done', { id, error: noAiMessage(r), reason: r.reason }); return; }
  const ctl = new AbortController();
  streams.set(id, ctl);
  try {
    await AI.IMPL[r.cfg.provider].stream(r.cfg, {
      system: ADVISOR_SYSTEM, messages, signal: ctl.signal,
      onText: (delta) => send('ai:delta', { id, delta }),
    });
    send('ai:done', { id, via: describe(r) });
  } catch (err) {
    send('ai:done', { id, error: ctl.signal.aborted ? null : (err.message || String(err)) });
  } finally {
    streams.delete(id);
  }
}

// ───────── 자동 업데이트 (GitHub Releases) ─────────
function updateSettings() { const u = readSettings().update || {}; return { auto: u.auto !== false, skip: u.skip || null }; }
function saveUpdateSettings(patch) { const all = readSettings(); writeSettings({ ...all, update: { ...updateSettings(), ...patch } }); }
function registerUpdateIpc() {
  // auto: 앱 실행 시 자동 확인(설정에서 끄거나 「이 버전 건너뛰기」한 버전이면 알리지 않음) / 수동: 항상 결과 표시
  ipcMain.handle('update:check', async (_e, { auto } = {}) => {
    const u = updateSettings();
    if (auto && !u.auto) return { available: false, off: true };
    try {
      const r = await updater.check();
      if (auto && r.available && u.skip === r.version) return { ...r, available: false, skipped: true };
      return r;
    } catch (err) {
      return { available: false, error: `업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (${err.message})` };
    }
  });
  ipcMain.handle('update:install', async (e) => {
    const sender = e.sender;
    try {
      const r = await updater.downloadAndInstall((pct) => { if (!sender.isDestroyed()) sender.send('update:progress', pct); });
      if (r.manual) manualUpdatePath = r.path;
      if (r.restarting) setTimeout(() => app.quit(), 400);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle('update:skip', (_e, version) => { saveUpdateSettings({ skip: String(version) }); });
  ipcMain.handle('update:setAuto', (_e, on) => { saveUpdateSettings({ auto: !!on }); });
  ipcMain.handle('update:reveal', () => { if (manualUpdatePath) shell.showItemInFolder(manualUpdatePath); });
}

// ───────── IPC ─────────
async function settingsPayload() {
  const s = aiSettings();
  const keys = {};
  for (const p of Object.keys(AI.PROVIDERS)) keys[p] = !!getKey(p);
  const ollama = await AI.detectOllama();
  return {
    platform: process.platform,
    ai: s,
    keys,
    providers: AI.PROVIDERS,
    ollama,
    active: describe(await resolveAI()),
    ledgerPath: ledgerPath(),
    ledgerExists: fs.existsSync(ledgerPath()),
    version: app.getVersion(),
    updateAuto: updateSettings().auto,
  };
}

function registerIpc() {
  registerUpdateIpc();
  ipcMain.handle('ai:parse', aiParse);
  ipcMain.on('ai:chat', aiChat);
  ipcMain.on('ai:abort', (_e, id) => { const c = streams.get(id); if (c) c.abort(); });

  ipcMain.handle('settings:get', settingsPayload);
  // { provider, key?, model?, baseURL? } — 키가 있으면 저장 전에 연결 테스트
  ipcMain.handle('settings:saveAI', async (_e, { provider, key, model, baseURL, deleteKey }) => {
    const all = readSettings();
    const cur = aiSettings();
    const next = { provider: provider || cur.provider, models: { ...cur.models }, baseURL: baseURL !== undefined ? baseURL.trim() : cur.baseURL };
    const target = next.provider === 'auto' ? null : next.provider;
    if (target && model !== undefined) { if (model.trim()) next.models[target] = model.trim(); else delete next.models[target]; }
    if (target && deleteKey) setKey(target, '');
    if (target && (key || target === 'custom' || target === 'local')) {
      const cfg = { provider: target, key: key ? key.trim() : getKey(target), model: next.models[target] || AI.PROVIDERS[target].defaultModel, baseURL: next.baseURL };
      if (target === 'local') {
        const o = await AI.detectOllama();
        if (!o) return { ok: false, error: '로컬 AI(Ollama)가 실행되고 있지 않습니다. Ollama를 설치·실행한 뒤 다시 시도해 주세요.' };
        if (!o.models.length) return { ok: false, error: 'Ollama에 설치된 모델이 없습니다. 터미널에서 "ollama pull gemma3:4b"를 실행해 주세요.' };
      } else if (target === 'custom' && !cfg.baseURL) {
        return { ok: false, error: '서버 주소(Base URL)를 입력해 주세요. 예) https://api.example.com/v1' };
      } else {
        try { await AI.IMPL[target].test(cfg); } catch (err) { return { ok: false, error: err.message }; }
      }
      if (key) setKey(target, key);
    }
    writeSettings({ ...all, ai: next });
    return { ok: true, settings: await settingsPayload() };
  });
  ipcMain.handle('ledger:choose', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '엑셀 장부 파일 위치', defaultPath: ledgerPath(),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }], buttonLabel: '선택',
    });
    if (r.canceled || !r.filePath) return null;
    const p = r.filePath.endsWith('.xlsx') ? r.filePath : r.filePath + '.xlsx';
    writeSettings({ ...readSettings(), ledgerPath: p });
    return p;
  });
  ipcMain.handle('ledger:append', async (_e, records) => {
    const file = ledgerPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const res = await Excel.appendRecords(file, records);
      return { ok: true, file, results: res };
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM');
      return { ok: false, error: busy ? '장부 파일이 다른 프로그램(엑셀 등)에서 열려 있어 쓸 수 없습니다. 엑셀을 닫고 다시 시도해 주세요.' : `장부 기록 실패: ${err.message}` };
    }
  });
  ipcMain.handle('ledger:export', async (_e, records) => {
    const target = process.env.ECOM_EXPORT_PATH || (await dialog.showSaveDialog(win, {
      title: '엑셀로 내보내기',
      defaultPath: path.join(app.getPath('downloads'), `이커머스계산_${new Date().toISOString().slice(0, 10)}.xlsx`),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    })).filePath;
    if (!target) return { ok: false, canceled: true };
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      await Excel.appendRecords(target, records);
      return { ok: true, file: target };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('ledger:open', async () => {
    const file = ledgerPath();
    if (!fs.existsSync(file)) return { ok: false, error: '아직 장부 파일이 없습니다. 먼저 "장부에 기록"을 눌러 주세요.' };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('ledger:reveal', () => { shell.showItemInFolder(ledgerPath()); });
  // ── 복사한 API 키 감지 (렌더러가 요청할 때만 클립보드를 읽음, 키 원문은 렌더러로 보내지 않음)
  ipcMain.handle('keydetect:check', async () => {
    pendingKey = null;
    const text = String((await clipboard.readText()) || '').trim();
    if (!text || text.length > 300) return null;
    const hit = KEY_PATTERNS.find(([, re]) => re.test(text));
    if (!hit) return null;
    const provider = hit[0];
    if (declinedKeys.has(fingerprint(text)) || getKey(provider) === text) return null;
    pendingKey = { provider, key: text };
    return { provider, label: AI.PROVIDERS[provider].label, masked: `${text.slice(0, 4)}…${text.slice(-4)}`, free: AI.PROVIDERS[provider].free };
  });
  ipcMain.handle('keydetect:accept', async () => {
    if (!pendingKey) return { ok: false, error: '감지된 키가 없습니다. 키를 다시 복사해 주세요.' };
    const { provider, key } = pendingKey;
    pendingKey = null;
    const cfg = { ...cfgFor(provider), key };
    // 실패해도 이어서 「아니요」를 누르면 이 키를 다시 묻지 않도록 보류 상태 유지
    try { await AI.IMPL[provider].test(cfg); } catch (err) { pendingKey = { provider, key }; return { ok: false, error: err.message }; }
    setKey(provider, key);
    const cur = aiSettings();
    if (cur.provider !== 'auto' && cur.provider !== provider) writeSettings({ ...readSettings(), ai: { ...cur, provider } });
    let cleared = false;
    if (String((await clipboard.readText()) || '').trim() === key) { await clipboard.writeText(''); cleared = true; }
    return { ok: true, cleared, label: AI.PROVIDERS[provider].label };
  });
  ipcMain.handle('keydetect:decline', () => { if (pendingKey) declinedKeys.add(fingerprint(pendingKey.key)); pendingKey = null; });
  ipcMain.handle('clipboard:write', async (_e, text) => { await clipboard.writeText(String(text)); return true; });
  ipcMain.handle('open:external', (_e, url) => {
    if (!/^https:\/\//.test(url)) return;
    if (process.env.ECOM_E2E) { global.__lastExternal = url; return; } // 테스트 중엔 브라우저를 열지 않음
    shell.openExternal(url);
  });
}

function buildMenu() {
  const send = (ch, arg) => () => win && win.webContents.send(ch, arg);
  const ids = Object.keys(Calc.CALCS);
  const settingsItem = { label: '설정…', accelerator: 'CmdOrCtrl+,', click: send('menu', 'settings') };
  const updateItem = { label: '업데이트 확인…', click: send('menu', 'checkUpdate') };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ label: app.name, submenu: [
      { role: 'about', label: '이커머스 AI 계산기 정보' }, updateItem, { type: 'separator' }, settingsItem,
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: '파일', submenu: [
      { label: '장부에 기록', accelerator: 'CmdOrCtrl+S', click: send('menu', 'record') },
      { label: '장부 열기', accelerator: 'CmdOrCtrl+O', click: send('menu', 'openLedger') },
      { label: '기록 내역 엑셀로 내보내기…', accelerator: 'CmdOrCtrl+Shift+E', click: send('menu', 'export') },
      ...(IS_MAC ? [] : [{ type: 'separator' }, settingsItem]),
      { type: 'separator' }, IS_MAC ? { role: 'close' } : { role: 'quit', label: '종료' },
    ] },
    { role: 'editMenu', label: '편집' },
    { label: '계산기', submenu: [
      ...ids.map((id, i) => ({ label: `${Calc.CALCS[id].icon} ${Calc.CALCS[id].name}`, accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : (i === 9 ? 'CmdOrCtrl+0' : undefined), click: send('menu', 'calc:' + id) })),
      { type: 'separator' },
      { label: 'AI 입력창', accelerator: 'CmdOrCtrl+K', click: send('menu', 'ai') },
      { label: 'AI 분석', accelerator: 'CmdOrCtrl+Enter', click: send('menu', 'analyze') },
      { label: '초기화', accelerator: IS_MAC ? 'Cmd+Backspace' : 'Ctrl+Shift+Backspace', click: send('menu', 'reset') },
    ] },
    { role: 'viewMenu', label: '보기' },
    { role: 'windowMenu', label: '창' },
    ...(IS_MAC ? [] : [{ label: '도움말', submenu: [updateItem, { label: `버전 ${app.getVersion()}`, enabled: false }] }]),
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 980, minHeight: 640,
    title: '이커머스 AI 계산기',
    icon: path.join(__dirname, 'build', 'icon.png'),
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: false }),
    backgroundColor: '#f5f6f8',
    show: !process.env.ECOM_E2E_HIDDEN,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // 개발용: 외부 E2E 테스트 스크립트 연결 (배포 앱에는 포함되지 않음)
  if (process.env.ECOM_E2E) require(process.env.ECOM_E2E)({ app, win, clipboard });
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
