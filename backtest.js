const https = require("https");

const VERSION = "2026-05-03 v1";

const CONFIG = {
  BASE_URL:      "https://fapi.binance.com",
  INTERVAL:      "1h",
  CANDLE_LIMIT:  720 + 150,  // 30일(720) + 지표 계산용(150)
  RSI_PERIOD:    14,
  RSI_THRESHOLD: 35,
  RSI_CUR_MAX:   38,         // 현재봉 RSI 임계값 (mid-candle 근사치)
  ORDER_USDT:    1000,
  LEVERAGE:      20,
  TP_PCT:        5,
  SL_PCT:        3,
  CAPITAL:       5000,
  MAX_POSITIONS: 5,          // 동시 최대 포지션 (5000 / 1000)
  SAMPLE_SIZE:   10,
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

  if (cur.close <= cur.open)  return false;  // 현재봉 양봉
  if (prev.close >= prev.open) return false; // 직전봉 음봉

  const prevCloses = klines.slice(0, i).map(k => k.close);
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= CONFIG.RSI_THRESHOLD) return false;

  const curCloses = klines.slice(0, i + 1).map(k => k.close);
  const curRsi = calcRSI(curCloses, CONFIG.RSI_PERIOD);
  if (curRsi === null || curRsi >= CONFIG.RSI_CUR_MAX) return false;

  const prevMid = (prev.high + prev.low) / 2;
  if (cur.close > prevMid) return false;

  const bbLower = calcBollingerLower(prevCloses);
  const prevAvg = (prev.low + prev.close) / 2;
  if (!bbLower || prevAvg >= bbLower) return false;

  return true;
}

function simulateSymbol(symbol, klines) {
  const trades = [];
  const startIdx = 150;
  const endIdx   = klines.length - 1;
  let openPos    = null;

  for (let i = startIdx; i <= endIdx; i++) {
    const k = klines[i];

    // 포지션 청산 체크
    if (openPos) {
      const tpPrice = openPos.entry * (1 + CONFIG.TP_PCT / 100);
      const slPrice = openPos.entry * (1 - CONFIG.SL_PCT / 100);

      let exitPrice = null, action = null;

      if (k.low <= slPrice && k.high >= tpPrice) {
        // 같은 봉에 SL/TP 둘 다 → 보수적으로 SL
        exitPrice = slPrice; action = "SL";
      } else if (k.low <= slPrice) {
        exitPrice = slPrice; action = "SL";
      } else if (k.high >= tpPrice) {
        exitPrice = tpPrice; action = "TP";
      }

      if (exitPrice) {
        const pnl = CONFIG.ORDER_USDT * (exitPrice - openPos.entry) / openPos.entry;
        trades.push({ symbol, action, entry: openPos.entry, exit: exitPrice, pnl: +pnl.toFixed(2) });
        openPos = null;
      }
    }

    // 진입 체크 (포지션 없을 때만)
    if (!openPos && checkEntry(klines, i)) {
      openPos = { entry: k.close, entryIdx: i };
    }
  }

  return trades;
}

async function main() {
  console.log(`[백테스트 ${VERSION}] ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log("심볼 목록 조회 중...");
  const info = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const allSymbols = info.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);

  // 랜덤 10개 선택
  const shuffled = allSymbols.sort(() => Math.random() - 0.5);
  const samples  = shuffled.slice(0, CONFIG.SAMPLE_SIZE);
  console.log(`\n샘플 심볼 (${CONFIG.SAMPLE_SIZE}개): ${samples.join(", ")}\n`);

  const allTrades = [];

  for (const sym of samples) {
    process.stdout.write(`  ${sym} 캔들 조회 중...`);
    const raw = await httpGet(
      `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${sym}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.CANDLE_LIMIT}`
    );
    const klines = raw.map(k => ({
      open: parseFloat(k[1]), high: parseFloat(k[2]),
      low:  parseFloat(k[3]), close: parseFloat(k[4]),
    }));

    const trades = simulateSymbol(sym, klines);
    allTrades.push(...trades);

    const pnl  = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.action === "TP").length;
    console.log(` → ${trades.length}건 | 승${wins}/패${trades.length - wins} | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`);
    await sleep(100);
  }

  // 전체 요약
  const totalPnl  = allTrades.reduce((s, t) => s + t.pnl, 0);
  const totalWins = allTrades.filter(t => t.action === "TP").length;
  const winRate   = allTrades.length ? (totalWins / allTrades.length * 100).toFixed(1) : 0;
  const finalBal  = CONFIG.CAPITAL + totalPnl;

  console.log(`\n${"─".repeat(55)}`);
  console.log(` 기간        : 최근 30일 (1시간봉)`);
  console.log(` 시작 자금   : $${CONFIG.CAPITAL.toLocaleString()}`);
  console.log(` 트레이드    : ${allTrades.length}건 | 승률 ${winRate}% (${totalWins}승 ${allTrades.length - totalWins}패)`);
  console.log(` 실현 손익   : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
  console.log(` 최종 잔고   : $${finalBal.toFixed(2)}`);
  console.log(` 수익률      : ${((finalBal / CONFIG.CAPITAL - 1) * 100).toFixed(1)}%`);
  console.log(`${"─".repeat(55)}\n`);
}

main().catch(e => console.error("에러:", e.message));
