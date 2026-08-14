/**
 * 1H 25MA 진입 + 평단 기준 DCA (HYPE)
 *
 * [진입]  25MA 대비 -2% 첫 터치 → $4000 매수
 * [추매1] 평단 대비 -3% → $2000 추가
 * [추매2] 추매1 후 신규 평단 대비 -5% → $2000 추가
 * [추매3] 추매2 후 신규 평단 대비 -8% → $2000 추가
 * [추매4] 추매3 후 신규 평단 대비 -12% → $2000 추가
 * [베이스 채우기] 포지션 < base*0.9 + 25MA -2% → base까지 매수
 * [완익]  평단 대비 +8% → 전량 매도
 *
 * cron: 10분마다
 */

const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const VERSION = "2026-07-23 v15";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID          || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY     || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY  || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  MA_PERIOD:          25,
  LEVERAGE:           50,
  ENTRY_USDT:         4000,
  DCA1_USDT:          2000,
  DCA2_USDT:          2000,
  DCA3_USDT:          2000,
  DCA4_USDT:          2000,
  ENTRY_GAP:          -2,
  FULL_TP_PCT:        8,   // 평단 대비 +8% → 전량 익절
};

const TARGETS = [
  { symbol: "HYPEUSDT", stateFile: path.join(__dirname, "hype_state.json") },
];

// ─── 상태 ─────────────────────────────────────────────────────────────────────
function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { dca1Done: false, dca2Done: false, dca3Done: false, dca4Done: false }; }
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
async function get1hMA25(symbol) {
  const raw    = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=27`);
  const closes = raw.map(k => parseFloat(k[4]));
  const ma     = closes.slice(-CONFIG.MA_PERIOD).reduce((s, v) => s + v, 0) / CONFIG.MA_PERIOD;
  return { ma: +ma.toFixed(4), cur: closes[closes.length - 1] };
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
  const name = symbol.replace("USDT", "");
  const { ma, cur } = await get1hMA25(symbol);
  const maGap    = +((cur - ma) / ma * 100).toFixed(2);
  const pos      = await getPosition(symbol, hedgeMode);
  const state    = loadState(stateFile);
  const stepSize = await getStepSize(symbol);

  // 포지션 없으면 상태 전체 리셋
  if (pos.qty === 0) {
    state.dca1Done = false;
    state.dca2Done = false;
    state.dca3Done = false;
    state.dca4Done = false;
    saveState(stateFile, state);
  }

  // 포지션 금액 기준 DCA 상태 리셋
  if (pos.qty > 0) {
    const base      = CONFIG.ENTRY_USDT;
    const dca1Level = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT;
    const dca2Level = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT + CONFIG.DCA2_USDT;
    const dca3Level = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT + CONFIG.DCA2_USDT + CONFIG.DCA3_USDT;
    if (Math.abs(pos.notional - base) / base <= 0.1) {
      console.log(`  [${name}] 포지션 $${pos.notional.toFixed(0)} ≈ base $${base} → dca1/dca2/dca3/dca4 리셋`);
      state.dca1Done = false;
      state.dca2Done = false;
      state.dca3Done = false;
      state.dca4Done = false;
      saveState(stateFile, state);
    } else if (state.dca2Done && Math.abs(pos.notional - dca1Level) / dca1Level <= 0.1) {
      console.log(`  [${name}] 포지션 $${pos.notional.toFixed(0)} ≈ dca1Level $${dca1Level} → dca2/dca3/dca4 리셋`);
      state.dca2Done = false;
      state.dca3Done = false;
      state.dca4Done = false;
      saveState(stateFile, state);
    } else if (state.dca3Done && Math.abs(pos.notional - dca2Level) / dca2Level <= 0.1) {
      console.log(`  [${name}] 포지션 $${pos.notional.toFixed(0)} ≈ dca2Level $${dca2Level} → dca3/dca4 리셋`);
      state.dca3Done = false;
      state.dca4Done = false;
      saveState(stateFile, state);
    } else if (state.dca4Done && Math.abs(pos.notional - dca3Level) / dca3Level <= 0.1) {
      console.log(`  [${name}] 포지션 $${pos.notional.toFixed(0)} ≈ dca3Level $${dca3Level} → dca4 리셋`);
      state.dca4Done = false;
      saveState(stateFile, state);
    }
  }

  const avgPrice = pos.qty > 0 ? pos.entryPrice : 0;
  const pnlPct   = avgPrice > 0 ? +((cur - avgPrice) / avgPrice * 100).toFixed(2) : 0;
  console.log(`  [${name}] 현재가 $${cur}  25MA $${ma}  MA갭 ${maGap}%  포지션 $${pos.notional.toFixed(0)}  평단 $${avgPrice.toFixed(4)}  평단갭 ${pnlPct}%`);

  const useLev = await setupLeverage(symbol);

  // ── DCA 후 평단+0.5% 복귀 시 DCA분 매도 → 베이스로 축소 ───────────────────
  const dcaSellCond = pos.qty > 0
    && (state.dca1Done || state.dca2Done || state.dca3Done || state.dca4Done)
    && cur >= avgPrice * 1.005;
  if (dcaSellCond) {
    const excessUsdt = +(pos.notional - CONFIG.ENTRY_USDT).toFixed(0);
    const excessQty  = floorToStep(excessUsdt / cur, stepSize);
    console.log(`  [${name}] ★ DCA익절: 현재 $${cur} ≥ 평단+0.5% $${(avgPrice * 1.005).toFixed(4)} → DCA분 ${excessQty}개 매도`);
    if (excessQty > 0) {
      const result = await placeSell(symbol, excessQty, hedgeMode);
      state.dca1Done = false;
      state.dca2Done = false;
      state.dca3Done = false;
      state.dca4Done = false;
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

  // ── 완익: 평단 대비 +8% → 전량 매도 ───────────────────────────────────────
  const fullTpCond = pos.qty > 0 && avgPrice > 0 && cur >= avgPrice * (1 + CONFIG.FULL_TP_PCT / 100);
  if (fullTpCond) {
    console.log(`  [${name}] ★ 완익: 현재 $${cur} ≥ 평단+${CONFIG.FULL_TP_PCT}% $${(avgPrice * (1 + CONFIG.FULL_TP_PCT / 100)).toFixed(4)} → 전량 매도`);
    const result = await placeSell(symbol, floorToStep(pos.qty, stepSize), hedgeMode);
    if (!result) return;
    state.dca1Done = false;
    state.dca2Done = false;
    state.dca3Done = false;
    state.dca4Done = false;
    state.lastBuyPrice = 0;
    saveState(stateFile, state);
    console.log(`  [${name}] 매도 완료: ${result.filledQty} @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})`);
    await sendTelegram(
      `💰 <b>${name} 완익</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>+${pnlPct}%</b>\n\n` +
      `매도  ${result.filledQty}개  @ $${result.filled}\n` +
      `금액  <b>$${result.filledUsdt.toFixed(0)}</b>`
    );
    return;
  }

  // ── 포지션 있지만 베이스 미달 + 25MA -2% → 베이스까지 채우기 ──────────────
  if (pos.qty > 0 && pos.notional < CONFIG.ENTRY_USDT * 0.9 && maGap <= CONFIG.ENTRY_GAP) {
    const topUpUsdt = +(CONFIG.ENTRY_USDT - pos.notional).toFixed(0);
    console.log(`  [${name}] ★ 베이스 채우기: $${pos.notional.toFixed(0)} → $${CONFIG.ENTRY_USDT}`);
    const result = await placeBuy(symbol, topUpUsdt, cur, stepSize, hedgeMode);
    if (!result) return;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    await sendTelegram(
      `🔵 <b>${name} 베이스 채우기</b>  (${VERSION})\n─────────────────\n` +
      `25MA <b>$${ma}</b>  갭 <b>${maGap}%</b>\n` +
      `포지션 $${pos.notional.toFixed(0)} → 베이스 $${CONFIG.ENTRY_USDT}\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}\n` +
      `금액  <b>$${result.filledUsdt.toFixed(0)}</b>  ${useLev}x CROSS`
    );
    return;
  }

  // ── 초기 진입: 포지션 없고 25MA -2% ──────────────────────────────────────
  if (pos.qty === 0 && maGap <= CONFIG.ENTRY_GAP) {
    console.log(`  [${name}] ★ 초기 진입: MA갭 ${maGap}% → $${CONFIG.ENTRY_USDT}`);
    const result = await placeBuy(symbol, CONFIG.ENTRY_USDT, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dca1Done = false;
    state.dca2Done = false;
    state.dca3Done = false;
    state.dca4Done = false;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    await sendTelegram(
      `🟢 <b>${name} 초기 진입</b>  (${VERSION})\n─────────────────\n` +
      `25MA <b>$${ma}</b>  갭 <b>${maGap}%</b>\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}\n` +
      `금액  <b>$${result.filledUsdt.toFixed(0)}</b>  ${useLev}x CROSS`
    );
    return;
  }

  // ── 추매1: 평단 -3% → $420까지 채우기 ───────────────────────────────────
  if (pos.qty > 0 && !state.dca1Done && avgPrice > 0 && cur <= avgPrice * 0.97) {
    const dca1Target = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT;
    const topUpUsdt  = +(dca1Target - pos.notional).toFixed(0);
    const gapFromAvg = +((cur - avgPrice) / avgPrice * 100).toFixed(2);
    console.log(`  [${name}] ★ 추매1: 평단 대비 ${gapFromAvg}% → $${pos.notional.toFixed(0)} → $${dca1Target}`);
    const result = await placeBuy(symbol, topUpUsdt, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dca1Done = true;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    const newAvg = (pos.notional + result.filledUsdt) / (pos.qty + result.filledQty);
    await sendTelegram(
      `🟡 <b>${name} 추매1</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>${gapFromAvg}%</b>\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})\n` +
      `신규 평단  <b>$${newAvg.toFixed(4)}</b>  누적 $${(pos.notional+result.filledUsdt).toFixed(0)} → $${dca1Target}`
    );
    return;
  }

  // ── 추매2: 추매1 후 새 평단 -5% → $600까지 채우기 ───────────────────────
  if (pos.qty > 0 && state.dca1Done && !state.dca2Done && avgPrice > 0 && cur <= avgPrice * 0.95) {
    const dca2Target = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT + CONFIG.DCA2_USDT;
    const gapFromAvg = +((cur - avgPrice) / avgPrice * 100).toFixed(2);
    console.log(`  [${name}] ★ 추매2: 평단 대비 ${gapFromAvg}% → $${pos.notional.toFixed(0)} → $${dca2Target}`);
    const topUpUsdt  = +(dca2Target - pos.notional).toFixed(0);
    const result = await placeBuy(symbol, topUpUsdt, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dca2Done = true;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    const newAvg = (pos.notional + result.filledUsdt) / (pos.qty + result.filledQty);
    await sendTelegram(
      `🔴 <b>${name} 추매2</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>${gapFromAvg}%</b>\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})\n` +
      `신규 평단  <b>$${newAvg.toFixed(4)}</b>  누적 $${(pos.notional+result.filledUsdt).toFixed(0)} → $${dca2Target}`
    );
    return;
  }

  // ── 추매3: 추매2 후 새 평단 -8% → $800까지 채우기 ───────────────────────
  if (pos.qty > 0 && state.dca2Done && !state.dca3Done && avgPrice > 0 && cur <= avgPrice * 0.92) {
    const dca3Target = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT + CONFIG.DCA2_USDT + CONFIG.DCA3_USDT;
    const gapFromAvg = +((cur - avgPrice) / avgPrice * 100).toFixed(2);
    console.log(`  [${name}] ★ 추매3: 평단 대비 ${gapFromAvg}% → $${pos.notional.toFixed(0)} → $${dca3Target}`);
    const topUpUsdt  = +(dca3Target - pos.notional).toFixed(0);
    const result = await placeBuy(symbol, topUpUsdt, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dca3Done = true;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    const newAvg = (pos.notional + result.filledUsdt) / (pos.qty + result.filledQty);
    await sendTelegram(
      `🔴 <b>${name} 추매3</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>${gapFromAvg}%</b>\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})\n` +
      `신규 평단  <b>$${newAvg.toFixed(4)}</b>  누적 $${(pos.notional+result.filledUsdt).toFixed(0)} → $${dca3Target}`
    );
    return;
  }

  // ── 추매4: 추매3 후 새 평단 -12% → $1000까지 채우기 ─────────────────────
  if (pos.qty > 0 && state.dca3Done && !state.dca4Done && avgPrice > 0 && cur <= avgPrice * 0.88) {
    const dca4Target = CONFIG.ENTRY_USDT + CONFIG.DCA1_USDT + CONFIG.DCA2_USDT + CONFIG.DCA3_USDT + CONFIG.DCA4_USDT;
    const gapFromAvg = +((cur - avgPrice) / avgPrice * 100).toFixed(2);
    console.log(`  [${name}] ★ 추매4: 평단 대비 ${gapFromAvg}% → $${pos.notional.toFixed(0)} → $${dca4Target}`);
    const topUpUsdt  = +(dca4Target - pos.notional).toFixed(0);
    const result = await placeBuy(symbol, topUpUsdt, cur, stepSize, hedgeMode);
    if (!result) return;
    state.dca4Done = true;
    state.lastBuyPrice = result.filled;
    saveState(stateFile, state);
    const newAvg = (pos.notional + result.filledUsdt) / (pos.qty + result.filledQty);
    await sendTelegram(
      `🔴 <b>${name} 추매4</b>  (${VERSION})\n─────────────────\n` +
      `평단 <b>$${avgPrice.toFixed(4)}</b>  갭 <b>${gapFromAvg}%</b>\n\n` +
      `매수  ${result.filledQty}개  @ $${result.filled}  ($${result.filledUsdt.toFixed(0)})\n` +
      `신규 평단  <b>$${newAvg.toFixed(4)}</b>  누적 $${(pos.notional+result.filledUsdt).toFixed(0)} → $${dca4Target}`
    );
    return;
  }

  if (maGap <= CONFIG.ENTRY_GAP && pos.qty > 0 && pos.notional >= CONFIG.ENTRY_USDT * 0.9) {
    console.log(`  [${name}] MA갭 ${maGap}% 충족 but 포지션 $${pos.notional.toFixed(0)} ≥ 베이스 $${CONFIG.ENTRY_USDT} - 매수 없음`);
  } else {
    console.log(`  [${name}] 조건 없음 - 대기`);
  }
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] MA25 스캐너 (${VERSION})`);
  const hedgeMode = await getIsHedgeMode();
  for (const { symbol, stateFile } of TARGETS) {
    try { await runSymbol(symbol, stateFile, hedgeMode); }
    catch (e) {
      console.error(`  [${symbol}] 오류: ${e.message}`);
      await sendTelegram(`❌ [MA25] ${symbol} 오류: ${e.message}`);
    }
  }
}

main().catch(async e => {
  console.error("에러:", e.message);
  await sendTelegram(`❌ [MA25] 오류: ${e.message}`);
});
