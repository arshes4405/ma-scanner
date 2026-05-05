const https = require("https");

const VERSION = "2026-05-05 v15";

const PERIODS = [
  { label: "하락장 (1~2월)", start: "2026-01-01", end: "2026-02-28" },
  { label: "상승장 (3~4월)", start: "2026-03-01", end: "2026-04-30" },
];

const BIAS_TEST     = false;
const BIAS_VALUES   = [-5, 0, 5];
const BIAS_PERIOD   = PERIODS[1];

const ADAPTIVE_TEST = false;
const ADAPTIVE_PERIOD = { start: "2026-01-01", end: "2026-04-30" };

const ETH_RSI_TEST   = false;  // ETH 주봉 RSI 필터: 전주대비 RSI 상승 → 알트 매수 허용
const ETHBTC_TEST    = true;   // ETH/BTC 비율 필터: 전주대비 ETH/BTC 상승 → 알트 매수 허용
const ETH_RSI_PERIOD = { start: "2026-01-01", end: "2026-04-30" };

const CONFIG = {
  BASE_URL:      "https://fapi.binance.com",
  INTERVAL:      "1h",
  MONTHS:        6,
  RSI_PERIOD:    14,
  RSI_CUR_DELTA: 5,
  TP_PCT:        5,
  SL_PCT:        3,
  MIN_VOLUME_USDT: 1_000_000,
  UNRANKED_LIMIT:  250,

  MAJOR_SYMBOLS:  ["ETHUSDT", "HYPEUSDT"],
  TIER1_SYMBOLS:  [],
  TIER2_SYMBOLS:  [],
  TIER3_SYMBOLS:  ["ZEREBROUSDT", "INITUSDT", "BULLAUSDT", "HANAUSDT", "SKYAIUSDT", "SOLVUSDT", "CLOUSDT", "PENGUUSDT", "MOODENGUSDT", "LUMIAUSDT", "PIEVERSEUSDT", "ENSOUSDT", "ONTUSDT", "SPKUSDT", "HAEDALUSDT", "BABYUSDT"],
  EXCLUDE_SYMBOLS: [
    "PLAYUSDT", "RAVEUSDT", "MEGAUSDT", "QNTUSDT", "XVSUSDT", "WLDUSDT", "BRUSDT", "EVAAUSDT", "ARIAUSDT", "BASEDUSDT",
    "STXUSDT", "MANAUSDT", "COMPUSDT", "HBARUSDT", "WOOUSDT", "ICPUSDT", "ACHUSDT", "TUSDT",
    "DUSKUSDT", "IOSTUSDT", "FLOWUSDT", "FETUSDT", "HIGHUSDT", "BELUSDT", "GTCUSDT",
    "PAXGUSDT", "ATUSDT",
  ],

  RSI_THRESHOLD_MAJOR: 45, BB_FROM_LOWER_MAJOR: 0.33,
  RSI_THRESHOLD_TIER1: 45, BB_FROM_LOWER_TIER1: 0.25,
  RSI_THRESHOLD_TIER2: 40, BB_FROM_LOWER_TIER2: 0.15,
  RSI_THRESHOLD_TIER3: 40, BB_FROM_LOWER_TIER3: 0,
  RSI_THRESHOLD:       35, BB_FROM_LOWER:        0,

  ORDER_USDT_MAJOR: 10000,
  ORDER_USDT_TIER1: 2000,
  ORDER_USDT_TIER2: 1500,
  ORDER_USDT:       1000,
};

async function httpGet(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve({ status: res.statusCode, data }));
      }).on("error", reject);
    });
    if (result.status === 418 || result.status === 429) {
      if (attempt < retries) {
        const waitSec = 300;  // 5분
        console.log(`\n  [WAIT] IP 차단 감지 (HTTP ${result.status}) → ${waitSec}초 대기 후 재시도 (${attempt + 1}/${retries})`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw new Error(`HTTP ${result.status} (rate limit)`);
    }
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    return JSON.parse(result.data);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getSymbolsAndVolumes() {
  const [info, tickers] = await Promise.all([
    httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`),
    httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/24hr`),
  ]);
  const volMap = {};
  for (const t of tickers) volMap[t.symbol] = parseFloat(t.quoteVolume);

  const allSymbols = info.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);

  return { allSymbols, volMap };
}

async function getKlinesPaged(symbol, startDate, endDate) {
  const INDICATOR_CANDLES = 150;
  const BATCH = 1500;
  const intervalMs = 60 * 60 * 1000;
  const endTime   = new Date(endDate + "T23:59:59Z").getTime();
  const startTime = new Date(startDate + "T00:00:00Z").getTime() - INDICATOR_CANDLES * intervalMs;

  const all = [];
  let from = startTime;
  while (true) {
    const url = `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${CONFIG.INTERVAL}&startTime=${from}&endTime=${endTime}&limit=${BATCH}`;
    const raw = await httpGet(url);
    if (!raw.length) break;
    all.push(...raw);
    from = raw[raw.length - 1][0] + intervalMs;
    if (raw.length < BATCH || from > endTime) break;
    await sleep(200);
  }
  return all.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]),
  }));
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  const from = Math.max(1, closes.length - period * 3);
  for (let i = from; i < from + period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = from + period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0,  d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcBollingerThreshold(closes, period = 20, mult = 2, fromLower = 0) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const lower = mean - mult * std;
  return lower + (mean - lower) * fromLower;
}

function checkEntry(klines, i, rsiThreshold, bbFromLower) {
  if (i < 150) return false;
  const cur  = klines[i];
  const prev = klines[i - 1];
  if (cur.close <= cur.open)   return false;
  if (prev.close >= prev.open) return false;

  const prevCloses = klines.slice(0, i).map(k => k.close);
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= rsiThreshold) return false;

  const curRsi = calcRSI(klines.slice(0, i + 1).map(k => k.close), CONFIG.RSI_PERIOD);
  if (curRsi === null || curRsi >= rsi + CONFIG.RSI_CUR_DELTA) return false;

  if (cur.close > (prev.high + prev.low) / 2) return false;

  const bbThreshold = calcBollingerThreshold(prevCloses, 20, 2, bbFromLower);
  if (!bbThreshold || (prev.low + prev.close) / 2 >= bbThreshold) return false;

  return true;
}

function simulateSymbol(symbol, klines, rsiThreshold, bbFromLower, orderUsdt) {
  const trades = [];
  let openPos = null;
  for (let i = 150; i < klines.length - 1; i++) {
    const k = klines[i];
    if (openPos) {
      const slPrice = openPos.entry * (1 - CONFIG.SL_PCT / 100);
      const tpPrice = openPos.entry * (1 + CONFIG.TP_PCT / 100);
      if (k.low <= slPrice) {
        trades.push({ symbol, action: "SL", pnl: +(orderUsdt * -CONFIG.SL_PCT / 100).toFixed(2), time: k.openTime });
        openPos = null;
      } else if (k.high >= tpPrice) {
        trades.push({ symbol, action: "TP", pnl: +(orderUsdt * CONFIG.TP_PCT / 100).toFixed(2), time: k.openTime });
        openPos = null;
      }
    }
    if (!openPos && checkEntry(klines, i, rsiThreshold, bbFromLower)) {
      openPos = { entry: k.close };
    }
  }
  return trades;
}

function printSummary(label, trades, orderUsdt) {
  const tp  = trades.filter(t => t.action === "TP").length;
  const sl  = trades.filter(t => t.action === "SL").length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "0.0";
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT";
  console.log(` ${label.padEnd(22)} ${String(trades.length).padStart(5)}건   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
  return pnl;
}

function runGroups(klinesMap, unranked) {
  const groups = [
    { label: "메이저",           syms: CONFIG.MAJOR_SYMBOLS, rsi: CONFIG.RSI_THRESHOLD_MAJOR, bb: CONFIG.BB_FROM_LOWER_MAJOR, order: CONFIG.ORDER_USDT_MAJOR },
    { label: "TIER1",           syms: CONFIG.TIER1_SYMBOLS,  rsi: CONFIG.RSI_THRESHOLD_TIER1, bb: CONFIG.BB_FROM_LOWER_TIER1, order: CONFIG.ORDER_USDT_TIER1 },
    { label: "TIER2",           syms: CONFIG.TIER2_SYMBOLS,  rsi: CONFIG.RSI_THRESHOLD_TIER2, bb: CONFIG.BB_FROM_LOWER_TIER2, order: CONFIG.ORDER_USDT_TIER2 },
    { label: "TIER3",           syms: CONFIG.TIER3_SYMBOLS,  rsi: CONFIG.RSI_THRESHOLD_TIER3, bb: CONFIG.BB_FROM_LOWER_TIER3, order: CONFIG.ORDER_USDT      },
    { label: `언랭(${unranked.length})`, syms: unranked,     rsi: CONFIG.RSI_THRESHOLD,       bb: CONFIG.BB_FROM_LOWER,       order: CONFIG.ORDER_USDT      },
  ];
  const allTrades = [];
  for (const g of groups) {
    if (!g.syms.length) continue;
    const trades = [];
    for (const sym of g.syms) {
      if (!klinesMap[sym]) continue;
      trades.push(...simulateSymbol(sym, klinesMap[sym], g.rsi, g.bb, g.order));
    }
    printSummary(g.label, trades, g.order);
    allTrades.push(...trades);
  }
  return allTrades;
}

async function main() {
  console.log(`[백테스트 ${VERSION}] ${new Date().toISOString().slice(0, 16)} UTC`);
  console.log(`TP+${CONFIG.TP_PCT}% SL-${CONFIG.SL_PCT}%\n`);

  console.log("심볼 + 거래량 조회 중...");
  const { allSymbols, volMap } = await getSymbolsAndVolumes();

  const excludeSet = new Set([...CONFIG.MAJOR_SYMBOLS, ...CONFIG.EXCLUDE_SYMBOLS]);
  const unrankedAll = allSymbols
    .filter(s => !excludeSet.has(s))
    .filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT)
    .sort((a, b) => (volMap[b] || 0) - (volMap[a] || 0));
  const unrankedRest = unrankedAll.slice(CONFIG.UNRANKED_LIMIT);
  const symbols = BIAS_TEST ? unrankedRest : unrankedAll;
  console.log(`대상: ${BIAS_TEST ? `251위~ ${unrankedRest.length}개 (BIAS 비교)` : `전체 ${unrankedAll.length}개`}\n`);

  // BIAS 비교 모드
  if (BIAS_TEST) {
    const period = BIAS_PERIOD;
    console.log(`\n${"═".repeat(65)}`);
    console.log(` ▶ MARKET_BIAS 비교  |  ${period.label}  (${period.start} ~ ${period.end})`);
    console.log(`${"═".repeat(65)}`);

    const klinesMap = {};
    for (let i = 0; i < symbols.length; i++) {
      process.stdout.write(`\r  캔들 로드 중: ${i + 1}/${symbols.length} (${symbols[i]})          `);
      try { klinesMap[symbols[i]] = await getKlinesPaged(symbols[i], period.start, period.end); } catch (_) {}
      await sleep(300);
    }
    console.log(`\n`);

    console.log(`${"─".repeat(65)}`);
    console.log(` ${"BIAS".padEnd(10)} ${"거래".padStart(5)}   ${"익절".padStart(4)}   ${"손절".padStart(4)}   ${"승률".padStart(6)}   ${"손익".padStart(13)}`);
    console.log(`${"─".repeat(65)}`);
    for (const bias of BIAS_VALUES) {
      const rsi = CONFIG.RSI_THRESHOLD + bias;
      const trades = [];
      for (const sym of symbols) {
        if (klinesMap[sym]) trades.push(...simulateSymbol(sym, klinesMap[sym], rsi, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT));
      }
      printSummary(`BIAS ${bias >= 0 ? "+" : ""}${bias} (RSI<${rsi})`, trades, CONFIG.ORDER_USDT);
    }
    console.log(`${"─".repeat(65)}\n`);
    return;
  }

  // ADAPTIVE MARKET_BIAS 모드
  if (ADAPTIVE_TEST) {
    const period = ADAPTIVE_PERIOD;
    console.log(`\n${"═".repeat(75)}`);
    console.log(` ▶ ADAPTIVE BIAS 테스트  |  ${period.start} ~ ${period.end}  (전주 수익→-5, 손실→+5 / 평균회귀)`);
    console.log(`  대상: 거래량 ${CONFIG.UNRANKED_LIMIT + 1}위~ ${unrankedRest.length}개`);
    console.log(`${"═".repeat(75)}`);

    // 주별 날짜 범위 생성
    const weeks = [];
    let cur = new Date(period.start + "T00:00:00Z");
    const periodEnd = new Date(period.end + "T23:59:59Z");
    while (cur <= periodEnd) {
      const wStart = new Date(cur);
      const wEnd   = new Date(cur);
      wEnd.setUTCDate(wEnd.getUTCDate() + 6);
      if (wEnd > periodEnd) wEnd.setTime(periodEnd.getTime());
      weeks.push({ start: wStart.toISOString().slice(0, 10), end: wEnd.toISOString().slice(0, 10) });
      cur.setUTCDate(cur.getUTCDate() + 7);
    }

    // 전 기간 캔들 한번에 로드
    const klinesMap = {};
    for (let i = 0; i < unrankedRest.length; i++) {
      process.stdout.write(`\r  캔들 로드 중: ${i + 1}/${unrankedRest.length} (${unrankedRest[i]})          `);
      try { klinesMap[unrankedRest[i]] = await getKlinesPaged(unrankedRest[i], period.start, period.end); } catch (_) {}
      await sleep(300);
    }
    console.log(`\n`);

    // 주별 시뮬레이션
    console.log(`${"─".repeat(75)}`);
    console.log(` ${"주차".padEnd(22)} ${"BIAS".padStart(6)} ${"거래".padStart(5)}   ${"익절".padStart(4)}   ${"손절".padStart(4)}   ${"승률".padStart(6)}   ${"손익".padStart(13)}`);
    console.log(`${"─".repeat(75)}`);

    let bias = 0;
    let totalPnl = 0;
    const totalTrades = [];
    let monthTrades = [];
    let curMonth = weeks[0]?.start.slice(0, 7);

    function flushMonth(label) {
      const tp  = monthTrades.filter(t => t.action === "TP").length;
      const sl  = monthTrades.filter(t => t.action === "SL").length;
      const pnl = monthTrades.reduce((s, t) => s + t.pnl, 0);
      const wr  = monthTrades.length ? (tp / monthTrades.length * 100).toFixed(1) : "0.0";
      const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT";
      console.log(`${"─".repeat(75)}`);
      console.log(` ${label.padEnd(22)} ${"".padStart(6)} ${String(monthTrades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
      console.log(`${"─".repeat(75)}`);
      monthTrades = [];
    }

    for (let w = 0; w < weeks.length; w++) {
      const wk = weeks[w];
      const wkMonth = wk.start.slice(0, 7);
      if (wkMonth !== curMonth) {
        flushMonth(`[${curMonth} 합계]`);
        curMonth = wkMonth;
      }
      const rsi = CONFIG.RSI_THRESHOLD + bias;
      const wkStartMs = new Date(wk.start + "T00:00:00Z").getTime();
      const wkEndMs   = new Date(wk.end   + "T23:59:59Z").getTime();
      const trades = [];
      for (const sym of unrankedRest) {
        if (!klinesMap[sym]) continue;
        simulateSymbol(sym, klinesMap[sym], rsi, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
          .filter(t => t.time >= wkStartMs && t.time <= wkEndMs)
          .forEach(t => trades.push(t));
      }
      const tp  = trades.filter(t => t.action === "TP").length;
      const sl  = trades.filter(t => t.action === "SL").length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "0.0";
      const label    = `${wk.start.slice(5)} ~ ${wk.end.slice(5)}`;
      const biasStr  = (bias >= 0 ? "+" : "") + bias;
      const pnlStr   = (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT";
      console.log(` ${label.padEnd(22)} ${biasStr.padStart(6)} ${String(trades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
      monthTrades.push(...trades);
      totalTrades.push(...trades);
      totalPnl += pnl;
      bias = pnl >= 0 ? -5 : 5;  // 평균회귀: 전주 수익→보수적, 전주 손실→공격적
    }
    if (monthTrades.length) flushMonth(`[${curMonth} 합계]`);
    console.log(`${"─".repeat(75)}`);
    {
      const tp = totalTrades.filter(t => t.action === "TP").length;
      const sl = totalTrades.filter(t => t.action === "SL").length;
      const wr = totalTrades.length ? (tp / totalTrades.length * 100).toFixed(1) : "0.0";
      const pnlStr = (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(0) + " USDT";
      console.log(` ${"[전체 합계]".padEnd(22)} ${"".padStart(6)} ${String(totalTrades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
    }
    console.log(`${"─".repeat(75)}\n`);

    // BIAS=0 고정 비교 (참고용)
    const periodStartMs = new Date(period.start + "T00:00:00Z").getTime();
    const periodEndMs   = new Date(period.end   + "T23:59:59Z").getTime();
    const fixedTrades = [];
    for (const sym of unrankedRest) {
      if (!klinesMap[sym]) continue;
      simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
        .filter(t => t.time >= periodStartMs && t.time <= periodEndMs)
        .forEach(t => fixedTrades.push(t));
    }
    console.log(` [참고] BIAS 0 고정 (RSI<${CONFIG.RSI_THRESHOLD}):`);
    printSummary(`BIAS 0 전체`, fixedTrades, CONFIG.ORDER_USDT);
    console.log();
    return;
  }

  // ETH 주봉 RSI 필터 모드
  if (ETH_RSI_TEST) {
    const period = ETH_RSI_PERIOD;
    console.log(`\n${"═".repeat(85)}`);
    console.log(` ▶ ETH 주봉 RSI 필터  |  ${period.start} ~ ${period.end}`);
    console.log(`  조건: ETH 주봉 RSI > 전주 RSI → 알트 매수 허용`);
    console.log(`  대상: 거래량 ${CONFIG.UNRANKED_LIMIT + 1}위~ ${unrankedRest.length}개`);
    console.log(`${"═".repeat(85)}`);

    // ETH 주봉 캔들 로드 (RSI 워밍업 16주 포함)
    const ethWarmupMs = new Date(period.start + "T00:00:00Z").getTime() - 16 * 7 * 24 * 3600 * 1000;
    const ethEndMs    = new Date(period.end   + "T23:59:59Z").getTime();
    const ethRaw = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=ETHUSDT&interval=1w&startTime=${ethWarmupMs}&endTime=${ethEndMs}&limit=200`);
    const ethWeekly = ethRaw.map(k => ({ openTime: k[0], close: parseFloat(k[4]) }));

    // 특정 시점 기준 ETH 주봉 RSI 반환 (해당 시점 이전 완료된 캔들만 사용)
    function ethRsiAt(beforeMs) {
      const closed = ethWeekly.filter(k => k.openTime < beforeMs);
      if (closed.length < 16) return null;
      return calcRSI(closed.map(k => k.close), 14);
    }

    // 주차 생성
    const weeks = [];
    let cur = new Date(period.start + "T00:00:00Z");
    const periodEnd = new Date(period.end + "T23:59:59Z");
    while (cur <= periodEnd) {
      const wStart = new Date(cur);
      const wEnd   = new Date(cur);
      wEnd.setUTCDate(wEnd.getUTCDate() + 6);
      if (wEnd > periodEnd) wEnd.setTime(periodEnd.getTime());
      weeks.push({ start: wStart.toISOString().slice(0, 10), end: wEnd.toISOString().slice(0, 10) });
      cur.setUTCDate(cur.getUTCDate() + 7);
    }

    // 알트 캔들 로드
    const klinesMap = {};
    for (let i = 0; i < unrankedRest.length; i++) {
      process.stdout.write(`\r  캔들 로드 중: ${i + 1}/${unrankedRest.length} (${unrankedRest[i]})          `);
      try { klinesMap[unrankedRest[i]] = await getKlinesPaged(unrankedRest[i], period.start, period.end); } catch (_) {}
      await sleep(300);
    }
    console.log(`\n`);

    const W = 85;
    console.log(`${"─".repeat(W)}`);
    console.log(` ${"주차".padEnd(22)} ${"ETH RSI".padStart(8)} ${"상태".padStart(5)} ${"거래".padStart(5)}   ${"익절".padStart(4)}   ${"손절".padStart(4)}   ${"승률".padStart(6)}   ${"손익".padStart(13)}`);
    console.log(`${"─".repeat(W)}`);

    let totalPnl = 0;
    const totalTrades = [];
    let mTrades = [];
    let curMonth = weeks[0]?.start.slice(0, 7);
    let prevRsi  = null;

    function flushEthMonth(label) {
      const tp  = mTrades.filter(t => t.action === "TP").length;
      const sl  = mTrades.filter(t => t.action === "SL").length;
      const pnl = mTrades.reduce((s, t) => s + t.pnl, 0);
      const wr  = mTrades.length ? (tp / mTrades.length * 100).toFixed(1) : "0.0";
      const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT";
      console.log(`${"─".repeat(W)}`);
      console.log(` ${label.padEnd(22)} ${"".padStart(8)} ${"".padStart(5)} ${String(mTrades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
      console.log(`${"─".repeat(W)}`);
      mTrades = [];
    }

    for (const wk of weeks) {
      const wkMonth  = wk.start.slice(0, 7);
      if (wkMonth !== curMonth) { flushEthMonth(`[${curMonth} 합계]`); curMonth = wkMonth; }

      const wkStartMs = new Date(wk.start + "T00:00:00Z").getTime();
      const wkEndMs   = new Date(wk.end   + "T23:59:59Z").getTime();

      const rsi = ethRsiAt(wkStartMs);
      const rsiStr  = rsi !== null ? rsi.toFixed(1) : " N/A";
      const allowed = rsi !== null && prevRsi !== null && rsi > prevRsi;
      const status  = allowed ? "매수" : "스킵";

      const trades = [];
      if (allowed) {
        for (const sym of unrankedRest) {
          if (!klinesMap[sym]) continue;
          simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
            .filter(t => t.time >= wkStartMs && t.time <= wkEndMs)
            .forEach(t => trades.push(t));
        }
      }
      const tp  = trades.filter(t => t.action === "TP").length;
      const sl  = trades.filter(t => t.action === "SL").length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "-";
      const label   = `${wk.start.slice(5)} ~ ${wk.end.slice(5)}`;
      const pnlStr  = trades.length ? (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT" : "-";
      console.log(` ${label.padEnd(22)} ${rsiStr.padStart(8)} ${status.padStart(5)} ${String(trades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${wr.padStart(6)}   ${pnlStr.padStart(13)}`);

      mTrades.push(...trades);
      totalTrades.push(...trades);
      totalPnl += pnl;
      if (rsi !== null) prevRsi = rsi;
    }
    flushEthMonth(`[${curMonth} 합계]`);
    console.log(` ${"[전체 합계]".padEnd(22)} ${"".padStart(8)} ${"".padStart(5)} ${String(totalTrades.length).padStart(5)}   ${String(totalTrades.filter(t=>t.action==="TP").length).padStart(4)}   ${String(totalTrades.filter(t=>t.action==="SL").length).padStart(4)}   ${(totalTrades.length?(totalTrades.filter(t=>t.action==="TP").length/totalTrades.length*100).toFixed(1)+"%" : "0.0%").padStart(6)}   ${((totalPnl>=0?"+":"")+totalPnl.toFixed(0)+" USDT").padStart(13)}`);
    console.log(`${"─".repeat(W)}\n`);

    // 필터 없음 비교
    const pStartMs = new Date(period.start + "T00:00:00Z").getTime();
    const pEndMs   = new Date(period.end   + "T23:59:59Z").getTime();
    const noFilterTrades = [];
    for (const sym of unrankedRest) {
      if (!klinesMap[sym]) continue;
      simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
        .filter(t => t.time >= pStartMs && t.time <= pEndMs)
        .forEach(t => noFilterTrades.push(t));
    }
    console.log(` [참고] 필터 없음:`);
    printSummary(`BIAS 0 전체`, noFilterTrades, CONFIG.ORDER_USDT);
    console.log();
    return;
  }

  // ETH/BTC 비율 방향 필터 모드
  if (ETHBTC_TEST) {
    const period = ETH_RSI_PERIOD;
    console.log(`\n${"═".repeat(85)}`);
    console.log(` ▶ ETH/BTC 비율 필터  |  ${period.start} ~ ${period.end}`);
    console.log(`  조건: ETH/BTC 주봉 close > 전주 → 알트 매수 허용`);
    console.log(`  대상: 거래량 ${CONFIG.UNRANKED_LIMIT + 1}위~ ${unrankedRest.length}개`);
    console.log(`${"═".repeat(85)}`);

    // ETH, BTC 주봉 캔들 로드
    const warmupMs  = new Date(period.start + "T00:00:00Z").getTime() - 4 * 7 * 24 * 3600 * 1000;
    const endMs     = new Date(period.end   + "T23:59:59Z").getTime();
    const [ethRaw, btcRaw] = await Promise.all([
      httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=ETHUSDT&interval=1w&startTime=${warmupMs}&endTime=${endMs}&limit=200`),
      httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=BTCUSDT&interval=1w&startTime=${warmupMs}&endTime=${endMs}&limit=200`),
    ]);
    // ETH/BTC 비율 맵 생성 (openTime → ratio)
    const btcMap = {};
    for (const k of btcRaw) btcMap[k[0]] = parseFloat(k[4]);
    const ethbtcWeekly = ethRaw
      .filter(k => btcMap[k[0]])
      .map(k => ({ openTime: k[0], ratio: parseFloat(k[4]) / btcMap[k[0]] }));

    function ethbtcAt(beforeMs) {
      const closed = ethbtcWeekly.filter(k => k.openTime < beforeMs);
      return closed.length >= 2 ? closed[closed.length - 1].ratio : null;
    }
    function ethbtcPrevAt(beforeMs) {
      const closed = ethbtcWeekly.filter(k => k.openTime < beforeMs);
      return closed.length >= 2 ? closed[closed.length - 2].ratio : null;
    }

    // 주차 생성
    const weeks = [];
    let cur = new Date(period.start + "T00:00:00Z");
    const periodEnd = new Date(period.end + "T23:59:59Z");
    while (cur <= periodEnd) {
      const wStart = new Date(cur), wEnd = new Date(cur);
      wEnd.setUTCDate(wEnd.getUTCDate() + 6);
      if (wEnd > periodEnd) wEnd.setTime(periodEnd.getTime());
      weeks.push({ start: wStart.toISOString().slice(0, 10), end: wEnd.toISOString().slice(0, 10) });
      cur.setUTCDate(cur.getUTCDate() + 7);
    }

    // 알트 캔들 로드
    const klinesMap = {};
    for (let i = 0; i < unrankedRest.length; i++) {
      process.stdout.write(`\r  캔들 로드 중: ${i + 1}/${unrankedRest.length} (${unrankedRest[i]})          `);
      try { klinesMap[unrankedRest[i]] = await getKlinesPaged(unrankedRest[i], period.start, period.end); } catch (_) {}
      await sleep(300);
    }
    console.log(`\n`);

    const W = 85;
    console.log(`${"─".repeat(W)}`);
    console.log(` ${"주차".padEnd(22)} ${"ETH/BTC".padStart(9)} ${"상태".padStart(5)} ${"거래".padStart(5)}   ${"익절".padStart(4)}   ${"손절".padStart(4)}   ${"승률".padStart(6)}   ${"손익".padStart(13)}`);
    console.log(`${"─".repeat(W)}`);

    let totalPnl = 0;
    const totalTrades = [];
    let mTrades = [], curMonth = weeks[0]?.start.slice(0, 7);

    function flushEthbtcMonth(label) {
      const tp = mTrades.filter(t => t.action === "TP").length;
      const sl = mTrades.filter(t => t.action === "SL").length;
      const pnl = mTrades.reduce((s, t) => s + t.pnl, 0);
      const wr = mTrades.length ? (tp / mTrades.length * 100).toFixed(1) : "0.0";
      const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT";
      console.log(`${"─".repeat(W)}`);
      console.log(` ${label.padEnd(22)} ${"".padStart(9)} ${"".padStart(5)} ${String(mTrades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${(wr + "%").padStart(6)}   ${pnlStr.padStart(13)}`);
      console.log(`${"─".repeat(W)}`);
      mTrades = [];
    }

    for (const wk of weeks) {
      const wkMonth  = wk.start.slice(0, 7);
      if (wkMonth !== curMonth) { flushEthbtcMonth(`[${curMonth} 합계]`); curMonth = wkMonth; }

      const wkStartMs = new Date(wk.start + "T00:00:00Z").getTime();
      const wkEndMs   = new Date(wk.end   + "T23:59:59Z").getTime();

      const cur  = ethbtcAt(wkStartMs);
      const prev = ethbtcPrevAt(wkStartMs);
      const allowed = cur !== null && prev !== null && cur > prev;
      const ratioStr = cur !== null ? cur.toFixed(5) : "  N/A";
      const status   = allowed ? "매수" : "스킵";

      const trades = [];
      if (allowed) {
        for (const sym of unrankedRest) {
          if (!klinesMap[sym]) continue;
          simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
            .filter(t => t.time >= wkStartMs && t.time <= wkEndMs)
            .forEach(t => trades.push(t));
        }
      }
      const tp  = trades.filter(t => t.action === "TP").length;
      const sl  = trades.filter(t => t.action === "SL").length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "-";
      const label  = `${wk.start.slice(5)} ~ ${wk.end.slice(5)}`;
      const pnlStr = trades.length ? (pnl >= 0 ? "+" : "") + pnl.toFixed(0) + " USDT" : "-";
      console.log(` ${label.padEnd(22)} ${ratioStr.padStart(9)} ${status.padStart(5)} ${String(trades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${wr.padStart(6)}   ${pnlStr.padStart(13)}`);

      mTrades.push(...trades);
      totalTrades.push(...trades);
      totalPnl += pnl;
    }
    flushEthbtcMonth(`[${curMonth} 합계]`);
    {
      const tp = totalTrades.filter(t => t.action === "TP").length;
      const sl = totalTrades.filter(t => t.action === "SL").length;
      const wr = totalTrades.length ? (tp / totalTrades.length * 100).toFixed(1) + "%" : "0.0%";
      const pnlStr = (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(0) + " USDT";
      console.log(` ${"[전체 합계]".padEnd(22)} ${"".padStart(9)} ${"".padStart(5)} ${String(totalTrades.length).padStart(5)}   ${String(tp).padStart(4)}   ${String(sl).padStart(4)}   ${wr.padStart(6)}   ${pnlStr.padStart(13)}`);
    }
    console.log(`${"─".repeat(W)}\n`);

    // 필터 없음 비교
    const pStartMs = new Date(period.start + "T00:00:00Z").getTime();
    const pEndMs   = new Date(period.end   + "T23:59:59Z").getTime();
    const noFilterTrades = [];
    for (const sym of unrankedRest) {
      if (!klinesMap[sym]) continue;
      simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)
        .filter(t => t.time >= pStartMs && t.time <= pEndMs)
        .forEach(t => noFilterTrades.push(t));
    }
    console.log(` [참고] 필터 없음:`);
    printSummary(`BIAS 0 전체`, noFilterTrades, CONFIG.ORDER_USDT);
    console.log();
    return;
  }

  // 기간별 실행
  for (const period of PERIODS) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(` ▶ ${period.label}  (${period.start} ~ ${period.end})`);
    console.log(`${"═".repeat(70)}`);

    // 캔들 로드
    const klinesMap = {};
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      process.stdout.write(`\r  캔들 로드 중: ${i + 1}/${symbols.length} (${sym})          `);
      try {
        klinesMap[sym] = await getKlinesPaged(sym, period.start, period.end);
      } catch (e) {
        process.stdout.write(`\n  [SKIP] ${sym}: ${e.message}\n`);
      }
      await sleep(300);
    }
    console.log(`\n`);

    console.log(`${"─".repeat(70)}`);
    console.log(` ${"그룹".padEnd(22)} ${"거래".padStart(5)}   ${"익절".padStart(4)}   ${"손절".padStart(4)}   ${"승률".padStart(6)}   ${"손익".padStart(13)}`);
    console.log(`${"─".repeat(70)}`);

    const topTrades  = [];
    const restTrades = [];
    for (const sym of unrankedTop)  { if (klinesMap[sym]) topTrades.push( ...simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)); }
    for (const sym of unrankedRest) { if (klinesMap[sym]) restTrades.push(...simulateSymbol(sym, klinesMap[sym], CONFIG.RSI_THRESHOLD, CONFIG.BB_FROM_LOWER, CONFIG.ORDER_USDT)); }
    printSummary(`상위 ${CONFIG.UNRANKED_LIMIT}개`, topTrades,  CONFIG.ORDER_USDT);
    printSummary(`${CONFIG.UNRANKED_LIMIT + 1}위~`,  restTrades, CONFIG.ORDER_USDT);
    console.log(`${"─".repeat(70)}`);
  }
  console.log();
}

main().catch(e => console.error("에러:", e.message));
