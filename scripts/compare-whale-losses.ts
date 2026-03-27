/**
 * compare-whale-losses.ts
 *
 * Compares every lost bot trade against the whale's actual position
 * on the same market to determine:
 *   - How much USDC the whale invested
 *   - What the whale's actual PnL was (cashPnl from Data API)
 *   - Whether the whale lost 100% or exited early (partial loss)
 *
 * Usage:  npx tsx scripts/compare-whale-losses.ts
 */

import mongoose from "mongoose";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

// ── MongoDB connection ──
const MONGO_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/polybot";
const WHALE_WALLET = "0x37c1874a60d348903594a96703e0507c518fc53a";
const DATA_API = "https://data-api.polymarket.com";

// ── Minimal PaperTrade schema (read-only) ──
const PaperTradeSchema = new mongoose.Schema(
  {
    internal_trade_id: String,
    question: String,
    direction: String,
    trade_type: String,
    paper_investment_amount: Number,
    num_shares: Number,
    entry_price: Number,
    exit_price: Number,
    status: String,
    whale_wallet: String,
    token_id: String,
    condition_id: String,
    pnl: Number,
    opened_at: Date,
    resolved_at: Date,
    whale_usdc_size: Number,
  },
  { collection: "papertrades" },
);
const PaperTrade = mongoose.model("PaperTrade", PaperTradeSchema);

// ── Fetch ALL whale positions (paginated) ──
async function fetchAllWhalePositions(): Promise<Record<string, unknown>[]> {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;
  const all: Record<string, unknown>[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const resp = await axios.get(`${DATA_API}/positions`, {
      params: { user: WHALE_WALLET, limit: PAGE_SIZE, offset },
    });
    const positions: Record<string, unknown>[] = Array.isArray(resp.data)
      ? resp.data
      : (resp.data?.positions ?? []);
    all.push(...positions);
    if (positions.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

// ── Main ──
async function main() {
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("Connected.\n");

  // Fetch all lost bot trades
  const lostTrades = await PaperTrade.find({
    status: "Resolved_Lost",
  }).sort({ resolved_at: -1 });

  const wonTrades = await PaperTrade.find({
    status: "Resolved_Won",
  }).sort({ resolved_at: -1 });

  const exitedTrades = await PaperTrade.find({
    status: "Exited",
  }).sort({ resolved_at: -1 });

  const openTrades = await PaperTrade.find({
    status: "Open",
  }).sort({ opened_at: -1 });

  console.log("═══════════════════════════════════════════════════════════");
  console.log("              BOT TRADE STATISTICS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(
    `  Total trades:    ${lostTrades.length + wonTrades.length + exitedTrades.length + openTrades.length}`,
  );
  console.log(`  Won:             ${wonTrades.length}`);
  console.log(`  Lost:            ${lostTrades.length}`);
  console.log(`  Exited:          ${exitedTrades.length}`);
  console.log(`  Open:            ${openTrades.length}`);
  console.log(
    `  Win rate:        ${((wonTrades.length / Math.max(1, wonTrades.length + lostTrades.length)) * 100).toFixed(1)}%`,
  );
  console.log();

  if (lostTrades.length === 0) {
    console.log("No lost trades to analyse. Exiting.");
    await mongoose.disconnect();
    return;
  }

  // Fetch ALL whale positions
  console.log("Fetching whale positions from Data API (paginated)…");
  const whalePositions = await fetchAllWhalePositions();
  console.log(`Fetched ${whalePositions.length} whale positions.\n`);

  // Build a map: tokenId → whale position
  const positionMap = new Map<string, Record<string, unknown>>();
  for (const pos of whalePositions) {
    const tokenId = String(pos.asset || pos.asset_id || pos.token_id || "");
    if (tokenId) positionMap.set(tokenId, pos);
  }

  // Compare each lost trade
  console.log("═══════════════════════════════════════════════════════════");
  console.log("         LOST TRADES: BOT vs WHALE COMPARISON");
  console.log("═══════════════════════════════════════════════════════════\n");

  let totalBotLoss = 0;
  let totalWhaleLoss = 0;
  let matchedCount = 0;
  let unmatchedCount = 0;
  let whaleAlsoLost100Pct = 0;
  let whaleHadPartialLoss = 0;
  let whaleActuallyWon = 0;

  const rows: {
    question: string;
    botInvested: number;
    botPnl: number;
    whaleInvested: number;
    whalePnl: number;
    whalePctLoss: number;
    whaleOutcome: string;
  }[] = [];

  for (const trade of lostTrades) {
    const tokenId = trade.token_id as string;
    const whalePos = positionMap.get(tokenId);

    const botInvested = trade.paper_investment_amount as number;
    const botPnl = trade.pnl as number;
    totalBotLoss += botPnl;

    if (!whalePos) {
      unmatchedCount++;
      rows.push({
        question: (trade.question as string).slice(0, 50),
        botInvested,
        botPnl,
        whaleInvested: 0,
        whalePnl: 0,
        whalePctLoss: 0,
        whaleOutcome: "⚠️ No matching position",
      });
      continue;
    }

    matchedCount++;
    const whaleInvested = parseFloat(String(whalePos.initialValue || "0"));
    const whaleCashPnl = parseFloat(String(whalePos.cashPnl || "0"));
    const whaleCurPrice = parseFloat(String(whalePos.curPrice ?? "-1"));
    const whaleRedeemable = Boolean(whalePos.redeemable);

    totalWhaleLoss += whaleCashPnl;

    // Determine whale outcome
    let whaleOutcome: string;
    const whalePctLoss =
      whaleInvested > 0 ? (Math.abs(whaleCashPnl) / whaleInvested) * 100 : 0;

    if (whaleCashPnl >= 0) {
      whaleOutcome = "✅ Whale actually WON";
      whaleActuallyWon++;
    } else if (whalePctLoss >= 95) {
      whaleOutcome = "❌ Whale also lost ~100%";
      whaleAlsoLost100Pct++;
    } else {
      whaleOutcome = `⚠️ Whale had partial loss (${whalePctLoss.toFixed(0)}%)`;
      whaleHadPartialLoss++;
    }

    rows.push({
      question: (trade.question as string).slice(0, 50),
      botInvested,
      botPnl,
      whaleInvested,
      whalePnl: whaleCashPnl,
      whalePctLoss,
      whaleOutcome,
    });
  }

  // Print the table
  for (const r of rows) {
    console.log(`📌 ${r.question}`);
    console.log(
      `   Bot:   invested $${r.botInvested.toFixed(2)}, PnL: $${r.botPnl.toFixed(2)} (100% loss)`,
    );
    if (r.whaleInvested > 0) {
      console.log(
        `   Whale: invested $${r.whaleInvested.toFixed(2)}, PnL: $${r.whalePnl.toFixed(2)} (${r.whalePctLoss.toFixed(0)}% loss)`,
      );
    }
    console.log(`   ${r.whaleOutcome}`);
    console.log();
  }

  // Summary
  console.log("═══════════════════════════════════════════════════════════");
  console.log("                     SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Lost trades analysed:       ${lostTrades.length}`);
  console.log(`  Matched to whale position:  ${matchedCount}`);
  console.log(`  No matching position:       ${unmatchedCount}`);
  console.log();
  console.log(`  Whale also lost ~100%:      ${whaleAlsoLost100Pct}`);
  console.log(`  Whale had partial loss:     ${whaleHadPartialLoss}`);
  console.log(`  Whale actually won:         ${whaleActuallyWon}`);
  console.log();
  console.log(`  Total bot PnL (losses):     $${totalBotLoss.toFixed(2)}`);
  console.log(`  Total whale PnL (same):     $${totalWhaleLoss.toFixed(2)}`);
  console.log();

  if (whaleActuallyWon > 0) {
    console.log(
      "⚠️  WARNING: Some trades the bot LOST on, the whale ACTUALLY WON.",
    );
    console.log(
      "   This means the bot is copying the WRONG SIDE of the trade!",
    );
    console.log(
      "   The direction inference (outcomeIndex → Yes/No mapping) may be broken.",
    );
    console.log();
  }

  if (whaleHadPartialLoss > 0) {
    console.log(
      "⚠️  Some whale positions had partial losses — the whale may have",
    );
    console.log(
      "   sold part of the position before resolution. The whale exit",
    );
    console.log("   detector may not have caught these sells.");
    console.log();
  }

  // ── Also check: did the whale win on positions we don't have? ──
  console.log("═══════════════════════════════════════════════════════════");
  console.log("         WHALE WIN RATE (from positions data)");
  console.log("═══════════════════════════════════════════════════════════");

  let wWon = 0,
    wLost = 0,
    wOpen = 0,
    wWonValue = 0,
    wLostValue = 0;
  for (const pos of whalePositions) {
    const cp = parseFloat(String(pos.curPrice ?? "-1"));
    const iv = parseFloat(String(pos.initialValue || "0"));
    const pnl = parseFloat(String(pos.cashPnl || "0"));
    const redeemable = Boolean(pos.redeemable);
    const size = parseFloat(String(pos.size || "0"));
    if (size === 0) continue;

    if (redeemable || cp === 1) {
      wWon++;
      wWonValue += pnl;
    } else if (cp === 0 && !redeemable) {
      wLost++;
      wLostValue += pnl;
    } else if (cp > 0 && cp < 1) {
      wOpen++;
    }
  }

  const wTotal = wWon + wLost;
  console.log(`  Won:       ${wWon} positions (PnL: $${wWonValue.toFixed(2)})`);
  console.log(
    `  Lost:      ${wLost} positions (PnL: $${wLostValue.toFixed(2)})`,
  );
  console.log(`  Open:      ${wOpen} positions`);
  console.log(
    `  Win rate:  ${wTotal > 0 ? ((wWon / wTotal) * 100).toFixed(1) : "N/A"}%`,
  );
  console.log(`  Net PnL:   $${(wWonValue + wLostValue).toFixed(2)}`);
  console.log();

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
