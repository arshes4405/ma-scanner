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

async function main() {
  const qs    = `timestamp=${Date.now()}`;
  const pRisk = await httpGetAuth(`${CONFIG.BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);

  const positions = pRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

  if (!positions.length) {
    console.log("보유 포지션 없음");
    return;
  }

  positions.sort((a, b) => parseFloat(b.unRealizedProfit) - parseFloat(a.unRealizedProfit));

  let totalPnl = 0;
  let totalWin = 0, totalLose = 0;

  console.log(`\n${"─".repeat(70)}`);
  console.log(` ${"심볼".padEnd(14)} ${"진입가".padStart(12)} ${"현재가".padStart(12)} ${"수익률".padStart(8)} ${"미실현손익".padStart(12)}`);
  console.log(`${"─".repeat(70)}`);

  for (const p of positions) {
    const entry  = parseFloat(p.entryPrice);
    const mark   = parseFloat(p.markPrice);
    const pnl    = parseFloat(p.unRealizedProfit);
    const pnlPct = ((mark - entry) / entry * 100);

    totalPnl += pnl;
    if (pnl >= 0) totalWin++; else totalLose++;

    const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
    const pctStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;

    console.log(` ${p.symbol.padEnd(14)} ${entry.toPrecision(6).padStart(12)} ${mark.toPrecision(6).padStart(12)} ${pctStr.padStart(8)} ${pnlStr.padStart(12)} USDT`);
  }

  console.log(`${"─".repeat(70)}`);
  console.log(` 총 ${positions.length}개  수익 ${totalWin}개  손실 ${totalLose}개`);
  console.log(` 미실현 총손익: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`);
  console.log(`${"─".repeat(70)}\n`);
}

main().catch(e => console.error("에러:", e.message));
