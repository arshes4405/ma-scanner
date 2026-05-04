const https = require("https");

const VERSION = "2026-05-03 v2";

const CONFIG = {
  BASE_URL:      "https://fapi.binance.com",
  INTERVAL:      "1h",
  MONTHS:        6,
  RSI_PERIOD:    14,
  RSI_THRESHOLD: 35,
  RSI_CUR_DELTA: 5,   // rsi + 2 + floor(30min/10) = rsi+5 (mid-candle 근사)
  ORDER_USDT:    1000,
  TP_PCT:        5,
  SL_PCT:        3,
  MIN_TRADES:    3,   // 최소 거래 수 (통계 신뢰도)
  TOP_N:         20,  // 워스트 출력 개수
};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getKlinesPaged(symbol) {
  const INDICATOR_CANDLES = 150;
  const BATCH = 1500;
  const intervalMs = 60 * 60 * 1000;
  const totalNeeded = CONFIG.MONTHS * 30 * 24 + INDICATOR_CANDLES;
  const startTime = Date.now() - totalNeeded * intervalMs;

  const all = [];
  let from = startTime;
  while (all.length < totalNeeded) {
    const url = `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${CONFIG.INTERVAL}&startTime=${from}&limit=${BATCH}`;
    const raw = await httpGet(url);
    if (!raw.length) break;
    all.push(...raw);
    from = raw[raw.length - 1][0] + intervalMs;
    if (raw.length < BATCH) break;
    await sleep(80);
  }
  return all.map(k => ({
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

function calcBollingerLower(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return mean - mult * std;
}

function checkEntry(klines, i) {
  if (i < 150) return false;
  const cur  = klines[i];
  const prev = klines[i - 1];
  if (cur.close <= cur.open)   return false;
  if (prev.close >= prev.open) return false;
  const prevCloses = klines.slice(0, i).map(k => k.close);
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= CONFIG.RSI_THRESHOLD) return false;
  const curCloses = klines.slice(0, i + 1).map(k => k.close);
  const curRsi = calcRSI(curCloses, CONFIG.RSI_PERIOD);
  if (curRsi === null || curRsi >= rsi + CONFIG.RSI_CUR_DELTA) return false;
  const prevMid = (prev.high + prev.low) / 2;
  if (cur.close > prevMid) return false;
  const bbLower = calcBollingerLower(prevCloses);
  const prevAvg = (prev.low + prev.close) / 2;
  if (!bbLower || prevAvg >= bbLower) return false;
  return true;
}

function simulateSymbol(klines) {
  const trades = [];
  let openPos  = null;

  for (let i = 150; i < klines.length; i++) {
    const k = klines[i];

    if (openPos) {
      const slPrice = openPos.entry * (1 - CONFIG.SL_PCT / 100);
      const tpPrice = openPos.entry * (1 + CONFIG.TP_PCT  / 100);

      if (k.low <= slPrice && k.high >= tpPrice) {
        trades.push({ action: "SL", pnl: +(CONFIG.ORDER_USDT * -CONFIG.SL_PCT / 100).toFixed(2) });
        openPos = null;
      } else if (k.low <= slPrice) {
        trades.push({ action: "SL", pnl: +(CONFIG.ORDER_USDT * -CONFIG.SL_PCT / 100).toFixed(2) });
        openPos = null;
      } else if (k.high >= tpPrice) {
        trades.push({ action: "TP", pnl: +(CONFIG.ORDER_USDT * CONFIG.TP_PCT / 100).toFixed(2) });
        openPos = null;
      }
    }

    if (!openPos && checkEntry(klines, i)) {
      openPos = { entry: k.close };
    }
  }

  return trades;
}

async function main() {
  console.log(`[findBadCoins ${VERSION}] ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log("전체 종목 조회 중...");

  const info = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const allSymbols = info.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);

  console.log(`총 ${allSymbols.length}개 종목 스캔 시작\n`);

  const results = [];

  for (let i = 0; i < allSymbols.length; i++) {
    const sym = allSymbols[i];
    process.stdout.write(`\r진행: ${i + 1}/${allSymbols.length} (${sym.padEnd(20)})`);

    try {
      const klines = await getKlinesPaged(sym);

      const trades = simulateSymbol(klines);
      if (trades.length < CONFIG.MIN_TRADES) { await sleep(80); continue; }

      const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
      const slCount   = trades.filter(t => t.action === "SL").length;
      const winRate   = (trades.filter(t => t.action === "TP").length / trades.length * 100);

      results.push({ sym, trades: trades.length, winRate, totalPnl, slCount });
    } catch (_) {}

    await sleep(80);
  }

  console.log(`\n\n스캔 완료. 유효 종목: ${results.length}개\n`);

  const printTable = (list) => {
    console.log(`${"─".repeat(58)}`);
    console.log(` ${"심볼".padEnd(20)} ${"거래".padStart(4)} ${"승률".padStart(7)} ${"손익".padStart(14)}`);
    console.log(`${"─".repeat(58)}`);
    for (const r of list) {
      const pnlStr = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2) + " USDT";
      console.log(` ${r.sym.padEnd(20)} ${String(r.trades).padStart(4)} ${(r.winRate.toFixed(1) + "%").padStart(7)} ${pnlStr.padStart(14)}`);
    }
  };

  // 손실 종목 전체 (손익 기준 오름차순)
  const losers = results.filter(r => r.totalPnl < 0).sort((a, b) => a.totalPnl - b.totalPnl);
  // 손익 워스트 TOP_N
  const worstPnl = [...results].sort((a, b) => a.totalPnl - b.totalPnl).slice(0, CONFIG.TOP_N);

  console.log(`▶ 손실 종목 전체 (${losers.length}개 / 유효 ${results.length}개)`);
  printTable(losers);

  console.log(`\n▶ 손익 워스트 ${CONFIG.TOP_N}`);
  printTable(worstPnl);

  console.log(`\n▶ 제외 추천 심볼 목록`);
  console.log(losers.map(r => `"${r.sym}"`).join(", "));
}

main().catch(e => console.error("에러:", e.message));
