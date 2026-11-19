/* 이커머스 AI 계산기 — 계산 엔진
 * 앱 화면(JS 계산)과 엑셀 장부(수식)가 같은 정의를 공유한다.
 * - 퍼센트 입력값은 화면에서 "5.5"(=5.5%) 형태, 엑셀에는 0.055 + % 서식으로 기록한다.
 * - outputs[].excel(c)는 같은 행의 셀 주소를 돌려주는 c(key)를 받아 엑셀 수식(= 제외)을 만든다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const n = (x) => (x === '' || x === null || x === undefined || isNaN(Number(x)) ? 0 : Number(x));
  const pct = (x) => n(x) / 100;
  const div = (a, b) => (b === 0 || !isFinite(b) ? null : a / b);
  const roundTo = (x, unit, mode) => {
    if (x === null || !isFinite(x)) return null;
    const u = n(unit) || 1;
    if (mode === 'up') return Math.ceil(x / u - 1e-9) * u;
    if (mode === 'down') return Math.floor(x / u + 1e-9) * u;
    return Math.round(x / u) * u;
  };
  // 엑셀: 분모 0이면 빈칸
  const xdiv = (a, b) => `IF(${b}=0,"",${a}/${b})`;

  const TAX = ['과세', '면세'];
  const YN = ['Y', 'N'];
  const UNITS = ['1', '10', '100', '1000'];

  const CALCS = {
    profit: {
      name: '영업이익률',
      icon: '📊',
      group: '수익성',
      desc: '실판매가·수수료·쿠폰·배송비·부가세까지 반영한 상품 1개당 영업이익',
      fields: [
        { key: 'name', label: '상품명', type: 'text', placeholder: '예) 여름 린넨 셔츠' },
        { key: 'taxType', label: '과/면세', type: 'select', options: TAX, default: '과세' },
        { key: 'price', label: '판매가', type: 'money', placeholder: '29,900' },
        { key: 'salePrice', label: '할인가', type: 'money', hint: '할인 판매 시 입력. 비우면 판매가로 계산' },
        { key: 'cost', label: '상품원가', type: 'money', hint: '매입가(VAT 포함)' },
        { key: 'feeRate', label: '판매수수료', type: 'percent', placeholder: '5.5' },
        { key: 'etcFeeRate', label: '기타수수료', type: 'percent', hint: '결제·카드·연동 수수료 등' },
        { key: 'shipping', label: '배송비(셀러부담)', type: 'money', hint: '택배비+포장재' },
        { key: 'couponRate', label: '쿠폰 할인율', type: 'percent' },
        { key: 'couponShare', label: '자체 쿠폰 분담율', type: 'percent', hint: '쿠폰 중 셀러 부담 비율. 100이면 전액 셀러 부담', default: 100 },
        { key: 'gift', label: '사은품 비용', type: 'money' },
        { key: 'otherCost', label: '기타비용(광고비 등)', type: 'money', hint: '개당 광고비·인건비 등' },
        { key: 'targetMargin', label: '목표 영업이익률', type: 'percent', default: 20, hint: '추천 판매가 계산용' },
        { key: 'vatDeduct', label: '비용 매입세액 공제', type: 'select', options: YN, default: 'Y', advanced: true, hint: '과세 사업자가 비용의 부가세를 공제받는지' },
      ],
      compute(v) {
        const price = n(v.price);
        const P = n(v.salePrice) > 0 ? n(v.salePrice) : price;
        const cr = pct(v.couponRate), sh = pct(v.couponShare);
        const fr = pct(v.feeRate), er = pct(v.etcFeeRate);
        const t = v.taxType === '면세' ? 0 : 1;
        const k = t * (v.vatDeduct === 'N' ? 0 : 1);
        const couponAmt = P * cr;
        const sellerCoupon = couponAmt * sh;
        const netSales = P - sellerCoupon;
        const fee = netSales * fr;
        const etcFee = netSales * er;
        const F = n(v.cost) + n(v.shipping) + n(v.gift) + n(v.otherCost);
        const totalCost = F + fee + etcFee;
        const vat = t * netSales / 11 - k * totalCost / 11;
        const profit = netSales - totalCost - vat;
        const s = 1 - cr * sh;
        const a = s * (1 - (fr + er) * (1 - k / 11) - t / 11);
        const b = F * (1 - k / 11);
        const tm = pct(v.targetMargin);
        const profitBeforeAd = profit + n(v.otherCost) * (1 - k / 11);
        return {
          realPrice: P,
          discountRate: price > 0 && n(v.salePrice) > 0 ? (price - P) / price : 0,
          couponAmt,
          sellerCoupon,
          netSales,
          fee,
          etcFee,
          vat,
          totalCost: totalCost + vat,
          profit,
          margin: div(profit, netSales),
          costRatio: div(n(v.cost), netSales),
          bepPrice: a > 0 ? b / a : null,
          targetPrice: a - tm * s > 0 ? roundTo(b / (a - tm * s), 10, 'up') : null,
          bepRoas: n(v.otherCost) > 0 && profitBeforeAd > 0 ? netSales / profitBeforeAd : null,
        };
      },
      outputs: [
        { key: 'profit', label: '영업이익', type: 'money', primary: true, tone: 'sign',
          excel: (c) => `${c('netSales')}-${c('totalCost')}` },
        { key: 'margin', label: '영업이익률', type: 'percent', primary: true, tone: 'margin',
          excel: (c) => xdiv(c('profit'), c('netSales')) },
        { key: 'realPrice', label: '실판매가', type: 'money',
          excel: (c) => `IF(N(${c('salePrice')})>0,${c('salePrice')},${c('price')})` },
        { key: 'discountRate', label: '할인율(판매가 대비)', type: 'percent',
          excel: (c) => `IF(AND(N(${c('salePrice')})>0,${c('price')}>0),(${c('price')}-${c('realPrice')})/${c('price')},0)` },
        { key: 'couponAmt', label: '쿠폰 할인액(전체)', type: 'money',
          excel: (c) => `${c('realPrice')}*N(${c('couponRate')})` },
        { key: 'sellerCoupon', label: '셀러부담 쿠폰', type: 'money',
          excel: (c) => `${c('couponAmt')}*N(${c('couponShare')})` },
        { key: 'netSales', label: '정산기준 매출', type: 'money',
          excel: (c) => `${c('realPrice')}-${c('sellerCoupon')}` },
        { key: 'fee', label: '판매수수료', type: 'money',
          excel: (c) => `${c('netSales')}*N(${c('feeRate')})` },
        { key: 'etcFee', label: '기타수수료', type: 'money',
          excel: (c) => `${c('netSales')}*N(${c('etcFeeRate')})` },
        { key: 'vat', label: '부가세 납부(예상)', type: 'money',
          excel: (c) => `IF(${c('taxType')}="면세",0,${c('netSales')}/11-IF(${c('vatDeduct')}="N",0,(N(${c('cost')})+N(${c('shipping')})+N(${c('gift')})+N(${c('otherCost')})+${c('fee')}+${c('etcFee')})/11))` },
        { key: 'totalCost', label: '총비용(부가세 포함)', type: 'money',
          excel: (c) => `N(${c('cost')})+N(${c('shipping')})+N(${c('gift')})+N(${c('otherCost')})+${c('fee')}+${c('etcFee')}+${c('vat')}` },
        { key: 'costRatio', label: '원가율', type: 'percent',
          excel: (c) => xdiv(`N(${c('cost')})`, c('netSales')) },
        { key: 'bepPrice', label: '손익분기 판매가', type: 'money', hint: '이익 0원이 되는 실판매가',
          excel: (c) => profitCoef(c, 'bep') },
        { key: 'targetPrice', label: '목표이익률 추천 판매가', type: 'money', hint: '목표 영업이익률을 맞추는 실판매가(10원 올림)',
          excel: (c) => profitCoef(c, 'target') },
        { key: 'bepRoas', label: '손익분기 ROAS', type: 'percent', hint: '광고비(기타비용) 기준 최소 ROAS',
          excel: (c) => `IF(N(${c('otherCost')})<=0,"",IF((${c('profit')}+N(${c('otherCost')})*(1-${kx(c)}/11))<=0,"",${c('netSales')}/(${c('profit')}+N(${c('otherCost')})*(1-${kx(c)}/11))))` },
      ],
    },

    growth: {
      name: '신장률', icon: '📈', group: '매출 분석',
      desc: '전기 대비 매출·주문 증감률',
      fields: [
        { key: 'prev', label: '이전 값', type: 'number', placeholder: '예) 지난달 매출' },
        { key: 'curr', label: '현재 값', type: 'number', placeholder: '예) 이번달 매출' },
      ],
      compute: (v) => ({ diff: n(v.curr) - n(v.prev), rate: div(n(v.curr) - n(v.prev), n(v.prev)) }),
      outputs: [
        { key: 'rate', label: '신장률', type: 'percent', primary: true, tone: 'sign', excel: (c) => xdiv(`(${c('curr')}-${c('prev')})`, c('prev')) },
        { key: 'diff', label: '증감', type: 'number', primary: true, tone: 'sign', excel: (c) => `${c('curr')}-${c('prev')}` },
      ],
    },

    target: {
      name: '목표 달성', icon: '🎯', group: '매출 분석',
      desc: '목표 대비 달성률과 남은 기간 일평균 필요 매출',
      fields: [
        { key: 'goal', label: '목표 매출', type: 'money' },
        { key: 'actual', label: '현재 실적', type: 'money' },
        { key: 'daysPassed', label: '경과 일수', type: 'number', hint: '선택: 마감 예상치 계산' },
        { key: 'daysTotal', label: '전체 일수', type: 'number', placeholder: '30' },
      ],
      compute(v) {
        const goal = n(v.goal), act = n(v.actual), dp = n(v.daysPassed), dt = n(v.daysTotal);
        const forecast = dp > 0 && dt > 0 ? act / dp * dt : null;
        return {
          rate: div(act, goal),
          remain: goal - act,
          forecast,
          forecastRate: forecast === null ? null : div(forecast, goal),
          dailyNeed: dt > dp && dt > 0 ? Math.max(0, goal - act) / (dt - dp) : null,
        };
      },
      outputs: [
        { key: 'rate', label: '달성률', type: 'percent', primary: true, tone: 'goal', excel: (c) => xdiv(c('actual'), c('goal')) },
        { key: 'remain', label: '남은 금액', type: 'money', primary: true, excel: (c) => `${c('goal')}-${c('actual')}` },
        { key: 'forecast', label: '마감 예상 실적', type: 'money', excel: (c) => `IF(AND(N(${c('daysPassed')})>0,N(${c('daysTotal')})>0),${c('actual')}/${c('daysPassed')}*${c('daysTotal')},"")` },
        { key: 'forecastRate', label: '마감 예상 달성률', type: 'percent', excel: (c) => `IF(OR(${c('forecast')}="",N(${c('goal')})=0),"",${c('forecast')}/${c('goal')})` },
        { key: 'dailyNeed', label: '남은 기간 일평균 필요', type: 'money', excel: (c) => `IF(N(${c('daysTotal')})>N(${c('daysPassed')}),MAX(0,${c('goal')}-${c('actual')})/(${c('daysTotal')}-N(${c('daysPassed')})),"")` },
      ],
    },

    vat: {
      name: '부가세', icon: '🧾', group: '가격·세금',
      desc: '합계금액 ↔ 공급가액·부가세(10%) 변환',
      fields: [
        { key: 'mode', label: '입력 기준', type: 'select', options: ['합계금액(VAT포함)', '공급가액(VAT별도)'], default: '합계금액(VAT포함)' },
        { key: 'amount', label: '금액', type: 'money' },
      ],
      compute(v) {
        const a = n(v.amount);
        if (v.mode === '공급가액(VAT별도)') { const vat = Math.round(a * 0.1); return { supply: a, vat, total: a + vat }; }
        const supply = Math.round(a / 1.1); return { supply, vat: a - supply, total: a };
      },
      outputs: [
        { key: 'supply', label: '공급가액', type: 'money', primary: true, excel: (c) => `IF(${c('mode')}="공급가액(VAT별도)",${c('amount')},ROUND(${c('amount')}/1.1,0))` },
        { key: 'vat', label: '부가세', type: 'money', primary: true, excel: (c) => `IF(${c('mode')}="공급가액(VAT별도)",ROUND(${c('amount')}*0.1,0),${c('amount')}-${c('supply')})` },
        { key: 'total', label: '합계금액', type: 'money', excel: (c) => `${c('supply')}+${c('vat')}` },
      ],
    },

    discountPrice: {
      name: '할인가', icon: '🏷️', group: '가격·세금',
      desc: '정가와 할인율로 할인 판매가 계산',
      fields: [
        { key: 'price', label: '정가', type: 'money' },
        { key: 'rate', label: '할인율', type: 'percent' },
        { key: 'unit', label: '끝자리 내림', type: 'select', options: UNITS, default: '10', hint: '1=그대로, 10=10원 단위 내림' },
      ],
      compute(v) {
        const sale = roundTo(n(v.price) * (1 - pct(v.rate)), v.unit, 'down');
        return { sale, off: n(v.price) - sale };
      },
      outputs: [
        { key: 'sale', label: '할인가', type: 'money', primary: true, excel: (c) => `FLOOR(${c('price')}*(1-N(${c('rate')}))+0.000001,${c('unit')})` },
        { key: 'off', label: '할인액', type: 'money', excel: (c) => `${c('price')}-${c('sale')}` },
      ],
    },

    discountRate: {
      name: '할인율', icon: '💸', group: '가격·세금',
      desc: '정가와 할인가로 할인율 역산',
      fields: [
        { key: 'price', label: '정가', type: 'money' },
        { key: 'sale', label: '할인가', type: 'money' },
      ],
      compute: (v) => ({ rate: div(n(v.price) - n(v.sale), n(v.price)), off: n(v.price) - n(v.sale) }),
      outputs: [
        { key: 'rate', label: '할인율', type: 'percent', primary: true, excel: (c) => xdiv(`(${c('price')}-${c('sale')})`, c('price')) },
        { key: 'off', label: '할인액', type: 'money', excel: (c) => `${c('price')}-${c('sale')}` },
      ],
    },

    marginRate: {
      name: '마진율', icon: '💹', group: '수익성',
      desc: '판매가와 원가로 마진율·마크업 계산',
      fields: [
        { key: 'price', label: '판매가', type: 'money' },
        { key: 'cost', label: '원가', type: 'money' },
      ],
      compute: (v) => ({
        margin: n(v.price) - n(v.cost),
        rate: div(n(v.price) - n(v.cost), n(v.price)),
        markup: div(n(v.price) - n(v.cost), n(v.cost)),
      }),
      outputs: [
        { key: 'rate', label: '마진율', type: 'percent', primary: true, tone: 'margin', excel: (c) => xdiv(`(${c('price')}-${c('cost')})`, c('price')) },
        { key: 'margin', label: '마진액', type: 'money', primary: true, tone: 'sign', excel: (c) => `${c('price')}-${c('cost')}` },
        { key: 'markup', label: '마크업률(원가 대비)', type: 'percent', excel: (c) => xdiv(`(${c('price')}-${c('cost')})`, c('cost')) },
      ],
    },

    sellPrice: {
      name: '판매가', icon: '🧮', group: '수익성',
      desc: '원가·목표 마진율·수수료로 적정 판매가 역산',
      fields: [
        { key: 'cost', label: '원가', type: 'money' },
        { key: 'margin', label: '목표 마진율', type: 'percent', placeholder: '30' },
        { key: 'feeRate', label: '판매수수료', type: 'percent', hint: '선택: 수수료까지 감안' },
        { key: 'unit', label: '끝자리 올림', type: 'select', options: UNITS, default: '100' },
      ],
      compute(v) {
        const d = 1 - pct(v.margin) - pct(v.feeRate);
        const price = d > 0 ? roundTo(n(v.cost) / d, v.unit, 'up') : null;
        return price === null ? { price: null, profit: null, fee: null }
          : { price, fee: price * pct(v.feeRate), profit: price - n(v.cost) - price * pct(v.feeRate) };
      },
      outputs: [
        { key: 'price', label: '권장 판매가', type: 'money', primary: true, excel: (c) => `IF(1-N(${c('margin')})-N(${c('feeRate')})<=0,"",CEILING(${c('cost')}/(1-N(${c('margin')})-N(${c('feeRate')}))-0.000001,${c('unit')}))` },
        { key: 'fee', label: '예상 수수료', type: 'money', excel: (c) => `IF(${c('price')}="","",${c('price')}*N(${c('feeRate')}))` },
        { key: 'profit', label: '개당 마진', type: 'money', tone: 'sign', excel: (c) => `IF(${c('price')}="","",${c('price')}-${c('cost')}-${c('fee')})` },
      ],
    },

    marginAmount: {
      name: '마진액', icon: '💰', group: '수익성',
      desc: '수량까지 반영한 총 마진',
      fields: [
        { key: 'price', label: '판매가', type: 'money' },
        { key: 'cost', label: '원가', type: 'money' },
        { key: 'qty', label: '수량', type: 'number', default: 1 },
      ],
      compute: (v) => ({
        unit: n(v.price) - n(v.cost),
        total: (n(v.price) - n(v.cost)) * n(v.qty),
        sales: n(v.price) * n(v.qty),
        rate: div(n(v.price) - n(v.cost), n(v.price)),
      }),
      outputs: [
        { key: 'total', label: '총 마진액', type: 'money', primary: true, tone: 'sign', excel: (c) => `(${c('price')}-${c('cost')})*${c('qty')}` },
        { key: 'unit', label: '개당 마진', type: 'money', excel: (c) => `${c('price')}-${c('cost')}` },
        { key: 'sales', label: '총 매출', type: 'money', excel: (c) => `${c('price')}*${c('qty')}` },
        { key: 'rate', label: '마진율', type: 'percent', tone: 'margin', excel: (c) => xdiv(`(${c('price')}-${c('cost')})`, c('price')) },
      ],
    },

    supplyPrice: {
      name: '공급가', icon: '📦', group: '가격·세금',
      desc: '소비자가와 유통 마진율로 공급(납품)가 계산',
      fields: [
        { key: 'consumer', label: '소비자가', type: 'money' },
        { key: 'distMargin', label: '유통 마진율', type: 'percent', hint: '판매처(벤더)가 가져가는 비율' },
        { key: 'taxType', label: '과/면세', type: 'select', options: TAX, default: '과세' },
      ],
      compute(v) {
        const supply = n(v.consumer) * (1 - pct(v.distMargin));
        const ex = v.taxType === '면세' ? supply : supply / 1.1;
        return { supply, supplyEx: ex, vat: supply - ex, channel: n(v.consumer) - supply };
      },
      outputs: [
        { key: 'supply', label: '공급가(VAT포함)', type: 'money', primary: true, excel: (c) => `${c('consumer')}*(1-N(${c('distMargin')}))` },
        { key: 'supplyEx', label: '공급가액(VAT별도)', type: 'money', primary: true, excel: (c) => `IF(${c('taxType')}="면세",${c('supply')},${c('supply')}/1.1)` },
        { key: 'vat', label: '부가세', type: 'money', excel: (c) => `${c('supply')}-${c('supplyEx')}` },
        { key: 'channel', label: '판매처 마진액', type: 'money', excel: (c) => `${c('consumer')}-${c('supply')}` },
      ],
    },
  };

  // 사이드바 그룹 순서대로 정렬 (⌘1~⌘0 단축키 순서와 일치)
  const ORDER = ['profit', 'marginRate', 'sellPrice', 'marginAmount', 'growth', 'target', 'vat', 'discountPrice', 'discountRate', 'supplyPrice'];
  for (const id of ORDER) { const c = CALCS[id]; delete CALCS[id]; CALCS[id] = c; }

  // 영업이익 선형식 계수 (엑셀 손익분기/추천가 공식). profit = a·P − b
  function kx(c) { return `IF(${c('taxType')}="면세",0,IF(${c('vatDeduct')}="N",0,1))`; }
  function profitCoef(c, which) {
    const t = `IF(${c('taxType')}="면세",0,1)`;
    const s = `(1-N(${c('couponRate')})*N(${c('couponShare')}))`;
    const a = `(${s}*(1-(N(${c('feeRate')})+N(${c('etcFeeRate')}))*(1-${kx(c)}/11)-${t}/11))`;
    const b = `((N(${c('cost')})+N(${c('shipping')})+N(${c('gift')})+N(${c('otherCost')}))*(1-${kx(c)}/11))`;
    if (which === 'bep') return `IF(${a}<=0,"",${b}/${a})`;
    const d = `(${a}-N(${c('targetMargin')})*${s})`;
    return `IF(${d}<=0,"",CEILING(${b}/${d}-0.000001,10))`;
  }

  function defaults(id) {
    const o = {};
    for (const f of CALCS[id].fields) o[f.key] = f.default !== undefined ? String(f.default) : '';
    return o;
  }

  function fmt(value, type) {
    if (value === null || value === undefined || value === '' || (typeof value === 'number' && !isFinite(value))) return '—';
    if (type === 'percent') return (value * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + '%';
    if (type === 'money') return Math.round(value).toLocaleString('ko-KR') + '원';
    if (type === 'number') return (Math.round(value * 100) / 100).toLocaleString('ko-KR');
    return String(value);
  }

  function fmtInput(value, type) {
    if (value === '' || value === undefined || value === null) return '';
    if (type === 'percent') return value + '%';
    if (type === 'money') return n(value).toLocaleString('ko-KR') + '원';
    if (type === 'number') return n(value).toLocaleString('ko-KR');
    return String(value);
  }

  function run(id, values) {
    const calc = CALCS[id];
    const v = Object.assign(defaults(id), values || {});
    const r = calc.compute(v);
    return calc.outputs.map((o) => Object.assign({}, o, { value: r[o.key], text: fmt(r[o.key], o.type) }));
  }

  function summaryText(id, values) {
    const calc = CALCS[id];
    const lines = [`[${calc.name} 계산기]`];
    for (const f of calc.fields) {
      if (values[f.key] !== '' && values[f.key] !== undefined) lines.push(`${f.label}: ${fmtInput(values[f.key], f.type)}`);
    }
    lines.push('— 결과 —');
    for (const o of run(id, values)) lines.push(`${o.label}: ${o.text}`);
    return lines.join('\n');
  }

  return { CALCS, defaults, run, fmt, fmtInput, summaryText, num: n };
});
