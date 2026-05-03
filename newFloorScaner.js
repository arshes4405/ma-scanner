/**
 * Binance Futures 바닥 스캐너 + 자동매수
 * 조건: MA 역배열 + 직전봉 RSI<30 + 직전봉 BB하단 이탈 + 현재봉 양봉 + 거래량 돌파
 * 자동매수: 조건 충족 + 미보유 시 20배 레버리지 $100 notional 매수 + -3% 스탑로스
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const VERSION = "2026-05-03 v14";

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
  ORDER_USDT:         1000,
  MAX_PRICE_USDT:     2000,
  LEVERAGE:           20,
  LEVERAGE_FALLBACK:  10,
  SL_PCT:             3,
  TP_PCT:             5,
  STATE_FILE:         path.join(__dirname, "floor_state.json"),
  TP_STATE_FILE:      path.join(__dirname, "tp_state.json"),
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

function loadTpState() {
  try {
    if (fs.existsSync(CONFIG.TP_STATE_FILE))
      return JSON.parse(fs.readFileSync(CONFIG.TP_STATE_FILE, "utf8"));
  } catch (_) {}
  return {};
}

function saveTpState(state) {
  try { fs.writeFileSync(CONFIG.TP_STATE_FILE, JSON.stringify(state), "utf8"); } catch (_) {}
}

function updateState(state, symbols) {
  const now = Date.now();
  for (const sym of symbols) state[sym] = now;
  for (const sym of Object.keys(state)) {
    if (now - state[sym] > 24 * 60 * 60 * 1000) delete state[sym];
  }
  return state;
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

async function setLeverage(symbol, leverage) {
  const qs = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/leverage", `${qs}&signature=${sign(qs)}`);
}

async function placeMarketBuy(symbol, price, stepSize, hedgeMode) {
  const qty     = floorToStep(CONFIG.ORDER_USDT / price, stepSize || 0.001);
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

// ─── 소프트웨어 스탑로스 + 절반 익절 ─────────────────────────────────────────
async function checkAndClosePositions(hedgeMode, stepSizes) {
  const qs    = `timestamp=${Date.now()}`;
  const pRisk = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);

  const positions = hedgeMode
    ? pRisk.filter(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
    : pRisk.filter(p => parseFloat(p.positionAmt) > 0);

  const tpState = loadTpState();

  // 포지션 없는 심볼의 TP 기록 정리
  const activeSymbols = new Set(positions.map(p => p.symbol));
  for (const sym of Object.keys(tpState)) {
    if (!activeSymbols.has(sym)) delete tpState[sym];
  }

  if (!positions.length) {
    saveTpState(tpState);
    return;
  }

  for (const pos of positions) {
    const sym       = pos.symbol;
    const entry     = parseFloat(pos.entryPrice);
    const qty       = Math.abs(parseFloat(pos.positionAmt));
    const markPrice = parseFloat(pos.markPrice);
    const pnlPct    = ((markPrice - entry) / entry) * 100;
    const posSide   = hedgeMode ? "&positionSide=LONG" : "";

    console.log(`  [POS] ${sym} 진입: $${entry} 현재: $${markPrice} 수익률: ${pnlPct.toFixed(2)}%`);

    // 절반 익절 (+5%)
    if (pnlPct >= CONFIG.TP_PCT && !tpState[sym]) {
      const halfQty = floorToStep(qty / 2, stepSizes[sym] || 0.001);
      if (halfQty > 0) {
        console.log(`  [TP]  ${sym} +${CONFIG.TP_PCT}% 도달 → 절반(${halfQty}) 익절`);
        try {
          const sellQs = `symbol=${sym}&side=SELL${posSide}&type=MARKET&quantity=${halfQty}&timestamp=${Date.now()}`;
          const order  = await httpPostSigned("/fapi/v1/order", `${sellQs}&signature=${sign(sellQs)}`);
          tpState[sym] = true;
          console.log(`  [TP]  ${sym} 익절 완료 orderId: ${order.orderId}`);
          await sendTelegram(
            `💰 <b>절반 익절</b>\n` +
            `<b>${sym}</b>  진입: $${entry} → 현재: $${markPrice}\n` +
            `  수익률: +${pnlPct.toFixed(2)}% | qty: ${halfQty} (절반 매도)\n` +
            `  orderId: ${order.orderId}`
          );
        } catch (e) {
          console.error(`  [TP]  ${sym} 익절 실패:`, e.message);
          await sendTelegram(`❌ ${sym} 절반 익절 실패: ${e.message}`);
        }
      }
    }

    // 스탑로스 (-3%)
    if (pnlPct <= -CONFIG.SL_PCT) {
      console.log(`  [SL]  ${sym} -${CONFIG.SL_PCT}% 도달 → 시장가 청산`);
      try {
        const sellQs = `symbol=${sym}&side=SELL${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
        const order  = await httpPostSigned("/fapi/v1/order", `${sellQs}&signature=${sign(sellQs)}`);
        console.log(`  [SL]  ${sym} 청산 완료 orderId: ${order.orderId}`);
        await sendTelegram(
          `🛑 <b>스탑로스 청산</b>\n` +
          `<b>${sym}</b>  진입: $${entry} → 청산: $${markPrice}\n` +
          `  수익률: ${pnlPct.toFixed(2)}% | qty: ${qty}\n` +
          `  orderId: ${order.orderId}`
        );
      } catch (e) {
        console.error(`  [SL]  ${sym} 청산 실패:`, e.message);
        await sendTelegram(`❌ ${sym} 스탑로스 청산 실패: ${e.message}`);
      }
    }
  }

  saveTpState(tpState);
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────
function analyze(symbol, klines) {
  if (klines.length < CONFIG.CANDLE_LIMIT) return null;

  const closes  = klines.map(k => k.close);
  const lastIdx = klines.length - 1;
  const cur     = klines[lastIdx];
  const prev    = klines[lastIdx - 1];

  if (cur.close <= cur.open) return null;

  // 거래량 돌파: 현재봉 경과 시간 기준 1시간 환산 비교
  const elapsedRatio = Math.min(1, Math.max(10 / 60, (Date.now() - cur.openTime) / 3_600_000));
  if ((cur.volume / elapsedRatio) <= prev.volume) return null;

  const prevCloses = closes.slice(0, -1);

  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= CONFIG.RSI_THRESHOLD) return null;

  // 직전봉 저가가 볼린저 하단(20, 2) 아래로 이탈
  const bbLower = calcBollingerLower(prevCloses);
  const prevLow = klines[lastIdx - 1].low;
  if (!bbLower || prevLow >= bbLower) return null;

  return {
    symbol,
    price:       cur.close,
    rsi:         +rsi.toFixed(1),
    bbLower:     +bbLower.toFixed(4),
    volRatio:    +((cur.volume / elapsedRatio) / prev.volume).toFixed(2),
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
  let msg = `🔍 <b>바닥 스캐너 (MA역배열 + RSI&lt;35 + BB하단이탈 + 양봉 + 거래량 돌파)</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `📊 ${total}개 스캔 · ${results.length}개 발견 · ${elapsed}초\n`;
  msg += `─────────────────\n`;

  results.sort((a, b) => a.rsi - b.rsi);

  for (const r of results) {
    const vol = r.vol >= 1e9 ? (r.vol / 1e9).toFixed(1) + "B" : (r.vol / 1e6).toFixed(0) + "M";
    msg += `\n<b>${r.symbol}</b>  $${r.price}\n`;
    msg += `  RSI(직전): <b>${r.rsi}</b> | BB하단: ${r.bbLower}\n`;
    msg += `  거래량: ${vol} | 직전봉 대비 <b>${r.volRatio}x</b>\n`;
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

  loadState();

  try {
    const hedgeMode = await getIsHedgeMode();
    const { symbols: allSymbols, stepSizes, tickSizes } = await getSymbolsInfo();

    // 스탑로스/익절 체크 (스캔보다 먼저)
    await checkAndClosePositions(hedgeMode, stepSizes);
    const { volMap, priceMap } = await getVolumes();
    const symbols = allSymbols
      .filter(s => (volMap[s]   || 0) >= CONFIG.MIN_VOLUME_USDT)
      .filter(s => (priceMap[s] || 0) <  CONFIG.MAX_PRICE_USDT);

    const total   = symbols.length;
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const klines = await getKlines(sym);
        const r = analyze(sym, klines);
        if (r) {
          r.vol = volMap[sym] || 0;

          try {
            const alreadyIn = await hasOpenPosition(sym, hedgeMode);
            if (alreadyIn) {
              console.log(`  [SKIP] ${sym} 이미 포지션 있음`);
              r.orderStatus = "이미 보유중";
            } else {
              let order, usedLeverage = CONFIG.LEVERAGE;
              try {
                await setLeverage(sym, CONFIG.LEVERAGE);
                order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode);
              } catch (e1) {
                console.log(`  [RETRY] ${sym} ${CONFIG.LEVERAGE}x 실패 → ${CONFIG.LEVERAGE_FALLBACK}x 재시도`);
                usedLeverage = CONFIG.LEVERAGE_FALLBACK;
                await setLeverage(sym, CONFIG.LEVERAGE_FALLBACK);
                order = await placeMarketBuy(sym, r.price, stepSizes[sym], hedgeMode);
              }
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
    await sendTelegram(`❌ 바닥 스캐너 오류: ${e.message}`);
  }

  process.exit(0);
}

main();
