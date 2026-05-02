/**
 * Binance Futures MA 돌파 스캐너 + 텔레그램 알림
 * 10분마다 실행, 중복 알림 방지 (2시간 쿨다운)
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CONFIG = {
  TG_TOKEN:          process.env.TG_TOKEN   || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:        process.env.TG_CHAT_ID || "133371996",
  BASE_URL:          "https://fapi.binance.com",
  INTERVAL:          "1h",
  WINDOW_HOURS:      1,        // 현재봉 + 이전봉
  MIN_CANDLE_CHANGE: 0.5,
  MODE:              "both",
  MIN_VOLUME_USDT:   1_000_000,
  CANDLE_LIMIT:      130,
  REQUEST_DELAY:     120,
  // 같은 종목 재알림 방지 시간 (ms) - 2시간
  COOLDOWN_MS:       2 * 60 * 60 * 1000,
  // 쿨다운 상태 저장 파일
  STATE_FILE:        path.join(__dirname, "alert_state.json"),
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

function calcMAat(closes, period, endIdx) {
  if (endIdx < period - 1) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += closes[i];
  return s / period;
}

// ─── 중복 알림 방지 ───────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state), "utf8");
  } catch (_) {}
}

function isOnCooldown(state, symbol) {
  const last = state[symbol];
  if (!last) return false;
  return Date.now() - last < CONFIG.COOLDOWN_MS;
}

function updateState(state, symbols) {
  const now = Date.now();
  for (const sym of symbols) state[sym] = now;
  // 오래된 항목 정리 (24시간 이상)
  for (const sym of Object.keys(state)) {
    if (now - state[sym] > 24 * 60 * 60 * 1000) delete state[sym];
  }
  return state;
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getAllSymbols() {
  const d = await httpGet(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  return d.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);
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
  return d.map(k => ({ open: parseFloat(k[1]), close: parseFloat(k[4]) }));
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────
function analyze(symbol, klines) {
  const len = klines.length;
  if (len < 101 + CONFIG.WINDOW_HOURS) return null;
  const closes = klines.map(k => k.close);
  const opens  = klines.map(k => k.open);
  const lastIdx = len - 1;

  const ma10 = calcMAat(closes, 10, lastIdx);
  const ma30 = calcMAat(closes, 30, lastIdx);
  const ma99 = calcMAat(closes, 99, lastIdx);
  if (!ma10 || !ma30 || !ma99) return null;
  if (!(ma99 > ma30 && ma30 > ma10)) return null;

  const searchStart = Math.max(lastIdx - CONFIG.WINDOW_HOURS, 99);
  const searchEnd   = lastIdx;

  let bestMA30 = null, bestMA99 = null;

  for (let i = searchStart; i <= searchEnd; i++) {
    const prev = closes[i - 1], curr = closes[i], open = opens[i];
    const chg = ((curr - open) / open) * 100;
    if (chg < CONFIG.MIN_CANDLE_CHANGE) continue;

    if (CONFIG.MODE !== "ma99") {
      const pm = calcMAat(closes, 30, i - 1), cm = calcMAat(closes, 30, i);
      if (pm && cm && prev < pm && curr >= cm) {
        let held = true;
        for (let j = i + 1; j <= lastIdx; j++) {
          const fm = calcMAat(closes, 30, j);
          if (fm && closes[j] < fm) { held = false; break; }
        }
        if (held && (!bestMA30 || chg > bestMA30.chg))
          bestMA30 = { barsAgo: lastIdx - i, chg: +chg.toFixed(1) };
      }
    }
    if (CONFIG.MODE !== "ma30") {
      const pm = calcMAat(closes, 99, i - 1), cm = calcMAat(closes, 99, i);
      if (pm && cm && prev < pm && curr >= cm) {
        let held = true;
        for (let j = i + 1; j <= lastIdx; j++) {
          const fm = calcMAat(closes, 99, j);
          if (fm && closes[j] < fm) { held = false; break; }
        }
        if (held && (!bestMA99 || chg > bestMA99.chg))
          bestMA99 = { barsAgo: lastIdx - i, chg: +chg.toFixed(1) };
      }
    }
  }

  if (!bestMA30 && !bestMA99) return null;

  const cur = closes[lastIdx];
  return {
    symbol, currentPrice: cur,
    ma30: +ma30.toFixed(6), ma99: +ma99.toFixed(6),
    pctMA30: +(((cur - ma30) / ma30) * 100).toFixed(1),
    pctMA99: +(((cur - ma99) / ma99) * 100).toFixed(1),
    crossMA30: bestMA30, crossMA99: bestMA99, vol: 0,
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

function formatMessage(results, elapsed, total, skipped) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const with99 = results.filter(r => r.crossMA99);
  const only30 = results.filter(r => !r.crossMA99 && r.crossMA30);

  let msg = `📡 <b>MA 돌파 스캐너</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `📊 ${total}개 스캔 · ${results.length}개 발견 · ${elapsed}초\n`;
  if (skipped > 0) msg += `🔕 쿨다운 중 ${skipped}개 제외\n`;
  msg += `─────────────────\n`;

  if (!results.length) {
    msg += `\n신규 돌파 종목 없음`;
    return msg;
  }

  if (with99.length) {
    msg += `\n🚀 <b>MA99 돌파 (${with99.length}개)</b>\n`;
    for (const r of with99) {
      const vol = r.vol >= 1e9 ? (r.vol/1e9).toFixed(1)+"B" : (r.vol/1e6).toFixed(0)+"M";
      msg += `\n<b>${r.symbol}</b>  $${r.currentPrice}\n`;
      msg += `  └ 🚀MA99 ${r.crossMA99.barsAgo}봉전 +${r.crossMA99.chg}%`;
      if (r.crossMA30) msg += ` | 📈MA30 ${r.crossMA30.barsAgo}봉전`;
      msg += `\n  └ vsMA30: +${r.pctMA30}% | vsMA99: +${r.pctMA99}% | ${vol}\n`;
    }
  }

  if (only30.length) {
    msg += `\n📈 <b>MA30 돌파 (${only30.length}개)</b>\n`;
    for (const r of only30) {
      const vol = r.vol >= 1e9 ? (r.vol/1e9).toFixed(1)+"B" : (r.vol/1e6).toFixed(0)+"M";
      msg += `\n<b>${r.symbol}</b>  $${r.currentPrice}\n`;
      msg += `  └ 📈MA30 ${r.crossMA30.barsAgo}봉전 +${r.crossMA30.chg}%\n`;
      msg += `  └ vsMA30: +${r.pctMA30}% | ${vol}\n`;
    }
  }

  return msg;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleString("ko-KR")}] 스캔 시작`);

  // 쿨다운 상태 로드
  const state = loadState();

  try {
    let symbols = await getAllSymbols();
    const volMap = await getVolumes();
    symbols = symbols.filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT);

    const total = symbols.length;
    const results = [];
    let skipped = 0;

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const klines = await getKlines(sym);
        const r = analyze(sym, klines);
        if (r) {
          r.vol = volMap[sym] || 0;
          // 쿨다운 체크 - 최근에 이미 알림 간 종목 제외
          if (isOnCooldown(state, sym)) {
            skipped++;
          } else {
            results.push(r);
          }
        }
      } catch (_) {}

      if (i % 20 === 0) process.stdout.write(`\r진행: ${i}/${total} 발견: ${results.length}개`);
      await sleep(CONFIG.REQUEST_DELAY);
    }

    // 정렬
    results.sort((a, b) => {
      const a99 = !!a.crossMA99, b99 = !!b.crossMA99;
      if (b99 !== a99) return Number(b99) - Number(a99);
      const aAgo = Math.min(a.crossMA30?.barsAgo ?? 99, a.crossMA99?.barsAgo ?? 99);
      const bAgo = Math.min(b.crossMA30?.barsAgo ?? 99, b.crossMA99?.barsAgo ?? 99);
      if (aAgo !== bAgo) return aAgo - bAgo;
      return b.vol - a.vol;
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n완료: ${results.length}개 발견, ${skipped}개 쿨다운 (${elapsed}초)`);

    // 알림 간 종목 쿨다운 등록
    if (results.length > 0) {
      updateState(state, results.map(r => r.symbol));
      saveState(state);
    }

    // 텔레그램 전송 (결과 없어도 전송 - 필요시 아래 조건 추가)
    // if (!results.length) { process.exit(0); return; }

    const msg = formatMessage(results, elapsed, total, skipped);
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
    await sendTelegram(`❌ 스캐너 오류: ${e.message}`);
  }

  process.exit(0);
}

main();
