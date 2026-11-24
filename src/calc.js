/* 이커머스 AI 계산기 — 계산 엔진
 * 앱 화면(JS 계산)과 엑셀 장부(수식)가 같은 정의를 공유한다.
 * - 퍼센트 입력값은 화면에서 "5.5"(=5.5%) 형태, 엑셀에는 0.055 + % 서식으로 기록한다.
 * - outputs[].excel(c)는 같은 행의 셀 주소를 돌려주는 c(key)를 받아 엑셀 수식(= 제외)을 만든다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /* global Events */
  const Ev = typeof Events !== 'undefined' ? Events : require('./events');
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

  // 큰 금액(bigmoney) 칸은 백만원 단위로 입력받고, 계산·엑셀에는 원 단위로 쓴다
  const MILLION = 1e6;
  // 원 → "1억 2,000만원", "1천만원", "20억원" 같은 한글 단위 (만원 단위 반올림)
  function korWon(won) {
    if (won === null || won === undefined || !isFinite(won)) return '—';
    const sign = won < 0 ? '-' : '';
    const a = Math.abs(won);
    if (a < 1e4) return sign + Math.round(a).toLocaleString('ko-KR') + '원';
    let man = Math.round(a / 1e4);
    const jo = Math.floor(man / 1e8); man -= jo * 1e8;
    const eok = Math.floor(man / 1e4); man -= eok * 1e4;
    const parts = [];
    if (jo) parts.push(jo.toLocaleString('ko-KR') + '조');
    if (eok) parts.push(eok.toLocaleString('ko-KR') + '억');
    if (man) parts.push((man % 1000 === 0 ? man / 1000 + '천' : man.toLocaleString('ko-KR')) + '만');
    return sign + parts.join(' ') + '원';
  }

  // 'YYYY-MM-DD' → 1970-01-01 기준 일수(UTC). 엑셀 날짜 일련번호 = 일수 + 25569
  function dayNum(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (new Date(t).getUTCMonth() !== +m[2] - 1) return null; // 2월 30일 같은 날짜
    return t / 86400000;
  }
  function todayStr(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 채널별 입력: [{name, goal, actual}] (goal·actual은 백만원 단위 문자열). 값이 하나라도 있는 행만 사용
  function channelsOf(v) {
    const list = Array.isArray(v && v.channels) ? v.channels : [];
    return list.filter((c) => c && (String(c.goal || '').trim() !== '' || String(c.actual || '').trim() !== ''));
  }
  const sumStr = (x) => String(Math.round(x * 1e6) / 1e6);

  // 목표 달성: 기간(날짜) 또는 직접 입력한 일수로 경과·전체 일수를 정한다
  function targetDays(v) {
    const s = dayNum(v.startDate), e = dayNum(v.endDate);
    if (s !== null && e !== null && e >= s) {
      const total = e - s + 1;
      const a = dayNum(v.asOfDate);
      const asOf = a !== null ? a : dayNum(todayStr(v._now));
      return { elapsed: Math.max(0, Math.min(total, asOf - s + 1)), total, fromDates: true };
    }
    return { elapsed: n(v.daysPassed) > 0 ? n(v.daysPassed) : null, total: n(v.daysTotal) > 0 ? n(v.daysTotal) : null, fromDates: false };
  }
  function targetMetrics(goal, act, d) {
    const dp = d.elapsed || 0, dt = d.total || 0;
    const forecast = dp > 0 && dt > 0 ? act / dp * dt : null;
    return {
      rate: div(act, goal),
      remain: goal - act,
      forecast,
      forecastRate: forecast === null ? null : div(forecast, goal),
      dailyNeed: dt > dp && dt > 0 ? Math.max(0, goal - act) / (dt - dp) : null,
    };
  }

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
        { key: 'couponRate', label: '쿠폰 할인율', type: 'percent', hint: '실판매가에서 %로 깎아 주는 쿠폰' },
        { key: 'couponFixed', label: '쿠폰 할인액(정액)', type: 'money', hint: '주문 1건에 금액으로 깎아 주는 쿠폰. 예) 3,000원 할인 쿠폰. 할인율 쿠폰과 함께 쓰면 둘 다 적용' },
        { key: 'couponShare', label: '자체 쿠폰 분담율', type: 'percent', hint: '쿠폰 할인액 중 셀러가 부담하는 비율. 100이면 전액 셀러 부담, 플랫폼 쿠폰이면 0', default: 100 },
        { key: 'gift', label: '사은품 비용', type: 'money', hint: '상품 1개에 함께 보내는 사은품 원가' },
        { key: 'otherCost', label: '기타비용(개당)', type: 'money', hint: '포장재·인건비 등 상품 1개당 드는 비용. 광고비는 아래 광고비 칸에 따로 넣어 주세요' },
        { key: 'adRate', label: '광고비(매출 대비 %)', type: 'percent', hint: '실판매가 기준 광고비 비율. 예) 매출의 10%를 광고비로 쓰면 10' },
        { key: 'adFixed', label: '광고비(정액·기간 총액)', type: 'money', hint: '한 달 광고비처럼 기간 전체에 쓰는 금액. 예상 판매수량으로 나눠 개당 광고비로 계산하고, 손익분기 판매수량을 알려 드려요' },
        { key: 'salesQty', label: '예상 판매수량', type: 'number', unit: '개', hint: '정액 광고비를 쓰는 기간 동안 팔 것으로 예상하는 수량(개). 비우면 개당 광고비에 정액 광고비를 넣지 않아요' },
        { key: 'targetMargin', label: '목표 영업이익률', type: 'percent', default: 20, hint: '목표이익률 추천 판매가를 계산할 때 쓰는 값' },
        { key: 'vatDeduct', label: '비용 매입세액 공제', type: 'select', options: YN, default: 'Y', advanced: true, hint: '과세 사업자가 비용의 부가세를 공제받는지' },
      ],
      compute(v) {
        const price = n(v.price);
        const P = n(v.salePrice) > 0 ? n(v.salePrice) : price;
        const cr = pct(v.couponRate), cf = n(v.couponFixed), sh = pct(v.couponShare);
        const fr = pct(v.feeRate), er = pct(v.etcFeeRate), ar = pct(v.adRate);
        const t = v.taxType === '면세' ? 0 : 1;
        const k = t * (v.vatDeduct === 'N' ? 0 : 1);
        const q = 1 - k / 11; // 비용의 부가세 공제 후 실부담 비율
        const qty = n(v.salesQty);
        const adFixedUnit = qty > 0 ? n(v.adFixed) / qty : 0;
        const couponAmt = P * cr + cf;
        const sellerCoupon = couponAmt * sh;
        const netSales = P - sellerCoupon;
        const fee = netSales * fr;
        const etcFee = netSales * er;
        const adCost = P * ar + adFixedUnit;
        const F = n(v.cost) + n(v.shipping) + n(v.gift) + n(v.otherCost) + adFixedUnit;
        const totalCost = F + fee + etcFee + P * ar;
        const vat = t * netSales / 11 - k * totalCost / 11;
        const profit = netSales - totalCost - vat;
        // 이익 = a·P − b (P: 실판매가)
        const s = 1 - cr * sh;
        const m = 1 - t / 11 - (fr + er) * q;
        const a = m * s - q * ar;
        const b = m * sh * cf + q * F;
        const tm = pct(v.targetMargin);
        const profitBeforeAd = profit + adCost * q;
        const contribution = profit + adFixedUnit * q; // 정액 광고비를 빼기 전 개당 이익
        return {
          realPrice: P,
          discountRate: price > 0 && n(v.salePrice) > 0 ? (price - P) / price : 0,
          couponAmt,
          sellerCoupon,
          netSales,
          fee,
          etcFee,
          adCost,
          vat,
          totalCost: totalCost + vat,
          profit,
          margin: div(profit, netSales),
          totalProfit: qty > 0 ? profit * qty : null,
          bepQty: n(v.adFixed) > 0 && contribution > 0 ? Math.ceil(n(v.adFixed) * q / contribution - 1e-9) : null,
          costRatio: div(n(v.cost), netSales),
          bepPrice: a > 0 ? b / a : null,
          targetPrice: a - tm * s > 0 ? roundTo((b - tm * sh * cf) / (a - tm * s), 10, 'up') : null,
          bepRoas: profitBeforeAd > 0 ? netSales * q / profitBeforeAd : null,
        };
      },
      outputs: [
        { key: 'profit', label: '영업이익(개당)', type: 'money', primary: true, tone: 'sign',
          excel: (c) => `${c('netSales')}-${c('totalCost')}` },
        { key: 'margin', label: '영업이익률', type: 'percent', primary: true, tone: 'margin',
          excel: (c) => xdiv(c('profit'), c('netSales')) },
        { key: 'realPrice', label: '실판매가', type: 'money', hint: '할인가가 있으면 할인가, 없으면 판매가',
          excel: (c) => `IF(N(${c('salePrice')})>0,${c('salePrice')},${c('price')})` },
        { key: 'discountRate', label: '할인율(판매가 대비)', type: 'percent',
          excel: (c) => `IF(AND(N(${c('salePrice')})>0,${c('price')}>0),(${c('price')}-${c('realPrice')})/${c('price')},0)` },
        { key: 'couponAmt', label: '쿠폰 할인액(전체)', type: 'money', hint: '할인율 쿠폰 + 정액 쿠폰. 플랫폼 부담분 포함',
          excel: (c) => `${c('realPrice')}*N(${c('couponRate')})+N(${c('couponFixed')})` },
        { key: 'sellerCoupon', label: '셀러부담 쿠폰', type: 'money', hint: '쿠폰 할인액 × 자체 쿠폰 분담율',
          excel: (c) => `${c('couponAmt')}*N(${c('couponShare')})` },
        { key: 'netSales', label: '정산기준 매출', type: 'money', hint: '실판매가에서 셀러부담 쿠폰을 뺀 금액. 수수료는 이 금액 기준',
          excel: (c) => `${c('realPrice')}-${c('sellerCoupon')}` },
        { key: 'fee', label: '판매수수료', type: 'money',
          excel: (c) => `${c('netSales')}*N(${c('feeRate')})` },
        { key: 'etcFee', label: '기타수수료', type: 'money',
          excel: (c) => `${c('netSales')}*N(${c('etcFeeRate')})` },
        { key: 'adCost', label: '광고비(개당)', type: 'money', hint: '실판매가 × 광고비% + 정액 광고비 ÷ 예상 판매수량',
          excel: (c) => `${c('realPrice')}*N(${c('adRate')})+IF(N(${c('salesQty')})>0,N(${c('adFixed')})/${c('salesQty')},0)` },
        { key: 'vat', label: '부가세 납부(예상)', type: 'money', hint: '매출 부가세 − 비용 매입세액(공제 시). 음수면 환급 예상',
          excel: (c) => `IF(${c('taxType')}="면세",0,${c('netSales')}/11-IF(${c('vatDeduct')}="N",0,(${baseX(c)}+${c('adCost')}+${c('fee')}+${c('etcFee')})/11))` },
        { key: 'totalCost', label: '총비용(부가세 포함)', type: 'money',
          excel: (c) => `${baseX(c)}+${c('adCost')}+${c('fee')}+${c('etcFee')}+${c('vat')}` },
        { key: 'costRatio', label: '원가율', type: 'percent', hint: '상품원가 ÷ 정산기준 매출',
          excel: (c) => xdiv(`N(${c('cost')})`, c('netSales')) },
        { key: 'totalProfit', label: '예상 총 영업이익', type: 'money', tone: 'sign', hint: '개당 영업이익 × 예상 판매수량. 예상 판매수량을 넣으면 표시',
          excel: (c) => `IF(N(${c('salesQty')})>0,${c('profit')}*${c('salesQty')},"")` },
        { key: 'bepQty', label: '손익분기 판매수량', type: 'number', unit: '개', hint: '정액 광고비를 회수하려면 최소 몇 개를 팔아야 하는지. 이보다 많이 팔아야 이익',
          excel: (c) => `IF(N(${c('adFixed')})<=0,"",IF(${contribX(c)}<=0,"",CEILING(N(${c('adFixed')})*(1-${kx(c)}/11)/${contribX(c)}-0.000000001,1)))` },
        { key: 'bepPrice', label: '손익분기 판매가', type: 'money', hint: '영업이익이 0원이 되는 실판매가. 이보다 싸게 팔면 적자',
          excel: (c) => profitCoef(c, 'bep') },
        { key: 'targetPrice', label: '목표이익률 추천 판매가', type: 'money', hint: '목표 영업이익률을 맞추려면 받아야 하는 실판매가(10원 단위 올림)',
          excel: (c) => profitCoef(c, 'target') },
        { key: 'bepRoas', label: '손익분기 ROAS', type: 'percent', hint: '광고 매출 ÷ 광고비가 이 값보다 낮으면 광고할수록 적자. 광고비를 빼기 전 이익으로 계산',
          excel: (c) => `IF((${c('profit')}+${c('adCost')}*(1-${kx(c)}/11))<=0,"",${c('netSales')}*(1-${kx(c)}/11)/(${c('profit')}+${c('adCost')}*(1-${kx(c)}/11)))` },
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
      desc: '기간·채널별 목표 대비 달성률과 남은 기간 일평균 필요 매출',
      fields: [
        { key: 'startDate', label: '기간 시작일', type: 'date', hint: '목표 기간의 첫날. 시작일과 종료일을 넣으면 경과 일수·전체 일수를 자동으로 계산해요' },
        { key: 'endDate', label: '기간 종료일', type: 'date', hint: '목표 기간의 마지막 날(마감일)' },
        { key: 'asOfDate', label: '실적 기준일', type: 'date', hint: '현재 실적을 집계한 날짜. 비우면 오늘로 계산하고, 장부에 기록할 때 오늘 날짜를 함께 남겨요' },
        { key: 'goal', label: '목표 매출', type: 'bigmoney', placeholder: '예) 100 = 1억', hint: '100만원 단위로 입력해요. 100을 넣으면 1억 원. 채널별로 입력하면 채널 합계가 자동으로 들어가요' },
        { key: 'actual', label: '현재 실적', type: 'bigmoney', placeholder: '예) 35 = 3,500만', hint: '100만원 단위로 입력해요. 채널별로 입력하면 채널 합계가 자동으로 들어가요' },
        { key: 'daysPassed', label: '경과 일수', type: 'number', unit: '일', hint: '기간(시작일·종료일)을 넣지 않을 때만 직접 입력해요' },
        { key: 'daysTotal', label: '전체 일수', type: 'number', unit: '일', placeholder: '30', hint: '기간(시작일·종료일)을 넣지 않을 때만 직접 입력해요' },
        { key: 'channels', label: '채널별 목표·실적', type: 'channels', default: [], hint: '스마트스토어·쿠팡·자사몰처럼 채널별로 목표와 실적을 나눠 넣으면 채널별 달성률을 보여 주고, 위 목표·실적 칸에는 합계가 들어가요' },
      ],
      // 채널별 입력이 있으면 목표·실적 칸을 채널 합계로 바꾼다 (화면·엑셀·AI가 같은 값을 쓰게)
      normalize(v) {
        const ch = channelsOf(v);
        if (!ch.length) return v;
        return Object.assign({}, v, {
          goal: sumStr(ch.reduce((s, c) => s + n(c.goal), 0)),
          actual: sumStr(ch.reduce((s, c) => s + n(c.actual), 0)),
        });
      },
      compute(v) {
        const d = targetDays(v);
        return Object.assign(targetMetrics(n(v.goal) * MILLION, n(v.actual) * MILLION, d), { elapsedDays: d.elapsed, periodDays: d.total });
      },
      outputs: [
        { key: 'rate', label: '달성률', type: 'percent', primary: true, tone: 'goal', excel: (c) => xdiv(c('actual'), c('goal')) },
        { key: 'remain', label: '남은 금액', type: 'money', big: true, primary: true, excel: (c) => `${c('goal')}-${c('actual')}` },
        { key: 'forecast', label: '마감 예상 실적', type: 'money', big: true, hint: '지금까지의 일평균 실적이 기간 끝까지 이어질 때의 예상 실적',
          excel: (c) => `IF(AND(N(${c('elapsedDays')})>0,N(${c('periodDays')})>0),${c('actual')}/${c('elapsedDays')}*${c('periodDays')},"")` },
        { key: 'forecastRate', label: '마감 예상 달성률', type: 'percent', excel: (c) => `IF(OR(${c('forecast')}="",N(${c('goal')})=0),"",${c('forecast')}/${c('goal')})` },
        { key: 'dailyNeed', label: '남은 기간 일평균 필요', type: 'money', big: true, hint: '남은 금액 ÷ 남은 일수',
          excel: (c) => `IF(AND(N(${c('periodDays')})>0,N(${c('periodDays')})>N(${c('elapsedDays')})),MAX(0,${c('goal')}-${c('actual')})/(${c('periodDays')}-N(${c('elapsedDays')})),"")` },
        { key: 'elapsedDays', label: '경과 일수', type: 'number', unit: '일', hint: '기간 시작일부터 실적 기준일까지(기준일 포함)',
          excel: (c) => `IF(AND(ISNUMBER(${c('startDate')}),ISNUMBER(${c('endDate')}),N(${c('endDate')})>=N(${c('startDate')})),MAX(0,MIN(${c('endDate')}-${c('startDate')}+1,IF(ISNUMBER(${c('asOfDate')}),${c('asOfDate')},TODAY())-${c('startDate')}+1)),IF(N(${c('daysPassed')})>0,N(${c('daysPassed')}),""))` },
        { key: 'periodDays', label: '전체 일수', type: 'number', unit: '일',
          excel: (c) => `IF(AND(ISNUMBER(${c('startDate')}),ISNUMBER(${c('endDate')}),N(${c('endDate')})>=N(${c('startDate')})),${c('endDate')}-${c('startDate')}+1,IF(N(${c('daysTotal')})>0,N(${c('daysTotal')}),""))` },
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
  // 개당 고정비(정액 광고비 개당 몫 포함)
  function fixedX(c) {
    return `(${baseX(c)}+${adUnitX(c)})`;
  }
  // 상품 1개당 고정비(광고비 제외)
  function baseX(c) { return `(N(${c('cost')})+N(${c('shipping')})+N(${c('gift')})+N(${c('otherCost')}))`; }
  function adUnitX(c) { return `IF(N(${c('salesQty')})>0,N(${c('adFixed')})/${c('salesQty')},0)`; }
  function contribX(c) {
    return `(${c('profit')}+IF(N(${c('salesQty')})>0,N(${c('adFixed')})/${c('salesQty')},0)*(1-${kx(c)}/11))`;
  }
  function profitCoef(c, which) {
    const t = `IF(${c('taxType')}="면세",0,1)`;
    const q = `(1-${kx(c)}/11)`;
    const sh = `N(${c('couponShare')})`;
    const s = `(1-N(${c('couponRate')})*${sh})`;
    const m = `(1-${t}/11-(N(${c('feeRate')})+N(${c('etcFeeRate')}))*${q})`;
    const a = `(${m}*${s}-${q}*N(${c('adRate')}))`;
    const b = `(${m}*${sh}*N(${c('couponFixed')})+${q}*${fixedX(c)})`;
    if (which === 'bep') return `IF(${a}<=0,"",${b}/${a})`;
    const d = `(${a}-N(${c('targetMargin')})*${s})`;
    return `IF(${d}<=0,"",CEILING((${b}-N(${c('targetMargin')})*${sh}*N(${c('couponFixed')}))/${d}-0.000001,10))`;
  }

  function defaults(id) {
    const o = {};
    for (const f of CALCS[id].fields) {
      if (Array.isArray(f.default)) o[f.key] = f.default.slice();
      else o[f.key] = f.default !== undefined ? String(f.default) : '';
    }
    return o;
  }

  // 화면·엑셀·AI가 모두 같은 값을 보도록 입력값을 정리 (기본값 채우기 + 계산기별 normalize)
  function normalize(id, values) {
    const v = Object.assign(defaults(id), values || {});
    return CALCS[id].normalize ? CALCS[id].normalize(v) : v;
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
    if (type === 'bigmoney') return `${korWon(n(value) * MILLION)} (${Math.round(n(value) * MILLION).toLocaleString('ko-KR')}원)`;
    if (type === 'number') return n(value).toLocaleString('ko-KR');
    return String(value);
  }

  function run(id, values) {
    const calc = CALCS[id];
    const v = normalize(id, values);
    const r = calc.compute(v);
    return calc.outputs.map((o) => {
      const value = r[o.key];
      let text = fmt(value, o.type), sub = '';
      // 큰 금액은 "1억 2,000만원"을 크게, 정확한 원 단위는 보조로 함께 표시
      if (o.big && text !== '—' && Math.abs(value) >= 1e4) { sub = text; text = korWon(value); }
      return Object.assign({}, o, { value, text: o.unit && text !== '—' ? text + o.unit : text, sub });
    });
  }

  // 채널별 달성 현황 (목표 달성 계산기). 금액은 원 단위
  function channelRows(values) {
    const v = normalize('target', values);
    const d = targetDays(v);
    const totalGoal = n(v.goal) * MILLION;
    return channelsOf(v).map((c, i) => {
      const goal = n(c.goal) * MILLION, actual = n(c.actual) * MILLION;
      return Object.assign({ name: String(c.name || '').trim() || `채널 ${i + 1}`, goal, actual, share: div(goal, totalGoal) }, targetMetrics(goal, actual, d));
    });
  }

  /* AI에 보내는 요약. opts로 개인정보를 가린다.
   * - alias: 상품명 등 텍스트 입력을 이 별칭으로 바꿔 보냄 (예: '상품A')
   * - hideMoney: 금액(원) 입력·결과를 빼고 비율·일수만 보냄 */
  function summaryText(id, values, opts) {
    const o = opts || {};
    const calc = CALCS[id];
    const v = normalize(id, values);
    const isMoney = (t) => t === 'money' || t === 'bigmoney';
    const lines = [`[${calc.name} 계산기]`];
    for (const f of calc.fields) {
      if (f.type === 'channels') continue;
      const raw = v[f.key];
      if (raw === '' || raw === undefined) continue;
      if (f.type === 'text') { lines.push(`${f.label}: ${o.alias || raw}`); continue; }
      if (o.hideMoney && isMoney(f.type)) { lines.push(`${f.label}: (비공개)`); continue; }
      lines.push(`${f.label}: ${fmtInput(raw, f.type)}${f.unit || ''}`);
    }
    if (id === 'target') {
      const rows = channelRows(v);
      if (rows.length) {
        lines.push('— 채널별 —');
        for (const r of rows) {
          lines.push(o.hideMoney
            ? `${r.name}: 목표 비중 ${fmt(r.share, 'percent')}, 달성률 ${fmt(r.rate, 'percent')}, 마감 예상 달성률 ${fmt(r.forecastRate, 'percent')}`
            : `${r.name}: 목표 ${korWon(r.goal)}, 실적 ${korWon(r.actual)}, 달성률 ${fmt(r.rate, 'percent')}, 남은 금액 ${korWon(r.remain)}, 마감 예상 달성률 ${fmt(r.forecastRate, 'percent')}, 일평균 필요 ${r.dailyNeed === null ? '—' : korWon(r.dailyNeed)}`);
        }
      }
    }
    if (id === 'target') {
      // 행사 날짜는 AI 기억이 아니라 앱 달력에서만 보낸다
      const s = dayNum(v.startDate), e = dayNum(v.endDate);
      if (s !== null && e !== null && e >= s) {
        const ev = Ev.withChannels(s, e, o.channels || []).filter((x) => x.boost || x.kind === 'holiday');
        if (ev.length) { lines.push('— 기간 내 주요 일정 (앱 달력 기준) —'); ev.forEach((x) => lines.push(Ev.describe(x))); }
        const plans = Object.entries(v.plans || {}).filter(([d, t]) => String(t).trim() && dayNum(d) !== null && dayNum(d) >= s && dayNum(d) <= e).sort();
        if (plans.length) { lines.push('— 판매 계획 —'); plans.forEach(([d, t]) => lines.push(`${d}: ${String(t).trim()}`)); }
      }
    }
    lines.push('— 결과 —');
    for (const r of run(id, v)) {
      if (o.hideMoney && isMoney(r.type)) continue;
      lines.push(`${r.label}: ${r.text}${r.sub ? ` (${r.sub})` : ''}`);
    }
    if (o.hideMoney) lines.push('※ 개인정보 보호 설정에 따라 금액은 보내지 않았습니다. 비율과 일수만 보고 조언해 주세요.');
    return lines.join('\n');
  }

  return { CALCS, defaults, normalize, run, channelRows, fmt, fmtInput, korWon, dayNum, todayStr, summaryText, num: n, MILLION };
});
