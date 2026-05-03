const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const CONFIG = {
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY    || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
  LOG_FILE:           path.join(__dirname, "trade_log.csv"),
  EXCLUDE_SYMBOLS:    ["LABUSDT", "ALGOUSDT"],  // 수동 거래 제외
};

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
        res.on("data", c => data += c);
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(JSON.parse(data));
        });
      }
    ).on("error", reject);
  });
}

function todayStartKST() {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow    = new Date(Date.now() + kstOffset);
  const midnight  = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  return midnight - kstOffset;
}

function fmtDatetime(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mo   = d.getUTCMonth() + 1;
  const dd   = d.getUTCDate();
  const hh   = d.getUTCHours();
  const mm   = d.getUTCMinutes().toString().padStart(2, "0");
  const ss   = d.getUTCSeconds().toString().padStart(2, "0");
  const ampm = hh < 12 ? "AM" : "PM";
  const h12  = hh % 12 || 12;
  return `${yyyy}. ${mo}. ${dd}. ${ampm} ${h12}:${mm}:${ss}`;
}

const NEW_HEADER = "datetime,symbol,action,entry_price,exit_price,qty,pnl_pct,pnl_usdt,order_id";
const OLD_HEADER = "datetime,symbol,action,entry_price,exit_price,qty,pnl_pct,order_id";

async function main() {
  // 기존 CSV 읽기
  let existingContent = "";
  let existingTranIds = new Set();

  if (fs.existsSync(CONFIG.LOG_FILE)) {
    existingContent = fs.readFileSync(CONFIG.LOG_FILE, "utf8");
    const lines = existingContent.trim().split("\n");

    // 헤더가 구버전이면 교체
    if (lines[0].trim() === OLD_HEADER) {
      // 기존 데이터 행에 빈 pnl_usdt 컬럼 삽입 (order_id 앞)
      const updated = lines.map((line, i) => {
        if (i === 0) return NEW_HEADER;
        const cols = line.split(",");
        // pnl_pct(idx6) 뒤에 빈 pnl_usdt 추가
        cols.splice(7, 0, "");
        return cols.join(",");
      });
      existingContent = updated.join("\n") + "\n";
      fs.writeFileSync(CONFIG.LOG_FILE, existingContent, "utf8");
      console.log("헤더 업그레이드 완료 (pnl_usdt 컬럼 추가)");
    }

    // 중복 방지용 tranId 수집 (order_id 컬럼 = idx8)
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      if (cols[8]) existingTranIds.add(cols[8].trim());
    }
  } else {
    existingContent = NEW_HEADER + "\n";
    fs.writeFileSync(CONFIG.LOG_FILE, existingContent, "utf8");
  }

  // 오늘 REALIZED_PNL 내역 조회
  const startTime = todayStartKST();
  const qs = `incomeType=REALIZED_PNL&startTime=${startTime}&limit=1000&timestamp=${Date.now()}`;
  const income = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/income?${qs}&signature=${sign(qs)}`);

  const filtered = income.filter(item =>
    !CONFIG.EXCLUDE_SYMBOLS.includes(item.symbol) &&
    !existingTranIds.has(String(item.tranId))
  );

  if (!filtered.length) {
    console.log("추가할 새 내역 없음");
    return;
  }

  // 심볼별로 그룹핑 → 1심볼 1행 (마지막 청산 시각 기준)
  const bySymbol = {};
  for (const item of filtered) {
    const sym = item.symbol;
    if (!bySymbol[sym]) bySymbol[sym] = { pnl: 0, lastTime: 0, lastTranId: "" };
    bySymbol[sym].pnl += parseFloat(item.income);
    if (item.time > bySymbol[sym].lastTime) {
      bySymbol[sym].lastTime   = item.time;
      bySymbol[sym].lastTranId = item.tranId;
    }
  }

  let appendCount = 0;
  let appendLines = "";

  for (const [sym, d] of Object.entries(bySymbol)) {
    const action   = d.pnl >= 0 ? "AUTO_CLOSE" : "AUTO_SL";
    const pnlUsdt  = d.pnl.toFixed(4);
    const datetime = fmtDatetime(d.lastTime);
    // datetime,symbol,action,entry_price,exit_price,qty,pnl_pct,pnl_usdt,order_id
    appendLines += `${datetime},${sym},${action},,,,,${pnlUsdt},${d.lastTranId}\n`;
    appendCount++;
  }

  fs.appendFileSync(CONFIG.LOG_FILE, appendLines, "utf8");
  console.log(`${appendCount}개 종목 추가 완료`);

  // 요약 출력
  const totalPnl = Object.values(bySymbol).reduce((s, d) => s + d.pnl, 0);
  const wins = Object.values(bySymbol).filter(d => d.pnl >= 0).length;
  console.log(`수익 ${wins}개 / 손실 ${appendCount - wins}개 / 총 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
}

main().catch(e => console.error("에러:", e.message));
