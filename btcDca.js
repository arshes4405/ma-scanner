/**
 * 일일 DCA 매수
 * 매일 오후 3시 KST (06:00 UTC) 실행
 *  - BTC: 0.01개 무조건 매수
 */

const https  = require("https");
const crypto = require("crypto");

const VERSION = "2026-06-09 v2";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  LEVERAGE:           100,
};

// BTC: qty 고정 (0.01개 무조건 매수)
const DCA_TARGETS = [
  { symbol: "BTCUSDT",  qty: 0.01, usdtAmount: null, onlyWhenLoss: false },
];

// --only SYMBOL,SYMBOL2 인자로 특정 심볼만 실행 가능 (예: node btcDca.js --only CRCLUSDT,ETHUSDT)
const onlySet = (() => {
  const idx = process.argv.indexOf("--only");
  if (idx === -1) return null;
  return new Set(process.argv[idx + 1].split(","));
})();

// ─── HTTP 유틸 ────────────────────────────────────────────────────────────────
function sign(qs) {
  return crypto.createHmac("sha256", CONFIG.BINANCE_SECRET_KEY).update(qs).digest("hex");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
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
        res.on("data", c => data += c);
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
      { hostname, path, method: "POST", family: 4,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
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
  } catch (e) {
    console.error(`[TG] 전송 실패: ${e.message}`);
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs = `timestamp=${Date.now()}`;
  const r  = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return r.dualSidePosition === true;
}

async function getStepSize(symbol) {
  const info = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const sym  = info.symbols.find(s => s.symbol === symbol);
  if (!sym) return 1;
  const lot  = sym.filters.find(f => f.filterType === "LOT_SIZE");
  return lot ? parseFloat(lot.stepSize) : 1;
}

// 현재가 조회
async function getPrice(symbol) {
  const data = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  return parseFloat(data.price);
}

// 포지션 손익 조회 (포지션 없으면 null, 있으면 unrealizedProfit)
async function getPositionPnl(symbol, hedgeMode) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  const pos  = hedgeMode
    ? data.find(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
    : data.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);
  if (!pos) return null;
  return parseFloat(pos.unRealizedProfit);
}

function floorToStep(value, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

async function setMarginType(symbol) {
  const qs = `symbol=${symbol}&marginType=CROSSED&timestamp=${Date.now()}`;
  try { await httpPostSigned("/fapi/v1/marginType", `${qs}&signature=${sign(qs)}`); } catch (e) {
    if (!e.message.includes("-4046") && !e.message.includes("-4047")) throw e;
  }
}

async function getMaxLeverage(symbol) {
  const qs  = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/leverageBracket?${qs}&signature=${sign(qs)}`);
  return data?.[0]?.brackets?.[0]?.initialLeverage || 20;
}

async function setLeverage(symbol, leverage) {
  const maxLev = await getMaxLeverage(symbol);
  const useLev = Math.min(leverage, maxLev);
  const qs = `symbol=${symbol}&leverage=${useLev}&timestamp=${Date.now()}`;
  await httpPostSigned("/fapi/v1/leverage", `${qs}&signature=${sign(qs)}`);
  return useLev;
}

async function placeMarketBuy(symbol, qty, hedgeMode) {
  const posSide = hedgeMode ? "&positionSide=LONG" : "";
  const qs = `symbol=${symbol}&side=BUY${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  return httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] 일일 DCA 시작 (${VERSION})`);

  const hedgeMode = await getIsHedgeMode();
  const results   = [];

  const targets = onlySet ? DCA_TARGETS.filter(t => onlySet.has(t.symbol)) : DCA_TARGETS;

  for (const target of targets) {
    const { symbol, onlyWhenLoss, usdtAmountNoLoss } = target;
    let   { qty, usdtAmount } = target;

    try {
      // 손실 조건 체크
      if (onlyWhenLoss || usdtAmountNoLoss) {
        const pnl = await getPositionPnl(symbol, hedgeMode);
        if (pnl === null) {
          console.log(`  [${symbol}] 포지션 없음 - 스킵`);
          results.push({ symbol, status: "스킵 (포지션 없음)", pnl: null });
          continue;
        }
        if (pnl >= 0 && usdtAmountNoLoss) {
          // 이익/보합 → 소액 매수
          usdtAmount = usdtAmountNoLoss;
          console.log(`  [${symbol}] 이익중 ($${pnl.toFixed(2)}) - $${usdtAmountNoLoss} 매수`);
        } else if (pnl >= 0) {
          console.log(`  [${symbol}] 이익중 ($${pnl.toFixed(2)}) - 스킵`);
          results.push({ symbol, status: `스킵 (이익중 $${pnl.toFixed(2)})`, pnl });
          continue;
        } else {
          console.log(`  [${symbol}] 손실중 ($${pnl.toFixed(2)}) - $${usdtAmount} 매수`);
        }
      }

      // 수량 계산 (usdtAmount 기준)
      if (usdtAmount) {
        const price    = await getPrice(symbol);
        const stepSize = await getStepSize(symbol);
        qty = floorToStep(usdtAmount / price, stepSize);
      }

      await setMarginType(symbol);
      const usedLev     = await setLeverage(symbol, CONFIG.LEVERAGE);
      const order       = await placeMarketBuy(symbol, qty, hedgeMode);
      const filledPrice = parseFloat(order.avgPrice) || await getPrice(symbol);
      const filledQty   = parseFloat(order.executedQty) || qty;
      const filledUsdt  = filledPrice * filledQty;

      console.log(`  [${symbol}] 매수 완료: ${filledQty} @ $${filledPrice}  ($${filledUsdt.toFixed(2)})  ${usedLev}x`);
      results.push({ symbol, status: "매수 완료", qty: filledQty, price: filledPrice, usdt: filledUsdt, lev: usedLev });

    } catch (e) {
      console.error(`  [${symbol}] 오류: ${e.message}`);
      results.push({ symbol, status: `오류: ${e.message}` });
    }
  }

  // ── TG 메시지 ──
  let msg = `📊 <b>일일 DCA</b>  (${VERSION})\n─────────────────\n`;
  for (const r of results) {
    if (r.status === "매수 완료") {
      msg += `\n✅ <b>${r.symbol}</b>  ${r.lev}x\n`;
      msg += `   ${r.qty} @ $${r.price?.toLocaleString()}  ($${r.usdt?.toFixed(2)})\n`;
    } else {
      msg += `\n⏭ <b>${r.symbol}</b>  ${r.status}\n`;
    }
  }
  msg += `CROSS | 최대 ${CONFIG.LEVERAGE}x (심볼별 상이)`;

  await sendTelegram(msg);
}

main().catch(async e => {
  console.error("에러:", e.message);
  await sendTelegram(`❌ [DCA] 오류: ${e.message}`);
});
