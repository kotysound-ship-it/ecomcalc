// 앱을 실제로 띄워 기능별로 조작·검증하는 E2E 테스트 (main 프로세스에서 실행)
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const Calc = require('../src/calc');
const Mock = require('./mock-ai');

module.exports = ({ app, win, clipboard }) => {
  const results = [];
  const OUT = process.env.ECOM_E2E_OUT;
  const shotDir = process.env.ECOM_E2E_SHOTS;
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(code, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(`return !!(${code})`)) return true; await sleep(80); }
    throw new Error('timeout waiting: ' + code);
  }
  async function step(name, fn) {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '' }); }
    catch (e) { results.push({ name, ok: false, detail: e.message }); }
  }
  const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
  const shot = async (name) => { if (!shotDir) return; const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(shotDir, name + '.png'), img.toPNG()); };

  // 렌더러 조작 헬퍼
  const H = `
    const $ = (s) => document.querySelector(s);
    const type = (id, val) => { const el = document.getElementById(id); el.focus(); el.value = val; el.dispatchEvent(new Event('input')); };
    const seg = (key, label) => { const f = document.getElementById('f_' + key); if (f) { f.value = label; f.dispatchEvent(new Event('change')); return; }
      [...document.querySelectorAll('.field')].find((w) => w.querySelector('label').htmlFor === 'f_' + key)
        .querySelectorAll('.segmented button').forEach((b) => { if (b.textContent === label) b.click(); }); };
    const nav = (name) => [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes(name)).click();
    const bigs = () => [...document.querySelectorAll('.big .val')].map((e) => e.textContent);
    const toastText = () => $('#toast').hidden ? '' : $('#toast').textContent;
  `;

  win.webContents.once('did-finish-load', async () => {
    const mock = await Mock.create();
    const base = `http://127.0.0.1:${mock.port}`;
    process.env.ECOM_ANTHROPIC_BASE_URL = base + '/anthropic';
    process.env.ECOM_OPENAI_BASE_URL = base + '/openai/v1';
    process.env.ECOM_GEMINI_BASE_URL = base + '/gemini';
    process.env.ECOM_OLLAMA_URL = 'http://127.0.0.1:9'; // 처음엔 로컬 AI 없음
    process.env.ECOM_UPDATE_URL = base + '/no-release'; // 처음엔 릴리스 없음 (실행 직후 자동 확인이 다른 테스트를 방해하지 않게)
    process.env.ECOM_UPDATE_DRYRUN = '1';
    const userData = app.getPath('userData');
    await sleep(500);

    // ───────── 1. 계산기 10종 ─────────
    const SAMPLES = {
      profit: { name: 'E2E 상품', price: '39900', salePrice: '34900', cost: '12000', feeRate: '5.5', etcFeeRate: '3.3', shipping: '3200', couponRate: '10', couponShare: '50', gift: '500', otherCost: '4000', targetMargin: '20' },
      marginRate: { price: '10000', cost: '6000' },
      sellPrice: { cost: '7000', margin: '30', feeRate: '5' },
      marginAmount: { price: '15000', cost: '9000', qty: '12' },
      growth: { prev: '1200000', curr: '1500000' },
      target: { goal: '30', actual: '12', daysPassed: '12', daysTotal: '30' },
      vat: { amount: '55000' },
      discountPrice: { price: '29900', rate: '15' },
      discountRate: { price: '20000', sale: '15000' },
      supplyPrice: { consumer: '33000', distMargin: '35' },
    };
    for (const [id, vals] of Object.entries(SAMPLES)) {
      await step(`계산기: ${Calc.CALCS[id].name}`, async () => {
        const typed = Object.entries(vals).map(([k, v]) => `type('f_${k}', ${JSON.stringify(v)});`).join('');
        const shown = await js(`${H} nav(${JSON.stringify(Calc.CALCS[id].name)}); await new Promise(r=>setTimeout(r,50)); ${typed} return bigs();`);
        const expected = Calc.run(id, Object.assign(Calc.defaults(id), vals)).filter((o) => o.primary).map((o) => o.text);
        ok(JSON.stringify(shown) === JSON.stringify(expected), `화면 ${shown} ≠ 기대 ${expected}`);
        return shown.join(' / ');
      });
    }
    await step('목표 달성: 백만원 단위 + 한글 병기 + 기간 + 채널별 입력', async () => {
      const r = await js(`${H} nav('목표 달성'); $('#btnReset').click();
        type('f_goal', '250'); const kor = document.getElementById('k_goal').textContent;
        const sd = document.getElementById('f_startDate'); sd.value = '2026-11-01'; sd.dispatchEvent(new Event('change'));
        const ed = document.getElementById('f_endDate'); ed.value = '2026-11-30'; ed.dispatchEvent(new Event('change'));
        const ad = document.getElementById('f_asOfDate'); ad.value = '2026-11-12'; ad.dispatchEvent(new Event('change'));
        const days = [document.getElementById('f_daysPassed').value, document.getElementById('f_daysTotal').value, document.getElementById('f_daysTotal').readOnly];
        $('#btnAddChannel').click(); $('#btnAddChannel').click();
        const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
        set('.ch-row:nth-of-type(2) .ch-name', '쿠팡'); set('[data-ch="0.goal"]', '200'); set('[data-ch="0.actual"]', '100');
        set('.ch-row:nth-of-type(3) .ch-name', '자사몰'); set('[data-ch="1.goal"]', '100'); set('[data-ch="1.actual"]', '20');
        return { kor, days, goal: document.getElementById('f_goal').value, goalRO: document.getElementById('f_goal').readOnly, korSum: document.getElementById('k_goal').textContent,
          bigs: bigs(), sub: [...document.querySelectorAll('.big .sub')].map((e) => e.textContent),
          rows: [...document.querySelectorAll('#channelResults tbody tr')].map((tr) => [...tr.children].map((td) => td.firstChild.textContent)) };`);
      ok(r.kor === '= 2억 5천만원', '한글 병기 ' + r.kor);
      ok(r.days[0] === '12' && r.days[1] === '30' && r.days[2], '기간 → 일수 ' + r.days);
      ok(r.goal === '300' && r.goalRO && r.korSum.includes('3억'), '채널 합계 ' + r.goal + ' ' + r.korSum);
      ok(r.bigs[0] === '40.0%' && r.bigs[1] === '1억 8천만원' && r.sub[0] === '180,000,000원', '결과 ' + r.bigs + ' / ' + r.sub);
      ok(r.rows.length === 2 && r.rows[0][0] === '쿠팡' && r.rows[0][3] === '50.0%' && r.rows[1][3] === '20.0%', '채널 표 ' + JSON.stringify(r.rows));
      await sleep(500); await shot('01b-target-channels');
      return `목표 ${r.kor} · 기간 ${r.days[0]}/${r.days[1]}일 · 채널 합계 ${r.korSum} · 남은 금액 ${r.bigs[1]} (${r.sub[0]})`;
    });
    await step('계산기: 과/면세·끝자리 선택 버튼', async () => {
      const r = await js(`${H} nav('부가세'); seg('mode', '공급가액(VAT별도)'); type('f_amount', '10000'); const a = bigs();
        nav('할인가'); type('f_price','29900'); type('f_rate','15'); seg('unit','안 함'); const b = bigs(); seg('unit','100원'); const c = bigs(); return [a,b,c];`);
      ok(r[0][1] === '1,000원', 'VAT 공급가 기준 ' + r[0]);
      ok(r[1][0] === '25,415원' && r[2][0] === '25,400원', '끝자리 내림 ' + r[1] + ' ' + r[2]);
      return `부가세 ${r[0].join('/')} · 할인가 ${r[1][0]} → 100원 내림 ${r[2][0]}`;
    });

    // ───────── 2. 입력 유지 (상품명 버그 회귀) ─────────
    await step('영업이익률: 정액 광고비 + 예상 판매수량 → 개당 광고비·손익분기 판매수량', async () => {
      const r = await js(`${H} nav('영업이익률'); $('#btnReset').click();
        type('f_price','39900'); type('f_salePrice','19900'); type('f_cost','7500'); type('f_feeRate','10'); type('f_shipping','2500'); type('f_targetMargin','10');
        type('f_adFixed','1000000'); const noQty = { big: bigs(), bep: $('#resultList [data-key="bepQty"] .v').textContent };
        type('f_salesQty','100');
        const row = (k) => $('#resultList [data-key="' + k + '"] .v').textContent;
        return { noQty, big: bigs(), ad: row('adCost'), bep: row('bepQty'), total: row('totalProfit'), unit: document.querySelector('#f_salesQty').parentElement.querySelector('.unit').textContent };`);
      ok(r.noQty.big[0] === '7,191원' && r.noQty.bep === '127개', JSON.stringify(r.noQty));
      ok(r.big[0] === '-1,900원' && r.ad === '10,000원' && r.bep === '127개' && r.total === '-190,000원' && r.unit === '개', JSON.stringify(r));
      await shot('profit-ads');
      return `수량 없음: 개당 이익 ${r.noQty.big[0]}, 손익분기 ${r.noQty.bep} / 100개: 개당 ${r.big[0]}, 광고비 ${r.ad}, 총 ${r.total}`;
    });
    await step('영업이익률: 광고비 %·정액 쿠폰', async () => {
      const r = await js(`${H} $('#btnReset').click(); seg('taxType','면세'); type('f_price','10000'); type('f_cost','5000'); type('f_adRate','10'); const a = bigs()[0];
        type('f_adRate',''); type('f_couponFixed','3000'); const row = (k) => $('#resultList [data-key="' + k + '"] .v').textContent;
        return { a, b: bigs()[0], net: row('netSales') };`);
      ok(r.a === '4,000원' && r.b === '2,000원' && r.net === '7,000원', JSON.stringify(r));
      await js(`${H} $('#btnReset').click();`);
      return `광고비 10% → ${r.a}, 정액 쿠폰 3,000원 → ${r.b}`;
    });
    await step('「?」 아이콘: 마우스를 올리면 설명 말풍선 (입력란·결과 모두)', async () => {
      const r = await js(`${H}
        const hover = (el) => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const t = $('#tip'); return t.hidden ? '' : t.textContent; };
        const a = hover(document.querySelector('#form .help'));
        const b = hover($('#resultList [data-key="bepRoas"] .help'));
        document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const icons = document.querySelectorAll('#resultList .help').length;
        const plain = [...document.querySelectorAll('#resultList dt')].some((d) => / \?$/.test(d.textContent.trim()) && !d.querySelector('.help'));
        return { a, b, hidden: $('#tip').hidden, icons, style: getComputedStyle($('#resultList .help')).borderRadius };`);
      ok(r.a.length > 5 && /적자/.test(r.b) && r.hidden && r.icons >= 3 && r.style === '50%', JSON.stringify(r));
      await js(`${H} $('#resultList [data-key="bepRoas"] .help').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      await shot('tooltip');
      await js(`document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      return `입력 「${r.a}」 / 결과 「${r.b}」`;
    });
    await step('결과 ★ 강조: 기본 강조 → 클릭으로 추가·해제 → 다시 열어도 유지', async () => {
      const r = await js(`${H} type('f_price','29900'); type('f_cost','9000');
        const pinned = () => [...document.querySelectorAll('#resultList .row.pinned')].map((x) => x.dataset.key);
        const cards = () => [...document.querySelectorAll('#pinnedResults .pin-card')].map((x) => x.dataset.key);
        const def = pinned();
        $('#resultList [data-key="netSales"]').click();
        const added = { rows: pinned(), cards: cards() };
        $('#resultList [data-key="bepRoas"] .help').click();
        const helpClick = pinned();
        $('#resultList [data-key="bepRoas"]').click();
        nav('마진율'); nav('영업이익률');
        return { def, added, helpClick, after: pinned(), saved: JSON.parse(localStorage.getItem('pins')).profit };`);
      ok(r.def.join() === 'bepPrice,bepRoas', '기본: ' + r.def);
      ok(r.added.rows.includes('netSales') && r.added.cards.includes('netSales'), JSON.stringify(r.added));
      ok(r.helpClick.length === r.added.rows.length, '「?」 클릭이 강조를 바꿈');
      ok(r.after.slice().sort().join() === 'bepPrice,netSales' && r.saved.slice().sort().join() === 'bepPrice,netSales', JSON.stringify(r));
      await shot('pinned');
      return `기본 [${r.def}] → 정산기준 매출 추가, 손익분기 ROAS 해제 → 유지 [${r.after}]`;
    });
    await step('입력값 저장·유지 (상품명 수정 반영)', async () => {
      const r = await js(`${H} nav('영업이익률'); type('f_name', '채움 서리태콩물두유'); type('f_name', '채움 서리태콩물두유 1L');
        nav('마진율'); nav('영업이익률'); return [document.getElementById('f_name').value, JSON.parse(localStorage.getItem('values')).profit.name];`);
      ok(r[0] === '채움 서리태콩물두유 1L' && r[1] === r[0], JSON.stringify(r));
      return r[0];
    });

    // ───────── 3. 채널 프리셋 ─────────
    await step('채널 프리셋 저장·적용·삭제', async () => {
      const r = await js(`${H} nav('영업이익률'); type('f_feeRate','10.8'); type('f_shipping','2800');
        document.querySelector('#presets .chip.add').click(); const inp = document.querySelector('#presets input');
        inp.value = '쿠팡테스트'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        type('f_feeRate','3'); type('f_shipping','0');
        const chip = [...document.querySelectorAll('#presets .chip')].find((c) => c.textContent.includes('쿠팡테스트')); chip.click();
        const applied = [document.getElementById('f_feeRate').value, document.getElementById('f_shipping').value];
        const chip2 = [...document.querySelectorAll('#presets .chip')].find((c) => c.textContent.includes('쿠팡테스트'));
        chip2.querySelector('.x').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { applied, left: JSON.parse(localStorage.getItem('presets')).length };`);
      ok(r.applied[0] === '10.8' && r.applied[1] === '2,800', '적용 ' + r.applied);
      ok(r.left === 0, '삭제 후 ' + r.left);
      return `적용 수수료 ${r.applied[0]}%, 배송비 ${r.applied[1]}원 → 삭제 OK`;
    });

    // ───────── 4. 결과 복사 / 초기화 ─────────
    await step('결과 복사', async () => {
      await clipboard.writeText('');
      await js(`${H} nav('영업이익률'); type('f_name','복사테스트'); type('f_price','20000'); type('f_cost','8000'); $('#btnCopy').click();`);
      await sleep(300);
      const t = await clipboard.readText();
      ok(typeof t === 'string' && t.includes('[영업이익률 계산기]') && t.includes('복사테스트') && t.includes('영업이익률:'), String(t).slice(0, 80));
      return t.split('\n').slice(0, 2).join(' | ');
    });
    await step('초기화', async () => {
      const r = await js(`${H} $('#btnReset').click(); return [document.getElementById('f_price').value, document.getElementById('f_name').value, bigs()[0]];`);
      ok(r[0] === '' && r[1] === '' && r[2] === '0원', JSON.stringify(r));
      return '모든 값 비움, 결과 0원';
    });

    // ───────── 5. 엑셀 장부 ─────────
    const ledger = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).ledgerPath;
    await step('장부에 기록 (함수 포함 xlsx 생성)', async () => {
      await js(`${H} nav('영업이익률'); type('f_name','장부상품A'); type('f_price','29900'); type('f_cost','9000'); type('f_feeRate','5.5'); type('f_shipping','3000');
        $('#memo').value = '첫 기록'; $('#btnRecord').click();`);
      await until(`document.querySelector('#toast').textContent.includes('기록했어요')`);
      await js(`${H} nav('부가세'); type('f_amount','55000'); $('#btnRecord').click();`);
      await until(`document.querySelector('#toast').textContent.includes("'부가세'")`);
      await js(`${H} nav('영업이익률'); type('f_name','장부상품B'); type('f_price','19900'); $('#btnRecord').click();`);
      await until(`document.querySelector('#toast').textContent.includes('3행')`);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(ledger);
      const names = wb.worksheets.map((w) => w.name);
      const ws = wb.getWorksheet('영업이익률');
      const hdr = ws.getRow(1).values; const col = (label) => hdr.findIndex((h) => typeof h === 'string' && h.startsWith(label));
      const r2 = ws.getRow(2), r3 = ws.getRow(3);
      const profit = r2.getCell(col('영업이익(개당)')).value;
      ok(names[0] === '요약' && names.includes('부가세'), '시트 ' + names);
      ok(r2.getCell(col('상품명')).value === '장부상품A' && r3.getCell(col('상품명')).value === '장부상품B', '상품명');
      ok(r2.getCell(col('메모')).value === '첫 기록', '메모');
      ok(profit && profit.formula && profit.formula.includes('2'), '함수 ' + JSON.stringify(profit));
      const expected = Calc.run('profit', Object.assign(Calc.defaults('profit'), { name: '장부상품A', price: '29900', cost: '9000', feeRate: '5.5', shipping: '3000' })).find((o) => o.key === 'profit').value;
      ok(Math.abs(profit.result - expected) < 1e-6, `캐시값 ${profit.result} ≠ ${expected}`);
      const sumF = wb.getWorksheet('요약').getCell('B4').value;
      return `시트 [${names.join(', ')}], 영업이익 칸 =${profit.formula} (${Math.round(profit.result)}원), 요약 =${sumF.formula}`;
    });
    await step('장부 파일이 열려 있어 잠긴 경우 안내 (잘못된 경로)', async () => {
      const s = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
      fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ...s, ledgerPath: '/dev/null/x/장부.xlsx' }));
      await js(`${H} $('#btnRecord').click();`);
      await until(`document.querySelector('#toast').classList.contains('err')`);
      const t = await js(`${H} return toastText();`);
      fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(s));
      return '오류 토스트: ' + t.slice(0, 40);
    });

    // ───────── 6. 기록 내역 / 내보내기 ─────────
    await step('기록 내역 (목록·다시 불러오기)', async () => {
      const r = await js(`${H} const n = $('#historyCount').textContent; $('#btnHistory').click();
        const items = [...document.querySelectorAll('.history-item')]; const last = items.find((i) => i.textContent.includes('장부상품A'));
        last.click(); return [n, items.length, document.getElementById('f_name').value, $('#historyModal').hidden];`);
      ok(r[0] === '3' && r[1] === 3 && r[2] === '장부상품A' && r[3] === true, JSON.stringify(r));
      return `${r[1]}건 표시, 클릭 시 '${r[2]}' 복원`;
    });
    await step('전체를 새 엑셀로 내보내기', async () => {
      await js(`${H} $('#btnHistory').click(); $('#btnExport').click();`);
      await until(`document.querySelector('#toast').textContent.includes('내보냈어요')`);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(process.env.ECOM_EXPORT_PATH);
      const rows = wb.getWorksheet('영업이익률').actualRowCount - 1;
      await js(`document.getElementById('historyModal').hidden = true;`);
      ok(rows === 2, 'rows ' + rows);
      return `영업이익률 ${rows}행 + 부가세 1행`;
    });
    await shot('01-main');

    // ───────── 7. AI 없음 → 안내 ─────────
    await step('AI 미연결: 상태 표시 + 연결 안내창', async () => {
      const st = await js(`${H} await new Promise(r=>setTimeout(r,300)); return $('#aiStatus').textContent;`);
      await js(`${H} $('#btnAnalyze').click();`);
      await until(`!document.getElementById('noAiModal').hidden`);
      await sleep(400); await shot('02-no-ai-guide');
      await js(`document.getElementById('noAiModal').hidden = true;`);
      ok(st.includes('연결 안 됨'), st);
      return `상태 "${st}" → 안내창(로컬 AI / 무료 Gemini 키 / 유료 키) 표시`;
    });

    // ───────── 8. 로컬 AI(Ollama) 자동 연결 ─────────
    await step('로컬 AI: 실행 중이지만 모델 없음 안내', async () => {
      process.env.ECOM_OLLAMA_URL = base + '/ollama'; mock.state.ollamaModels = [];
      await js(`${H} document.getElementById('noAiModal').hidden = false; $('#btnRecheckAI').click();`);
      await until(`document.querySelector('#toast').textContent.includes('ollama pull')`);
      await js(`document.getElementById('noAiModal').hidden = true;`);
      return 'ollama pull 안내 표시';
    });
    await step('로컬 AI: 키 없이 자동 연결', async () => {
      mock.state.ollamaModels = ['gemma3:4b'];
      win.webContents.send('focus-test');
      await js(`window.dispatchEvent(new Event('focus'));`);
      await until(`document.getElementById('aiStatus').textContent.includes('로컬')`);
      return await js(`return document.getElementById('aiStatus').textContent`);
    });

    // AI 공통 검증: 말로 입력 + AI 분석 + 후속 질문
    async function aiFlow(label, pathPrefix) {
      const before = mock.state.requests.length;
      await js(`${H} nav('마진율'); $('#btnReset').click(); const i = $('#aiInput'); i.value = '원가 8천원, 판매가 29,900원, 수수료 5.5%, 배송비 3천원'; $('#aiGo').click();`);
      await until(`document.getElementById('aiNote').textContent.includes('채웠어요') || document.getElementById('aiNote').classList.contains('err')`);
      const fill = await js(`${H} return { note: $('#aiNote').textContent, title: $('#calcTitle').textContent, cost: document.getElementById('f_cost').value, fee: document.getElementById('f_feeRate').value, profit: bigs()[0] };`);
      ok(fill.title.includes('영업이익률') && fill.cost === '8,000' && fill.fee === '5.5', `${label} 채우기 실패: ${JSON.stringify(fill)}`);
      await js(`${H} $('#aiClear').click(); $('#btnAnalyze').click();`);
      await until(`(() => { const m = document.querySelectorAll('.msg.assistant'); const l = m[m.length-1]; return l && !l.classList.contains('typing'); })()`);
      const a1 = await js(`const m = document.querySelectorAll('.msg.assistant'); return m[m.length-1].innerHTML;`);
      ok(a1.includes('<h4>진단</h4>') && a1.includes('<strong>양호</strong>') && a1.includes('<li>배송비 절감</li>'), `${label} 분석 렌더링: ${a1.slice(0, 120)}`);
      await js(`${H} $('#aiAsk').value = '쿠팡으로 옮기면?'; $('#aiCompose').requestSubmit();`);
      await until(`document.querySelectorAll('.msg.assistant').length === 2 && !document.querySelectorAll('.msg.assistant')[1].classList.contains('typing')`);
      const reqs = mock.state.requests.slice(before).filter((r) => r.path.startsWith(pathPrefix) && r.method === 'POST');
      const followUp = reqs[reqs.length - 1].body;
      return { fill, reqs, followUp };
    }

    await step('로컬 AI: 말로 입력 → 자동 채움 / AI 분석 스트리밍 / 후속 질문', async () => {
      const { fill, reqs, followUp } = await aiFlow('Ollama', '/ollama');
      ok(reqs[0].body.model === 'gemma3:4b', 'model ' + reqs[0].body.model);
      ok(followUp.messages.length === 4 && followUp.messages[3].content.includes('현재 계산기 화면 값'), '후속 질문 대화 맥락');
      await shot('03-ai-analysis');
      return `영업이익률로 전환, 원가 ${fill.cost} 채움 (없는 필드는 무시) · 분석 표시 · 후속 질문에 대화+최신 수치 포함`;
    });
    await step('AI 응답 중지 버튼', async () => {
      mock.state.slow = true;
      await js(`${H} $('#aiAsk').value = '1+1 행사하면?'; $('#aiCompose').requestSubmit();`);
      await until(`!document.getElementById('aiStop').hidden`);
      await sleep(500);
      await js(`document.getElementById('aiStop').click();`);
      await until(`document.getElementById('aiStop').hidden`);
      mock.state.slow = false;
      const n = await js(`const m = document.querySelectorAll('.msg.assistant'); return m[m.length-1].dataset.raw.length;`);
      ok(n < ADVICE_LEN(), '중지 후에도 계속 수신');
      return '스트리밍 도중 중지됨';
    });
    function ADVICE_LEN() { return Mock.ADVICE.join('').length; }

    await step('AI 개인정보 보호: 상품명 별칭 / 금액 숨기기', async () => {
      const lastSent = () => { const r = mock.state.requests.filter((x) => x.path.startsWith('/ollama') && x.method === 'POST' && x.body && x.body.stream); return JSON.stringify(r[r.length - 1].body.messages); };
      const analyzeOnce = async () => {
        await js(`${H} $('#aiClear').click(); $('#btnAnalyze').click();`);
        await until(`(() => { const m = document.querySelectorAll('.msg.assistant'); const l = m[m.length-1]; return l && !l.classList.contains('typing'); })()`);
      };
      await js(`${H} nav('영업이익률'); $('#btnReset').click(); type('f_name', '비밀 린넨 셔츠'); type('f_price', '29900'); type('f_cost', '9000'); type('f_feeRate', '5.5');`);
      await analyzeOnce();
      const a = lastSent();
      ok(!a.includes('비밀 린넨 셔츠') && a.includes('상품A') && a.includes('29,900'), '기본(상품명 가림) ' + a.slice(0, 200));
      const badge = await js(`return document.getElementById('privacyBadge').textContent`);
      await js(`${H} $('#aiAsk').value = '비밀 린넨 셔츠 가격을 올리면?'; $('#aiCompose').requestSubmit();`);
      await until(`document.querySelectorAll('.msg.assistant').length === 2 && !document.querySelectorAll('.msg.assistant')[1].classList.contains('typing')`);
      const q = lastSent();
      ok(!q.includes('비밀 린넨 셔츠') && q.includes('상품A 가격을 올리면'), '질문 속 상품명 ' + q.slice(-300));
      await js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250)); const s = $('#privacyMode'); s.value = 'strict'; s.dispatchEvent(new Event('change')); document.getElementById('settingsModal').hidden = true;`);
      await analyzeOnce();
      const b = lastSent();
      ok(!b.includes('29,900') && !b.includes('9,000') && b.includes('5.5%') && b.includes('비공개'), '금액 숨김 ' + b.slice(0, 300));
      await js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250)); const s = $('#privacyMode'); s.value = 'name'; s.dispatchEvent(new Event('change')); document.getElementById('settingsModal').hidden = true;`);
      return `배지 "${badge}" · 상품명 → 상품A (분석·질문 모두) · 금액 숨김 모드에서 금액 미전송`;
    });

    // ───────── 9. 클라우드 공급자 3종 + 직접 입력 서버 ─────────
    process.env.ECOM_OLLAMA_URL = 'http://127.0.0.1:9';
    async function setup(provider, key, extra = '') {
      return js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250));
        const sel = $('#aiProvider'); sel.value = ${JSON.stringify(provider)}; sel.dispatchEvent(new Event('change'));
        $('#apiKey').value = ${JSON.stringify(key)}; ${extra}
        $('#btnSaveAI').click(); await new Promise(r=>setTimeout(r,50));
        for (let i=0;i<100 && $('#btnSaveAI').disabled;i++) await new Promise(r=>setTimeout(r,50));
        const t = toastText(); $('#settingsModal').hidden = true; return t;`);
    }
    for (const [prov, label, prefix] of [['anthropic', 'Claude', '/anthropic'], ['openai', 'OpenAI', '/openai'], ['gemini', 'Gemini', '/gemini']]) {
      await step(`${label}: 잘못된 키 거부`, async () => {
        const t = await setup(prov, 'wrong-key');
        ok(/올바르지|not valid|권한/.test(t), t);
        const keys = fs.existsSync(path.join(userData, 'keys.json')) ? JSON.parse(fs.readFileSync(path.join(userData, 'keys.json'))) : {};
        ok(!keys[prov], '잘못된 키가 저장됨');
        return t;
      });
      await step(`${label}: 키 저장(암호화) → 말로 입력 / 분석 / 후속 질문`, async () => {
        const n0 = mock.state.requests.length;
        const t = await setup(prov, mock.GOOD);
        ok(t.includes('저장했어요'), t + ' | reqs: ' + JSON.stringify(mock.state.requests.slice(n0).map((r) => [r.method, r.path, r.headers['x-api-key'] || r.headers.authorization || r.headers['x-goog-api-key']])));
        const raw = fs.readFileSync(path.join(userData, 'keys.json'), 'utf8');
        ok(!raw.includes(mock.GOOD), '키가 평문으로 저장됨');
        const st = await js(`return document.getElementById('aiStatus').textContent`);
        const { reqs } = await aiFlow(label, prefix);
        let extra = '';
        if (prov === 'anthropic') {
          const b = reqs[0].body;
          ok(b.model === 'claude-opus-5-5' && b.fallbacks === 'default' && b.output_config.format.type === 'json_schema', 'Claude 요청 형식');
          ok(String(reqs[0].headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), 'beta 헤더');
          extra = 'claude-opus-5-5, 구조화 출력+fallback 헤더 확인';
        }
        if (prov === 'openai') { ok(reqs[0].body.response_format.type === 'json_schema' && reqs[0].body.model === 'gpt-5-mini', 'OpenAI 요청 형식'); extra = 'gpt-5-mini, json_schema'; }
        if (prov === 'gemini') { ok(reqs[0].path.endsWith('gemini-flash-latest:generateContent'), 'Gemini 경로'); extra = 'gemini-flash-latest, SSE 스트리밍'; }
        // 다음 공급자 테스트를 위해 키 삭제
        await js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250)); const sel=$('#aiProvider'); sel.value=${JSON.stringify(prov)}; sel.dispatchEvent(new Event('change')); $('#btnDeleteKey').click(); await new Promise(r=>setTimeout(r,300)); $('#settingsModal').hidden = true;`);
        const after = JSON.parse(fs.readFileSync(path.join(userData, 'keys.json'), 'utf8'));
        ok(!after[prov], '키 삭제 실패');
        return `상태 "${st}" · ${extra} · 키 삭제 OK`;
      });
    }
    await step('OpenAI 호환 서버(직접 입력): 주소+모델만으로 연결', async () => {
      const t = await setup('custom', '', `$('#aiBase').value = ${JSON.stringify(base + '/custom/v1')}; $('#aiModel').value = 'llama-3.3-70b';`);
      ok(t.includes('저장했어요'), t);
      const { reqs } = await aiFlow('Custom', '/custom');
      ok(reqs[0].body.model === 'llama-3.3-70b' && !reqs[0].headers.authorization, '요청 형식');
      return '모델 llama-3.3-70b, 키 없이 요청';
    });
    await step('자동 모드: 저장된 키 우선 사용', async () => {
      await setup('gemini', mock.GOOD);
      await js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250)); const sel=$('#aiProvider'); sel.value='auto'; sel.dispatchEvent(new Event('change')); $('#btnSaveAI').click(); await new Promise(r=>setTimeout(r,400)); $('#settingsModal').hidden = true;`);
      const st = await js(`return document.getElementById('aiStatus').textContent`);
      ok(st.includes('Gemini'), st);
      await js(`${H} $('#toast').hidden = true; $('#btnSettings').click(); await new Promise(r=>setTimeout(r,400));`);
      await shot('04-settings');
      await js(`document.getElementById('settingsModal').hidden = true;`);
      return st;
    });

    await step('알림(토스트): 처음엔 안 보이고, 표시 후 자동으로 사라짐', async () => {
      const r = await js(`const t = document.getElementById('toast');
        t.hidden = true; const hiddenInit = getComputedStyle(t).display === 'none';
        document.getElementById('btnCopy').click(); await new Promise(r=>setTimeout(r,300));
        const shown = getComputedStyle(t).display !== 'none';
        await new Promise(r=>setTimeout(r,3700));
        return [hiddenInit, shown, getComputedStyle(t).display === 'none'];`);
      ok(r[0] && r[1] && r[2], JSON.stringify(r));
      return '숨김 → 표시 → 3.5초 후 사라짐';
    });

    // ───────── 10. 복사한 키 자동 감지 ─────────
    const keysNow = () => JSON.parse(fs.readFileSync(path.join(userData, 'keys.json'), 'utf8'));
    const focus = () => js(`window.dispatchEvent(new Event('focus'));`);
    await step('키 감지: 키 받기 링크를 누르지 않았으면 클립보드를 읽지 않음', async () => {
      await js(`${H} $('#btnSettings').click(); await new Promise(r=>setTimeout(r,250)); const sel=$('#aiProvider'); sel.value='gemini'; sel.dispatchEvent(new Event('change')); $('#btnDeleteKey').click(); await new Promise(r=>setTimeout(r,300)); $('#settingsModal').hidden = true;`);
      await clipboard.writeText(mock.GEMINI_TEST_KEY);
      await focus(); await sleep(500);
      ok(await js(`return document.getElementById('keyFoundModal').hidden`), '설정/안내창이 닫혀 있는데 키 감지창이 뜸');
      return '앱 사용 중 일반 복사는 확인하지 않음';
    });
    await step('키 감지: 「무료 키 받기」 → 키 복사 → 앱 복귀 → 확인 한 번으로 Gemini 연결', async () => {
      await clipboard.writeText('');
      await js(`${H} document.getElementById('noAiModal').hidden = false; [...document.querySelectorAll('#noAiModal [data-url]')].find((b) => b.dataset.url.includes('apikey')).click(); document.getElementById('noAiModal').hidden = true;`);
      ok(global.__lastExternal === 'https://aistudio.google.com/apikey', 'AI Studio 링크 ' + global.__lastExternal);
      await clipboard.writeText(mock.GEMINI_TEST_KEY);   // 사용자가 브라우저에서 키를 복사
      await focus();                                     // 앱으로 돌아옴
      await until(`!document.getElementById('keyFoundModal').hidden`);
      const shown = await js(`return document.getElementById('keyFoundText').textContent`);
      ok(!shown.includes(mock.GEMINI_TEST_KEY) && shown.includes('AIza…TTTT'), '키가 마스킹되지 않음: ' + shown);
      await sleep(300); await shot('05-key-detected');
      await js(`document.getElementById('btnKeyAccept').click();`);
      await until(`document.getElementById('keyFoundModal').hidden && document.querySelector('#toast').textContent.includes('연결됐어요')`);
      const t = await js(`return document.querySelector('#toast').textContent`);
      const clip = await clipboard.readText();
      ok(keysNow().gemini, '키 미저장');
      ok(!fs.readFileSync(path.join(userData, 'keys.json'), 'utf8').includes(mock.GEMINI_TEST_KEY), '평문 저장');
      ok(clip === '', '클립보드에 키가 남음');
      const st = await js(`return document.getElementById('aiStatus').textContent`);
      return `"${shown.trim()}" → ${t} · 상태 "${st}"`;
    });
    await step('키 감지: 「아니요」 누르면 저장 안 하고 같은 키로 다시 묻지 않음', async () => {
      const oaKey = 'sk-proj-' + 'x'.repeat(40);
      await clipboard.writeText(oaKey);
      await js(`${H} $('#btnSettings').click();`);
      await until(`!document.getElementById('keyFoundModal').hidden`);
      const label = await js(`return document.getElementById('keyFoundText').textContent`);
      await js(`document.getElementById('btnKeyDecline').click();`);
      await focus(); await sleep(500);
      const again = await js(`return !document.getElementById('keyFoundModal').hidden`);
      await js(`document.getElementById('settingsModal').hidden = true;`);
      ok(label.includes('OpenAI'), label);
      ok(!keysNow().openai && !again, '거절 후 저장/재질문');
      return 'OpenAI 키 감지 → 거절 → 저장 안 됨, 재질문 없음';
    });
    await step('키 감지: 형식은 맞지만 무효인 키는 연결 실패 안내 후 저장 안 함', async () => {
      const bad = 'AIza' + 'Q'.repeat(35);
      await clipboard.writeText(bad);
      await js(`${H} $('#btnSettings').click();`);
      await until(`!document.getElementById('keyFoundModal').hidden`);
      await js(`document.getElementById('btnKeyAccept').click();`);
      await until(`!document.getElementById('keyFoundErr').hidden`);
      const err = await js(`return document.getElementById('keyFoundErr').textContent`);
      await js(`document.getElementById('btnKeyDecline').click(); document.getElementById('settingsModal').hidden = true;`);
      ok(/올바르지|권한/.test(err), err);
      ok((await clipboard.readText()) === bad, '실패했는데 클립보드를 지움');
      await js(`document.getElementById('btnSettings').click();`);
      await sleep(600);
      ok(await js(`return document.getElementById('keyFoundModal').hidden`), '실패 후 거절한 키를 다시 물어봄');
      await js(`document.getElementById('settingsModal').hidden = true;`);
      return err;
    });

    // ───────── 자동 업데이트 ─────────
    const readSettingsFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    await step('업데이트: 릴리스가 없으면 수동 확인 시 「최신 버전」 안내, 알림창 없음', async () => {
      await js(`${H} $('#btnSettings').click();`);
      await until(`!document.getElementById('settingsModal').hidden`);
      const ver = await js(`return document.getElementById('appVersion').textContent`);
      ok(ver === app.getVersion(), '설정에 버전 표시 안 됨: ' + ver);
      ok(await js(`return document.getElementById('autoUpdate').checked`), '자동 확인 기본값이 켜짐이 아님');
      await js(`document.getElementById('btnCheckUpdate').click();`);
      await until(`/최신 버전/.test(document.getElementById('toast').textContent)`);
      ok(await js(`return document.getElementById('updateModal').hidden`), '알림창이 떴음');
      return `현재 ${ver}`;
    });
    process.env.ECOM_UPDATE_URL = base + '/update';
    await step('업데이트: 새 버전이 올라오면 알림창 (버전·용량·변경 사항 링크)', async () => {
      win.webContents.send('menu', 'checkUpdate');
      await until(`!document.getElementById('updateModal').hidden`);
      const text = await js(`return document.getElementById('updateText').textContent`);
      ok(text.includes(app.getVersion()) && text.includes('9.9.0'), text);
      await js(`document.getElementById('updateNotes').click();`);
      await sleep(400);
      ok(/releases\/tag\/v9\.9\.0$/.test(global.__lastExternal), '변경 사항 링크: ' + global.__lastExternal);
      await shot('update-modal');
      return text;
    });
    await step('업데이트: 「이 버전 건너뛰기」 → 자동 확인 때는 안 뜨고, 수동 확인 때는 뜸', async () => {
      await js(`document.getElementById('btnUpdateSkip').click();`);
      await until(`document.getElementById('updateModal').hidden`);
      ok(readSettingsFile().update.skip === '9.9.0', 'skip 저장 안 됨');
      const auto = await js(`return await api.checkUpdate({ auto: true })`);
      ok(!auto.available && auto.skipped, JSON.stringify(auto));
      win.webContents.send('menu', 'checkUpdate');
      await until(`!document.getElementById('updateModal').hidden`);
      return '건너뛴 버전 자동 알림 없음 / 수동 확인은 표시';
    });
    await step('업데이트: 파일이 손상되면 설치하지 않고 「다시 시도」 안내', async () => {
      mock.state.update.corrupt = true;
      await js(`document.getElementById('btnUpdateNow').click();`);
      await until(`!document.getElementById('updateErr').hidden`, 15000);
      const err = await js(`return document.getElementById('updateErr').textContent`);
      const btn = await js(`return document.getElementById('btnUpdateNow').textContent`);
      mock.state.update.corrupt = false;
      ok(/손상|변조/.test(err) && btn === '다시 시도', err + ' / ' + btn);
      return err;
    });
    await step('업데이트: 「지금 업데이트」 → 내려받기·검증·설치 준비 (진행 중엔 창을 닫을 수 없음)', async () => {
      const target = path.join(userData, 'Applications', 'EcomCalc AI.app');
      fs.mkdirSync(target, { recursive: true });
      process.env.ECOM_UPDATE_TARGET = target;
      mock.state.slow = true;
      await js(`document.getElementById('btnUpdateNow').click();`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('#updateModal [data-close]').click();`);
      const stillOpen = await js(`return !document.getElementById('updateModal').hidden`);
      await until(`/설치 준비 완료/.test(document.getElementById('updateTitle').textContent)`, 20000);
      mock.state.slow = false;
      const pct = await js(`return document.getElementById('updatePct').textContent`);
      ok(stillOpen, '진행 중에 창이 닫힘');
      ok(pct === '100%', '진행률 ' + pct);
      await shot('update-done');
      await js(`delete document.getElementById('updateModal').dataset.busy; document.getElementById('updateModal').hidden = true;`);
      return `진행률 ${pct}`;
    });
    await step('업데이트: 설정에서 자동 확인 끄기', async () => {
      await js(`${H} $('#btnSettings').click();`);
      await until(`!document.getElementById('settingsModal').hidden`);
      await js(`const c = document.getElementById('autoUpdate'); c.checked = false; c.dispatchEvent(new Event('change')); document.getElementById('settingsModal').hidden = true;`);
      await sleep(200);
      ok(readSettingsFile().update.auto === false, 'auto 저장 안 됨');
      const r = await js(`return await api.checkUpdate({ auto: true })`);
      ok(r.off && !r.available, JSON.stringify(r));
      return '자동 확인 꺼짐';
    });

    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    mock.server.close();
    app.quit();
  });
};
