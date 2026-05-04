/**
 * Binance Futures 바닥 스캐너 Ver2 - 조건별 필터링 로그 버전
 * 자동매수 없음, 각 코인이 어느 조건에서 탈락하는지 확인용
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");

const VERSION = "floorScanerTester v2";

const CONFIG = {
  BASE_URL:           "https://fapi.binance.com",
  INTERVAL:           "1h",
  CANDLE_LIMIT:       150,
  MIN_VOLUME_USDT:    1_000_000,
  REQUEST_DELAY:      120,
  RSI_PERIOD:         14,
  RSI_THRESHOLD:      35,
  RSI_THRESHOLD_MAJOR: 45,
  BB_FROM_LOWER_MAJOR: 0.33,
  MAJOR_SYMBOLS:      ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT"],

  LOG_FILE:           path.join(__dirname, "floor_v2_log.txt"),
};

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 로그 ─────────────────────────────────────────────────────────────────────
const logLines = [];
function log(line) {
  console.log(line);
  logLines.push(line);
}

function saveLog() {
  try {
    const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const header = `\n${"=".repeat(60)}\n${ts}\n${"=".repeat(60)}\n`;
    fs.appendFileSync(CONFIG.LOG_FILE, header + logLines.join("\n") + "\n");
  } catch (_) {}
}

// ─── 지표 계산 ────────────────────────────────────────────────────────────────
function calcMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  const from = Math.max(1, closes.length - period * 3);
  for (let i = from; i < from + period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ag += diff; else al -= diff;
  }
  ag /= period;
  al /= period;
  for (let i = from + period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0,  diff)) / period;
    al = (al * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
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
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const lower = mean - mult * std;
  return lower + (mean - lower) * fromLower;
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getAllSymbols() {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  return d.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);
}

async function getVolumes() {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/24hr`);
  const volMap = {}, priceMap = {};
  for (const t of d) {
    volMap[t.symbol]   = parseFloat(t.quoteVolume);
    priceMap[t.symbol] = parseFloat(t.lastPrice);
  }
  return { volMap, priceMap };
}

async function getKlines(symbol) {
  const d = await httpGet(
    `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.CANDLE_LIMIT}`
  );
  return d.map(k => ({
    openTime: k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[7]),
  }));
}

// ─── 분석 (조건별 결과 반환) ───────────────────────────────────────────────────
function analyzeWithLog(symbol, klines, rsiThreshold = CONFIG.RSI_THRESHOLD, bbFromLower = 0) {
  if (klines.length < CONFIG.CANDLE_LIMIT) return { pass: false, reason: "캔들 부족" };

  const closes  = klines.map(k => k.close);
  const lastIdx = klines.length - 1;
  const cur     = klines[lastIdx];
  const prev    = klines[lastIdx - 1];

  // 1. 현재봉 양봉
  if (cur.close <= cur.open)
    return { pass: false, reason: `현재봉 음봉 (open:${cur.open.toFixed(4)} close:${cur.close.toFixed(4)})` };

  // 2. 직전봉 음봉
  if (prev.close >= prev.open)
    return { pass: false, reason: `직전봉 양봉 (open:${prev.open.toFixed(4)} close:${prev.close.toFixed(4)})` };

  // 3. RSI (직전봉)
  const prevCloses = closes.slice(0, -1);
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null)
    return { pass: false, reason: "RSI 계산 불가" };
  if (rsi >= rsiThreshold)
    return { pass: false, reason: `RSI ${rsi.toFixed(1)} (기준 ${rsiThreshold} 초과)` };

  // 4. 현재봉 RSI 보정: 경과 시간에 따라 임계값 상향 (5분→36, 15분→37, ...)
  const elapsedMin = (Date.now() - cur.openTime) / 60_000;
  const curRsiMax  = rsi + 2 + Math.floor(elapsedMin / 10);
  const curRsi = calcRSI(closes, CONFIG.RSI_PERIOD);
  if (curRsi === null || curRsi >= curRsiMax)
    return { pass: false, reason: `현재봉 RSI ${curRsi?.toFixed(1)} >= ${curRsiMax} (경과 ${Math.round(elapsedMin)}분 기준)` };

  // 5. 현재가가 직전봉 고저 평균 이하
  const prevMid = (prev.high + prev.low) / 2;
  if (cur.close > prevMid)
    return { pass: false, reason: `현재가 직전봉 중간값 초과 (cur:${cur.close.toFixed(4)} > mid:${prevMid.toFixed(4)})` };

  // 6. BB 하단 이탈 (직전봉 저가)
  const bbThreshold = calcBollingerThreshold(prevCloses, 20, 2, bbFromLower);
  if (!bbThreshold)
    return { pass: false, reason: "BB 계산 불가" };
  const prevLow = prev.low;
  const prevAvg = (prevLow + prev.close) / 2;
  if (prevAvg >= bbThreshold)
    return { pass: false, reason: `BB 미이탈 (avg:${prevAvg.toFixed(4)} > bb:${bbThreshold.toFixed(4)})` };

  return {
    pass: true,
    price: cur.close, rsi: +rsi.toFixed(1), curRsi: +curRsi.toFixed(1), curRsiMax,
    bbLower: +bbLower.toFixed(4),
  };
}


// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  log(`[${new Date().toLocaleString("ko-KR")}] ${VERSION} 시작`);

  // 조건별 카운터
  const counter = { 현재봉음봉: 0, 직전봉양봉: 0, RSI: 0, 현재봉RSI: 0, 중간값초과: 0, BB하단: 0, 통과: 0 };
  const passed = [];

  try {
    const allSymbols       = await getAllSymbols();
    const { volMap, priceMap } = await getVolumes();
    const symbols = allSymbols
      .filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT);

    log(`총 ${symbols.length}개 스캔 시작\n`);

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const klines = await getKlines(sym);
        const isMajor = CONFIG.MAJOR_SYMBOLS.includes(sym);
        const rsiThreshold = isMajor ? CONFIG.RSI_THRESHOLD_MAJOR : CONFIG.RSI_THRESHOLD;
        const bbFromLower  = isMajor ? CONFIG.BB_FROM_LOWER_MAJOR : 0;
        const result = analyzeWithLog(sym, klines, rsiThreshold, bbFromLower);

        if (result.pass) {
          counter["통과"]++;
          passed.push({ symbol: sym, ...result, vol: volMap[sym], price: priceMap[sym], isMajor });
          const tag = isMajor ? " [메이저]" : "";
          log(`✅ ${sym.padEnd(12)} 통과!${tag} RSI직전:${result.rsi} RSI현재:${result.curRsi}(기준<${result.curRsiMax}) BB:${result.bbLower}`);
        } else {
          // 탈락 이유 첫 단어로 카운터 분류
          const key = Object.keys(counter).find(k => result.reason.includes(k));
          if (key) counter[key]++;
          log(`   ${sym.padEnd(12)} ❌ ${result.reason}`);
        }
      } catch (_) {}

      if (i % 20 === 0) process.stdout.write(`\r진행: ${i}/${symbols.length}`);
      await sleep(CONFIG.REQUEST_DELAY);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`\n${"─".repeat(50)}`);
    log(`[조건별 탈락 요약] (${elapsed}초)`);
    log(`  현재봉 음봉  : ${counter["현재봉음봉"]}개`);
    log(`  직전봉 양봉  : ${counter["직전봉양봉"]}개`);
    log(`  RSI 초과     : ${counter["RSI"]}개`);
    log(`  현재봉RSI 고점: ${counter["현재봉RSI"]}개`);
    log(`  직전봉중간값초과: ${counter["중간값초과"]}개`);
    log(`  BB하단 미이탈: ${counter["BB하단"]}개`);
    log(`  최종 통과    : ${counter["통과"]}개`);
    log(`${"─".repeat(50)}`);

    saveLog();

    if (passed.length) {
      log("\n[최종 통과 종목]");
      for (const r of passed.sort((a, b) => a.rsi - b.rsi)) {
        const vol = r.vol >= 1e9 ? (r.vol/1e9).toFixed(1)+"B" : (r.vol/1e6).toFixed(0)+"M";
        log(`  ${r.symbol.padEnd(12)} RSI직전:${r.rsi} RSI현재:${r.curRsi}(기준<${r.curRsiMax}) BB:${r.bbLower} ${vol}`);
      }
    }

  } catch (e) {
    console.error("에러:", e.message);
  }

  process.exit(0);
}

main();
