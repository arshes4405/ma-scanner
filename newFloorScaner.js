/**
 * Binance Futures 바닥 스캐너
 * 조건: MA 역배열 (MA99 > MA30 > MA10) + RSI(14) < 30
 *       + 현재봉 양봉 + 현재봉 거래량 > 직전봉 거래량
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CONFIG = {
  TG_TOKEN:        process.env.TG_TOKEN    || "8352132886:AAF8H9O62wLKDev2Bqpfs0E2qwBe8lppNII",
  TG_CHAT_ID:      process.env.TG_CHAT_ID  || "133371996",
  BASE_URL:        "https://fapi.binance.com",
  INTERVAL:        "1h",
  CANDLE_LIMIT:    150,
  MIN_VOLUME_USDT: 1_000_000,
  REQUEST_DELAY:   120,
  RSI_PERIOD:      14,
  RSI_THRESHOLD:   30,
  COOLDOWN_MS:     2 * 60 * 60 * 1000,
  STATE_FILE:      path.join(__dirname, "floor_state.json"),
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

// ─── 지표 계산 ────────────────────────────────────────────────────────────────
function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let avgGain = 0, avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing (이전 봉들)
  // 초기값 계산을 위해 더 앞에서부터 smoothing
  let ag = 0, al = 0;
  const start = closes.length - period * 3;
  const from  = Math.max(1, start);

  for (let i = from; i <= from + period - 1; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ag += diff; else al -= diff;
  }
  ag /= period;
  al /= period;

  for (let i = from + period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    ag = (ag * (period - 1) + gain) / period;
    al = (al * (period - 1) + loss) / period;
  }

  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
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

function isOnCooldown(state, symbol) {
  const last = state[symbol];
  return last && Date.now() - last < CONFIG.COOLDOWN_MS;
}

function updateState(state, symbols) {
  const now = Date.now();
  for (const sym of symbols) state[sym] = now;
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
  return d.map(k => ({
    open:   parseFloat(k[1]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[7]), // quote asset volume (USDT)
  }));
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

  // 직전봉 기준 RSI (현재 양봉으로 RSI가 30 위로 올라온 케이스 포함)
  const rsi = calcRSI(closes.slice(0, -1), CONFIG.RSI_PERIOD);
  if (rsi === null || rsi >= CONFIG.RSI_THRESHOLD) return null;

  return {
    symbol,
    price:      cur.close,
    rsi:        +rsi.toFixed(1),
    ma10:       +ma10.toFixed(4),
    ma30:       +ma30.toFixed(4),
    ma99:       +ma99.toFixed(4),
    pctFromMA10: +(((cur.close - ma10) / ma10) * 100).toFixed(1),
    volRatio:   +(cur.volume / prev.volume).toFixed(2), // 직전봉 대비 거래량 배율
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
  let msg = `🔍 <b>바닥 스캐너 (MA역배열 + RSI&lt;30 + 양봉 + 거래량 돌파)</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `📊 ${total}개 스캔 · ${results.length}개 발견 · ${elapsed}초\n`;
  if (skipped > 0) msg += `🔕 쿨다운 중 ${skipped}개 제외\n`;
  msg += `─────────────────\n`;

  if (!results.length) {
    msg += `\n해당 종목 없음`;
    return msg;
  }

  // RSI 낮은 순 정렬
  results.sort((a, b) => a.rsi - b.rsi);

  for (const r of results) {
    const vol = r.vol >= 1e9 ? (r.vol / 1e9).toFixed(1) + "B" : (r.vol / 1e6).toFixed(0) + "M";
    msg += `\n<b>${r.symbol}</b>  $${r.price}\n`;
    msg += `  RSI: <b>${r.rsi}</b> | MA10 대비 ${r.pctFromMA10}%\n`;
    msg += `  MA10: ${r.ma10} | MA30: ${r.ma30} | MA99: ${r.ma99}\n`;
    msg += `  거래량: ${vol} | 직전봉 대비 <b>${r.volRatio}x</b>\n`;
  }

  return msg;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleString("ko-KR")}] 바닥 스캐너 시작`);

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

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n완료: ${results.length}개 발견, ${skipped}개 쿨다운 (${elapsed}초)`);

    if (results.length > 0) {
      updateState(state, results.map(r => r.symbol));
      saveState(state);
    }

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
    await sendTelegram(`❌ 바닥 스캐너 오류: ${e.message}`);
  }

  process.exit(0);
}

main();
