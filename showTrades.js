const https  = require("https");
const crypto = require("crypto");

const CONFIG = {
  BINANCE_API_KEY:    process.env.BINANCE_API_KEY    || "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N",
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx",
  BASE_URL:           "https://fapi.binance.com",
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

// 오늘 00:00 KST → UTC ms
function todayStartKST() {
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow    = new Date(Date.now() + kstOffset);
  const midnight  = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  return midnight - kstOffset;
}

function fmtTime(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " KST";
}

async function main() {
  const startTime = todayStartKST();
  const qs = `incomeType=REALIZED_PNL&startTime=${startTime}&limit=1000&timestamp=${Date.now()}`;
  const income = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v1/income?${qs}&signature=${sign(qs)}`);

  if (!income.length) {
    console.log("금일 실현손익 내역 없음");
    return;
  }

  // 심볼별 집계
  const bySymbol = {};
  for (const item of income) {
    const sym = item.symbol;
    if (!bySymbol[sym]) bySymbol[sym] = { count: 0, pnl: 0, lastTime: 0 };
    bySymbol[sym].count++;
    bySymbol[sym].pnl += parseFloat(item.income);
    if (item.time > bySymbol[sym].lastTime) bySymbol[sym].lastTime = item.time;
  }

  const entries = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);

  let totalPnl = 0, winCount = 0, loseCount = 0;

  const today = new Date(startTime + 9 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`\n금일(${today}) 실현손익 내역`);
  console.log(`${"─".repeat(62)}`);
  console.log(` ${"심볼".padEnd(14)} ${"청산수".padStart(5)} ${"마지막청산".padStart(21)} ${"실현손익".padStart(14)}`);
  console.log(`${"─".repeat(62)}`);

  for (const [sym, d] of entries) {
    totalPnl += d.pnl;
    if (d.pnl >= 0) winCount++; else loseCount++;
    const pnlStr = `${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)} USDT`;
    console.log(` ${sym.padEnd(14)} ${String(d.count).padStart(5)} ${fmtTime(d.lastTime).padStart(21)} ${pnlStr.padStart(14)}`);
  }

  console.log(`${"─".repeat(62)}`);
  console.log(` 총 ${entries.length}종목  수익 ${winCount}개  손실 ${loseCount}개`);
  console.log(` 실현 총손익: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
  console.log(`${"─".repeat(62)}\n`);
}

main().catch(e => console.error("에러:", e.message));
