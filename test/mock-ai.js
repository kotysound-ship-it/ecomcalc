// 각 AI 공급자의 API 형식을 흉내 내는 로컬 테스트 서버
const http = require('http');

const GOOD = 'good-key';
const GEMINI_TEST_KEY = 'AIza' + 'Sy' + 'T'.repeat(33); // 실제 Gemini 키 형식(39자)
const PARSE_RESULT = {
  calculator: 'profit',
  inputs: [
    { field: 'cost', value: '8000' }, { field: 'price', value: '29900' },
    { field: 'feeRate', value: '5.5' }, { field: 'shipping', value: '3000' },
    { field: 'bogusField', value: '1' }, // 존재하지 않는 필드 → 앱이 걸러내야 함
  ],
  note: '원가·판매가·수수료·배송비를 채웠어요.',
};
const ADVICE = ['### 진단\n', '마진은 **양호**합니다.\n', '- 가격 유지\n', '- 배송비 절감\n'];

function create() {
  const state = { requests: [], ollamaModels: ['gemma3:4b'], ollamaUp: true, slow: false };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: json });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const sse = async (chunks, fmt) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) { res.write(fmt(c)); await new Promise((r) => setTimeout(r, state.slow ? 400 : 20)); if (res.destroyed) return; }
      res.end();
    };
    const p = url.pathname;

    // ── Anthropic
    if (p.startsWith('/anthropic/')) {
      if (req.headers['x-api-key'] !== GOOD && req.headers.authorization !== `Bearer ${GOOD}`) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.method === 'GET' && p.startsWith('/anthropic/v1/models/')) return send(200, { id: p.split('/').pop(), type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z' });
      if (p === '/anthropic/v1/messages') {
        if (!json.stream) {
          return send(200, { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: JSON.stringify(PARSE_RESULT) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
        }
        const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        const events = [
          ev('message_start', { message: { id: 'msg_2', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ...ADVICE.map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })),
          ev('content_block_stop', { index: 0 }),
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }),
          ev('message_stop', {}),
        ];
        return sse(events, (e) => e);
      }
    }

    // ── OpenAI / Custom / Ollama (Chat Completions)
    const oa = p.match(/^\/(openai|custom|ollama)\/v1\/(chat\/completions|models)$/);
    if (oa) {
      const who = oa[1];
      if (who === 'openai' && req.headers.authorization !== `Bearer ${GOOD}`) return send(401, { error: { message: 'Incorrect API key provided' } });
      if (who === 'ollama' && !state.ollamaUp) { req.socket.destroy(); return; }
      if (oa[2] === 'models') return send(200, { data: [{ id: 'm' }] });
      if (!json.stream) return send(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(PARSE_RESULT) } }] });
      return sse([...ADVICE.map((t) => ({ choices: [{ delta: { content: t } }] })), '[DONE]'], (c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
    }
    if (p === '/ollama/api/tags') {
      if (!state.ollamaUp) { req.socket.destroy(); return; }
      return send(200, { models: state.ollamaModels.map((name) => ({ name })) });
    }

    // ── Gemini
    const gm = p.match(/^\/gemini\/models\/([^:]+)(?::(generateContent|streamGenerateContent))?$/);
    if (gm) {
      if (req.headers['x-goog-api-key'] !== GOOD && req.headers['x-goog-api-key'] !== GEMINI_TEST_KEY) return send(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
      if (!gm[2]) return send(200, { name: `models/${gm[1]}` });
      if (gm[2] === 'generateContent') return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(PARSE_RESULT) }] } }] });
      return sse(ADVICE.map((t) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })), (c) => `data: ${JSON.stringify(c)}\n\n`);
    }
    send(404, { error: { message: 'not found ' + p } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, GOOD, GEMINI_TEST_KEY })));
}

module.exports = { create, PARSE_RESULT, ADVICE };
