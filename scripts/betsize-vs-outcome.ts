/**
 * betsize-vs-outcome.ts
 *
 * Tests the hypothesis: "Does whale bet size predict win/loss?"
 * If the ML model would work, we'd see a clear correlation between
 * larger bets and higher win rates. Let's check.
 *
 * Usage:  npx tsx scripts/betsize-vs-outcome.ts
 */

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHALE_WALLET = "0x37c1874a60d348903594a96703e0507c518fc53a";
const DATA_API = "https://data-api.polymarket.com";

interface Position {
  asset: string;
  size: string;
  initialValue: string;
  curPrice: string;
  cashPnl: string;
  redeemable: boolean;
  outcome: string;
  title: string;
  [key: string]: unknown;
}

async function fetchAllPositions(): Promise<Position[]> {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;
  const all: Position[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const resp = await axios.get(`${DATA_API}/positions`, {
      params: { user: WHALE_WALLET, limit: PAGE_SIZE, offset },
    });
    const positions = Array.isArray(resp.data)
      ? resp.data
      : (resp.data?.positions ?? []);
    all.push(...positions);
    if (positions.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

async function main() {
  console.log("Fetching all whale positions…\n");
  const positions = await fetchAllPositions();
  console.log(`Total positions: ${positions.length}\n`);

  // Categorize each position as won/lost/open based on curPrice + redeemable
  const resolved: { invested: number; won: boolean; title: string }[] = [];

  for (const pos of positions) {
    const invested = parseFloat(pos.initialValue || "0");
    const curPrice = parseFloat(pos.curPrice ?? "-1");
    const redeemable = Boolean(pos.redeemable);
    const size = parseFloat(pos.size || "0");
    const cashPnl = parseFloat(pos.cashPnl || "0");

    if (size === 0 && !redeemable) continue; // skip empty

    // Only look at resolved positions (curPrice=0 or curPrice=1 or redeemable)
    if (
      curPrice === 0 ||
      (curPrice === 1 && redeemable) ||
      (redeemable && curPrice <= 0.01)
    ) {
      // Lost: curPrice=0 and not redeemable, or redeemable with curPrice=0
      resolved.push({ invested, won: false, title: pos.title || "" });
    } else if (curPrice >= 0.99 || redeemable) {
      // Won
      resolved.push({ invested, won: true, title: pos.title || "" });
    }
    // else: still open, skip
  }

  console.log(`Resolved positions: ${resolved.length}\n`);

  // ── Bucket by investment size and check win rate per bucket ──
  const buckets = [
    { label: "$0 – $5", min: 0, max: 5 },
    { label: "$5 – $10", min: 5, max: 10 },
    { label: "$10 – $25", min: 10, max: 25 },
    { label: "$25 – $50", min: 25, max: 50 },
    { label: "$50 – $100", min: 50, max: 100 },
    { label: "$100 – $250", min: 100, max: 250 },
    { label: "$250 – $500", min: 250, max: 500 },
    { label: "$500 – $1K", min: 500, max: 1000 },
    { label: "$1K – $5K", min: 1000, max: 5000 },
    { label: "$5K – $50K", min: 5000, max: 50000 },
    { label: "$50K+", min: 50000, max: Infinity },
  ];

  console.log("═══════════════════════════════════════════════════════════");
  console.log("     BET SIZE vs WIN RATE – Does bigger bet = more wins?");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(
    `${"Bucket".padEnd(18)} ${"Won".padStart(5)} ${"Lost".padStart(5)} ${"Total".padStart(6)} ${"Win%".padStart(7)}`,
  );
  console.log("─".repeat(55));

  let totalWon = 0;
  let totalLost = 0;

  for (const bucket of buckets) {
    const inBucket = resolved.filter(
      (r) => r.invested >= bucket.min && r.invested < bucket.max,
    );
    const won = inBucket.filter((r) => r.won).length;
    const lost = inBucket.filter((r) => !r.won).length;
    const total = won + lost;
    const winRate = total > 0 ? ((won / total) * 100).toFixed(1) : "N/A";

    totalWon += won;
    totalLost += lost;

    if (total > 0) {
      console.log(
        `${bucket.label.padEnd(18)} ${String(won).padStart(5)} ${String(lost).padStart(5)} ${String(total).padStart(6)} ${(winRate + "%").padStart(7)}`,
      );
    }
  }

  console.log("─".repeat(55));
  const overallWinRate = ((totalWon / (totalWon + totalLost)) * 100).toFixed(1);
  console.log(
    `${"OVERALL".padEnd(18)} ${String(totalWon).padStart(5)} ${String(totalLost).padStart(5)} ${String(totalWon + totalLost).padStart(6)} ${(overallWinRate + "%").padStart(7)}`,
  );

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  CONCLUSION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(
    "  If bet size predicted win rate, you'd see a CLEAR upward trend\n" +
      "  from small buckets (low win%) to large buckets (high win%).\n" +
      "  If the numbers are roughly flat across all buckets, then bet\n" +
      "  size has NO predictive power — and an ML model trained on it\n" +
      "  would learn nothing useful.\n",
  );

  // ── Show biggest losses to drive the point home ──
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TOP 10 BIGGEST LOSSES (whale invested most, still lost)");
  console.log("═══════════════════════════════════════════════════════════");
  const biggestLosses = resolved
    .filter((r) => !r.won)
    .sort((a, b) => b.invested - a.invested)
    .slice(0, 10);

  for (const loss of biggestLosses) {
    console.log(
      `  💀 $${loss.invested.toFixed(2)} invested → LOST | ${loss.title.slice(0, 60)}`,
    );
  }

  console.log("\n  ^ These are massive bets that STILL lost. An ML model");
  console.log("    would have given them HIGH confidence → you'd have");
  console.log("    sized UP on these → even BIGGER losses.\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
