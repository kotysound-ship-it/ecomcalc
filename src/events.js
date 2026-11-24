/* 이커머스 AI 계산기 — 행사 달력 데이터
 * AI가 아니라 앱 데이터에서만 행사 날짜를 가져온다 (AI가 날짜를 지어내지 않게).
 * kind
 *  - holiday : 공휴일·명절 연휴 (확정)
 *  - day     : 기념일·쇼핑 데이 (날짜 규칙이 정해져 있어 확정)
 *  - season  : 확정 날짜를 기준으로 잡은 판매 시즌 구간 (예: 명절 선물 시즌)
 *  - expected: 채널별 정기 행사 예상 구간 (과거 패턴 기준, 사용자가 확인해야 함) — 다음 단계에서 추가
 * boost: 판매가 늘어나는 날/구간이면 true
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Events = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const dn = (y, m, d) => Date.UTC(y, m - 1, d) / DAY; // 1970-01-01 기준 일수
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return dn(y, m, d); };
  const str = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const wd = (n) => new Date(n * DAY).getUTCDay(); // 0=일

  // 음력 명절(양력 환산). 우주항공청(한국천문연구원) 월력요항 기준. 대체공휴일 포함한 연휴 구간
  // 표에 없는 연도는 설·추석을 표시하지 않는다 (앱 업데이트로 추가)
  const LUNAR = {
    2025: { seol: ['2025-01-27', '2025-01-30', '1/27 임시공휴일 포함'], chuseok: ['2025-10-05', '2025-10-08', '10/8 대체공휴일 포함, 개천절(10/3)·한글날(10/9)과 이어짐'] },
    2026: { seol: ['2026-02-16', '2026-02-18'], chuseok: ['2026-09-24', '2026-09-26'] },
    2027: { seol: ['2027-02-06', '2027-02-09', '2/9 대체공휴일 포함'], chuseok: ['2027-09-14', '2027-09-16'] },
    2028: { seol: ['2028-01-26', '2028-01-28'], chuseok: ['2028-10-02', '2028-10-05', '개천절(10/3)과 겹쳐 10/5 대체공휴일 포함'] },
  };
  const LUNAR_YEARS = Object.keys(LUNAR).map(Number);

  function nthWeekday(y, m, weekday, nth) { // 그 달 n번째 요일
    const first = dn(y, m, 1);
    return first + ((weekday - wd(first) + 7) % 7) + (nth - 1) * 7;
  }

  function yearEvents(y) {
    const ev = [];
    const add = (id, name, start, end, kind, boost, note) => ev.push({ id: `${id}-${y}`, name, start, end: end === undefined ? start : end, kind, boost: !!boost, note: note || '', confirmed: kind === 'holiday' || kind === 'day' });

    const L = LUNAR[y];
    if (L) {
      for (const [key, name] of [['seol', '설날'], ['chuseok', '추석']]) {
        const [a, b, note] = L[key];
        const s = parse(a), e = parse(b);
        add(key, `${name} 연휴`, s, e, 'holiday', false, `${note ? note + '. ' : ''}연휴 중에는 주문·배송이 줄어요`);
        add(key + '-gift', `${name} 선물 시즌`, s - 21, s - 4, 'season', true, '선물세트 수요가 몰리는 구간. 택배 마감은 보통 연휴 3~5일 전이니 택배사 공지를 확인하세요');
      }
    }
    // 공휴일 (양력 고정)
    add('newyear', '신정', dn(y, 1, 1), undefined, 'holiday', false);
    add('march1', '삼일절', dn(y, 3, 1), undefined, 'holiday', false);
    add('children', '어린이날', dn(y, 5, 5), undefined, 'holiday', true, '가정의 달 선물 수요');
    add('memorial', '현충일', dn(y, 6, 6), undefined, 'holiday', false);
    add('liberation', '광복절', dn(y, 8, 15), undefined, 'holiday', false);
    add('foundation', '개천절', dn(y, 10, 3), undefined, 'holiday', false);
    add('hangul', '한글날', dn(y, 10, 9), undefined, 'holiday', false);
    add('xmas', '크리스마스', dn(y, 12, 25), undefined, 'holiday', true);
    // 기념일·쇼핑 데이
    add('valentine', '발렌타인데이', dn(y, 2, 14), undefined, 'day', true);
    add('white', '화이트데이', dn(y, 3, 14), undefined, 'day', true);
    add('parents', '어버이날', dn(y, 5, 8), undefined, 'day', true);
    add('teachers', '스승의날', dn(y, 5, 15), undefined, 'day', true);
    add('pepero', '빼빼로데이', dn(y, 11, 11), undefined, 'day', true, '11번가 십일절 등 11월 11일 행사와 겹쳐요');
    const thanks = nthWeekday(y, 11, 4, 4); // 미국 추수감사절: 11월 넷째 목요일
    add('blackfriday', '블랙프라이데이', thanks + 1, undefined, 'day', true, '미국 추수감사절 다음 날. 국내 채널도 이 주간에 할인 행사를 많이 열어요');
    add('cybermonday', '사이버먼데이', thanks + 4, undefined, 'day', true);
    // 시즌
    add('family', '가정의 달', dn(y, 5, 1), dn(y, 5, 31), 'season', true, '어린이날·어버이날·스승의날 선물 수요');
    add('bf-week', '블랙프라이데이 주간', thanks - 3, thanks + 4, 'season', true);
    add('xmas-gift', '크리스마스 선물 시즌', dn(y, 12, 1), dn(y, 12, 24), 'season', true);
    add('yearend', '연말 시즌', dn(y, 12, 26), dn(y, 12, 31), 'season', true, '송년·신년 준비, 연말 결산 할인');
    return ev;
  }

  const cache = {};
  const ofYear = (y) => cache[y] || (cache[y] = yearEvents(y));

  // [from, to] 일수 구간과 겹치는 행사 (시작일 순)
  function between(from, to) {
    const y1 = new Date(from * DAY).getUTCFullYear(), y2 = new Date(to * DAY).getUTCFullYear();
    const out = [];
    for (let y = y1; y <= y2; y++) for (const e of ofYear(y)) if (e.end >= from && e.start <= to) out.push(e);
    const order = { holiday: 0, day: 1, expected: 2, season: 3 };
    return out.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);
  }
  const lunarCovered = (y) => !!LUNAR[y];

  /* 채널별 정기 행사 — 「예상」
   * 과거 개최 기록(보도자료·공식 공지)을 보고 "매년 이 달 이 주차"로 잡은 패턴이다. 채널이 일정을 옮길 수 있으므로 확정이 아니다.
   * 주차: 1주차=1~7일 · 2주차=8~14일 · 3주차=15~21일 · 4주차=22~28일 · 5주차=29일~말일
   * weeks:[시작 주차, 끝 주차] 또는 days:[시작일, 끝일] / confidence: 높음(2년 이상 같은 시기) · 보통(1년 기록 또는 시기가 조금씩 다름) · 낮음(비공식 자료)
   * 사용자가 실제 날짜를 확정하면 그 해는 확정으로 바뀌고, 다음 해 예상은 그 확정 날짜를 기준으로 계산한다. */
  const CHANNELS = ['네이버(스마트스토어)', '쿠팡', '11번가', 'G마켓·옥션', 'SSG닷컴', '롯데온', '카카오', '올리브영', '무신사', '29CM', '컬리'];
  const CHANNEL_RULES = [
    { id: 'naver-nupda', channel: '네이버(스마트스토어)', name: '넾다세일', month: 11, weeks: [1, 2], confidence: '보통', basis: '2025년 10/29~11/11 (네이버쇼핑 페스타를 리브랜딩). 10월 말에 시작하기도 해요', sources: ['https://www.news1.kr/amp/it-science/general-it/5956855', 'https://www.newsis.com/view/NISX20251029_0003380987'] },
    { id: 'coupang-wow', channel: '쿠팡', name: '와우 멤버스데이', months: [7, 11], weeks: [1, 1], confidence: '보통', basis: '연 2회, 보통 7월 초·11월 초 (와우 회원 대상, 와우 빅세일에서 「와우 멤버스데이(와멤데)」로 개편). 2026년 11월 11/2~11/8', sources: ['https://www.thefairnews.co.kr/news/articleView.html?idxno=29446', 'https://www.fnnews.com/news/202611151329405871'] },
    { id: 'coupang-bf', channel: '쿠팡', name: '가전·디지털 블랙프라이데이', month: 11, weeks: [3, 4], confidence: '보통', basis: '2026년 11/16~11/29. 2025년 로켓직구 블프는 11/24~12/1', sources: ['https://www.fnnews.com/news/202611151108219824', 'https://www.businesskorea.co.kr/news/articleView.html?idxno=281315'] },
    { id: '11st-grand-nov', channel: '11번가', name: '그랜드십일절', month: 11, days: [1, 11], confidence: '높음', basis: '2025·2026년 모두 11/1~11/11', sources: ['https://zdnet.co.kr/view/?no=20251029100828', 'https://zdnet.co.kr/view/?no=20261029165428'] },
    { id: '11st-grand-may', channel: '11번가', name: '5월 그랜드십일절', month: 5, weeks: [2, 3], confidence: '보통', basis: '2025년 5/7~5/17', sources: ['https://zdnet.co.kr/view/?no=20250502152058'] },
    { id: 'gmarket-bigsmile-nov', channel: 'G마켓·옥션', name: '빅스마일데이', month: 11, weeks: [1, 2], confidence: '높음', basis: '2024년 11/1~11/10 · 2025년 11/1~11/11 · 2026년 11/2~11/13', sources: ['https://www.globalepic.co.kr/view.php?ud=20251110183200281ac3d53c8ec_29', 'https://www.rapportian.com/news/articleView.html?idxno=241880'] },
    { id: 'gmarket-bigsmile-may', channel: 'G마켓·옥션', name: '5월 빅스마일데이', month: 5, weeks: [2, 2], confidence: '보통', basis: '2025년 5/7~5/13 (5월 연휴 직후)', sources: ['https://biz.heraldcorp.com/article/10482311'] },
    { id: 'ssg-day', channel: 'SSG닷컴', name: '쓱데이', month: 11, weeks: [1, 2], confidence: '보통', basis: '2025년 10/30~11/9 (신세계그룹 18개 계열사). 10월 말에 시작해요', sources: ['https://zdnet.co.kr/view/?no=20251029140941', 'https://www.shinsegaegroupnewsroom.com/shinsegae-group-opens-korea-shopping-festival-ssgday/'] },
    { id: 'lotteon-feb', channel: '롯데온', name: '온세상 쇼핑 페스타', month: 2, weeks: [3, 4], confidence: '보통', basis: '2025년 2/17~2/23. 2020년부터 매년 여는 연례 행사', sources: ['https://www.ngonews.kr/news/articleView.html?idxno=202777'] },
    { id: 'lotteon-oct', channel: '롯데온', name: '가을 온세상 쇼핑 페스타', month: 10, weeks: [2, 4], confidence: '낮음', basis: '10/13~10/22 개최 기사(연도 미확인)', sources: ['https://www.koreadaily.com/article/20251012223544979'] },
    { id: 'kakao-festa', channel: '카카오', name: '카카오쇼핑페스타', month: 10, weeks: [3, 5], confidence: '보통', basis: '2025년 약 2주간, 11/2 종료 (선물하기·톡딜)', sources: ['https://www.etnews.com/20251022000072'] },
    { id: 'kakao-family', channel: '카카오', name: '선물하기 가정의 달 기획전', month: 5, weeks: [1, 3], confidence: '보통', basis: '2025년 4/28~5/19 (어린이날·어버이날·스승의날·성년의날)', sources: ['https://zdnet.co.kr/view/?no=20250429102104'] },
    { id: 'oy-sale', channel: '올리브영', name: '올영세일', months: [3, 6, 9, 12], weeks: [1, 1], confidence: '보통', basis: '연 4회(계절 시작). 2025년 8/29~9/4 · 11/30~12/6. 전달 말일 전후에 시작해요', sources: ['https://magazine.hankyung.com/business/article/202508286708b', 'https://www.hankookilbo.com/news/article/A2025112814190005549'] },
    { id: 'oy-day', channel: '올리브영', name: '올영데이', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: [25, 27], confidence: '낮음', basis: '매달 25~27일 (비공식 정리 자료)', sources: ['https://unpa.me/community/beautytip/114298366'] },
    { id: 'musinsa-summer', channel: '무신사', name: '무진장 여름 블랙프라이데이', month: 6, weeks: [3, 4], confidence: '높음', basis: '2024년 6/23~7/3 · 2025년 6/15~6/25', sources: ['https://www.newsis.com/view/NISX20240620_0002779770', 'https://newsroom.musinsa.com/newsroom-menu/2025-0613'] },
    { id: 'musinsa-winter', channel: '무신사', name: '무진장 겨울 블랙프라이데이', month: 11, weeks: [3, 5], confidence: '높음', basis: '2024년 11/24~12/4 · 2025년 11/16~11/26 · 2026년 11/22~12/2', sources: ['https://x.com/musinsaofficial/status/1989279914030457010', 'https://tnnews.co.kr/archives/256577'] },
    { id: '29cm-summer', channel: '29CM', name: '여름 이구위크', month: 6, weeks: [1, 2], confidence: '보통', basis: '2025년 6/4~6/14', sources: ['https://news.nate.com/view/20250530n28069'] },
    { id: '29cm-winter', channel: '29CM', name: '겨울 이구위크', month: 11, weeks: [1, 3], confidence: '높음', basis: '2025년 11/3~11/13 · 2026년 11/9~11/19', sources: ['https://newsroom.musinsa.com/newsroom-menu/2025-1031-29cm', 'https://zdnet.co.kr/view/?no=20251101132332'] },
    { id: 'kurly-food', channel: '컬리', name: '컬리푸드페스타(오프라인)', month: 12, weeks: [3, 3], confidence: '보통', basis: '2025년 12/18~12/21 코엑스 마곡. 온라인 연계 할인', sources: ['https://www.etnews.com/20251124000308'] },
  ];
  const SHORT = { '네이버(스마트스토어)': '네이버', 'G마켓·옥션': 'G마켓', 'SSG닷컴': 'SSG', '올리브영': '올영' };
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weekStart = (w) => (w - 1) * 7 + 1;
  const weekEnd = (y, m, w) => (w >= 5 ? lastDay(y, m) : Math.min(w * 7, lastDay(y, m)));
  const ruleLabel = (r, m) => (r.days ? `${m}월 ${r.days[0]}~${r.days[1]}일` : r.weeks[0] === r.weeks[1] ? `${m}월 ${r.weeks[0]}주차` : `${m}월 ${r.weeks[0]}~${r.weeks[1]}주차`);

  // 사용자가 확정한 날짜: { '<ruleId>:<연도>': { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } }
  let confirmedMap = {};
  function setConfirmed(map) { confirmedMap = map || {}; }

  function channelEvents(y, channels) {
    const out = [];
    for (const r of CHANNEL_RULES) {
      if (channels && !channels.includes(r.channel)) continue;
      for (const m of r.months || [r.month]) {
        const key = `${r.id}${r.months ? '-' + m : ''}:${y}`;
        const base = { channel: r.channel, short: `${SHORT[r.channel] || r.channel} ${r.name}`, ruleId: r.id, confidence: r.confidence, basis: r.basis, sources: r.sources, boost: true, key };
        const c = confirmedMap[key];
        if (c) { out.push(Object.assign({}, base, { id: key, name: `${r.channel} ${r.name}`, start: parse(c.start), end: parse(c.end), kind: 'channel', confirmed: true, label: '사용자 확정', note: `확정한 날짜 · 이전 근거: ${r.basis}` })); continue; }
        // 지난해에 확정한 날짜가 있으면 같은 월·일로 예상 (내 기록 우선)
        const prevKey = Object.keys(confirmedMap).filter((k) => k.startsWith(`${r.id}${r.months ? '-' + m : ''}:`) && +k.split(':')[1] < y).sort().pop();
        let start, end, label, note;
        if (prevKey) {
          const p = confirmedMap[prevKey], py = +prevKey.split(':')[1];
          start = parse(p.start) - dn(py, 1, 1) + dn(y, 1, 1); end = parse(p.end) - parse(p.start) + start;
          label = `${py}년 확정일 기준`; note = `${py}년에 확정한 날짜(${p.start.slice(5)}~${p.end.slice(5)})를 기준으로 잡은 예상이에요`;
        } else {
          start = dn(y, m, r.days ? r.days[0] : weekStart(r.weeks[0]));
          end = dn(y, m, r.days ? Math.min(r.days[1], lastDay(y, m)) : weekEnd(y, m, r.weeks[1]));
          label = ruleLabel(r, m); note = `근거: ${r.basis}`;
        }
        out.push(Object.assign({}, base, { id: key, name: `${r.channel} ${r.name}`, start, end, kind: 'expected', confirmed: false, label, note }));
      }
    }
    return out;
  }

  // [from, to] 일수 구간과 겹치는 행사 + 채널 행사(channels: 보여 줄 채널 목록, null이면 전체, []이면 없음)
  function withChannels(from, to, channels) {
    const base = between(from, to);
    if (channels && !channels.length) return base;
    const y1 = new Date(from * DAY).getUTCFullYear(), y2 = new Date(to * DAY).getUTCFullYear();
    const ch = [];
    for (let y = y1; y <= y2; y++) for (const e of channelEvents(y, channels)) if (e.end >= from && e.start <= to) ch.push(e);
    const order = { holiday: 0, day: 1, channel: 2, expected: 3, season: 4 };
    return base.concat(ch).sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);
  }

  // AI에 보낼 요약 줄
  function describe(e) {
    const range = e.start === e.end ? str(e.start) : `${str(e.start)}~${str(e.end)}`;
    const tag = { holiday: '공휴일·연휴', day: '기념일', season: '판매 시즌', expected: `채널 행사·예상(${e.label}, 신뢰도 ${e.confidence})`, channel: '채널 행사' }[e.kind];
    return `${range} ${e.name} [${tag}${e.confirmed ? '·확정' : ''}${e.boost ? '·판매 증가' : ''}]`;
  }

  return { between, withChannels, channelEvents, setConfirmed, CHANNELS, CHANNEL_RULES, ofYear, describe, lunarCovered, LUNAR_YEARS, str, parse };
});
