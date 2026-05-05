/**
 * Binance Futures 바닥 스캐너 + 자동매수
 * 조건: MA 역배열 + 직전봉 RSI<30 + 직전봉 BB하단 이탈 + 현재봉 양봉 + 거래량 돌파
 * 자동매수: 조건 충족 + 미보유 시 20배 레버리지 $100 notional 매수 + -3% 스탑로스
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const VERSION = "2026-05-05 v43";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  INTERVAL:           "1h",
  CANDLE_LIMIT:       150,
  MIN_VOLUME_USDT:    1_000_000,
  REQUEST_DELAY:      120,
  RSI_PERIOD:         14,
  RSI_THRESHOLD:      35,
  MARKET_BIAS:        0,   // 상승장 +5 / 하락장 -5 / 중립 0
  ORDER_USDT:          1000,
  ORDER_USDT_TIER2:    1500,
  ORDER_USDT_TIER1:    2000,
  ORDER_USDT_ADD:      100,
  MAX_INVESTED:        1500,
  MAX_INVESTED_TIER2:  2250,
  MAX_INVESTED_TIER1:  3000,
  LEVERAGE:            30,
  LEVERAGE_FALLBACK:   20,
  LEVERAGE_FALLBACK2:  10,
  ORDER_USDT_MAJOR:    10000,
  LEVERAGE_MAJOR:      50,
  LEVERAGE_MAJOR_FALLBACK: 20,
  RSI_THRESHOLD_MAJOR: 45,  BB_FROM_LOWER_MAJOR: 0.33,
  RSI_THRESHOLD_TIER1: 45,  BB_FROM_LOWER_TIER1: 0.25,
  RSI_THRESHOLD_TIER2: 40,  BB_FROM_LOWER_TIER2: 0.15,
  RSI_THRESHOLD_TIER3: 40,  BB_FROM_LOWER_TIER3: 0,
  // ── 코인 그룹 ──────────────────────────────────────────────────
  // 메이저: Cross 50x $10,000 / RSI<45 / BB+33%
  MAJOR_SYMBOLS:  ["ETHUSDT", "HYPEUSDT"],
  // 1군: 순익절>=5 / RSI<45 / BB+25%
  TIER1_SYMBOLS:  [],
  // 2군: 순익절>=3 / RSI<40 / BB+15%
  TIER2_SYMBOLS:  [],
  // 3군: 순익절>=1 / RSI<40 / BB하단
  TIER3_SYMBOLS:  ["ZEREBROUSDT", "INITUSDT", "BULLAUSDT", "HANAUSDT", "SKYAIUSDT", "SOLVUSDT", "CLOUSDT", "PENGUUSDT", "MOODENGUSDT", "LUMIAUSDT", "PIEVERSEUSDT", "ENSOUSDT", "ONTUSDT", "SPKUSDT", "HAEDALUSDT", "BABYUSDT"],
  // 언랭: 나머지 전체 / RSI<35 / BB하단
  // 블랙: 제외 종목
  EXCLUDE_SYMBOLS: [
    "PLAYUSDT", "RAVEUSDT", "MEGAUSDT", "QNTUSDT", "XVSUSDT", "WLDUSDT", "BRUSDT", "EVAAUSDT", "ARIAUSDT", "BASEDUSDT",
    "STXUSDT", "MANAUSDT", "COMPUSDT", "HBARUSDT", "WOOUSDT", "ICPUSDT", "ACHUSDT", "TUSDT",
    "DUSKUSDT", "IOSTUSDT", "FLOWUSDT", "FETUSDT", "HIGHUSDT", "BELUSDT", "GTCUSDT",
    "PAXGUSDT",
  ],
  UNRANKED_LIMIT:     250,                   // 언랭 거래량 상위 N개만 스캔
  SL_PCT:             3,
  SL_COOLDOWN_MS:     8 * 60 * 60 * 1000,   // SL 후 재매수 금지 (8시간)
  STATE_FILE:         path.join(__dirname, "floor_state.json"),
  TRADE_LOG_FILE:     path.join(__dirname, "trade_log.csv"),
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

function sign(qs) {
  return crypto.createHmac("sha256", CONFIG.BINANCE_SECRET_KEY).update(qs).digest("hex");
}

function httpGetAuth(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        headers: { "X-MBX-APIKEY": CONFIG.BINANCE_API_KEY } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(JSON.parse(data));
        });
      }
    ).on("error", reject);
  });
}

function httpPostSigned(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "fapi.binance.com", path: endpoint, method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "X-MBX-APIKEY": CONFIG.BINANCE_API_KEY,
        }},
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
          else resolve(JSON.parse(d));
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function floorToStep(value, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

// ─── 지표 계산 ────────────────────────────────────────────────────────────────
function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
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

// ─── 쿨다운 ──────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE))
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
  } catch (_) {}
  return {};
}

function saveState(state) {
  try { fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state), "utf8"); } catch (_) {}
}

function getStateEntry(state, sym) {
  const v = state[sym];
  if (!v) return null;
  // 구버전 호환 (숫자만 저장된 경우)
  if (typeof v === "number") return { time: v, candleTime: 0, totalInvested: CONFIG.ORDER_USDT };
  return v;
}

function updateState(state, sym, candleTime, invested) {
  state[sym] = { time: Date.now(), candleTime, totalInvested: invested };
  // 24시간 지난 항목 정리
  const now = Date.now();
  for (const k of Object.keys(state)) {
    const entry = getStateEntry(state, k);
    if (entry && now - entry.time > 24 * 60 * 60 * 1000) delete state[k];
  }
  return state;
}

// ─── SL 쿨다운 맵 (CSV 기반) ──────────────────────────────────────────────────
function parseCsvDatetime(str) {
  if (!str) return 0;
  // "2026. 5. 5. AM 5:34:56" 또는 "2026. 5. 5. 오전 5:34:56"
  const m = str.match(/(\d{4})\.\s*(\d+)\.\s*(\d+)\.\s*(AM|PM|오전|오후)\s*(\d+):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const [, yyyy, mo, dd, ampm, h, mm, ss] = m;
  let hour = parseInt(h);
  if ((ampm === "PM" || ampm === "오후") && hour !== 12) hour += 12;
  if ((ampm === "AM" || ampm === "오전") && hour === 12) hour = 0;
  return Date.UTC(+yyyy, +mo - 1, +dd, hour - 9, +mm, +ss); // KST → UTC
}

function loadSlCooldownMap() {
  const map = {};
  if (!fs.existsSync(CONFIG.TRADE_LOG_FILE)) return map;
  try {
    const lines = fs.readFileSync(CONFIG.TRADE_LOG_FILE, "utf8").trim().split("\n");
    const hdr = lines[0].split(",");
    const ci = { sym: hdr.indexOf("symbol"), action: hdr.indexOf("action"),
                 source: hdr.indexOf("source"), date: hdr.indexOf("datetime"),
                 oid: hdr.indexOf("order_id") };
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const sym    = c[ci.sym]?.trim();
      const action = c[ci.action]?.trim();
      if (!sym || (action !== "SL" && action !== "AUTO_SL")) continue;
      let ts = 0;
      const oid = c[ci.oid]?.trim();
      if (c[ci.source]?.trim() === "MANUAL" && oid?.includes("_")) {
        // SYMBOL_SEC 포맷: ATUSDT_1746403354
        const sec = parseInt(oid.split("_").pop());
        if (!isNaN(sec)) ts = sec * 1000;
      } else {
        ts = parseCsvDatetime(c[ci.date]?.trim());
      }
      if (ts > 0 && ts > (map[sym] || 0)) map[sym] = ts;
    }
  } catch (_) {}
  return map;
}

// ─── API (Public) ─────────────────────────────────────────────────────────────
async function getSymbolsInfo() {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const symbols   = [];
  const stepSizes = {};
  const tickSizes = {};
  for (const s of d.symbols) {
    if (s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING") {
      symbols.push(s.symbol);
      const lot   = s.filters.find(f => f.filterType === "LOT_SIZE");
      const price = s.filters.find(f => f.filterType === "PRICE_FILTER");
      if (lot)   stepSizes[s.symbol] = parseFloat(lot.stepSize);
      if (price) tickSizes[s.symbol] = parseFloat(price.tickSize);
    }
  }
  return { symbols, stepSizes, tickSizes };
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

// ─── API (Signed) ─────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs   = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return data.dualSidePosition; // true = 헤지모드, false = 단방향
}

async function hasOpenPosition(symbol, hedgeMode) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  if (hedgeMode) {
    return data.some(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0);
  }
  return data.some(p => Math.abs(parseFloat(p.positionAmt)) > 0);
}

async function setMarginType(symbol, type = "ISOLATED") {
  const qs = `symbol=${symbol}&marginType=${type}&timestamp=${Date.now()}`;
  try {
    await httpPostSigned("/fapi/v1/marginType", `${qs}&signature=${sign(qs)}`);
  } catch (e) {
    if (!e.message.includes("-4046")) throw e;
  }
}

async function setLeverage(symbol, leverage) {
  const qs = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/leverage", `${qs}&signature=${sign(qs)}`);
}

async function placeMarketBuy(symbol, price, stepSize, hedgeMode, amount = CONFIG.ORDER_USDT) {
  const qty     = floorToStep(amount / price, stepSize || 0.001);
  if (qty <= 0) throw new Error(`수량 계산 오류 (price: ${price}, step: ${stepSize})`);
  const posSide = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=BUY${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

async function placeStopLoss(symbol, entryPrice, qty, tickSize, hedgeMode) {
  const tick      = tickSize || 0.01;
  const stopPrice = floorToStep(entryPrice * (1 - CONFIG.SL_PCT / 100), tick);
  const limitPrice = floorToStep(stopPrice * 0.995, tick); // 트리거 후 체결 보장용 리밋
  const posSide   = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=SELL${posSide}&type=STOP&price=${limitPrice}&stopPrice=${stopPrice}&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────
function analyze(symbol, klines, rsiThreshold = CONFIG.RSI_THRESHOLD, bbFromLower = 0) {
  if (klines.length < CONFIG.CANDLE_LIMIT) return null;

  const closes  = klines.map(k => k.close);
  const lastIdx = klines.length - 1;
  const cur     = klines[lastIdx];
  const prev    = klines[lastIdx - 1];

  if (cur.close <= cur.open) return null;

  // 직전봉 음봉
  if (prev.close >= prev.open) return null;

  const prevCloses = closes.slice(0, -1);

  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= rsiThreshold) return null;

  // 현재봉 RSI 보정: 경과 시간에 따라 임계값 상향 (5분→36, 15분→37, ...)
  const elapsedMin = (Date.now() - cur.openTime) / 60_000;
  const curRsiMax  = rsi + 2 + Math.floor(elapsedMin / 10);
  const curRsi = calcRSI(closes, CONFIG.RSI_PERIOD);
  if (curRsi === null || curRsi >= curRsiMax) return null;

  // 현재가가 직전봉 고저 평균 이하
  const prevMid = (prev.high + prev.low) / 2;
  if (cur.close > prevMid) return null;

  // 직전봉 저가가 볼린저 하단(20, 2) 아래로 이탈
  const bbThreshold = calcBollingerThreshold(prevCloses, 20, 2, bbFromLower);
  const prevLow = klines[lastIdx - 1].low;
  const prevAvg = (prevLow + prev.close) / 2;
  if (!bbThreshold || prevAvg >= bbThreshold) return null;

  return {
    symbol,
    open:     cur.open,
    price:    cur.close,
    rsi:      +rsi.toFixed(1),
    curRsi:   +curRsi.toFixed(1),
    curRsiMax,
    bbLower:  +bbThreshold.toFixed(4),
  };
}

// ─── 텔레그램 ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await httpsPost("api.telegram.org",
      `/bot${CONFIG.TG_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (e) { console.error("[TG] 전송 실패:", e.message); }
}

function formatMessage(results, elapsed, total) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  let msg = `🔍 <b>바닥 스캐너 ${VERSION}</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `📊 ${total}개 스캔 · ${results.length}개 발견 · ${elapsed}초\n`;
  msg += `─────────────────\n`;

  results.sort((a, b) => a.rsi - b.rsi);

  for (const r of results) {
    const vol    = r.vol >= 1e9 ? (r.vol / 1e9).toFixed(1) + "B" : (r.vol / 1e6).toFixed(0) + "M";
    const chgPct = ((r.price - r.open) / r.open * 100).toFixed(2);
    const majorTag = r.isMajor ? " 🔵[메이저 Cross 50x]" : "";
    msg += `\n<b>${r.symbol}</b>${majorTag}  $${r.open} → $${r.price} (${chgPct >= 0 ? "+" : ""}${chgPct}%)\n`;
    msg += `  RSI 직전: <b>${r.rsi}</b> | 현재: <b>${r.curRsi}</b>(기준&lt;${r.curRsiMax}) | BB하단: ${r.bbLower}\n`;
    msg += `  거래량: ${vol}\n`;
    if (r.orderStatus) {
      const icon = r.orderStatus.startsWith("매수 완료") ? "✅" : r.orderStatus.startsWith("이미") ? "⏭" : "❌";
      msg += `  ${icon} ${r.orderStatus}\n`;
    }
  }

  return msg;
}

// ─── 테스트 매도 ──────────────────────────────────────────────────────────────
async function testSell(symbol = "ETHUSDT") {
  console.log(`\n=== [TEST SELL] ${symbol} ===`);
  try {
    const hedgeMode = await getIsHedgeMode();
    console.log(`  포지션 모드: ${hedgeMode ? "헤지모드" : "단방향"}`);

    const qs    = `symbol=${symbol}&timestamp=${Date.now()}`;
    const pRisk = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
    const pos   = hedgeMode
      ? pRisk.find(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
      : pRisk.find(p => parseFloat(p.positionAmt) > 0);

    if (!pos) {
      console.log(`  포지션 없음 → 매도 스킵`);
      await sendTelegram(`⚠️ [TEST] ${symbol} 포지션 없음`);
      return;
    }

    const qty      = Math.abs(parseFloat(pos.positionAmt));
    const entry    = parseFloat(pos.entryPrice);
    const posSide  = hedgeMode ? "&positionSide=LONG" : "";
    console.log(`  포지션 확인: 진입가 $${entry}, qty: ${qty}`);

    const sellQs = `symbol=${symbol}&side=SELL${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
    const order  = await httpPostSigned("/fapi/v1/order", `${sellQs}&signature=${sign(sellQs)}`);
    console.log(`  매도 완료! orderId: ${order.orderId} | qty: ${order.origQty}`);

    await sendTelegram(
      `✅ [TEST] ${symbol} 매도 완료\n` +
      `  진입가: $${entry} | 수량: ${qty}\n` +
      `  orderId: ${order.orderId}`
    );
  } catch (e) {
    console.error(`  실패:`, e.message);
    await sendTelegram(`❌ [TEST] ${symbol} 매도 실패: ${e.message}`);
  }
  console.log(`=== [TEST SELL] 완료 ===\n`);
}

// ─── 테스트 매수 ──────────────────────────────────────────────────────────────
async function testBuy(symbol = "ETHUSDT") {
  console.log(`\n=== [TEST BUY] ${symbol} ===`);
  try {
    const hedgeMode = await getIsHedgeMode();
    console.log(`  포지션 모드: ${hedgeMode ? "헤지모드" : "단방향"}`);

    const ticker = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    const price  = parseFloat(ticker.price);
    console.log(`  현재가: $${price}`);

    const { stepSizes, tickSizes } = await getSymbolsInfo();

    // 포지션 조회
    const qs2  = `symbol=${symbol}&timestamp=${Date.now()}`;
    const pRisk = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs2}&signature=${sign(qs2)}`);
    const pos   = hedgeMode
      ? pRisk.find(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
      : pRisk.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);

    if (pos) {
      // 이미 포지션 있음 → 스탑로스만 설정
      const entryPrice = parseFloat(pos.entryPrice);
      const qty        = Math.abs(parseFloat(pos.positionAmt));
      const slPrice    = floorToStep(entryPrice * (1 - CONFIG.SL_PCT / 100), tickSizes[symbol] || 0.01);
      console.log(`  이미 포지션 있음 → 스탑로스만 설정 (진입가: $${entryPrice}, qty: ${qty})`);
      const sl = await placeStopLoss(symbol, entryPrice, qty, tickSizes[symbol], hedgeMode);
      console.log(`  스탑로스 설정! orderId: ${sl.orderId} | stopPrice: $${slPrice}`);
      await sendTelegram(
        `🛑 [TEST] ${symbol} 스탑로스 설정\n` +
        `  진입가: $${entryPrice} | qty: ${qty}\n` +
        `  stopPrice: $${slPrice} (-${CONFIG.SL_PCT}%)\n` +
        `  orderId: ${sl.orderId}`
      );
      return;
    }

    await setLeverage(symbol);
    console.log(`  레버리지 ${CONFIG.LEVERAGE}x 설정 완료`);

    const order   = await placeMarketBuy(symbol, price, stepSizes[symbol], hedgeMode);
    console.log(`  매수 완료! orderId: ${order.orderId} | qty: ${order.origQty}`);

    const sl      = await placeStopLoss(symbol, price, order.origQty, tickSizes[symbol], hedgeMode);
    const slPrice = floorToStep(price * (1 - CONFIG.SL_PCT / 100), tickSizes[symbol] || 0.01);
    console.log(`  스탑로스 설정! orderId: ${sl.orderId} | stopPrice: $${slPrice}`);

    await sendTelegram(
      `✅ [TEST] ${symbol} 매수 완료\n` +
      `  진입가: $${price} | 수량: ${order.origQty}\n` +
      `  notional: $${CONFIG.ORDER_USDT} / ${CONFIG.LEVERAGE}x\n` +
      `  🛑 스탑로스: $${slPrice} (-${CONFIG.SL_PCT}%)\n` +
      `  orderId: ${order.orderId}`
    );
  } catch (e) {
    console.error(`  실패:`, e.message);
    await sendTelegram(`❌ [TEST] ${symbol} 매수 실패: ${e.message}`);
  }
  console.log(`=== [TEST BUY] 완료 ===\n`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleString("ko-KR")}] 바닥 스캐너 시작 (${VERSION})`);

  const state = loadState();
  const slCooldownMap = loadSlCooldownMap();

  try {
    const hedgeMode = await getIsHedgeMode();
    const { symbols: allSymbols, stepSizes, tickSizes } = await getSymbolsInfo();
    const { volMap, priceMap } = await getVolumes();
    const tieredSet = new Set([
      ...CONFIG.MAJOR_SYMBOLS, ...CONFIG.TIER1_SYMBOLS,
      ...CONFIG.TIER2_SYMBOLS, ...CONFIG.TIER3_SYMBOLS,
    ]);
    const tiered  = allSymbols.filter(s => tieredSet.has(s) && !CONFIG.EXCLUDE_SYMBOLS.includes(s));
    const unranked = allSymbols
      .filter(s => !tieredSet.has(s) && !CONFIG.EXCLUDE_SYMBOLS.includes(s))
      .filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT)
      .sort((a, b) => (volMap[b] || 0) - (volMap[a] || 0))
      .slice(0, CONFIG.UNRANKED_LIMIT);
    const symbols = [...tiered, ...unranked];

    const total   = symbols.length;
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const klines = await getKlines(sym);
        const isMajor = CONFIG.MAJOR_SYMBOLS.includes(sym);
        const isTier1 = CONFIG.TIER1_SYMBOLS.includes(sym);
        const isTier2 = CONFIG.TIER2_SYMBOLS.includes(sym);
        const isTier3 = CONFIG.TIER3_SYMBOLS.includes(sym);
        const rsiBase      = isMajor ? CONFIG.RSI_THRESHOLD_MAJOR
                           : isTier1 ? CONFIG.RSI_THRESHOLD_TIER1
                           : isTier2 ? CONFIG.RSI_THRESHOLD_TIER2
                           : isTier3 ? CONFIG.RSI_THRESHOLD_TIER3
                           : CONFIG.RSI_THRESHOLD;
        const rsiThreshold = rsiBase + CONFIG.MARKET_BIAS;
        const bbFromLower  = isMajor ? CONFIG.BB_FROM_LOWER_MAJOR
                           : isTier1 ? CONFIG.BB_FROM_LOWER_TIER1
                           : isTier2 ? CONFIG.BB_FROM_LOWER_TIER2
                           : 0;
        const r = analyze(sym, klines, rsiThreshold, bbFromLower);
        if (r) {
          r.vol = volMap[sym] || 0;
          r.isMajor = isMajor;

          try {
            const alreadyIn = await hasOpenPosition(sym, hedgeMode);
            const curCandleTime = klines[klines.length - 1].openTime;
            const stateEntry = getStateEntry(state, sym);

            // SL 쿨다운 체크 (CSV 기반, 미보유 + 알트만)
            if (!alreadyIn && !isMajor && slCooldownMap[sym]) {
              const elapsed = Date.now() - slCooldownMap[sym];
              if (elapsed < CONFIG.SL_COOLDOWN_MS) {
                const remaining = Math.ceil((CONFIG.SL_COOLDOWN_MS - elapsed) / 3600000);
                console.log(`  [SKIP] ${sym} SL 쿨다운 중 (${remaining}시간 남음)`);
                r.orderStatus = `SL 쿨다운 (${remaining}h 남음)`;
                results.push(r);
                continue;
              }
            }

            if (alreadyIn) {
              if (isMajor) {
                // 메이저 코인은 DCA 없이 스킵
                console.log(`  [SKIP] ${sym} 이미 보유중 [메이저]`);
                r.orderStatus = "이미 보유중";
              } else {
                if (!stateEntry) {
                  console.log(`  [SKIP] ${sym} 이미 보유중 (추적 없음)`);
                  r.orderStatus = "이미 보유중";
                } else if (stateEntry.candleTime === curCandleTime) {
                  console.log(`  [SKIP] ${sym} 동일봉 스킵`);
                  r.orderStatus = "이미 보유중 (동일봉)";
                } else {
                  // DCA (티어별 초기매수의 10%, 최대한도 티어별)
                  const dcaBase = isTier1 ? CONFIG.ORDER_USDT_TIER1
                                : isTier2 ? CONFIG.ORDER_USDT_TIER2
                                : CONFIG.ORDER_USDT;
                  const maxInvested = isTier1 ? CONFIG.MAX_INVESTED_TIER1
                                   : isTier2 ? CONFIG.MAX_INVESTED_TIER2
                                   : CONFIG.MAX_INVESTED;
                  if (stateEntry.totalInvested >= maxInvested) {
                    console.log(`  [SKIP] ${sym} 최대매수 도달 ($${maxInvested})`);
                    r.orderStatus = `최대매수 도달 ($${maxInvested})`;
                  } else {
                  const dcaUnit = Math.round(dcaBase * 0.1);
                  const addAmount = Math.min(dcaUnit, maxInvested - stateEntry.totalInvested);
                  let order, usedLeverage = CONFIG.LEVERAGE;
                  try {
                    order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, addAmount);
                  } catch (e1) {
                    console.log(`  [RETRY] ${sym} DCA ${CONFIG.LEVERAGE}x 실패 → ${CONFIG.LEVERAGE_FALLBACK}x 재시도`);
                    usedLeverage = CONFIG.LEVERAGE_FALLBACK;
                    try {
                      await setLeverage(sym, CONFIG.LEVERAGE_FALLBACK);
                      order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, addAmount);
                    } catch (e2) {
                      console.log(`  [RETRY] ${sym} DCA ${CONFIG.LEVERAGE_FALLBACK}x 실패 → ${CONFIG.LEVERAGE_FALLBACK2}x 재시도`);
                      usedLeverage = CONFIG.LEVERAGE_FALLBACK2;
                      await setLeverage(sym, CONFIG.LEVERAGE_FALLBACK2);
                      order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, addAmount);
                    }
                  }
                  const newInvested = stateEntry.totalInvested + addAmount;
                  updateState(state, sym, curCandleTime, newInvested);
                  saveState(state);
                  console.log(`  [DCA] ${sym} +$${addAmount} 추가 (총 $${newInvested}) orderId: ${order.orderId} qty: ${order.origQty}`);
                  r.orderStatus = `DCA +$${addAmount} | 총 $${newInvested} | qty: ${order.origQty} | ${usedLeverage}x`;
                  }
                }
              }
            } else if (isMajor) {
              // 메이저 코인 신규 매수: Cross 50x $10,000
              let order, usedLeverage = CONFIG.LEVERAGE_MAJOR;
              try {
                await setMarginType(sym, "CROSSED");
                await setLeverage(sym, CONFIG.LEVERAGE_MAJOR);
                order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, CONFIG.ORDER_USDT_MAJOR);
              } catch (e1) {
                console.log(`  [RETRY] ${sym} [메이저] ${CONFIG.LEVERAGE_MAJOR}x 실패 → ${CONFIG.LEVERAGE_MAJOR_FALLBACK}x 재시도`);
                usedLeverage = CONFIG.LEVERAGE_MAJOR_FALLBACK;
                await setMarginType(sym, "CROSSED");
                await setLeverage(sym, CONFIG.LEVERAGE_MAJOR_FALLBACK);
                order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, CONFIG.ORDER_USDT_MAJOR);
              }
              console.log(`  [BUY] ${sym} [메이저] orderId: ${order.orderId} qty: ${order.origQty} (${usedLeverage}x)`);
              r.orderStatus = `매수 완료 [메이저] | qty: ${order.origQty} | ${usedLeverage}x`;
            } else {
              // 알트 신규 매수: Isolated 20x
              const orderAmt = isTier1 ? CONFIG.ORDER_USDT_TIER1
                             : isTier2 ? CONFIG.ORDER_USDT_TIER2
                             : CONFIG.ORDER_USDT;
              let order, usedLeverage = CONFIG.LEVERAGE;
              try {
                await setMarginType(sym);
                await setLeverage(sym, CONFIG.LEVERAGE);
                order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, orderAmt);
              } catch (e1) {
                console.log(`  [RETRY] ${sym} ${CONFIG.LEVERAGE}x 실패 → ${CONFIG.LEVERAGE_FALLBACK}x 재시도`);
                usedLeverage = CONFIG.LEVERAGE_FALLBACK;
                try {
                  await setMarginType(sym);
                  await setLeverage(sym, CONFIG.LEVERAGE_FALLBACK);
                  order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, orderAmt);
                } catch (e2) {
                  console.log(`  [RETRY] ${sym} ${CONFIG.LEVERAGE_FALLBACK}x 실패 → ${CONFIG.LEVERAGE_FALLBACK2}x 재시도`);
                  usedLeverage = CONFIG.LEVERAGE_FALLBACK2;
                  await setMarginType(sym);
                  await setLeverage(sym, CONFIG.LEVERAGE_FALLBACK2);
                  order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode, orderAmt);
                }
              }
              updateState(state, sym, curCandleTime, orderAmt);
              saveState(state);
              console.log(`  [BUY] ${sym} orderId: ${order.orderId} qty: ${order.origQty} (${usedLeverage}x)`);
              r.orderStatus = `매수 완료 | qty: ${order.origQty} | ${usedLeverage}x`;
            }
          } catch (e) {
            console.error(`  [ERR] ${sym} 주문 실패:`, e.message);
            r.orderStatus = `주문 실패: ${e.message}`;
          }

          results.push(r);
        }
      } catch (e) {
        console.error(`  [ERR] ${sym} 스캔 오류:`, e.message);
      }

      if (i % 20 === 0) process.stdout.write(`\r진행: ${i}/${total} 발견: ${results.length}개`);
      await sleep(CONFIG.REQUEST_DELAY);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n완료: ${results.length}개 발견 (${elapsed}초)`);

    if (!results.length) { process.exit(0); return; }

    const msg = formatMessage(results, elapsed, total);
    if (msg.length <= 4096) {
      await sendTelegram(msg);
    } else {
      const chunks = [];
      let chunk = "";
      for (const line of msg.split("\n")) {
        if ((chunk + line).length > 4000) { chunks.push(chunk); chunk = ""; }
        chunk += line + "\n";
      }
      if (chunk) chunks.push(chunk);
      for (const c of chunks) await sendTelegram(c);
    }

  } catch (e) {
    console.error("에러:", e.message);
    await sendTelegram(`❌ 스캐너 오류 [${VERSION}]: ${e.message}`);
  }

  process.exit(0);
}

main();
