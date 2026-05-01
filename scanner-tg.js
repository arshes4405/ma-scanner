/**
 * Binance Futures MA 돌파 스캐너 + 텔레그램 알림
 * Railway 배포용 - 12시간마다 자동 실행
 */

const https = require("https");

// ─── 설정 ─────────────────────────────────────────────────────────────────────
const CONFIG = {
  // 텔레그램
  TG_TOKEN:   process.env.TG_TOKEN   || "여기에토큰",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "여기에ChatID",

  // 스캐너 설정
  BASE_URL:          "https://fapi-data.binance.com",
  INTERVAL:          "1h",
  WINDOW_HOURS:      5,
  MIN_CANDLE_CHANGE: 1.0,
  MODE:              "ma30",   // ma30 / ma99 / both
  MIN_VOLUME_USDT:   5_000_000,
  CANDLE_LIMIT:      130,
  REQUEST_DELAY:     100,
  CONCURRENCY:       5,

  // 12시간마다 실행 (ms)
  INTERVAL_MS: 12 * 60 * 60 * 1000,
};

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200)
          reject(new Error(`HTTP ${res.statusCode}`));
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
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      }
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

  // 역배열: MA99 > MA30 > MA10
  if (!(ma99 > ma30 && ma30 > ma10)) return null;

  const searchStart = Math.max(lastIdx - CONFIG.WINDOW_HOURS, 99);
  const searchEnd   = lastIdx - 1;

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
    symbol,
    currentPrice: cur,
    ma30: +ma30.toFixed(6),
    ma99: +ma99.toFixed(6),
    pctMA30: +(((cur - ma30) / ma30) * 100).toFixed(1),
    pctMA99: +(((cur - ma99) / ma99) * 100).toFixed(1),
    crossMA30: bestMA30,
    crossMA99: bestMA99,
    vol: 0,
  };
}

// ─── 텔레그램 전송 ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await httpsPost("api.telegram.org",
      `/bot${CONFIG.TG_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }
    );
    console.log("[TG] 메시지 전송 완료");
  } catch (e) {
    console.error("[TG] 전송 실패:", e.message);
  }
}

function formatMessage(results, elapsed) {
  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const with99 = results.filter(r => r.crossMA99);
  const only30 = results.filter(r => !r.crossMA99 && r.crossMA30);

  let msg = `📡 <b>MA 돌파 스캐너</b>\n`;
  msg += `🕐 ${ts}\n`;
  msg += `⏱ 소요: ${elapsed}초 | 발견: ${results.length}개\n`;
  msg += `─────────────────\n`;

  if (with99.length) {
    msg += `\n🚀 <b>MA99 돌파 (${with99.length}개)</b>\n`;
    for (const r of with99) {
      const vol = r.vol >= 1e9 ? (r.vol/1e9).toFixed(1)+"B" : (r.vol/1e6).toFixed(0)+"M";
      msg += `\n<b>${r.symbol}</b>  $${r.currentPrice}\n`;
      msg += `  └ MA99 ${r.crossMA99.barsAgo}봉전 +${r.crossMA99.chg}%`;
      if (r.crossMA30) msg += ` | MA30 ${r.crossMA30.barsAgo}봉전 +${r.crossMA30.chg}%`;
      msg += `\n  └ vsMA30: +${r.pctMA30}% | 거래량: ${vol}\n`;
    }
  }

  if (only30.length) {
    msg += `\n📈 <b>MA30 돌파 (${only30.length}개)</b>\n`;
    for (const r of only30) {
      const vol = r.vol >= 1e9 ? (r.vol/1e9).toFixed(1)+"B" : (r.vol/1e6).toFixed(0)+"M";
      msg += `\n<b>${r.symbol}</b>  $${r.currentPrice}\n`;
      msg += `  └ MA30 ${r.crossMA30.barsAgo}봉전 +${r.crossMA30.chg}%\n`;
      msg += `  └ vsMA30: +${r.pctMA30}% | 거래량: ${vol}\n`;
    }
  }

  if (!results.length) {
    msg += `\n조건 충족 종목 없음`;
  }

  return msg;
}

// ─── 메인 스캔 함수 ───────────────────────────────────────────────────────────
async function runScan() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toLocaleString("ko-KR")}] 스캔 시작`);

  try {
    let symbols = await getAllSymbols();
    const volMap = await getVolumes();
    symbols = symbols.filter(s => (volMap[s] || 0) >= CONFIG.MIN_VOLUME_USDT);

    console.log(`심볼 수: ${symbols.length}`);

    const results = [];
    for (let i = 0; i < symbols.length; i += CONFIG.CONCURRENCY) {
      const batch = symbols.slice(i, i + CONFIG.CONCURRENCY);
      await Promise.all(batch.map(async (sym) => {
        try {
          const klines = await getKlines(sym);
          const r = analyze(sym, klines);
          if (r) { r.vol = volMap[sym] || 0; results.push(r); }
        } catch (_) {}
      }));
      if (i % 50 === 0) process.stdout.write(`\r진행: ${i}/${symbols.length} 발견: ${results.length}`);
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
    console.log(`\n완료: ${results.length}개 발견 (${elapsed}초)`);

    // 텔레그램 전송
    // 메시지가 너무 길면 나눠서 전송 (텔레그램 4096자 제한)
    const msg = formatMessage(results, elapsed);
    if (msg.length <= 4096) {
      await sendTelegram(msg);
    } else {
      // 헤더 + MA99 / MA30 나눠서 전송
      const header = msg.split("📈")[0];
      await sendTelegram(header.slice(0, 4096));
      const rest = "📈" + msg.split("📈")[1];
      if (rest.length > 5) await sendTelegram(rest.slice(0, 4096));
    }

  } catch (e) {
    console.error("스캔 에러:", e.message);
    await sendTelegram(`❌ 스캐너 오류: ${e.message}`);
  }
}

// ─── 실행 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("MA 돌파 스캐너 시작");
  console.log(`실행 주기: 12시간`);
  console.log(`설정: ${CONFIG.WINDOW_HOURS}시간 범위 | MA변화 ${CONFIG.MIN_CANDLE_CHANGE}% | ${CONFIG.MODE}`);

  await sendTelegram("✅ MA 스캐너 시작됨\n12시간마다 결과를 전송합니다.");

  // 시작하자마자 1회 실행
  await runScan();

  // 이후 12시간마다 반복
  setInterval(runScan, CONFIG.INTERVAL_MS);
}

main().catch(console.error);
