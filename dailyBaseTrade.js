/**
 * 써클(CRCL) / 비트마인(BMNR) 일일 베이스 매매
 * 매일 아침 7시 KST (22:00 UTC) 실행
 *
 * 로직 (심볼별, 기존 포지션 있을 때만 동작 - 신규 진입 없음):
 *  1. 베이스 $6000
 *  2. 평단가 대비 손실이면 → $200 매수
 *  3. 평단가 대비 +1% 이상 수익이면 → 베이스($6000) 남기고 초과분 매도
 *  4. 그 외(0% ~ +1% 사이) → 아무 동작 안 함
 *
 * 레버리지/마진타입은 건드리지 않음 (기존 포지션 설정 그대로 사용)
 */

const https  = require("https");
const crypto = require("crypto");

const VERSION = "2026-09-02 v3";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  PROFIT_TRIGGER_PCT: 1, // 평단 대비 이 % 이상 수익이면 베이스로 축소
};

const TARGETS = [
  { symbol: "CRCLUSDT", baseUsdt: 8000, dcaUsdt: 200 }, // 써클
  { symbol: "BMNRUSDT", baseUsdt: 6000, dcaUsdt: 200 }, // 비트마인
];

// --only SYMBOL,SYMBOL2 인자로 특정 심볼만 실행 가능
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
    https.get(url, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        else resolve(JSON.parse(d));
      });
    }).on("error", reject);
  });
}
function httpGetAuth(url) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    https.get(
      { hostname: p.hostname, path: p.pathname + p.search,
        headers: { "X-MBX-APIKEY": CONFIG.BINANCE_API_KEY } },
      res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
          else resolve(JSON.parse(d));
        });
      }
    ).on("error", reject);
  });
}
function httpPostSigned(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "fapi.binance.com", path: endpoint, method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body), "X-MBX-APIKEY": CONFIG.BINANCE_API_KEY } },
      res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
          else resolve(JSON.parse(d));
        });
      }
    );
    req.on("error", reject); req.write(body); req.end();
  });
}
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", family: 4,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject); req.write(payload); req.end();
  });
}
async function sendTelegram(text) {
  try {
    await httpsPost("api.telegram.org", `/bot${CONFIG.TG_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) { console.error(`[TG] 전송 실패: ${e.message}`); }
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs = `timestamp=${Date.now()}`;
  const r  = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return r.dualSidePosition === true;
}
async function getPosition(symbol, hedgeMode) {
  const qs   = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  const pos  = hedgeMode
    ? data.find(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
    : data.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);
  if (!pos) return { qty: 0, notional: 0, entryPrice: 0 };
  return {
    qty:        Math.abs(parseFloat(pos.positionAmt)),
    notional:   Math.abs(parseFloat(pos.notional)),
    entryPrice: parseFloat(pos.entryPrice),
  };
}
async function getCurrentPrice(symbol) {
  const r = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  return parseFloat(r.price);
}
async function getStepSize(symbol) {
  const info = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const sym  = info.symbols.find(s => s.symbol === symbol);
  const lot  = sym.filters.find(f => f.filterType === "LOT_SIZE");
  return lot ? parseFloat(lot.stepSize) : 1;
}
function floorToStep(value, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}
// 주문 즉시 응답에 avgPrice가 비어 오는 경우가 있어, 체결정보 재조회로 보정
async function getOrderFill(symbol, orderId) {
  const qs = `symbol=${symbol}&orderId=${orderId}&timestamp=${Date.now()}`;
  return httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/order?${qs}&signature=${sign(qs)}`);
}
async function resolveFill(symbol, order, fallbackQty, fallbackPrice) {
  let filled    = parseFloat(order.avgPrice) || 0;
  let filledQty = parseFloat(order.executedQty) || 0;
  if (!filled || !filledQty) {
    try {
      const o2 = await getOrderFill(symbol, order.orderId);
      filled    = parseFloat(o2.avgPrice) || filled || fallbackPrice;
      filledQty = parseFloat(o2.executedQty) || filledQty || fallbackQty;
    } catch (e) {
      filled    = filled || fallbackPrice;
      filledQty = filledQty || fallbackQty;
    }
  }
  return { filled, filledQty, filledUsdt: filled * filledQty };
}
async function placeBuy(symbol, usdt, cur, stepSize, hedgeMode) {
  const qty = floorToStep(usdt / cur, stepSize);
  if (qty <= 0) return null;
  const ps    = hedgeMode ? "&positionSide=LONG" : "";
  const qs    = `symbol=${symbol}&side=BUY${ps}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  const order = await httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
  return resolveFill(symbol, order, qty, cur);
}
async function placeSell(symbol, qty, hedgeMode, cur) {
  const ps    = hedgeMode ? "&positionSide=LONG" : "";
  const qs    = `symbol=${symbol}&side=SELL${ps}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  const order = await httpPostSigned("/fapi/v1/order", `${qs}&signature=${sign(qs)}`);
  return resolveFill(symbol, order, qty, cur);
}

// ─── 심볼별 처리 ──────────────────────────────────────────────────────────────
async function runSymbol(target, hedgeMode) {
  const { symbol, baseUsdt, dcaUsdt } = target;
  const name = symbol.replace("USDT", "");

  const pos = await getPosition(symbol, hedgeMode);
  if (pos.qty === 0) {
    console.log(`  [${name}] 포지션 없음 - 스킵`);
    return { symbol, status: "스킵 (포지션 없음)" };
  }

  const cur       = await getCurrentPrice(symbol);
  const avgPrice  = pos.entryPrice;
  const costBasis = pos.qty * avgPrice; // 실매수금(원가) = 수량 × 평단가, 현재가 변동과 무관
  const pnlPct    = avgPrice > 0 ? +((cur - avgPrice) / avgPrice * 100).toFixed(2) : 0;
  console.log(`  [${name}] 현재가 $${cur}  평단 $${avgPrice}  실매수금 $${costBasis.toFixed(0)}  갭 ${pnlPct}%`);

  // ── 1% 이상 수익 → 베이스 남기고 매도 (실매수금 기준, 평가금액 아님) ──
  if (pnlPct >= CONFIG.PROFIT_TRIGGER_PCT) {
    const excessCostBasis = +(costBasis - baseUsdt).toFixed(0);
    if (excessCostBasis <= 0) {
      console.log(`  [${name}] 수익중(${pnlPct}%)이나 실매수금 $${costBasis.toFixed(0)} ≤ 베이스 $${baseUsdt} - 매도 불필요`);
      return { symbol, status: `스킵 (베이스 이하, +${pnlPct}%)` };
    }
    const stepSize  = await getStepSize(symbol);
    const excessQty = floorToStep(excessCostBasis / avgPrice, stepSize); // 초과 실매수금에 해당하는 수량(평단가 기준)
    if (excessQty <= 0) return { symbol, status: `스킵 (매도수량 0)` };

    const result = await placeSell(symbol, excessQty, hedgeMode, cur);
    console.log(`  [${name}] 매도 완료: ${result.filledQty} @ $${result.filled} ($${result.filledUsdt.toFixed(0)})`);
    await sendTelegram(
      `📉 <b>${name} 베이스 축소</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice}</b>  현재 <b>$${cur}</b>  (+${pnlPct}%)\n` +
      `실매수금 <b>$${costBasis.toFixed(0)}</b> → 베이스 $${baseUsdt}로 축소\n\n` +
      `매도  ${result.filledQty}개  @ $${result.filled}\n` +
      `금액  <b>$${result.filledUsdt.toFixed(0)}</b>`
    );
    return { symbol, status: "매도 완료", ...result };
  }

  // ── 손실 → $dcaUsdt 매수 ──
  if (pnlPct < 0) {
    const stepSize = await getStepSize(symbol);
    const result   = await placeBuy(symbol, dcaUsdt, cur, stepSize, hedgeMode);
    if (!result) return { symbol, status: "스킵 (매수수량 0)" };

    console.log(`  [${name}] 매수 완료: ${result.filledQty} @ $${result.filled} ($${result.filledUsdt.toFixed(0)})`);
    await sendTelegram(
      `🟡 <b>${name} 일일 매수</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice}</b>  현재 <b>$${cur}</b>  (${pnlPct}%)\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}\n` +
      `금액  <b>$${result.filledUsdt.toFixed(0)}</b>`
    );
    return { symbol, status: "매수 완료", ...result };
  }

  // ── 0% ~ +1% 사이 → 대기 ──
  console.log(`  [${name}] 조건 없음 (${pnlPct}%) - 대기`);
  return { symbol, status: `대기 (${pnlPct}%)` };
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] 일일 베이스 매매 (${VERSION})`);
  const hedgeMode = await getIsHedgeMode();
  const targets   = onlySet ? TARGETS.filter(t => onlySet.has(t.symbol)) : TARGETS;

  for (const target of targets) {
    try {
      await runSymbol(target, hedgeMode);
    } catch (e) {
      console.error(`  [${target.symbol}] 오류: ${e.message}`);
      await sendTelegram(`❌ [일일 베이스 매매] ${target.symbol} 오류: ${e.message}`);
    }
  }
}

main().catch(async e => {
  console.error("에러:", e.message);
  await sendTelegram(`❌ [일일 베이스 매매] 오류: ${e.message}`);
});
