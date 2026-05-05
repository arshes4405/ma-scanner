/**
 * trade_log.csv 분석 → 순익절 기준 자동 티어 승격
 * TIER1: tp-sl >= 5 | TIER2: tp-sl >= 3 | TIER3: tp-sl >= 1
 * 실행: node promoteCoins.js
 */

const VERSION = "2026-05-05 v7";

const fs   = require("fs");
const path = require("path");

const CSV_FILE     = path.join(__dirname, "trade_log.csv");
const SCANNER_FILE = path.join(__dirname, "newFloorScaner.js");

const TIER_RULES = [
  { key: "TIER1", label: "1군", min: 5 },
  { key: "TIER2", label: "2군", min: 3 },
  { key: "TIER3", label: "3군", min: 1 },
];

function readTier(key) {
  const src = fs.readFileSync(SCANNER_FILE, "utf8");
  const m = src.match(new RegExp(`${key}_SYMBOLS:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || [];
}

function writeTier(key, symbols) {
  let src = fs.readFileSync(SCANNER_FILE, "utf8");
  const arr = symbols.length ? `["${symbols.join('", "')}"]` : `[]`;
  src = src.replace(new RegExp(`${key}_SYMBOLS:\\s*\\[[^\\]]*\\]`), `${key}_SYMBOLS:  ${arr}`);
  fs.writeFileSync(SCANNER_FILE, src, "utf8");
}

function readExclude() {
  const src = fs.readFileSync(SCANNER_FILE, "utf8");
  const m = src.match(/EXCLUDE_SYMBOLS:\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return m[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || [];
}

function addToExclude(symbols) {
  let src = fs.readFileSync(SCANNER_FILE, "utf8");
  const current = readExclude();
  const toAdd = symbols.filter(s => !current.includes(s));
  if (!toAdd.length) return 0;
  // 마지막 항목 뒤에 추가
  const addStr = toAdd.map(s => `"${s}"`).join(", ");
  src = src.replace(/(EXCLUDE_SYMBOLS:\s*\[[\s\S]*?)(,?\s*\])/, `$1, ${addStr}$2`);
  fs.writeFileSync(SCANNER_FILE, src, "utf8");
  return toAdd.length;
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
  const colSource = header.indexOf("source");

  if (colSymbol === -1 || colAction === -1) {
    console.error("CSV 컬럼 오류:", header);
    process.exit(1);
  }

  // 1차: SYSTEM source (TP_HALF / SL)
  const stats = {};
  const systemSlSymbols = new Set();
  for (const line of lines.slice(1)) {
    const cols   = line.split(",");
    const sym    = cols[colSymbol]?.trim();
    const action = cols[colAction]?.trim();
    const source = colSource !== -1 ? cols[colSource]?.trim() : null;
    if (!sym || !action) continue;
    if (source !== "SYSTEM") continue;
    if (!stats[sym]) stats[sym] = { tp: 0, sl: 0 };
    if (action === "TP_HALF") stats[sym].tp++;
    else if (action === "SL") { stats[sym].sl++; systemSlSymbols.add(sym); }
  }

  // 2차: MANUAL AUTO_SL — SYSTEM SL 없는 심볼만 (강제청산 등 모니터 미포착 건)
  for (const line of lines.slice(1)) {
    const cols   = line.split(",");
    const sym    = cols[colSymbol]?.trim();
    const action = cols[colAction]?.trim();
    const source = colSource !== -1 ? cols[colSource]?.trim() : null;
    if (!sym || !action) continue;
    if (source !== "MANUAL" || action !== "AUTO_SL") continue;
    if (systemSlSymbols.has(sym)) continue;
    if (!stats[sym]) stats[sym] = { tp: 0, sl: 0 };
    stats[sym].sl++;
  }

  // 티어별 분류 (상위 티어 우선)
  const tierMap = { TIER1: [], TIER2: [], TIER3: [] };
  const blackList = [];
  const allRows = Object.entries(stats)
    .map(([sym, s]) => ({ sym, ...s, net: s.tp - s.sl, winRate: (s.tp / (s.tp + s.sl) * 100).toFixed(1) }))
    .sort((a, b) => b.net - a.net);

  const warningList = [];
  for (const r of allRows) {
    if      (r.net >= 5)  tierMap.TIER1.push(r);
    else if (r.net >= 3)  tierMap.TIER2.push(r);
    else if (r.net >= 1)  tierMap.TIER3.push(r);
    else if (r.net <= -2) blackList.push(r);
    else if (r.sl > 0)    warningList.push(r);
  }

  // 결과 출력
  console.log(`\n[promoteCoins ${VERSION}] trade_log.csv 분석 완료 (TP_HALF/SL 기준)`);
  console.log(`▶ 블랙 (순익절 <= -2) : ${blackList.length}개`);
  if (blackList.length) {
    console.log(`  ${"─".repeat(56)}`);
    console.log(`  ${"심볼".padEnd(14)} ${"익절".padStart(4)} ${"손절".padStart(4)} ${"순익절".padStart(5)} ${"승률".padStart(6)}`);
    console.log(`  ${"─".repeat(56)}`);
    for (const r of blackList)
      console.log(`  ${r.sym.padEnd(14)} ${String(r.tp).padStart(4)} ${String(r.sl).padStart(4)} ${String(r.net).padStart(5)} ${((r.tp + r.sl) > 0 ? r.winRate + "%" : "-").padStart(6)}`);
  } else {
    console.log(`  없음`);
  }
  console.log();
  console.log(`총 ${Object.keys(stats).length}개 종목\n`);

  for (const { key, label, min } of TIER_RULES) {
    const rows = tierMap[key];
    console.log(`▶ ${label} (순익절 >= ${min}) : ${rows.length}개`);
    if (rows.length) {
      console.log(`  ${"─".repeat(56)}`);
      console.log(`  ${"심볼".padEnd(14)} ${"익절".padStart(4)} ${"손절".padStart(4)} ${"순익절".padStart(5)} ${"승률".padStart(6)}`);
      console.log(`  ${"─".repeat(56)}`);
      for (const r of rows)
        console.log(`  ${r.sym.padEnd(14)} ${String(r.tp).padStart(4)} ${String(r.sl).padStart(4)} ${("+" + r.net).padStart(5)} ${(r.winRate + "%").padStart(6)}`);
    }
    console.log();
  }

  // 언랭 SL 기록
  if (warningList.length) {
    console.log(`▶ 언랭 SL 기록 (순익절 < 1) : ${warningList.length}개`);
    console.log(`  ${"─".repeat(56)}`);
    console.log(`  ${"심볼".padEnd(14)} ${"익절".padStart(4)} ${"손절".padStart(4)} ${"순익절".padStart(5)} ${"승률".padStart(6)}`);
    console.log(`  ${"─".repeat(56)}`);
    for (const r of warningList)
      console.log(`  ${r.sym.padEnd(14)} ${String(r.tp).padStart(4)} ${String(r.sl).padStart(4)} ${String(r.net).padStart(5)} ${((r.tp + r.sl) > 0 ? r.winRate + "%" : "-").padStart(6)}`);
    console.log();
  }

  // 파일 업데이트
  let changed = false;
  for (const { key, label } of TIER_RULES) {
    const newList     = tierMap[key].map(r => r.sym);
    const currentList = readTier(key);
    const added   = newList.filter(s => !currentList.includes(s));
    const removed = currentList.filter(s => !newList.includes(s));
    if (added.length || removed.length) {
      if (added.length)   console.log(`[${label}] 추가 (${added.length}개): ${added.join(", ")}`);
      if (removed.length) console.log(`[${label}] 제거 (${removed.length}개): ${removed.join(", ")}`);
      writeTier(key, newList);
      changed = true;
    }
  }

  // 블랙리스트 추가
  if (blackList.length) {
    const n = addToExclude(blackList.map(r => r.sym));
    if (n > 0) {
      console.log(`[블랙] 추가 (${n}개): ${blackList.map(r => r.sym).join(", ")}`);
      changed = true;
    }
  }

  if (changed) {
    console.log(`\n✅ newFloorScaner.js 티어 업데이트 완료`);
    console.log(`   서버 반영: scanupdate\n`);
  } else {
    console.log("변경 없음. 티어 최신 상태입니다.");
  }
}

main();
