// AI 공급자 추상화 (메인 프로세스 전용)
// - anthropic: 공식 SDK
// - openai / custom(OpenAI 호환) / local(Ollama): Chat Completions HTTP
// - gemini: Google Generative Language REST
// 공통 인터페이스: json({system, user, schema}) → object, stream({system, messages, onText, signal}) → void
const Anthropic = require('@anthropic-ai/sdk');

const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', needsKey: true, defaultModel: 'claude-opus-5-5', keyUrl: 'https://platform.claude.com/settings/keys', free: false },
  openai: { label: 'OpenAI (ChatGPT)', needsKey: true, defaultModel: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys', free: false },
  gemini: { label: 'Google Gemini', needsKey: true, defaultModel: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey', free: true },
  custom: { label: 'OpenAI 호환 (직접 입력)', needsKey: false, defaultModel: '', keyUrl: null, free: false },
  local: { label: '로컬 AI (Ollama, 무료)', needsKey: false, defaultModel: '', keyUrl: 'https://ollama.com/download', free: true },
};

const env = (k, d) => process.env[k] || d;
const ANTHROPIC_BASE = () => process.env.ECOM_ANTHROPIC_BASE_URL || undefined;
const OPENAI_BASE = () => env('ECOM_OPENAI_BASE_URL', 'https://api.openai.com/v1');
const GEMINI_BASE = () => env('ECOM_GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta');
const OLLAMA_BASE = () => env('ECOM_OLLAMA_URL', 'http://127.0.0.1:11434');

class AIError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fallthrough */ } }
  throw new AIError('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.', 'BAD_JSON');
}

async function httpError(res, label) {
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { /* ignore */ }
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(String(detail)))) return new AIError(`${label} API 키가 올바르지 않거나 권한이 없습니다.`, 'AUTH');
  if (res.status === 404) return new AIError(`${label}: 모델 또는 주소를 찾을 수 없습니다. 설정의 모델명을 확인해 주세요. ${detail}`.trim(), 'NOT_FOUND');
  if (res.status === 429) return new AIError(`${label}: 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.`, 'RATE');
  return new AIError(`${label} 오류 (${res.status}) ${typeof detail === 'string' ? detail : ''}`.trim(), 'HTTP');
}

async function readSSE(res, onData, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch {} return; }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { onData(JSON.parse(data)); } catch { /* partial / keepalive */ }
    }
  }
}

// ───────── Anthropic ─────────
function anthropicClient(cfg) { return new Anthropic({ apiKey: cfg.key, baseURL: ANTHROPIC_BASE() }); }
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function anthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AIError('Anthropic API 키가 올바르지 않습니다.', 'AUTH');
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('이 API 키로는 해당 모델을 사용할 수 없습니다.', 'AUTH');
  if (err instanceof Anthropic.NotFoundError) return new AIError('Anthropic: 모델을 찾을 수 없습니다. 설정의 모델명을 확인해 주세요.', 'NOT_FOUND');
  if (err instanceof Anthropic.RateLimitError) return new AIError('Anthropic: 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 'RATE');
  if (err instanceof Anthropic.APIConnectionError) return new AIError('인터넷 연결을 확인해 주세요.', 'NET');
  if (err instanceof Anthropic.APIError) return new AIError(`Anthropic 오류 (${err.status}): ${err.message}`, 'HTTP');
  return err;
}

const anthropic = {
  async json(cfg, { system, user, schema }) {
    try {
      const res = await anthropicClient(cfg).beta.messages.create({
        model: cfg.model, max_tokens: 4000,
        betas: [FALLBACK_BETA], fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        system, messages: [{ role: 'user', content: user }],
      });
      if (res.stop_reason === 'refusal') throw new AIError('AI가 이 요청을 처리하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.', 'REFUSAL');
      const t = res.content.find((b) => b.type === 'text');
      return extractJSON(t ? t.text : '');
    } catch (e) { throw anthropicError(e); }
  },
  async stream(cfg, { system, messages, onText, signal }) {
    try {
      const s = anthropicClient(cfg).beta.messages.stream({
        model: cfg.model, max_tokens: 16000,
        betas: [FALLBACK_BETA], fallbacks: 'default',
        output_config: { effort: 'medium' },
        system, messages,
      });
      if (signal) signal.addEventListener('abort', () => s.abort());
      s.on('text', onText);
      const final = await s.finalMessage();
      if (final.stop_reason === 'refusal') throw new AIError('AI가 이 요청에 답하지 않았습니다. 질문을 바꿔 다시 시도해 주세요.', 'REFUSAL');
    } catch (e) {
      if (e && e.name === 'APIUserAbortError') return;
      throw anthropicError(e);
    }
  },
  async test(cfg) {
    try { await anthropicClient(cfg).models.retrieve(cfg.model); } catch (e) { throw anthropicError(e); }
  },
};

// ───────── OpenAI Chat Completions (openai / custom / local) ─────────
function oaBase(cfg) {
  if (cfg.provider === 'openai') return OPENAI_BASE();
  if (cfg.provider === 'local') return OLLAMA_BASE() + '/v1';
  return String(cfg.baseURL || '').replace(/\/+$/, '');
}
function oaHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h.Authorization = `Bearer ${cfg.key}`;
  return h;
}
const oaLabel = (cfg) => PROVIDERS[cfg.provider].label;

const openaiCompat = {
  async json(cfg, { system, user, schema }) {
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: system + '\n\n반드시 JSON 객체 하나만 출력하세요.' }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'calculator_fill', strict: true, schema } },
    };
    let res = await fetch(`${oaBase(cfg)}/chat/completions`, { method: 'POST', headers: oaHeaders(cfg), body: JSON.stringify(body) });
    if (res.status === 400 && cfg.provider !== 'openai') { // json_schema 미지원 서버 → 일반 JSON 모드로 재시도
      delete body.response_format;
      res = await fetch(`${oaBase(cfg)}/chat/completions`, { method: 'POST', headers: oaHeaders(cfg), body: JSON.stringify(body) });
    }
    if (!res.ok) throw await httpError(res, oaLabel(cfg));
    const j = await res.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (msg && msg.refusal) throw new AIError('AI가 이 요청을 처리하지 않았습니다.', 'REFUSAL');
    return extractJSON((msg && msg.content) || '');
  },
  async stream(cfg, { system, messages, onText, signal }) {
    const res = await fetch(`${oaBase(cfg)}/chat/completions`, {
      method: 'POST', headers: oaHeaders(cfg), signal,
      body: JSON.stringify({ model: cfg.model, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
    }).catch((e) => { if (e.name === 'AbortError') return null; throw new AIError(`${oaLabel(cfg)}에 연결할 수 없습니다.`, 'NET'); });
    if (!res) return;
    if (!res.ok) throw await httpError(res, oaLabel(cfg));
    await readSSE(res, (d) => {
      const t = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
      if (t) onText(t);
    }, signal).catch((e) => { if (e.name !== 'AbortError') throw e; });
  },
  async test(cfg) {
    const res = await fetch(`${oaBase(cfg)}/models`, { headers: oaHeaders(cfg) })
      .catch(() => { throw new AIError(`${oaLabel(cfg)}에 연결할 수 없습니다. 주소를 확인해 주세요.`, 'NET'); });
    if (!res.ok) throw await httpError(res, oaLabel(cfg));
  },
};

// ───────── Google Gemini ─────────
const gemini = {
  body(system, messages, extra) {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      ...extra,
    });
  },
  headers(cfg) { return { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key }; },
  async json(cfg, { system, user, schema }) {
    const res = await fetch(`${GEMINI_BASE()}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST', headers: gemini.headers(cfg),
      body: gemini.body(system + `\n\n다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하세요:\n${JSON.stringify(schema)}`,
        [{ role: 'user', content: user }], { generationConfig: { responseMimeType: 'application/json' } }),
    }).catch(() => { throw new AIError('Google Gemini에 연결할 수 없습니다.', 'NET'); });
    if (!res.ok) throw await httpError(res, 'Google Gemini');
    const j = await res.json();
    const c = j.candidates && j.candidates[0];
    if (!c || !c.content) throw new AIError('Gemini가 응답하지 않았습니다(안전 필터 등). 표현을 바꿔 다시 시도해 주세요.', 'REFUSAL');
    return extractJSON(c.content.parts.map((p) => p.text || '').join(''));
  },
  async stream(cfg, { system, messages, onText, signal }) {
    const res = await fetch(`${GEMINI_BASE()}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: gemini.headers(cfg), signal, body: gemini.body(system, messages),
    }).catch((e) => { if (e.name === 'AbortError') return null; throw new AIError('Google Gemini에 연결할 수 없습니다.', 'NET'); });
    if (!res) return;
    if (!res.ok) throw await httpError(res, 'Google Gemini');
    await readSSE(res, (d) => {
      const c = d.candidates && d.candidates[0];
      const t = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || '').join('') : '';
      if (t) onText(t);
    }, signal).catch((e) => { if (e.name !== 'AbortError') throw e; });
  },
  async test(cfg) {
    const res = await fetch(`${GEMINI_BASE()}/models/${encodeURIComponent(cfg.model)}`, { headers: gemini.headers(cfg) })
      .catch(() => { throw new AIError('Google Gemini에 연결할 수 없습니다.', 'NET'); });
    if (!res.ok) throw await httpError(res, 'Google Gemini');
  },
};

const IMPL = { anthropic, openai: openaiCompat, custom: openaiCompat, local: openaiCompat, gemini };

// ───────── 로컬 AI(Ollama) 자동 감지 ─────────
async function detectOllama() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`${OLLAMA_BASE()}/api/tags`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    const models = (j.models || []).map((m) => m.name);
    return { running: true, models };
  } catch { return null; }
}

module.exports = { PROVIDERS, IMPL, AIError, detectOllama, extractJSON };
