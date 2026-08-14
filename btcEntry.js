/**
 * 평단 기준 무한 DCA (BTC) — 진입/반익절 없음, 포지션 존재 시에만 동작
 *
 * [추매1]   평단 대비 -3%  → 베이스/2 ($6000) 추가
 * [추매2+]  평단 대비 -5%, -10%, -15% ... (5%씩 증가, 무한) → 베이스/2 ($6000)씩 추가
 * [DCA익절] 추매 후 평단+0.5% 복귀 시 DCA분 매도 → 베이스 $12000로 축소
 *
 * cron: 10분마다
 */

const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const VERSION = "2026-08-01 v5";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  LEVERAGE:           50,
  ENTRY_USDT:         15000,
  DCA1_GAP:           -3,   // 1차 추매 트리거 (평단 대비 %)
  DCA_STEP_GAP:       -5,   // 2차부터 트리거 증분 (-5, -10, -15 ...)
};
CONFIG.DCA_UNIT = CONFIG.ENTRY_USDT / 2; // 매 추매 단위 금액

const TARGETS = [
  { symbol: "BTCUSDT", stateFile: path.join(__dirname, "btc_state.json") },
];

// 다음 추매(level번째, 1부터 시작)에 필요한 평단 대비 갭(%) — level1: -3%, level2: -5%, level3: -10% ...
function nextDcaGapPct(level) {
  return level === 1 ? CONFIG.DCA1_GAP : CONFIG.DCA_STEP_GAP * (level - 1);
}

// ─── 상태 ─────────────────────────────────────────────────────────────────────
function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { dcaCount: 0 }; }
}
function saveState(file, s) { fs.writeFileSync(file, JSON.stringify(s, null, 2)); }

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
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    ).on("error", reject);
  });
}
function httpPostSigned(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "fapi.binance.com", path: endpoint, method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body), "X-MBX-APIKEY": CONFIG.BINANCE_API_KEY } },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
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
async function setupLeverage(symbol) {
  const qs1    = `symbol=${symbol}&timestamp=${Date.now()}`;
  const data   = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/leverageBracket?${qs1}&signature=${sign(qs1)}`);
  const useLev = Math.min(CONFIG.LEVERAGE, data?.[0]?.brackets?.[0]?.initialLeverage || 20);
  const lqs    = `symbol=${symbol}&leverage=${useLev}&timestamp=${Date.now()}`;
  await httpPostSigned("/fapi/v1/leverage", `${lqs}&signature=${sign(lqs)}`);
  const mqs    = `symbol=${symbol}&marginType=CROSSED&timestamp=${Date.now()}`;
  try { await httpPostSigned("/fapi/v1/marginType", `${mqs}&signature=${sign(mqs)}`); }
  catch (e) { if (!e.message.includes("-4046") && !e.message.includes("-4047")) throw e; }
  return useLev;
}
async function placeSell(symbol, qty, hedgeMode) {
  const ps  = hedgeMode ? "&positionSide=LONG" : "";
  const oqs = `symbol=${symbol}&side=SELL${ps}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  const order = await httpPostSigned("/fapi/v1/order", `${oqs}&signature=${sign(oqs)}`);
  const filled    = parseFloat(order.avgPrice) || 0;
  const filledQty = parseFloat(order.executedQty) || qty;
  return { filled, filledQty, filledUsdt: filled * filledQty };
}
async function placeBuy(symbol, usdt, cur, stepSize, hedgeMode) {
  const qty    = floorToStep(usdt / cur, stepSize);
  if (qty <= 0) return null;
  const ps     = hedgeMode ? "&positionSide=LONG" : "";
  const oqs    = `symbol=${symbol}&side=BUY${ps}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
  const order  = await httpPostSigned("/fapi/v1/order", `${oqs}&signature=${sign(oqs)}`);
  const filled    = parseFloat(order.avgPrice) || cur;
  const filledQty = parseFloat(order.executedQty) || qty;
  return { filled, filledQty, filledUsdt: filled * filledQty };
}

// ─── 심볼별 처리 ──────────────────────────────────────────────────────────────
async function runSymbol(symbol, stateFile, hedgeMode) {
  const name     = symbol.replace("USDT", "");
  const cur      = await getCurrentPrice(symbol);
  const pos      = await getPosition(symbol, hedgeMode);
  const state    = loadState(stateFile);
  const stepSize = await getStepSize(symbol);

  // 포지션 없으면 상태 전체 리셋
  if (pos.qty === 0) {
    state.dcaCount = 0;
    saveState(stateFile, state);
    console.log(`  [${name}] 포지션 없음 - 대기`);
    return;
  }

  // 포지션 금액 기준 dcaCount 리셋 (베이스로 돌아왔으면 카운트 초기화)
  if (Math.abs(pos.notional - CONFIG.ENTRY_USDT) / CONFIG.ENTRY_USDT <= 0.1) {
    if (state.dcaCount > 0) {
      console.log(`  [${name}] 포지션 $${pos.notional.toFixed(0)} ≈ base $${CONFIG.ENTRY_USDT} → dcaCount 리셋`);
      state.dcaCount = 0;
      saveState(stateFile, state);
    }
  }

  const avgPrice = pos.entryPrice;
  const dcaCount = state.dcaCount || 0;
  const pnlPct   = avgPrice > 0 ? +((cur - avgPrice) / avgPrice * 100).toFixed(2) : 0;
  console.log(`  [${name}] 현재가 $${cur}  포지션 $${pos.notional.toFixed(0)}  평단 $${avgPrice.toFixed(4)}  평단갭 ${pnlPct}%  dcaCount ${dcaCount}`);

  await setupLeverage(symbol);

  // ── DCA 후 평단+0.5% 복귀 시 DCA분 매도 → 베이스로 축소 ───────────────────
  if (dcaCount > 0 && cur >= avgPrice * 1.005) {
    const excessUsdt = +(pos.notional - CONFIG.ENTRY_USDT).toFixed(0);
    const excessQty  = floorToStep(excessUsdt / cur, stepSize);
    console.log(`  [${name}] ★ DCA익절: 현재 $${cur} ≥ 평단+0.5% $${(avgPrice * 1.005).toFixed(4)} → DCA분 ${excessQty}개 매도`);
    if (excessQty > 0) {
      const result = await placeSell(symbol, excessQty, hedgeMode);
      state.dcaCount = 0;
      saveState(stateFile, state);
      console.log(`  [${name}] 매도 완료: ${result.filledQty} @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})`);
      await sendTelegram(
        `📉 <b>${name} DCA익절</b>  (${VERSION})\n─────────────────\n` +
        `평단 <b>$${avgPrice.toFixed(4)}</b>  현재 <b>$${cur}</b>  (+${pnlPct}%)\n\n` +
        `DCA분 매도  ${result.filledQty}개  @ $${result.filled}\n` +
        `금액  <b>$${result.filledUsdt.toFixed(0)}</b>  → 베이스 $${CONFIG.ENTRY_USDT}로 축소`
      );
      return;
    }
  }

  // ── 추매: 평단 대비 -3% / -5% / -10% / -15% ... (무한) → 베이스/2씩 추가 ──
  const nextLevel  = dcaCount + 1;
  const gapNeeded  = nextDcaGapPct(nextLevel);
  const gapFromAvg = avgPrice > 0 ? +((cur - avgPrice) / avgPrice * 100).toFixed(2) : 0;
  if (avgPrice > 0 && gapFromAvg <= gapNeeded) {
    console.log(`  [${name}] ★ 추매${nextLevel}: 평단 대비 ${gapFromAvg}% ≤ ${gapNeeded}% → $${CONFIG.DCA_UNIT} 추가`);
    const result = await placeBuy(symbol, CONFIG.DCA_UNIT, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dcaCount = nextLevel;
    saveState(stateFile, state);
    const newAvg = (pos.notional + result.filledUsdt) / (pos.qty + result.filledQty);
    await sendTelegram(
      `🟡 <b>${name} 추매${nextLevel}</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>${gapFromAvg}%</b>  (트리거 ${gapNeeded}%)\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})\n` +
      `신규 평단  <b>$${newAvg.toFixed(4)}</b>  누적 $${(pos.notional+result.filledUsdt).toFixed(0)}`
    );
    return;
  }

  console.log(`  [${name}] 조건 없음 - 대기 (다음 추매${nextLevel} 트리거 ${gapNeeded}%)`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] BTC DCA (${VERSION})`);
  const hedgeMode = await getIsHedgeMode();
  for (const { symbol, stateFile } of TARGETS) {
    try { await runSymbol(symbol, stateFile, hedgeMode); }
    catch (e) {
      console.error(`  [${symbol}] 오류: ${e.message}`);
      await sendTelegram(`❌ [BTC DCA] ${symbol} 오류: ${e.message}`);
    }
  }
}

main().catch(async e => {
  console.error("에러:", e.message);
  await sendTelegram(`❌ [BTC DCA] 오류: ${e.message}`);
});
