/**
 * One-time backfill script: populates `event_end_date` for all PaperTrades
 * that are missing it.
 *
 * How it works:
 *   1. Connects to MongoDB
 *   2. Finds all trades where event_end_date is null
 *   3. Groups them by whale_wallet to minimise API calls
 *   4. Fetches each whale's positions from the Data API
 *   5. Matches by token_id and writes back the endDate
 *
 * Usage:
 *   npx tsx scripts/backfill-end-dates.ts
 *
 * Safe to run multiple times — only updates trades that still have null.
 */

import mongoose from "mongoose";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/polybot";
const DATA_API_URL =
  process.env.DATA_API_URL || "https://data-api.polymarket.com";

// ── Minimal PaperTrade model (matches the main app schema) ──
const PaperTradeSchema = new mongoose.Schema(
  {
    internal_trade_id: String,
    token_id: String,
    whale_wallet: String,
    question: String,
    market_slug: String,
    status: String,
    event_end_date: { type: Date, default: null },
  },
  { collection: "papertrades", strict: false },
);

const PaperTrade = mongoose.model("PaperTrade", PaperTradeSchema);

async function fetchPositions(
  wallet: string,
): Promise<Record<string, unknown>[]> {
  try {
    const resp = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: wallet.toLowerCase() },
      timeout: 15_000,
    });
    return Array.isArray(resp.data) ? resp.data : (resp.data?.positions ?? []);
  } catch (err) {
    console.error(`  ⚠ Failed to fetch positions for ${wallet}: ${err}`);
    return [];
  }
}

/**
 * Try to extract a date from a market slug.
 * Slugs often look like "nba-nop-nyk-2026-03-24-spread-home-8pt5"
 * or "ufc-fight-night-2026-03-22". We look for a YYYY-MM-DD pattern.
 */
function parseDateFromSlug(slug: string): Date | null {
  if (!slug) return null;
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(match[1] + "T23:59:00Z"); // Assume end of day
  return isNaN(parsed.getTime()) ? null : parsed;
}

async function main() {
  console.log("🔧 Backfill: event_end_date for PaperTrades");
  console.log(`   MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, "//***@")}`);
  console.log(`   Data API: ${DATA_API_URL}\n`);

  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to MongoDB\n");

  // Find all trades missing event_end_date
  const trades = await PaperTrade.find({
    $or: [{ event_end_date: null }, { event_end_date: { $exists: false } }],
  });

  console.log(`📋 Found ${trades.length} trade(s) missing event_end_date\n`);

  if (trades.length === 0) {
    console.log("Nothing to do. All trades already have end dates.");
    await mongoose.disconnect();
    return;
  }

  // Group by whale_wallet
  const byWallet = new Map<string, typeof trades>();
  for (const trade of trades) {
    const wallet = ((trade.whale_wallet as string) || "").toLowerCase();
    if (!wallet) continue;
    if (!byWallet.has(wallet)) byWallet.set(wallet, []);
    byWallet.get(wallet)!.push(trade);
  }

  console.log(`🐋 ${byWallet.size} unique whale wallet(s) to query\n`);

  let updated = 0;
  let updatedFromSlug = 0;
  let notFound = 0;

  for (const [wallet, walletTrades] of byWallet) {
    console.log(
      `  Fetching positions for ${wallet.slice(0, 8)}… (${walletTrades.length} trade(s))`,
    );

    const positions = await fetchPositions(wallet);

    // Build lookup: token_id → endDate
    const endDateMap = new Map<string, string>();
    for (const pos of positions) {
      const asset = String(pos.asset || pos.asset_id || pos.token_id || "");
      const endDate = pos.endDate ? String(pos.endDate) : "";
      if (asset && endDate) {
        endDateMap.set(asset, endDate);
      }
    }

    console.log(
      `    → ${positions.length} position(s), ${endDateMap.size} with endDate`,
    );

    for (const trade of walletTrades) {
      const tokenId = trade.token_id as string;
      const endDateStr = endDateMap.get(tokenId);

      if (endDateStr) {
        const parsed = new Date(endDateStr);
        if (!isNaN(parsed.getTime())) {
          trade.event_end_date = parsed;
          await trade.save();
          updated++;
          console.log(
            `    ✅ ${(trade.internal_trade_id as string).slice(0, 8)}… → ${endDateStr}  (${trade.question})  [Data API]`,
          );
          continue;
        }
      }

      // Fallback: parse date from market_slug (e.g. "nba-nop-nyk-2026-03-24-spread-home-8pt5")
      const slugDate = parseDateFromSlug((trade.market_slug as string) || "");
      if (slugDate) {
        trade.event_end_date = slugDate;
        await trade.save();
        updatedFromSlug++;
        console.log(
          `    ✅ ${(trade.internal_trade_id as string).slice(0, 8)}… → ${slugDate.toISOString().slice(0, 10)}  (${trade.question})  [slug]`,
        );
        continue;
      }

      notFound++;
      console.log(
        `    ❌ ${(trade.internal_trade_id as string).slice(0, 8)}… → no end date found  (${trade.question})`,
      );
    }

    // Small delay between wallets to be polite to the API
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n──────────────────────────────`);
  console.log(`✅ Updated from Data API: ${updated}`);
  console.log(`✅ Updated from slug:     ${updatedFromSlug}`);
  console.log(`❌ Not found:             ${notFound}`);
  console.log(`──────────────────────────────\n`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
