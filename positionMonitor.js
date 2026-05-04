/**
 * Binance Futures 포지션 모니터 (SL/TP 전용)
 * crontab: * /1 * * * * (1분마다) 또는 * /5 * * * * (5분마다)
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const VERSION = "2026-05-04 v4";

const CONFIG = {
  TG_TOKEN:           process.env.TG_TOKEN           || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:         process.env.TG_CHAT_ID         || "133371996",
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY    || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  SL_PCT:             3,
  TP_PCT:             5,
  MAX_NOTIONAL_USDT:  2000,
  MAJOR_SYMBOLS:      ["ETHUSDT", "HYPEUSDT"],
  MAX_POSITIONS:      55,
  PROTECT_SYMBOLS:    [],  // 자동매도 방지 (SL/TP/MAX_POS 전부 스킵)
  TP_STATE_FILE:      path.join(__dirname, "tp_state.json"),
  TRADE_LOG_FILE:     path.join(__dirname, "trade_log.csv"),
};

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
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

function floorToStep(value, step) {
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

// ─── 상태 / 로그 ──────────────────────────────────────────────────────────────
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

function logTrade(action, symbol, entryPrice, exitPrice, qty, pnlPct, pnlUsdt, orderId) {
  try {
    const header = "datetime,symbol,action,entry_price,exit_price,qty,pnl_pct,pnl_usdt,source,order_id\n";
    const dt  = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }).replace(/,/g, "");
    const row = `${dt},${symbol},${action},${entryPrice},${exitPrice},${qty},${pnlPct},${pnlUsdt},SYSTEM,${orderId}\n`;
    if (!fs.existsSync(CONFIG.TRADE_LOG_FILE)) fs.writeFileSync(CONFIG.TRADE_LOG_FILE, header, "utf8");
    fs.appendFileSync(CONFIG.TRADE_LOG_FILE, row, "utf8");
  } catch (_) {}
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

// ─── API ─────────────────────────────────────────────────────────────────────
async function getIsHedgeMode() {
  const qs   = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/positionSide/dual?${qs}&signature=${sign(qs)}`);
  return data.dualSidePosition;
}

async function getSymbolStepSizes(symbols) {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  const stepSizes = {};
  for (const s of d.symbols) {
    if (symbols.includes(s.symbol)) {
      const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
      if (lot) stepSizes[s.symbol] = parseFloat(lot.stepSize);
    }
  }
  return stepSizes;
}

// ─── SL/TP 체크 ───────────────────────────────────────────────────────────────
async function checkAndClosePositions(hedgeMode) {
  const qs    = `timestamp=${Date.now()}`;
  const pRisk = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);

  const positions = (hedgeMode
    ? pRisk.filter(p => p.positionSide === "LONG" && Math.abs(parseFloat(p.positionAmt)) > 0)
    : pRisk.filter(p => parseFloat(p.positionAmt) > 0)
  ).filter(p => {
    if (CONFIG.PROTECT_SYMBOLS.includes(p.symbol)) return false;
    if (CONFIG.MAJOR_SYMBOLS.includes(p.symbol)) return true;
    return Math.abs(parseFloat(p.notional)) < CONFIG.MAX_NOTIONAL_USDT;
  });

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

  // 보유 중인 심볼의 stepSize만 조회
  const stepSizes = await getSymbolStepSizes([...activeSymbols]);

  // 포지션 50개 초과 시 수익률 3% 이상인 종목 전량 청산
  if (positions.length > CONFIG.MAX_POSITIONS) {
    const toClose = positions
      .map(p => ({ ...p, pnlPct: ((parseFloat(p.markPrice) - parseFloat(p.entryPrice)) / parseFloat(p.entryPrice)) * 100 }))
      .filter(p => p.pnlPct >= 3)
      .sort((a, b) => b.pnlPct - a.pnlPct);
    console.log(`  [MAX_POS] 포지션 ${positions.length}개 > ${CONFIG.MAX_POSITIONS}개 → +3% 이상 ${toClose.length}개 청산`);
    for (const pos of toClose) {
      const sym     = pos.symbol;
      const qty     = Math.abs(parseFloat(pos.positionAmt));
      const entry   = parseFloat(pos.entryPrice);
      const mark    = parseFloat(pos.markPrice);
      const posSide = hedgeMode ? "&positionSide=LONG" : "";
      try {
        const sellQs = `symbol=${sym}&side=SELL${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
        const order  = await httpPostSigned("/fapi/v1/order", `${sellQs}&signature=${sign(sellQs)}`);
        logTrade("MAX_POS_CLOSE", sym, entry, mark, qty, +pos.pnlPct.toFixed(2), +(qty * (mark - entry)).toFixed(4), order.orderId);
        console.log(`  [MAX_POS] ${sym} 청산 완료 (${pos.pnlPct.toFixed(2)}%) orderId: ${order.orderId}`);
        await sendTelegram(
          `📊 <b>포지션 수 초과 청산</b>\n` +
          `<b>${sym}</b>  진입: $${entry} → 현재: $${mark}\n` +
          `  수익률: +${pos.pnlPct.toFixed(2)}% | orderId: ${order.orderId}`
        );
      } catch (e) {
        console.error(`  [MAX_POS] ${sym} 청산 실패:`, e.message);
      }
    }
    // 청산된 심볼 positions에서 제거 (이후 SL/TP 체크 스킵)
    const closedSyms = new Set(toClose.map(p => p.symbol));
    positions.splice(0, positions.length, ...positions.filter(p => !closedSyms.has(p.symbol)));
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
          logTrade("TP_HALF", sym, entry, markPrice, halfQty, +pnlPct.toFixed(2), +(halfQty * (markPrice - entry)).toFixed(4), order.orderId);
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

    // 스탑로스: 반익절 후 +0.5%, 미익절 시 -3%
    const slThreshold = tpState[sym] ? 0.5 : -CONFIG.SL_PCT;
    const slLabel     = tpState[sym] ? "+0.5% 청산" : `스탑로스 -${CONFIG.SL_PCT}%`;
    if (pnlPct <= slThreshold) {
      console.log(`  [SL]  ${sym} ${slLabel} 도달 → 시장가 청산`);
      try {
        const sellQs = `symbol=${sym}&side=SELL${posSide}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
        const order  = await httpPostSigned("/fapi/v1/order", `${sellQs}&signature=${sign(sellQs)}`);
        const action = tpState[sym] ? "BE_CLOSE" : "SL";
        console.log(`  [SL]  ${sym} 청산 완료 orderId: ${order.orderId}`);
        logTrade(action, sym, entry, markPrice, qty, +pnlPct.toFixed(2), +(qty * (markPrice - entry)).toFixed(4), order.orderId);

        await sendTelegram(
          `🛑 <b>${slLabel} 청산</b>\n` +
          `<b>${sym}</b>  진입: $${entry} → 청산: $${markPrice}\n` +
          `  수익률: ${pnlPct.toFixed(2)}% | qty: ${qty}\n` +
          `  orderId: ${order.orderId}`
        );
      } catch (e) {
        console.error(`  [SL]  ${sym} 청산 실패:`, e.message);
        await sendTelegram(`❌ ${sym} ${slLabel} 청산 실패: ${e.message}`);
      }
    }
  }

  saveTpState(tpState);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toLocaleString("ko-KR")}] 포지션 모니터 시작 (${VERSION})`);
  try {
    const hedgeMode = await getIsHedgeMode();
    await checkAndClosePositions(hedgeMode);
  } catch (e) {
    console.error("에러:", e.message);
    await sendTelegram(`❌ 포지션 모니터 오류: ${e.message}`);
  }
  process.exit(0);
}

main();
