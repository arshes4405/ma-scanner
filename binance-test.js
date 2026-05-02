/**
 * Binance Futures API 테스트 - 잔고 / 포지션 조회
 */

const https  = require("https");
const crypto = require("crypto");

const API_KEY    = "JYPKR09GLF0jmld6hyGxLqavw3RcTtVEzK8tEtoQwSF2g0Y6XX5kbqjoNBcZrP4N";
const SECRET_KEY = "dTHfgpNSvBgWk6bl1GLOpW7oyqauHgTCmFzaC1FgL7PcFcpGsvbo6VctuYIcm5Xx";
const BASE_URL   = "https://fapi.binance.com";

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
function sign(qs) {
  return crypto.createHmac("sha256", SECRET_KEY).update(qs).digest("hex");
}

function httpGetAuth(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        headers: { "X-MBX-APIKEY": API_KEY } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200)
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(JSON.parse(data));
        });
      }
    ).on("error", reject);
  });
}

// ─── API ─────────────────────────────────────────────────────────────────────
async function getBalance() {
  const qs = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${BASE_URL}/fapi/v2/balance?${qs}&signature=${sign(qs)}`);
  return data.filter(a => parseFloat(a.balance) > 0);
}

async function getPositions() {
  const qs = `timestamp=${Date.now()}`;
  const data = await httpGetAuth(`${BASE_URL}/fapi/v2/positionRisk?${qs}&signature=${sign(qs)}`);
  return data.filter(p => parseFloat(p.positionAmt) !== 0);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Binance Futures API 테스트 ===\n");

  // 잔고 조회
  console.log("▶ 잔고 조회...");
  const balances = await getBalance();
  if (!balances.length) {
    console.log("  잔고 없음");
  } else {
    for (const b of balances) {
      console.log(`  ${b.asset}`);
      console.log(`    총 잔고    : ${parseFloat(b.balance).toFixed(4)}`);
      console.log(`    가용 잔고  : ${parseFloat(b.availableBalance).toFixed(4)}`);
      console.log(`    미실현손익 : ${parseFloat(b.crossUnPnl).toFixed(4)}`);
    }
  }

  console.log();

  // 포지션 조회
  console.log("▶ 오픈 포지션 조회...");
  const positions = await getPositions();
  if (!positions.length) {
    console.log("  오픈 포지션 없음");
  } else {
    for (const p of positions) {
      const amt  = parseFloat(p.positionAmt);
      const side = amt > 0 ? "LONG" : "SHORT";
      const pnl  = parseFloat(p.unrealizedProfit);
      console.log(`  ${p.symbol} ${side}`);
      console.log(`    수량       : ${Math.abs(amt)}`);
      console.log(`    진입가     : ${parseFloat(p.entryPrice).toFixed(4)}`);
      console.log(`    현재가     : ${parseFloat(p.markPrice).toFixed(4)}`);
      console.log(`    미실현손익 : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`);
      console.log(`    레버리지   : ${p.leverage}x`);
    }
  }

  console.log("\n=== 테스트 완료 ===");
}

main().catch(e => console.error("오류:", e.message));
