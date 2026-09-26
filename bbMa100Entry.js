/**
 * 볼린저 하단 + 1H 100MA 연속 이탈 신규진입 스캐너
 *
 * 조건 (AND):
 *  1) 현재가 < 4H BB(20,2) 하단
 *  2) 1시간봉 종가가 100MA 아래로 연속 12개봉 이상
 *
 * 신규진입만 수행 (이미 보유 중인 종목은 스킵, DCA 없음)
 * 매수: $500 / 10x Cross
 * BTC 제외, 보유 종목 10개(BTC 제외) 도달 시 신규매수 중단
 *
 * 실행: node bbMa100Entry.js         → 실매수
 *       node bbMa100Entry.js --dry-run → 매수 없이 로그만 출력
 *
 * cron 예시 (매시 5분): 5 * * * *
 */

const https  = require("https");
const crypto = require("crypto");

const VERSION = "2026-09-26 v1";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  MIN_VOLUME_USDT:    1_000_000,
  BB_PERIOD:          20,
  BB_MULT:            2,
  MA_PERIOD:          100,
  CONSECUTIVE_MIN:    12,
  ORDER_USDT:         500,
  LEVERAGE:           10,
  MIN_BALANCE_USDT:   2000,
  MAX_POSITIONS:      10,   // BTC 제외 보유 종목 수 상한 (도달 시 신규매수 중단)
  SKIP_SYMBOLS:       ["USDCUSDT", "BTCDOMUSDT"],
  EXCLUDE_SYMBOLS:    ["BTCUSDT"],
  REQUEST_DELAY:      120,
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

// ─── 지표 ─────────────────────────────────────────────────────────────────────
function calcBBLower(closes, period = CONFIG.BB_PERIOD, mult = CONFIG.BB_MULT) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return mean - mult * std;
}

// 최근 캔들부터 거꾸로, "종가 < 그 시점 기준 100MA" 가 끊기지 않고 연속되는 개수
function countConsecutiveBelowMA(closes, period = CONFIG.MA_PERIOD) {
  let count = 0;
  for (let i = closes.length - 1; i >= period - 1; i--) {
    const slice = closes.slice(i - period + 1, i + 1);
    const ma = slice.reduce((s, v) => s + v, 0) / period;
    if (closes[i] < ma) count++;
    else break;
  }
  return count;
}

// ─── API (Public) ─────────────────────────────────────────────────────────────
async function getSymbolsInfo() {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const symbols = [];
  const stepSizes = {};
  for (const s of d.symbols) {
    if (s.quoteAsset === "USDT" && (s.contractType === "PERPETUAL" || s.contractType === "TRADIFI_PERPETUAL") && s.status === "TRADING") {
      symbols.push(s.symbol);
      const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
      if (lot) stepSizes[s.symbol] = parseFloat(lot.stepSize);
    }
  }
  return { symbols, stepSizes };
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

async function get4hBBLower(symbol) {
  const raw = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=${CONFIG.BB_PERIOD + 2}`);
  const closes = raw.map(k => parseFloat(k[4]));
  return calcBBLower(closes);
}

async function get1hMA100Streak(symbol) {
  const limit = CONFIG.MA_PERIOD + CONFIG.CONSECUTIVE_MIN + 8;
  const raw = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
  const closes = raw.map(k => parseFloat(k[4]));
  if (closes.length < CONFIG.MA_PERIOD) return null;
  const streak = countConsecutiveBelowMA(closes);
  const ma = closes.slice(-CONFIG.MA_PERIOD).reduce((s, v) => s + v, 0) / CONFIG.MA_PERIOD;
  return { streak, ma: +ma.toFixed(6), cur: closes[closes.length - 1] };
}

// ─── API (Signed) ─────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return data.dualSidePosition === true;
}

async function getOpenPosition(symbol, hedgeMode) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  const pos  = hedgeMode
    ? data.find(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
    : data.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);
  return pos ? { entryPrice: parseFloat(pos.entryPrice) } : null;
}

// 전체 계정 기준, 제외 심볼(BTC 등) 뺀 현재 보유 종목 수
async function getHeldSymbolCount(hedgeMode, excludeSymbols) {
  const qs   = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  return data
    .filter(p => hedgeMode ? p.positionSide === "LONG" : true)
    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
    .filter(p => !excludeSymbols.includes(p.symbol))
    .length;
}

async function getAvailableBalance() {
  const qs = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/balance?${qs}&signature=${sign(qs)}`);
  const usdt = data.find(b => b.asset === "USDT");
  return usdt ? parseFloat(usdt.availableBalance) : 0;
}

async function getMaxLeverage(symbol) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/leverageBracket?${qs}&signature=${sign(qs)}`);
  return data?.[0]?.brackets?.[0]?.initialLeverage || 20;
}

async function setMarginType(symbol, type = "CROSSED") {
  const qs = `symbol=${symbol}&marginType=${type}&timestamp=${Date.now()}`;
  try { await httpPostSigned("/fapi/v1/marginType", `${qs}&signature=${sign(qs)}`); } catch (e) {
    if (!e.message.includes("-4046")) throw e;
  }
}

async function setLeverage(symbol, leverage) {
  const maxLev = await getMaxLeverage(symbol);
  const useLev = Math.min(leverage, maxLev);
  const qs = `symbol=${symbol}&leverage=${useLev}&timestamp=${Date.now()}`;
  await httpPostSigned("/fapi/v1/leverage", `${qs}&signature=${sign(qs)}`);
  return useLev;
}

async function placeMarketBuy(symbol, usdtAmount, price, stepSize, hedgeMode) {
  const qty = floorToStep(usdtAmount / price, stepSize || 0.001);
  if (qty <= 0) throw new Error(`수량 계산 오류 (price: ${price}, step: ${stepSize})`);
  const posSide = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=BUY${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleString("ko-KR")}] 볼린저+100MA 신규진입 스캐너 (${VERSION})${DRY_RUN ? " [DRY-RUN]" : ""}`);

  const hedgeMode = await getIsHedgeMode();
  const availableUsdt = await getAvailableBalance();
  const buyEnabled = availableUsdt >= CONFIG.MIN_BALANCE_USDT;
  console.log(`  [잔고] 가용 $${availableUsdt.toFixed(0)} | 매수 ${buyEnabled ? "허용" : "금지 (기준 $" + CONFIG.MIN_BALANCE_USDT + ")"}`);

  let heldCount = await getHeldSymbolCount(hedgeMode, CONFIG.EXCLUDE_SYMBOLS);
  console.log(`  [포지션] 보유 ${heldCount}/${CONFIG.MAX_POSITIONS} (BTC 제외)`);

  const { symbols: allSymbols, stepSizes } = await getSymbolsInfo();
  const { volMap, priceMap } = await getVolumes();

  const symbols = allSymbols
    .filter(s => !CONFIG.SKIP_SYMBOLS.includes(s))
    .filter(s => !CONFIG.EXCLUDE_SYMBOLS.includes(s))
    .filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT);

  console.log(`  대상: ${symbols.length}개 (거래량 $${CONFIG.MIN_VOLUME_USDT.toLocaleString()} 이상)`);

  const buys = [];
  const errors = [];
  let candidateCount = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`\r진행: ${i + 1}/${symbols.length} 후보: ${candidateCount}개`);
    try {
      const curPrice = priceMap[sym];
      const bbLower  = await get4hBBLower(sym);
      if (bbLower === null || curPrice >= bbLower) { await sleep(CONFIG.REQUEST_DELAY); continue; }

      const ma1h = await get1hMA100Streak(sym);
      if (!ma1h || ma1h.streak < CONFIG.CONSECUTIVE_MIN) { await sleep(CONFIG.REQUEST_DELAY); continue; }

      candidateCount++;
      const gapPct = +((curPrice - bbLower) / bbLower * 100).toFixed(2);
      console.log(`\n  [${sym}] ★ 후보: 현재가 $${curPrice} < 4H BB하단 $${bbLower.toFixed(6)} (${gapPct}%) | 1H 100MA 연속 ${ma1h.streak}봉`);

      const posInfo = await getOpenPosition(sym, hedgeMode);
      if (posInfo) {
        console.log(`  [${sym}] 이미 보유중 (진입가 $${posInfo.entryPrice}) → 스킵 (신규진입만)`);
        await sleep(CONFIG.REQUEST_DELAY);
        continue;
      }

      if (!buyEnabled) {
        console.log(`  [${sym}] 잔고 부족 → 매수 스킵`);
        await sleep(CONFIG.REQUEST_DELAY);
        continue;
      }

      if (heldCount >= CONFIG.MAX_POSITIONS) {
        console.log(`  [${sym}] 포지션 한도 도달 (${heldCount}/${CONFIG.MAX_POSITIONS}, BTC 제외) → 매수 스킵`);
        await sleep(CONFIG.REQUEST_DELAY);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [${sym}] (dry-run, 미체결)`);
        buys.push({ symbol: sym, price: curPrice, bbLower, gapPct, streak: ma1h.streak, dryRun: true });
        heldCount++;
        await sleep(CONFIG.REQUEST_DELAY);
        continue;
      }

      let usedLev = CONFIG.LEVERAGE;
      await setMarginType(sym, "CROSSED");
      usedLev = await setLeverage(sym, CONFIG.LEVERAGE);
      const order = await placeMarketBuy(sym, CONFIG.ORDER_USDT, curPrice, stepSizes[sym], hedgeMode);
      const filled    = parseFloat(order.avgPrice) || curPrice;
      const filledQty = parseFloat(order.executedQty) || parseFloat(order.origQty) || 0;

      heldCount++;
      console.log(`  [${sym}] 매수 완료: ${filledQty} @ $${filled} orderId: ${order.orderId} (${usedLev}x) | 보유 ${heldCount}/${CONFIG.MAX_POSITIONS}`);
      buys.push({ symbol: sym, price: filled, qty: filledQty, bbLower, gapPct, streak: ma1h.streak, lev: usedLev });
    } catch (e) {
      console.error(`\n  [${sym}] 오류: ${e.message}`);
      errors.push({ symbol: sym, message: e.message });
    }
    await sleep(CONFIG.REQUEST_DELAY);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n완료: ${elapsed}초 | 후보 ${candidateCount}개 | 매수 ${buys.filter(b => !b.dryRun).length}개`);

  if (buys.length || errors.length) {
    let msg = `📊 <b>볼린저+100MA 신규진입${DRY_RUN ? " (DRY-RUN)" : ""}</b>  (${VERSION})\n─────────────────\n`;
    for (const b of buys) {
      msg += `\n<b>${b.symbol}</b>\n`;
      msg += `  4H BB하단 $${b.bbLower.toFixed(6)}  현재가 $${b.price}  (${b.gapPct}%)\n`;
      msg += `  1H 100MA 연속 ${b.streak}봉\n`;
      if (!b.dryRun) msg += `  ✅ 매수 $${CONFIG.ORDER_USDT}  qty ${b.qty}  ${b.lev}x CROSS\n`;
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
  await sendTelegram(`❌ [볼린저+100MA 신규진입] 오류: ${e.message}`);
});
