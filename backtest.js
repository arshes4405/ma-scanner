const https = require("https");

const VERSION = "2026-05-03 v5";

const CONFIG = {
  BASE_URL:      "https://fapi.binance.com",
  INTERVAL:      "1h",
  MONTHS:        6,          // 백테스트 기간 (개월)
  RSI_PERIOD:    14,
  RSI_THRESHOLD: 35,
  RSI_THRESHOLD_MAJOR: 45,
  RSI_CUR_DELTA: 5,          // rsi + 2 + floor(30min/10) = rsi+5 (mid-candle 근사)
  MAJOR_SYMBOLS: ["ETHUSDT", "HYPEUSDT"],
  ORDER_USDT:    10000,
  TP_PCT:        5,          // 익절 (전량)
  SL_PCT:        3,          // 손절
  CAPITAL:       5000,
  SAMPLE_SIZE:   50,
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
  const intervalMs = 60 * 60 * 1000; // 1h
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

function calcBollingerLower(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return mean - mult * std;
}

function calcBollingerThreshold(closes, period = 20, mult = 2, fromLower = 0) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const mean   = slice.reduce((s, v) => s + v, 0) / period;
  const std    = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const lower  = mean - mult * std;
  // fromLower=0: 하단, fromLower=0.33: 하단에서 중단 방향 33% 지점
  return lower + (mean - lower) * fromLower;
}

function checkEntry(klines, i, rsiThreshold = CONFIG.RSI_THRESHOLD, bbFromLower = 0) {
  if (i < 150) return false;
  const cur  = klines[i];
  const prev = klines[i - 1];

  if (cur.close <= cur.open)  return false;  // 현재봉 양봉
  if (prev.close >= prev.open) return false; // 직전봉 음봉

  const prevCloses = klines.slice(0, i).map(k => k.close);
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= rsiThreshold) return false;

  const curCloses = klines.slice(0, i + 1).map(k => k.close);
  const curRsi = calcRSI(curCloses, CONFIG.RSI_PERIOD);
  const curRsiMax = rsi + CONFIG.RSI_CUR_DELTA;
  if (curRsi === null || curRsi >= curRsiMax) return false;

  const prevMid = (prev.high + prev.low) / 2;
  if (cur.close > prevMid) return false;

  const bbThreshold = calcBollingerThreshold(prevCloses, 20, 2, bbFromLower);
  const prevAvg = (prev.low + prev.close) / 2;
  if (!bbThreshold || prevAvg >= bbThreshold) return false;

  return true;
}

function simulateSymbol(symbol, klines, rsiThreshold = CONFIG.RSI_THRESHOLD, bbFromLower = 0) {
  const trades = [];
  const startIdx = 150;
  const endIdx   = klines.length - 1;
  let openPos    = null;

  for (let i = startIdx; i <= endIdx; i++) {
    const k = klines[i];

    if (openPos) {
      const slPrice = openPos.entry * (1 - CONFIG.SL_PCT / 100);
      const tpPrice = openPos.entry * (1 + CONFIG.TP_PCT  / 100);

      if (k.low <= slPrice && k.high >= tpPrice) {
        trades.push({ symbol, action: "SL", pnl: +(CONFIG.ORDER_USDT * -CONFIG.SL_PCT / 100).toFixed(2), time: k.openTime });
        openPos = null;
      } else if (k.low <= slPrice) {
        trades.push({ symbol, action: "SL", pnl: +(CONFIG.ORDER_USDT * -CONFIG.SL_PCT / 100).toFixed(2), time: k.openTime });
        openPos = null;
      } else if (k.high >= tpPrice) {
        trades.push({ symbol, action: "TP", pnl: +(CONFIG.ORDER_USDT * CONFIG.TP_PCT / 100).toFixed(2), time: k.openTime });
        openPos = null;
      }
    }

    if (!openPos && checkEntry(klines, i, rsiThreshold, bbFromLower)) {
      openPos = { entry: k.close };
    }
  }

  return trades;
}

async function main() {
  console.log(`[백테스트 ${VERSION}] ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log("심볼 목록 조회 중...");
  const samples = CONFIG.MAJOR_SYMBOLS;
  console.log(`메이저 코인 (${samples.length}개): ${samples.join(", ")}\n`);

  // 캔들 미리 로드
  const klinesMap = {};
  for (const sym of samples) {
    process.stdout.write(`  ${sym} 캔들 조회 중...`);
    klinesMap[sym] = await getKlinesPaged(sym);
    console.log(` ${klinesMap[sym].length}개`);
    await sleep(100);
  }

  const TESTS = [
    { label: "RSI<45 BB하단",      rsi: 45, bb: 0    },
    { label: "RSI<45 BB+33%",      rsi: 45, bb: 0.33 },
  ];
  const summary = [];

  for (const t of TESTS) {
    const allTrades = [];
    for (const sym of samples) {
      allTrades.push(...simulateSymbol(sym, klinesMap[sym], t.rsi, t.bb));
    }
    const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
    const tpCount  = allTrades.filter(t => t.action === "TP").length;
    const slCount  = allTrades.filter(t => t.action === "SL").length;
    const winRate  = allTrades.length ? (tpCount / allTrades.length * 100).toFixed(1) : 0;
    summary.push({ ...t, trades: allTrades.length, tpCount, slCount, winRate, totalPnl });
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(` 조건                  거래   익절   손절     승률        손익`);
  console.log(`${"─".repeat(66)}`);
  for (const s of summary) {
    const pnlStr = (s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toFixed(0) + " USDT";
    console.log(` ${s.label.padEnd(20)} ${String(s.trades).padStart(4)}   ${String(s.tpCount).padStart(4)}   ${String(s.slCount).padStart(4)}   ${(s.winRate + "%").padStart(6)}   ${pnlStr.padStart(12)}`);
  }
  console.log(`${"─".repeat(66)}\n`);

  // 가장 좋은 조건으로 월별 상세 출력
  const best = summary.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
  console.log(`▶ 최적 조건 [${best.label}] 월별 상세:`);
  const allTrades = [];
  for (const sym of samples) {
    allTrades.push(...simulateSymbol(sym, klinesMap[sym], best.rsi, best.bb));
  }

  // 전체 요약
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const slCount  = allTrades.filter(t => t.action === "SL").length;
  const tpCount  = allTrades.filter(t => t.action === "TP").length;
  const winRate  = allTrades.length ? (tpCount / allTrades.length * 100).toFixed(1) : 0;
  const finalBal = CONFIG.CAPITAL + totalPnl;

  console.log(`\n${"─".repeat(55)}`);
  console.log(` 기간        : 최근 ${CONFIG.MONTHS}개월 (1시간봉)`);
  console.log(` 시작 자금   : $${CONFIG.CAPITAL.toLocaleString()}`);
  console.log(` 트레이드    : ${allTrades.length}건 | 승률 ${winRate}%`);
  console.log(` 익절(+${CONFIG.TP_PCT}%)  : ${tpCount}건 | 손절(-${CONFIG.SL_PCT}%): ${slCount}건`);
  console.log(` 실현 손익   : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
  console.log(` 최종 잔고   : $${finalBal.toFixed(2)}`);
  console.log(` 수익률      : ${((finalBal / CONFIG.CAPITAL - 1) * 100).toFixed(1)}%`);
  console.log(`${"─".repeat(55)}`);

  // 월별 집계
  const monthly = {};
  for (const t of allTrades) {
    const d   = new Date(t.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthly[key]) monthly[key] = { pnl: 0, tp: 0, sl: 0 };
    monthly[key].pnl += t.pnl;
    if (t.action === "TP") monthly[key].tp++;
    else monthly[key].sl++;
  }
  console.log(`\n [월별 손익]`);
  console.log(` ${"월".padEnd(10)} ${"거래".padStart(4)} ${"승률".padStart(7)} ${"손익".padStart(14)}`);
  console.log(` ${"─".repeat(38)}`);
  for (const [month, m] of Object.entries(monthly).sort()) {
    const total   = m.tp + m.sl;
    const wr      = (m.tp / total * 100).toFixed(1);
    const pnlStr  = (m.pnl >= 0 ? "+" : "") + m.pnl.toFixed(2) + " USDT";
    console.log(` ${month.padEnd(10)} ${String(total).padStart(4)} ${(wr + "%").padStart(7)} ${pnlStr.padStart(14)}`);
  }
  console.log();
}

main().catch(e => console.error("에러:", e.message));
