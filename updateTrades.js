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

function recentRangeKST() {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow    = new Date(Date.now() + kstOffset);
  const todayMidnight = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - kstOffset;
  const startTime = todayMidnight - 86400000; // 어제 00:00 KST
  const endTime   = Date.now();               // 지금
  return { startTime, endTime };
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

const NEW_HEADER = "datetime,symbol,action,entry_price,exit_price,qty,pnl_pct,pnl_usdt,source,order_id";

// 구버전 헤더 → 신버전 마이그레이션 (컬럼 수로 판별)
function migrateHeader(lines) {
  const cols = lines[0].split(",").length;
  if (cols === 10) return null; // 이미 최신
  return lines.map((line, i) => {
    if (i === 0) return NEW_HEADER;
    const c = line.split(",");
    if (cols === 8) { c.splice(7, 0, "", "SYSTEM"); }  // pnl_pct 뒤 pnl_usdt+source 추가
    if (cols === 9) { c.splice(8, 0, "SYSTEM"); }       // pnl_usdt 뒤 source 추가
    return c.join(",");
  }).join("\n") + "\n";
}

async function main() {
  // 기존 CSV 읽기
  let existingTranIds = new Set();

  if (fs.existsSync(CONFIG.LOG_FILE)) {
    const existingContent = fs.readFileSync(CONFIG.LOG_FILE, "utf8");
    const lines = existingContent.trim().split("\n");

    const migrated = migrateHeader(lines);
    if (migrated) {
      fs.writeFileSync(CONFIG.LOG_FILE, migrated, "utf8");
      console.log("헤더 업그레이드 완료");
    }

    // 중복 방지용 order_id 수집 (idx9) — MANUAL은 SYMBOL_SEC 키로 저장됨
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      if (c[9]) existingTranIds.add(c[9].trim());
    }
    // MANUAL 항목의 시각+심볼 → SEC 키도 추가 (tranId 단위 dedup 보완)
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      if (c[8]?.trim() === "MANUAL" && c[9]?.includes("_")) existingTranIds.add(c[9].trim());
    }
  } else {
    fs.writeFileSync(CONFIG.LOG_FILE, NEW_HEADER + "\n", "utf8");
  }

  // REALIZED_PNL 조회 (페이지네이션)
  const { startTime, endTime } = recentRangeKST();
  const fromDate = new Date(startTime + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const toDate   = new Date(endTime   + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`조회 범위: ${fromDate} 00:00 ~ ${toDate} (KST)`);

  let allIncome = [];
  let cursor = startTime;
  while (true) {
    const qs = `incomeType=REALIZED_PNL&startTime=${cursor}&endTime=${endTime}&limit=1000&timestamp=${Date.now()}`;
    const page = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/income?${qs}&signature=${sign(qs)}`);
    allIncome = allIncome.concat(page);
    if (page.length < 1000) break;
    cursor = page[page.length - 1].time + 1;
  }

  // 같은 심볼 + 같은 초 = 하나의 청산 이벤트로 묶기 (key: SYMBOL_SEC)
  const grouped = {};
  for (const item of allIncome) {
    if (CONFIG.EXCLUDE_SYMBOLS.includes(item.symbol)) continue;
    const sec = Math.floor(item.time / 1000);
    const key = `${item.symbol}_${sec}`;
    if (existingTranIds.has(key)) continue;          // 이미 처리된 이벤트
    if (!grouped[key]) grouped[key] = { symbol: item.symbol, time: item.time, pnl: 0, key };
    grouped[key].pnl += parseFloat(item.income);
  }

  if (!Object.keys(grouped).length) {
    console.log("추가할 새 내역 없음");
    return;
  }

  let appendCount = 0;
  let appendLines = "";
  let totalPnl = 0, wins = 0;

  for (const g of Object.values(grouped)) {
    const pnl     = g.pnl;
    const action  = pnl >= 0 ? "AUTO_CLOSE" : "AUTO_SL";
    const pnlUsdt = pnl.toFixed(4);
    const datetime = fmtDatetime(g.time);
    appendLines += `${datetime},${g.symbol},${action},,,,,${pnlUsdt},MANUAL,${g.key}\n`;
    totalPnl += pnl;
    if (pnl >= 0) wins++;
    appendCount++;
  }

  fs.appendFileSync(CONFIG.LOG_FILE, appendLines, "utf8");
  console.log(`${appendCount}건 추가 완료`);

  // 요약 출력
  console.log(`수익 ${wins}건 / 손실 ${appendCount - wins}건 / 총 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
}

main().catch(e => console.error("에러:", e.message));
