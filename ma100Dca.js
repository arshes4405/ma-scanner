/**
 * 1H 100MA 추매 배치
 * 대상: 현재 보유 중인 전체 포지션 (BTC 제외)
 * 조건: 현재가 < 1시간봉 100MA → $100 고정 추매
 *  - 손실 중일 때만 매수 (현재가 < 평단가), 수익권이면 스킵
 *  - 레버리지/마진타입 별도 설정 안 함 (기존 포지션 설정 유지)
 *  - 동일 1시간봉 내 중복 매수 방지 (캔들당 1회)
 *  - 종목당 포지션 $3,000 상한 (전체 notional 기준, 남은 한도만큼만 추매)
 *  - 포지션이 한도의 절반($1,500) 초과 시 2시간에 1회로 추매 속도 제한
 *  - 매도: 평단 대비 +5% → 전량 매도 (익절)
 *
 * 실행: node ma100Dca.js         → 실매수
 *       node ma100Dca.js --dry-run → 매수 없이 로그만 출력
 *
 * cron 예시 (매시 5분): 5 * * * *
 */

const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const VERSION = "2026-09-29 v2";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  INTERVAL:           "1h",
  MA_PERIOD:          100,
  DCA_USDT:           100,
  MAX_NOTIONAL_USDT:  3000,  // 종목당 포지션 상한 (전체 notional 기준, 도달 시 추매 중단)
  MIN_ORDER_USDT:     5,     // 바이낸스 최소 주문금액 미만이면 추매 스킵
  HIGH_NOTIONAL_INTERVAL_MS: 2 * 60 * 60 * 1000,  // 포지션이 한도의 절반 초과 시 추매 최소 간격 (2시간)
  TP_PCT:             5,     // 평단 대비 +5% → 전량 매도
  EXCLUDE_SYMBOLS:    ["BTCUSDT"],
  REQUEST_DELAY:      150,
  STATE_FILE:         path.join(__dirname, "ma100_dca_state.json"),
};

const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP 유틸 ────────────────────────────────────────────────────────────────
function sign(qs) {
  return crypto.createHmac("sha256", CONFIG.BINANCE_SECRET_KEY).update(qs).digest("hex");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        else resolve(JSON.parse(data));
      });
    }).on("error", reject);
  });
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
        res.on("data", (c) => (d += c));
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
      { hostname, path, method: "POST", family: 4,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function sendTelegram(text) {
  try {
    await httpsPost("api.telegram.org",
      `/bot${CONFIG.TG_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (e) { console.error(`[TG] 전송 실패: ${e.message}`); }
}

function floorToStep(value, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

// ─── 상태 (캔들당 1회 제한) ───────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
  } catch (_) {}
  return {};
}

function saveState(state) {
  try { fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state), "utf8"); } catch (_) {}
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs = `timestamp=${Date.now()}`;
  const r  = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return r.dualSidePosition === true;
}

// 심볼 지정 없이 전체 포지션 조회 → 보유 중인 심볼만 추출
async function getAllOpenPositions(hedgeMode) {
  const qs   = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  return data
    .filter(p => hedgeMode ? p.positionSide === "LONG" : true)
    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
    .map(p => ({
      symbol:     p.symbol,
      entryPrice: parseFloat(p.entryPrice),
      qty:        Math.abs(parseFloat(p.positionAmt)),
      notional:   Math.abs(parseFloat(p.notional)),
    }));
}

async function getStepSizes() {
  const info = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const map  = {};
  for (const s of info.symbols) {
    const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
    if (lot) map[s.symbol] = parseFloat(lot.stepSize);
  }
  return map;
}

async function get1hMA100(symbol) {
  const raw = await httpGet(
    `${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.MA_PERIOD + 2}`
  );
  const closes = raw.map(k => parseFloat(k[4]));
  if (closes.length < CONFIG.MA_PERIOD) return null;
  const ma = closes.slice(-CONFIG.MA_PERIOD).reduce((s, v) => s + v, 0) / CONFIG.MA_PERIOD;
  return {
    ma:         +ma.toFixed(6),
    cur:        closes[closes.length - 1],
    candleTime: raw[raw.length - 1][0],
  };
}

async function placeMarketBuy(symbol, usdtAmount, price, stepSize, hedgeMode) {
  const qty = floorToStep(usdtAmount / price, stepSize || 0.001);
  if (qty <= 0) throw new Error(`수량 계산 오류 (price: ${price}, step: ${stepSize})`);
  const posSide = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=BUY${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

async function placeMarketSell(symbol, qty, stepSize, hedgeMode) {
  const sellQty = floorToStep(qty, stepSize || 0.001);
  if (sellQty <= 0) throw new Error(`매도 수량 오류 (qty: ${qty}, step: ${stepSize})`);
  const posSide = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=SELL${posSide}&type=MARKET&quantity=${sellQty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] 1H 100MA 추매 배치 (${VERSION})${DRY_RUN ? " [DRY-RUN]" : ""}`);

  const hedgeMode  = await getIsHedgeMode();
  const positions  = (await getAllOpenPositions(hedgeMode))
    .filter(p => !CONFIG.EXCLUDE_SYMBOLS.includes(p.symbol));

  console.log(`  보유 종목 (BTC 제외): ${positions.length}개 → ${positions.map(p => p.symbol).join(", ") || "없음"}`);

  if (positions.length === 0) return;

  const stepSizes = await getStepSizes();
  const state     = loadState();

  // 더 이상 보유하지 않는 심볼의 상태는 정리
  const heldSet = new Set(positions.map(p => p.symbol));
  for (const sym of Object.keys(state)) if (!heldSet.has(sym)) delete state[sym];

  const buys   = [];
  const sells  = [];
  const errors = [];

  for (const { symbol, entryPrice, notional, qty } of positions) {
    try {
      const { ma, cur, candleTime } = await get1hMA100(symbol) || {};
      if (ma === undefined) { console.log(`  [${symbol}] 캔들 부족 - 스킵`); continue; }

      // 익절: 평단 대비 +5% → 전량 매도
      const tpPrice = entryPrice * (1 + CONFIG.TP_PCT / 100);
      if (entryPrice > 0 && cur >= tpPrice) {
        const pnlPct = +((cur - entryPrice) / entryPrice * 100).toFixed(2);
        console.log(`  [${symbol}] ★ 익절: 현재가 $${cur} >= 평단+${CONFIG.TP_PCT}% $${tpPrice.toFixed(6)} (+${pnlPct}%) → 전량 매도${DRY_RUN ? " (dry-run, 미체결)" : ""}`);
        if (DRY_RUN) {
          sells.push({ symbol, price: cur, entryPrice, pnlPct, dryRun: true });
          continue;
        }
        const order = await placeMarketSell(symbol, qty, stepSizes[symbol], hedgeMode);
        const filled    = parseFloat(order.avgPrice) || cur;
        const filledQty = parseFloat(order.executedQty) || parseFloat(order.origQty) || qty;
        delete state[symbol];
        saveState(state);
        console.log(`  [${symbol}] 매도 완료: ${filledQty} @ $${filled} orderId: ${order.orderId}`);
        sells.push({ symbol, price: filled, qty: filledQty, entryPrice, pnlPct });
        continue;
      }

      const gapPct = +((cur - ma) / ma * 100).toFixed(2);

      if (state[symbol]?.candleTime === candleTime) {
        console.log(`  [${symbol}] 현재가 $${cur} 100MA $${ma} (${gapPct}%) - 동일 캔들 이미 매수함`);
        continue;
      }

      if (cur >= ma) {
        console.log(`  [${symbol}] 현재가 $${cur} 100MA $${ma} (${gapPct}%) - 조건 미충족`);
        continue;
      }

      // 손실 중일 때만 추매 (현재가 < 평단가)
      if (cur >= entryPrice) {
        console.log(`  [${symbol}] 현재가 $${cur} < 100MA $${ma} 이지만 수익권 (평단 $${entryPrice}) - 추매 스킵`);
        continue;
      }

      // 종목당 포지션 상한 체크 (남은 한도만큼만 추매)
      const remaining = CONFIG.MAX_NOTIONAL_USDT - notional;
      if (remaining < CONFIG.MIN_ORDER_USDT) {
        console.log(`  [${symbol}] 포지션 $${notional.toFixed(0)} / 한도 $${CONFIG.MAX_NOTIONAL_USDT} 도달 - 추매 스킵`);
        continue;
      }

      // 한도 절반 초과 시 추매 간격을 2시간으로 제한
      const halfCap = CONFIG.MAX_NOTIONAL_USDT / 2;
      if (notional > halfCap) {
        const lastTime = state[symbol]?.time || 0;
        const elapsed  = Date.now() - lastTime;
        if (elapsed < CONFIG.HIGH_NOTIONAL_INTERVAL_MS) {
          const remainMin = Math.ceil((CONFIG.HIGH_NOTIONAL_INTERVAL_MS - elapsed) / 60000);
          console.log(`  [${symbol}] 포지션 $${notional.toFixed(0)} > 한도절반 $${halfCap} → 2시간 간격 제한 (${remainMin}분 남음)`);
          continue;
        }
      }

      const dcaAmount = Math.min(CONFIG.DCA_USDT, remaining);

      console.log(`  [${symbol}] ★ 현재가 $${cur} < 100MA $${ma} (${gapPct}%) → $${dcaAmount.toFixed(0)} 추매 (포지션 $${notional.toFixed(0)}/$${CONFIG.MAX_NOTIONAL_USDT})${DRY_RUN ? " (dry-run, 미체결)" : ""}`);

      if (DRY_RUN) {
        buys.push({ symbol, price: cur, ma, gapPct, entryPrice, notional, dcaAmount, dryRun: true });
        continue;
      }

      const order      = await placeMarketBuy(symbol, dcaAmount, cur, stepSizes[symbol], hedgeMode);
      // 주문 ACK 응답은 체결 확정 전에 도착해 avgPrice/executedQty가 0으로 올 수 있음 → origQty/현재가로 대체 표시
      const filled     = parseFloat(order.avgPrice) || cur;
      const filledQty  = parseFloat(order.executedQty) || parseFloat(order.origQty) || 0;

      state[symbol] = { candleTime, time: Date.now() };
      saveState(state);

      console.log(`  [${symbol}] 매수 완료: ${filledQty} @ $${filled} orderId: ${order.orderId} (포지션 $${(notional + dcaAmount).toFixed(0)}/$${CONFIG.MAX_NOTIONAL_USDT})`);
      buys.push({ symbol, price: filled, qty: filledQty, ma, gapPct, entryPrice, notional, dcaAmount });
    } catch (e) {
      console.error(`  [${symbol}] 오류: ${e.message}`);
      errors.push({ symbol, message: e.message });
    }
    await sleep(CONFIG.REQUEST_DELAY);
  }

  if (buys.length || sells.length || errors.length) {
    let msg = `📊 <b>1H 100MA 추매/익절${DRY_RUN ? " (DRY-RUN)" : ""}</b>  (${VERSION})\n─────────────────\n`;
    for (const s of sells) {
      msg += `\n<b>${s.symbol}</b>  💰 익절\n`;
      msg += `  평단 $${s.entryPrice}  현재가 $${s.price}  (+${s.pnlPct}%)\n`;
      if (!s.dryRun) msg += `  ✅ 전량 매도  qty ${s.qty}\n`;
      else msg += `  🔎 조건 충족 (매도 안 함)\n`;
    }
    for (const b of buys) {
      msg += `\n<b>${b.symbol}</b>\n`;
      msg += `  100MA $${b.ma}  현재가 $${b.price}  (${b.gapPct}%)\n`;
      if (!b.dryRun) msg += `  ✅ 추매 $${b.dcaAmount.toFixed(0)}  qty ${b.qty}  포지션 $${(b.notional + b.dcaAmount).toFixed(0)}/$${CONFIG.MAX_NOTIONAL_USDT}\n`;
      else msg += `  🔎 조건 충족 (매수 안 함)\n`;
    }
    for (const e of errors) {
      msg += `\n<b>${e.symbol}</b>\n  ❌ ${e.message}\n`;
    }
    await sendTelegram(msg);
  }
}

main().catch(async e => {
  console.error("에러:", e.message);
  await sendTelegram(`❌ [1H 100MA 추매] 오류: ${e.message}`);
});
