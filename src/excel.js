// 엑셀 장부: 계산기별 시트에 한 행씩 기록. 입력값은 값으로, 결과는 "엑셀 함수"로 기록해
// 엑셀에서 입력값을 고치면 결과가 자동으로 다시 계산된다.
const ExcelJS = require('exceljs');
const fs = require('fs');
const Calc = require('./calc');

const META_COLS = [
  { key: '_date', label: '기록일시', width: 18 },
  { key: '_memo', label: '메모', width: 22 },
];

const COLORS = {
  meta: 'FF5B6170',
  input: 'FF3B6FE0',
  output: 'FF14915F',
  primary: 'FF0E7A4F',
};

function colLetter(i) { // 1-based
  let s = '';
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function layout(id) {
  const calc = Calc.CALCS[id];
  const cols = [];
  META_COLS.forEach((m) => cols.push({ kind: 'meta', ...m }));
  calc.fields.filter((f) => f.type !== 'channels').forEach((f) => cols.push({ kind: 'input', key: f.key, label: f.label + unitSuffix(f.type), field: f }));
  calc.outputs.forEach((o) => cols.push({ kind: 'output', key: o.key, label: o.label + unitSuffix(o.type), output: o }));
  cols.forEach((c, i) => { c.index = i + 1; c.letter = colLetter(i + 1); });
  return cols;
}

// 큰 금액(백만원 단위 입력)도 엑셀에는 원 단위로 기록한다
function unitSuffix(type) {
  return type === 'money' || type === 'bigmoney' ? ' (원)' : type === 'percent' ? ' (%)' : '';
}

// 입력값 → 엑셀 셀 값
function inputCellValue(f, raw) {
  if (raw === '' || raw === undefined || raw === null) return null;
  if (f.type === 'percent') return Calc.num(raw) / 100;
  if (f.type === 'bigmoney') return Math.round(Calc.num(raw) * Calc.MILLION * 100) / 100;
  if (f.type === 'money' || f.type === 'number') return Calc.num(raw);
  if (f.type === 'date') { const d = Calc.dayNum(raw); return d === null ? null : new Date(d * 86400000); }
  if (f.type === 'select' && f.options.every((o) => !isNaN(Number(o)))) return Number(raw);
  return String(raw);
}

function numFmt(type) {
  if (type === 'date') return 'yyyy-mm-dd';
  if (type === 'money' || type === 'bigmoney') return '#,##0;[Red]-#,##0';
  if (type === 'percent') return '0.0%;[Red]-0.0%';
  if (type === 'number') return '#,##0.##';
  return undefined;
}

function sheetName(id) { return Calc.CALCS[id].name; }

function ensureSheet(wb, id) {
  const name = sheetName(id);
  let ws = wb.getWorksheet(name);
  const cols = layout(id);
  // 앱 업데이트로 입력·결과 항목이 바뀌었으면 기존 시트는 이름을 바꿔 보관하고 새 양식으로 시작
  if (ws) {
    const header = ws.getRow(1);
    const same = cols.length === header.cellCount && cols.every((c) => String(header.getCell(c.index).value || '') === c.label);
    if (!same) {
      let i = 1, old;
      do { old = `${name}_이전양식${i > 1 ? i : ''}`; i++; } while (wb.getWorksheet(old));
      ws.name = old;
      ws = null;
    }
  }
  if (!ws) {
    ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
    const header = ws.getRow(1);
    cols.forEach((c) => {
      const cell = header.getCell(c.index);
      cell.value = c.label;
      const color = c.kind === 'meta' ? COLORS.meta : c.kind === 'input' ? COLORS.input : (c.output.primary ? COLORS.primary : COLORS.output);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      ws.getColumn(c.index).width = c.width || Math.max(12, c.label.length * 2 + 2);
      if (c.kind === 'input' && c.field.hint) cell.note = c.field.hint;
      if (c.kind === 'output' && c.output.hint) cell.note = c.output.hint;
    });
    header.height = 32;
    ws.autoFilter = { from: 'A1', to: `${cols[cols.length - 1].letter}1` };
  }
  return { ws, cols };
}

function lastDataRow(ws) {
  let last = 1;
  ws.eachRow({ includeEmpty: false }, (row, r) => { if (r > last && row.getCell(1).value !== null) last = r; });
  return last;
}

function writeRecord(wb, rec) {
  const { ws, cols } = ensureSheet(wb, rec.calc);
  const r = lastDataRow(ws) + 1;
  const addr = {};
  cols.forEach((c) => { addr[c.key] = `${c.letter}${r}`; });
  const ref = (k) => {
    if (!addr[k]) throw new Error(`unknown column ${k}`);
    return addr[k];
  };
  const computed = {};
  Calc.run(rec.calc, rec.values).forEach((o) => { computed[o.key] = o.value; });
  const row = ws.getRow(r);
  const values = Calc.normalize(rec.calc, rec.values);

  cols.forEach((c) => {
    const cell = row.getCell(c.index);
    if (c.key === '_date') { cell.value = new Date(rec.date || Date.now()); cell.numFmt = 'yyyy-mm-dd hh:mm'; return; }
    if (c.key === '_memo') { cell.value = rec.memo || ''; return; }
    if (c.kind === 'input') {
      const f = c.field;
      cell.value = inputCellValue(f, values[f.key]);
      if (numFmt(f.type)) cell.numFmt = numFmt(f.type);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FD' } };
      return;
    }
    const o = c.output;
    const result = computed[o.key];
    cell.value = { formula: o.excel(ref), result: result === null || result === undefined || !isFinite(result) ? '' : result };
    if (numFmt(o.type)) cell.numFmt = numFmt(o.type);
    if (o.primary) cell.font = { bold: true };
  });
  row.commit();
  if (rec.calc === 'target') writeChannelRows(wb, rec, values, computed);
  return { sheet: ws.name, row: r };
}

// 목표 달성: 채널별 목표·실적을 별도 시트에 채널마다 한 줄씩 기록 (결과는 엑셀 함수)
const CH_SHEET = '목표 달성_채널별';
const CH_COLS = [
  ['기록일시', 18, 'yyyy-mm-dd hh:mm'], ['메모', 18], ['기간 시작일', 12, 'yyyy-mm-dd'], ['기간 종료일', 12, 'yyyy-mm-dd'],
  ['경과 일수', 10, '#,##0'], ['전체 일수', 10, '#,##0'], ['채널', 16],
  ['목표 매출 (원)', 16, '#,##0;[Red]-#,##0'], ['현재 실적 (원)', 16, '#,##0;[Red]-#,##0'],
  ['달성률 (%)', 11, '0.0%;[Red]-0.0%'], ['남은 금액 (원)', 16, '#,##0;[Red]-#,##0'],
  ['마감 예상 실적 (원)', 18, '#,##0;[Red]-#,##0'], ['마감 예상 달성률 (%)', 14, '0.0%;[Red]-0.0%'], ['남은 기간 일평균 필요 (원)', 18, '#,##0;[Red]-#,##0'],
];
function writeChannelRows(wb, rec, values, computed) {
  const rows = Calc.channelRows(values);
  if (!rows.length) return;
  let ws = wb.getWorksheet(CH_SHEET);
  if (!ws) {
    ws = wb.addWorksheet(CH_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
    const h = ws.getRow(1);
    CH_COLS.forEach(([label, width], i) => {
      const cell = h.getCell(i + 1); cell.value = label;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i < 2 ? COLORS.meta : i < 9 ? COLORS.input : COLORS.output } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      ws.getColumn(i + 1).width = width;
    });
    h.height = 32;
    ws.autoFilter = { from: 'A1', to: `${colLetter(CH_COLS.length)}1` };
  }
  const date = (k) => { const d = Calc.dayNum(values[k]); return d === null ? null : new Date(d * 86400000); };
  const num = (x) => (x === null || x === undefined || !isFinite(x) ? null : x);
  let r = lastDataRow(ws);
  for (const ch of rows) {
    r++;
    const row = ws.getRow(r);
    const E = `E${r}`, F = `F${r}`, H = `H${r}`, I = `I${r}`;
    const vals = [
      new Date(rec.date || Date.now()), rec.memo || '', date('startDate'), date('endDate'),
      num(computed.elapsedDays), num(computed.periodDays), ch.name, ch.goal, ch.actual,
      { formula: `IF(${H}=0,"",${I}/${H})`, result: num(ch.rate) === null ? '' : ch.rate },
      { formula: `${H}-${I}`, result: ch.remain },
      { formula: `IF(AND(N(${E})>0,N(${F})>0),${I}/${E}*${F},"")`, result: num(ch.forecast) === null ? '' : ch.forecast },
      { formula: `IF(OR(L${r}="",${H}=0),"",L${r}/${H})`, result: num(ch.forecastRate) === null ? '' : ch.forecastRate },
      { formula: `IF(AND(N(${F})>0,N(${F})>N(${E})),MAX(0,${H}-${I})/(${F}-N(${E})),"")`, result: num(ch.dailyNeed) === null ? '' : ch.dailyNeed },
    ];
    vals.forEach((val, i) => {
      const cell = row.getCell(i + 1); cell.value = val;
      if (CH_COLS[i][2]) cell.numFmt = CH_COLS[i][2];
      if (i >= 2 && i <= 8) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FD' } };
    });
    row.commit();
  }
}

// 요약 시트: 장부 전체를 함수로 집계
function writeSummary(wb) {
  let ws = wb.getWorksheet('요약');
  if (ws) wb.removeWorksheet(ws.id);
  ws = wb.addWorksheet('요약');
  ws.orderNo = -1; // 맨 앞 탭으로 (worksheets는 orderNo 순 정렬)

  ws.getColumn(1).width = 30; ws.getColumn(2).width = 20;
  ws.getCell('A1').value = '이커머스 계산 장부 요약';
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.getCell('A2').value = '모든 값은 각 시트를 참조하는 엑셀 함수입니다. 각 시트의 파란 칸(입력값)을 고치면 자동 재계산됩니다.';
  ws.getCell('A2').font = { color: { argb: 'FF666666' }, size: 10 };
  let r = 4;
  const put = (label, formula, fmt, bold) => {
    ws.getCell(`A${r}`).value = label;
    const cell = ws.getCell(`B${r}`);
    cell.value = { formula };
    if (fmt) cell.numFmt = fmt;
    if (bold) { ws.getCell(`A${r}`).font = { bold: true }; }
    r++;
  };
  for (const id of Object.keys(Calc.CALCS)) {
    const sw = wb.getWorksheet(sheetName(id));
    if (!sw) continue;
    const cols = layout(id);
    const q = `'${sheetName(id)}'`;
    put(`[${sheetName(id)}] 기록 수`, `COUNTA(${q}!A:A)-1`, '0', true);
    if (id === 'profit') {
      const col = (k) => cols.find((c) => c.key === k).letter;
      const rng = (k) => `${q}!${col(k)}2:${col(k)}10000`;
      put('  평균 영업이익률', `IFERROR(AVERAGE(${rng('margin')}),"")`, '0.0%');
      put('  최저 영업이익률', `IFERROR(MIN(${rng('margin')}),"")`, '0.0%;[Red]-0.0%');
      put('  최고 영업이익률', `IFERROR(MAX(${rng('margin')}),"")`, '0.0%');
      put('  적자 상품 수', `COUNTIF(${rng('profit')},"<0")`, '0');
      put('  개당 영업이익 합계', `SUM(${rng('profit')})`, '#,##0;[Red]-#,##0');
    }
    r++;
  }
}

async function loadOrCreate(file) {
  const wb = new ExcelJS.Workbook();
  if (file && fs.existsSync(file)) await wb.xlsx.readFile(file);
  else { wb.creator = '이커머스 AI 계산기'; wb.created = new Date(); }
  wb.calcProperties = Object.assign({}, wb.calcProperties, { fullCalcOnLoad: true });
  return wb;
}

async function appendRecords(file, records) {
  const wb = await loadOrCreate(file);
  const results = records.map((rec) => writeRecord(wb, rec));
  writeSummary(wb);
  await wb.xlsx.writeFile(file);
  return results;
}

module.exports = { appendRecords, layout, CH_SHEET };
