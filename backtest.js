const https = require("https");

const VERSION = "2026-05-05 v10";

const PERIODS = [
  { label: "하락장 (1~2월)", start: "2026-01-01", end: "2026-02-28" },
  { label: "상승장 (3~4월)", start: "2026-03-01", end: "2026-04-30" },
];

const COMPARE_VOLUME = true;  // true: 거래량 상위250 vs 나머지 비교 (메이저/티어 제외)

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
  const unrankedTop  = unrankedAll.slice(0, CONFIG.UNRANKED_LIMIT);
  const unrankedRest = unrankedAll.slice(CONFIG.UNRANKED_LIMIT);
  const symbols = unrankedAll;
  console.log(`대상: 언랭 전체 ${unrankedAll.length}개 (상위${CONFIG.UNRANKED_LIMIT} vs 나머지 ${unrankedRest.length}개)\n`);

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
