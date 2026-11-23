// 1) 손계산 검증  2) 엑셀 수식 == JS 계산 (HyperFormula로 수식 평가)  3) 실제 xlsx 생성/추가 기록
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { HyperFormula } = require('hyperformula');
const Calc = require('../src/calc');
const Excel = require('../src/excel');

const near = (a, b, msg) => {
  if ((a === null || a === '') && (b === null || b === '')) return;
  assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${msg}: ${a} != ${b}`);
};
const R = (id, v) => Object.fromEntries(Calc.run(id, v).map((o) => [o.key, o.value]));

// ── 1. 손계산
{
  // 면세, 쿠폰 없음: 판매가 10000, 원가 5000, 수수료 10%, 배송 2000 → 이익 = 10000-5000-1000-2000 = 2000
  const r = R('profit', { taxType: '면세', price: '10000', cost: '5000', feeRate: '10', shipping: '2000' });
  near(r.profit, 2000, 'profit taxfree'); near(r.margin, 0.2, 'margin');
  // 손익분기: P - 0.1P - 7000 = 0 → P = 7777.78
  near(r.bepPrice, 7000 / 0.9, 'bep');
  // 목표 20%: 0.9P - 7000 = 0.2P → P = 10000
  near(r.targetPrice, 10000, 'target');
}
{
  // 과세 + 매입공제: 11000원, 원가 5500, 나머지 0 → 매출VAT 1000, 매입VAT 500 → 이익 = 11000-5500-500 = 5000
  const r = R('profit', { price: '11000', cost: '5500' });
  near(r.vat, 500, 'vat'); near(r.profit, 5000, 'profit taxed');
  // 쿠폰 10%, 셀러 50% 분담 → 셀러부담 550
  const r2 = R('profit', { price: '11000', cost: '5500', couponRate: '10', couponShare: '50' });
  near(r2.sellerCoupon, 550, 'seller coupon'); near(r2.netSales, 10450, 'net');
}
{
  // 면세. 판매가 10000, 원가 5000, 정액 광고비 100,000 / 예상 50개 → 개당 광고비 2000, 이익 3000
  const r = R('profit', { taxType: '면세', price: '10000', cost: '5000', adFixed: '100000', salesQty: '50' });
  near(r.adCost, 2000, 'ad unit'); near(r.profit, 3000, 'profit with ad'); near(r.totalProfit, 150000, 'total profit');
  // 광고비 빼기 전 개당 5000 → 손익분기 100,000/5000 = 20개
  near(r.bepQty, 20, 'bep qty');
  // 판매수량 미입력: 개당 이익에 정액 광고비 미반영, 손익분기 수량은 표시
  const r2 = R('profit', { taxType: '면세', price: '10000', cost: '5000', adFixed: '100000' });
  near(r2.profit, 5000, 'profit no qty'); near(r2.bepQty, 20, 'bep qty no qty'); assert.strictEqual(r2.totalProfit, null);
  // 광고비 10% (실판매가 기준) → 1000
  const r3 = R('profit', { taxType: '면세', price: '10000', cost: '5000', adRate: '10' });
  near(r3.adCost, 1000, 'ad rate'); near(r3.profit, 4000, 'profit ad rate');
  // 손익분기 ROAS: 광고비 빼기 전 이익 5000 → 매출 10000 / 5000 = 200%
  near(r3.bepRoas, 2, 'bep roas');
  // 손익분기 판매가: 0.9P - 5000 = 0 (광고비 10%)
  near(r3.bepPrice, 5000 / 0.9, 'bep price with ad rate');
  // 정액 쿠폰 3000원, 셀러 100% 부담 → 정산매출 7000, 이익 2000
  const r4 = R('profit', { taxType: '면세', price: '10000', cost: '5000', couponFixed: '3000' });
  near(r4.couponAmt, 3000, 'coupon fixed'); near(r4.netSales, 7000, 'net with fixed coupon'); near(r4.profit, 2000, 'profit fixed coupon');
  near(r4.bepPrice, 8000, 'bep with fixed coupon');
  // 목표 20%: P-3000-5000 = 0.2(P-3000) → P = 9250
  near(R('profit', { taxType: '면세', price: '10000', cost: '5000', couponFixed: '3000', targetMargin: '20' }).targetPrice, 9250, 'target with fixed coupon');
  // 과세: 원가 5500, 정액 광고비 110,000 / 0개 → 기여이익 5000, 광고 실부담 100,000 → 20개
  near(R('profit', { price: '11000', cost: '5500', adFixed: '110000' }).bepQty, 20, 'bep qty taxed');
}
near(R('growth', { prev: '100', curr: '125' }).rate, 0.25, 'growth');
near(R('vat', { amount: '11000' }).supply, 10000, 'vat supply');
near(R('vat', { mode: '공급가액(VAT별도)', amount: '10000' }).total, 11000, 'vat total');
near(R('discountPrice', { price: '29900', rate: '15', unit: '10' }).sale, 25410, 'discount price');
near(R('discountRate', { price: '20000', sale: '15000' }).rate, 0.25, 'discount rate');
near(R('marginRate', { price: '10000', cost: '6000' }).markup, 4000 / 6000, 'markup');
near(R('sellPrice', { cost: '7000', margin: '30', unit: '100' }).price, 10000, 'sell price');
near(R('marginAmount', { price: '100', cost: '60', qty: '5' }).total, 200, 'margin amount');
// 목표 달성: 금액은 100만원 단위 입력 → 원 단위 결과
near(R('target', { goal: '1000', actual: '400', daysPassed: '10', daysTotal: '30' }).dailyNeed, 30e6, 'daily need');
{
  // 기간 11/1~11/30, 기준일 11/12 → 경과 12일 / 전체 30일
  const r = R('target', { startDate: '2026-11-01', endDate: '2026-11-30', asOfDate: '2026-11-12', goal: '300', actual: '120', daysPassed: '99', daysTotal: '99' });
  near(r.elapsedDays, 12, 'elapsed from dates'); near(r.periodDays, 30, 'period from dates');
  near(r.forecast, 300e6, 'forecast'); near(r.dailyNeed, 180e6 / 18, 'daily need dates');
  // 기준일이 기간 밖이면 0~전체 일수로 맞춤, 종료일이 시작일보다 앞이면 직접 입력값 사용
  near(R('target', { startDate: '2026-11-01', endDate: '2026-11-30', asOfDate: '2026-12-25', goal: '1' }).elapsedDays, 30, 'elapsed clamp');
  near(R('target', { startDate: '2026-11-30', endDate: '2026-11-01', daysPassed: '5', daysTotal: '10', goal: '1' }).periodDays, 10, 'bad dates fallback');
  // 채널별 입력 → 목표·실적은 채널 합계
  const ch = { goal: '999', actual: '999', startDate: '2026-11-01', endDate: '2026-11-30', asOfDate: '2026-11-15',
    channels: [{ name: '스마트스토어', goal: '200', actual: '100' }, { name: '쿠팡', goal: '100', actual: '20' }, { name: '빈 행', goal: '', actual: '' }] };
  const t = R('target', ch);
  near(t.rate, 0.4, 'channel total rate'); near(t.remain, 180e6, 'channel remain');
  const rows = Calc.channelRows(ch);
  assert.strictEqual(rows.length, 2, 'empty channel rows skipped');
  near(rows[0].rate, 0.5, 'ch1 rate'); near(rows[1].forecast, 40e6, 'ch2 forecast'); near(rows[0].share, 2 / 3, 'ch1 share');
  // 한글 단위
  assert.strictEqual(Calc.korWon(1e7), '1천만원'); assert.strictEqual(Calc.korWon(1e8), '1억원');
  assert.strictEqual(Calc.korWon(2e9), '20억원'); assert.strictEqual(Calc.korWon(123456789), '1억 2,346만원');
  assert.strictEqual(Calc.korWon(-35e6), '-3,500만원'); assert.strictEqual(Calc.korWon(5000), '5,000원');
  // AI 요약: 상품명 별칭, 금액 숨기기
  const sm = Calc.summaryText('profit', { name: '비밀 셔츠', price: '29900', cost: '9000', feeRate: '5.5' }, { alias: '상품A', hideMoney: true });
  assert.ok(!sm.includes('비밀 셔츠') && sm.includes('상품A'), 'alias');
  assert.ok(!/29,900|9,000/.test(sm) && sm.includes('5.5%'), 'money hidden: ' + sm);
  const st = Calc.summaryText('target', ch, { hideMoney: true });
  assert.ok(!/억|만원|,000원/.test(st) && st.includes('스마트스토어'), 'target money hidden: ' + st);
  assert.ok(Calc.summaryText('target', ch).includes('3억원'), 'target summary shows kor units');
}
near(R('supplyPrice', { consumer: '11000', distMargin: '30' }).supplyEx, 7000, 'supply ex');

// ── 2. 엑셀 수식 vs JS (무작위 입력 다수)
function rand(f) {
  if (f.type === 'select') return f.options[Math.floor(Math.random() * f.options.length)];
  if (f.type === 'text') return '상품';
  if (f.type === 'channels') return [];
  if (f.type === 'date') return Math.random() < 0.3 ? '' : `2026-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
  if (f.type === 'bigmoney') return String(Math.round(Math.random() * 5000) / 10);
  if (Math.random() < 0.15) return '';
  if (f.type === 'percent') return String(Math.round(Math.random() * 400) / 10);
  if (f.type === 'money') return String(Math.round(Math.random() * 50000));
  return String(Math.round(Math.random() * 60));
}
let checked = 0;
for (const id of Object.keys(Calc.CALCS)) {
  const cols = Excel.layout(id);
  for (let trial = 0; trial < 60; trial++) {
    const values = {};
    Calc.CALCS[id].fields.forEach((f) => { values[f.key] = rand(f); });
    if (values.asOfDate === '') values.asOfDate = '2026-06-15'; // 엑셀 TODAY()와 비교하지 않도록
    const v = Object.assign(Calc.defaults(id), values);
    const addr = Object.fromEntries(cols.map((c) => [c.key, `${c.letter}2`]));
    const row = cols.map((c) => {
      if (c.kind === 'meta') return null;
      if (c.kind === 'input') {
        const raw = v[c.key]; const f = c.field;
        if (raw === '') return null;
        if (f.type === 'percent') return Number(raw) / 100;
        if (f.type === 'bigmoney') return Number(raw) * Calc.MILLION;
        if (f.type === 'date') return Calc.dayNum(raw) + 25569;
        if (f.type === 'money' || f.type === 'number') return Number(raw);
        if (f.type === 'select' && f.options.every((o) => !isNaN(Number(o)))) return Number(raw);
        return raw;
      }
      return '=' + c.output.excel((k) => addr[k]);
    });
    const hf = HyperFormula.buildFromArray([cols.map((c) => c.label), row], { licenseKey: 'gpl-v3' });
    const js = R(id, v);
    cols.filter((c) => c.kind === 'output').forEach((c) => {
      let xv = hf.getCellValue({ sheet: 0, row: 1, col: c.index - 1 });
      if (xv && typeof xv === 'object') throw new Error(`${id}.${c.key} excel error ${xv.value} | ${row[c.index - 1]}`);
      const jv = js[c.key];
      if (jv === null || jv === undefined) { assert.ok(xv === '' || xv === null, `${id}.${c.key} expected blank got ${xv} | ${JSON.stringify(v)}`); return; }
      near(xv, jv, `${id}.${c.key} ${JSON.stringify(v)}`);
      checked++;
    });
    hf.destroy();
  }
}
console.log(`✓ 엑셀 수식 == 앱 계산: ${checked}개 값 일치`);

// ── 3. 실제 xlsx 파일 생성 + 추가 기록
(async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), '장부.xlsx');
  await Excel.appendRecords(file, [{ calc: 'profit', values: { name: 'A', price: '29900', cost: '9000', feeRate: '5.5', shipping: '3000' }, memo: '첫 기록' }]);
  const res = await Excel.appendRecords(file, [
    { calc: 'profit', values: { name: 'B', price: '19900', cost: '12000', feeRate: '10.8', shipping: '3000', otherCost: '2000' } },
    { calc: 'vat', values: { amount: '55000' } },
    { calc: 'target', values: { startDate: '2026-11-01', endDate: '2026-11-30', asOfDate: '2026-11-15', channels: [{ name: '쿠팡', goal: '100', actual: '40' }, { name: '자사몰', goal: '50', actual: '10' }] } },
  ]);
  assert.deepStrictEqual(res.map((r) => r.row), [3, 2, 2]);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  assert.strictEqual(wb.worksheets[0].name, '요약');
  {
    const tw = wb.getWorksheet('목표 달성'); const tc = Excel.layout('target');
    const at = (k) => tw.getCell(`${tc.find((c) => c.key === k).letter}2`).value;
    assert.strictEqual(at('goal'), 150e6, '목표는 원 단위 채널 합계로 기록');
    assert.ok(at('startDate') instanceof Date, '날짜 칸');
    const cw = wb.getWorksheet(Excel.CH_SHEET);
    assert.ok(cw && cw.getCell('G3').value === '자사몰' && cw.getCell('H3').value === 50e6, '채널별 시트');
    assert.ok(cw.getCell('J2').value.formula, '채널 달성률 수식');
  }
  const ws = wb.getWorksheet('영업이익률');
  const cols = Excel.layout('profit');
  const pc = cols.find((c) => c.key === 'profit').letter;
  const cell = ws.getCell(`${pc}3`).value;
  assert.ok(cell.formula && /N\d|\d/.test(cell.formula), 'formula stored');
  // 예전 양식 시트가 있으면 이름을 바꿔 보관하고 새 양식으로 기록
  ws.getRow(1).getCell(cols.length + 1).value = '예전 열';
  await wb.xlsx.writeFile(file);
  const res2 = await Excel.appendRecords(file, [{ calc: 'profit', values: { name: 'C', price: '10000', cost: '5000' } }]);
  assert.strictEqual(res2[0].row, 2);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.readFile(file);
  assert.ok(wb2.getWorksheet('영업이익률_이전양식'), '예전 시트 보관');
  console.log(`✓ xlsx 생성/추가 OK → ${file}`);
  console.log(`  예) ${pc}3 = ${cell.formula}  (값 ${Math.round(cell.result)})`);
})().catch((e) => { console.error(e); process.exit(1); });
