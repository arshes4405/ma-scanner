/**
 * trade_log.csv 분석 → TP_HALF 기록 있는 종목을 TIER3_SYMBOLS에 자동 반영
 * 실행: node promoteCoins.js
 */

const fs   = require("fs");
const path = require("path");

const CSV_FILE    = path.join(__dirname, "trade_log.csv");
const SCANNER_FILE = path.join(__dirname, "newFloorScaner.js");

function readCurrentTier3() {
  const src = fs.readFileSync(SCANNER_FILE, "utf8");
  const m = src.match(/TIER3_SYMBOLS:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return m[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || [];
}

function updateTier3(symbols) {
  const src = fs.readFileSync(SCANNER_FILE, "utf8");
  const arr = symbols.length
    ? `["${symbols.join('", "')}"]`
    : `[]`;
  const updated = src.replace(/TIER3_SYMBOLS:\s*\[[^\]]*\]/, `TIER3_SYMBOLS:  ${arr}`);
  fs.writeFileSync(SCANNER_FILE, updated, "utf8");
}

function main() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error("trade_log.csv 없음:", CSV_FILE);
    process.exit(1);
  }

  const lines = fs.readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const colSymbol = header.indexOf("symbol");
  const colAction = header.indexOf("action");

  if (colSymbol === -1 || colAction === -1) {
    console.error("CSV 컬럼 오류:", header);
    process.exit(1);
  }

  // 심볼별 TP/SL 집계
  const stats = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const sym    = cols[colSymbol]?.trim();
    const action = cols[colAction]?.trim();
    if (!sym || !action) continue;
    if (!stats[sym]) stats[sym] = { tp: 0, sl: 0 };
    if (action === "TP_HALF") stats[sym].tp++;
    else if (action === "SL" || action === "BE_CLOSE") stats[sym].sl++;
  }

  // TP_HALF 1회 이상 → 3군 후보
  const candidates = Object.entries(stats)
    .filter(([, s]) => s.tp > 0)
    .map(([sym, s]) => ({ sym, ...s, total: s.tp + s.sl, winRate: (s.tp / (s.tp + s.sl) * 100).toFixed(1) }))
    .sort((a, b) => b.tp - a.tp);

  console.log(`\n[promoteCoins] trade_log.csv 분석 완료`);
  console.log(`총 ${Object.keys(stats).length}개 거래 종목, 익절 있는 종목: ${candidates.length}개\n`);
  console.log(`${"─".repeat(52)}`);
  console.log(` ${"심볼".padEnd(14)} ${"거래".padStart(4)} ${"익절".padStart(4)} ${"손절".padStart(4)} ${"승률".padStart(6)}`);
  console.log(`${"─".repeat(52)}`);
  for (const r of candidates) {
    console.log(` ${r.sym.padEnd(14)} ${String(r.total).padStart(4)} ${String(r.tp).padStart(4)} ${String(r.sl).padStart(4)} ${(r.winRate + "%").padStart(6)}`);
  }
  console.log(`${"─".repeat(52)}\n`);

  const newTier3 = candidates.map(r => r.sym);
  const currentTier3 = readCurrentTier3();

  const added   = newTier3.filter(s => !currentTier3.includes(s));
  const removed = currentTier3.filter(s => !newTier3.includes(s));

  if (added.length === 0 && removed.length === 0) {
    console.log("변경 없음. TIER3 최신 상태입니다.");
    return;
  }

  if (added.length)   console.log(`추가될 종목 (${added.length}개):   ${added.join(", ")}`);
  if (removed.length) console.log(`제거될 종목 (${removed.length}개): ${removed.join(", ")}`);

  updateTier3(newTier3);
  console.log(`\n✅ newFloorScaner.js TIER3_SYMBOLS 업데이트 완료 (${newTier3.length}개)`);
  console.log(`   서버 반영: scanupdate\n`);
}

main();
