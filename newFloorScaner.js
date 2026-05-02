/**
 * Binance Futures 바닥 스캐너 + 자동매수
 * 조건: MA 역배열 + 직전봉 RSI<30 + 직전봉 BB하단 이탈 + 현재봉 양봉 + 거래량 돌파
 * 자동매수: 조건 충족 + 미보유 시 20배 레버리지 $100 notional 매수
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

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
  RSI_THRESHOLD:      30,
  ORDER_USDT:         100,  // notional (마진 = ORDER_USDT / LEVERAGE)
  LEVERAGE:           20,
  SL_PCT:             3,    // 스탑로스 % (진입가 대비 하락)
  STATE_FILE:         path.join(__dirname, "floor_state.json"),
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
  const m = {};
  for (const t of d) m[t.symbol] = parseFloat(t.quoteVolume);
  return m;
}

async function getKlines(symbol) {
  const d = await httpGet(
    `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.CANDLE_LIMIT}`
  );
  return d.map(k => ({
    open:   parseFloat(k[1]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[7]),
  }));
}

// ─── API (Signed) ─────────────────────────────────────────────────────────────
async function hasOpenPosition(symbol) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  return data.some(p => Math.abs(parseFloat(p.positionAmt)) > 0);
}

async function setLeverage(symbol) {
  const qs = `symbol=${symbol}&leverage=${CONFIG.LEVERAGE}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/leverage", `${qs}&signature=${sign(qs)}`);
}

async function placeMarketBuy(symbol, price, stepSize) {
  const qty = floorToStep(CONFIG.ORDER_USDT / price, stepSize || 0.001);
  if (qty <= 0) throw new Error(`수량 계산 오류 (price: ${price}, step: ${stepSize})`);
  const qs = `symbol=${symbol}&side=BUY&positionSide=LONG&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

async function placeStopLoss(symbol, entryPrice, tickSize) {
  const stopPrice = floorToStep(entryPrice * (1 - CONFIG.SL_PCT / 100), tickSize || 0.01);
  const qs = `symbol=${symbol}&side=SELL&positionSide=LONG&type=STOP_MARKET&stopPrice=${stopPrice}&closePosition=true&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────
function analyze(symbol, klines) {
  if (klines.length < CONFIG.CANDLE_LIMIT) return null;

  const closes  = klines.map(k => k.close);
  const lastIdx = klines.length - 1;
  const cur     = klines[lastIdx];
  const prev    = klines[lastIdx - 1];

  // 현재봉 양봉
  if (cur.close <= cur.open) return null;

  // 현재봉 거래량 > 직전봉 거래량
  if (cur.volume <= prev.volume) return null;

  const ma10 = calcMA(closes, 10);
  const ma30 = calcMA(closes, 30);
  const ma99 = calcMA(closes, 99);
  if (!ma10 || !ma30 || !ma99) return null;

  // MA 역배열: MA99 > MA30 > MA10
  if (!(ma99 > ma30 && ma30 > ma10)) return null;

  const prevCloses = closes.slice(0, -1);

  // 직전봉 기준 RSI < 30
  const rsi = calcRSI(prevCloses, CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= CONFIG.RSI_THRESHOLD) return null;

  // 직전봉이 볼린저 하단(20, 2) 아래로 이탈
  const bbLower = calcBollingerLower(prevCloses);
  if (!bbLower || prevCloses[prevCloses.length - 1] >= bbLower) return null;

  return {
    symbol,
    price:       cur.close,
    rsi:         +rsi.toFixed(1),
    bbLower:     +bbLower.toFixed(4),
    ma10:        +ma10.toFixed(4),
    ma30:        +ma30.toFixed(4),
    ma99:        +ma99.toFixed(4),
    pctFromMA10: +(((cur.close - ma10) / ma10) * 100).toFixed(1),
    volRatio:    +(cur.volume / prev.volume).toFixed(2),
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
  let msg = `🔍 <b>바닥 스캐너 (MA역배열 + RSI&lt;30 + BB하단이탈 + 양봉 + 거래량 돌파)</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `📊 ${total}개 스캔 · ${results.length}개 발견 · ${elapsed}초\n`;
  msg += `─────────────────\n`;

  results.sort((a, b) => a.rsi - b.rsi);

  for (const r of results) {
    const vol = r.vol >= 1e9 ? (r.vol / 1e9).toFixed(1) + "B" : (r.vol / 1e6).toFixed(0) + "M";
    msg += `\n<b>${r.symbol}</b>  $${r.price}\n`;
    msg += `  RSI(직전): <b>${r.rsi}</b> | BB하단: ${r.bbLower}\n`;
    msg += `  MA10: ${r.ma10} | MA30: ${r.ma30} | MA99: ${r.ma99}\n`;
    msg += `  거래량: ${vol} | 직전봉 대비 <b>${r.volRatio}x</b>\n`;
    if (r.orderStatus) {
      const icon = r.orderStatus.startsWith("매수 완료") ? "✅" : r.orderStatus.startsWith("이미") ? "⏭" : "❌";
      msg += `  ${icon} ${r.orderStatus}\n`;
    }
  }

  return msg;
}

// ─── 테스트 매수 ────────────────────────────────────────────────────────────��─
async function testBuy(symbol = "ETHUSDT") {
  console.log(`\n=== [TEST BUY] ${symbol} ===`);
  try {
    const ticker = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    const price  = parseFloat(ticker.price);
    console.log(`  현재가: $${price}`);

    const alreadyIn = await hasOpenPosition(symbol);
    if (alreadyIn) {
      console.log(`  이미 포지션 있음 → 매수 스킵`);
      await sendTelegram(`⏭ [TEST] ${symbol} 이미 포지션 있음`);
      return;
    }

    await setLeverage(symbol);
    console.log(`  레버리지 ${CONFIG.LEVERAGE}x 설정 완료`);

    const { symbols: _, stepSizes, tickSizes } = await getSymbolsInfo();
    const order = await placeMarketBuy(symbol, price, stepSizes[symbol]);
    console.log(`  매수 완료! orderId: ${order.orderId} | qty: ${order.origQty}`);

    const sl    = await placeStopLoss(symbol, price, tickSizes[symbol]);
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
    console.error(`  매수 실패:`, e.message);
    await sendTelegram(`❌ [TEST] ${symbol} 매수 실패: ${e.message}`);
  }
  console.log(`=== [TEST BUY] 완료 ===\n`);
}

// ─── 메인 ─────────────────────────���─────────────────────────────────���─────────
async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleString("ko-KR")}] 바닥 스캐너 시작`);

  // ★ 테스트 매수 - 확인 후 제거
  await testBuy("ETHUSDT");
  process.exit(0);
  // ★★★★★★★★★★��★★★★★★★★

  loadState(); // 향후 쿨다운 복원 시 사용

  try {
    const { symbols: allSymbols, stepSizes, tickSizes } = await getSymbolsInfo();
    const volMap = await getVolumes();
    const symbols = allSymbols.filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT);

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
            const alreadyIn = await hasOpenPosition(sym);
            if (alreadyIn) {
              console.log(`  [SKIP] ${sym} 이미 포지션 있음`);
              r.orderStatus = "이미 보유중";
            } else {
              await setLeverage(sym);
              const order   = await placeMarketBuy(sym, r.price, stepSizes[sym]);
              const sl      = await placeStopLoss(sym, r.price, tickSizes[sym]);
              const slPrice = floorToStep(r.price * (1 - CONFIG.SL_PCT / 100), tickSizes[sym] || 0.01);
              console.log(`  [BUY]  ${sym} 매수 완료 orderId: ${order.orderId} qty: ${order.origQty}`);
              console.log(`  [SL]   ${sym} 스탑로스 $${slPrice} orderId: ${sl.orderId}`);
              r.orderStatus = `매수 완료 | qty: ${order.origQty} | SL: $${slPrice} (-${CONFIG.SL_PCT}%)`;
            }
          } catch (e) {
            console.error(`  [ERR]  ${sym} 주문 실패:`, e.message);
            r.orderStatus = `주문 실패: ${e.message}`;
          }

          results.push(r); // 매수 성공/실패/스킵 모두 결과에 포함
        }
      } catch (e) {
        console.error(`  [ERR]  ${sym} 스캔 오류:`, e.message);
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
