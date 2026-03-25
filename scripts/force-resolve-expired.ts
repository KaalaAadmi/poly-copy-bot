/**
 * One-time script: Force-resolve all open trades whose event_end_date
 * has passed. Uses the same resolution logic as the MarketResolver's
 * expiry fallback but runs immediately instead of waiting for the
 * next poll cycle.
 *
 * Resolution strategy (in order):
 *   1. Gamma API lookup by slug → determine win/loss from outcomePrices
 *   2. Gamma API lookup by token ID → same
 *   3. Whale activity history → check for REDEEM events
 *   4. Last resort → mark as LOST
 *
 * Usage:
 *   npx tsx scripts/force-resolve-expired.ts
 *
 * Safe to run multiple times — only processes trades that are still "Open".
 */

import mongoose from "mongoose";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/polybot";
const GAMMA_API_URL =
  process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";
const CLOB_API_URL = process.env.CLOB_API_URL || "https://clob.polymarket.com";
const DATA_API_URL =
  process.env.DATA_API_URL || "https://data-api.polymarket.com";

// Grace period: how many hours after event_end_date before force-resolving
const GRACE_HOURS = 6;

// ── Minimal PaperTrade model ──
const PaperTradeSchema = new mongoose.Schema(
  {
    internal_trade_id: String,
    token_id: String,
    condition_id: String,
    whale_wallet: String,
    question: String,
    market_slug: String,
    direction: String,
    trade_type: String,
    paper_investment_amount: Number,
    num_shares: Number,
    entry_price: Number,
    exit_price: { type: Number, default: null },
    status: String,
    pnl: { type: Number, default: 0 },
    opened_at: Date,
    resolved_at: { type: Date, default: null },
    is_live: { type: Boolean, default: false },
    event_end_date: { type: Date, default: null },
  },
  { collection: "papertrades", strict: false },
);

const PaperTrade = mongoose.model("PaperTrade", PaperTradeSchema);

// SystemState model
const SystemStateSchema = new mongoose.Schema(
  {
    current_balance: Number,
    daily_starting_balance: Number,
    initial_balance: Number,
    last_daily_reset: Date,
    live_mode: Boolean,
  },
  { collection: "systemstates", strict: false },
);

const SystemState = mongoose.model("SystemState", SystemStateSchema);

// ── API helpers ──

interface GammaMarket {
  question: string;
  conditionId: string;
  slug: string;
  outcomePrices: string;
  clobTokenIds: string;
  closed: boolean;
  umaResolutionStatus?: string;
}

async function gammaLookupBySlug(slug: string): Promise<GammaMarket | null> {
  try {
    const resp = await axios.get(`${GAMMA_API_URL}/markets`, {
      params: { slug, limit: 1 },
      timeout: 15_000,
    });
    const markets = resp.data as GammaMarket[];
    if (markets.length === 0) return null;
    if (markets[0].slug !== slug) return null;
    return markets[0];
  } catch {
    return null;
  }
}

async function gammaLookupByTokenId(
  tokenId: string,
): Promise<GammaMarket | null> {
  try {
    const resp = await axios.get(`${GAMMA_API_URL}/markets`, {
      params: { clob_token_ids: tokenId, limit: 5 },
      timeout: 15_000,
    });
    const markets = resp.data as GammaMarket[];
    for (const m of markets) {
      try {
        const ids: string[] = JSON.parse(m.clobTokenIds);
        if (ids.includes(tokenId)) return m;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function clobIsAlive(tokenId: string): Promise<boolean> {
  try {
    const resp = await axios.get(`${CLOB_API_URL}/midpoint`, {
      params: { token_id: tokenId },
      timeout: 10_000,
    });
    return resp.data?.mid != null;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    return status !== 404; // 404 = dead, anything else = assume alive
  }
}

async function getWhaleActivity(
  wallet: string,
): Promise<Record<string, unknown>[]> {
  try {
    const resp = await axios.get(`${DATA_API_URL}/activity`, {
      params: { user: wallet.toLowerCase() },
      timeout: 15_000,
    });
    return Array.isArray(resp.data) ? resp.data : (resp.data?.history ?? []);
  } catch {
    return [];
  }
}

function determineWinLossFromGamma(
  market: GammaMarket,
  tokenId: string,
): boolean | null {
  if (!market.closed) return null;

  let outcomePrices: number[] = [];
  let clobTokenIds: string[] = [];
  try {
    outcomePrices = JSON.parse(market.outcomePrices).map(Number);
    clobTokenIds = JSON.parse(market.clobTokenIds);
  } catch {
    return null;
  }

  const winningIndex = outcomePrices.findIndex((p) => p >= 0.99);
  if (winningIndex < 0) return null;

  const winningTokenId = clobTokenIds[winningIndex] ?? null;
  return tokenId === winningTokenId;
}

// ── Main ──

async function main() {
  console.log("🔧 Force-Resolve Expired Trades");
  console.log(`   MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, "//***@")}`);
  console.log(`   Gamma API: ${GAMMA_API_URL}`);
  console.log(`   CLOB API: ${CLOB_API_URL}`);
  console.log(`   Grace period: ${GRACE_HOURS} hours\n`);

  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to MongoDB\n");

  const now = Date.now();

  // Find all open trades with expired event_end_date
  const allOpen = await PaperTrade.find({ status: "Open" });
  console.log(`📋 Total open trades: ${allOpen.length}\n`);

  const expired = allOpen.filter((t) => {
    if (!t.event_end_date) return false;
    const endDate = new Date(t.event_end_date as Date);
    if (isNaN(endDate.getTime())) return false;
    const deadlineMs = endDate.getTime() + GRACE_HOURS * 60 * 60 * 1000;
    return now >= deadlineMs;
  });

  console.log(
    `⏰ Expired trades (event_end_date + ${GRACE_HOURS}h < now): ${expired.length}\n`,
  );

  if (expired.length === 0) {
    console.log("Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  let resolvedWon = 0;
  let resolvedLost = 0;
  let resolvedForce = 0;
  let skipped = 0;

  // Load system state for balance updates
  const systemState = await SystemState.findOne();
  if (!systemState) {
    console.error("❌ No SystemState found in DB. Cannot update balance.");
    await mongoose.disconnect();
    return;
  }

  for (const trade of expired) {
    const tradeId = (trade.internal_trade_id as string).slice(0, 8);
    const question = trade.question as string;
    const tokenId = trade.token_id as string;
    const slug = trade.market_slug as string;
    const conditionId = trade.condition_id as string;
    const wallet = trade.whale_wallet as string;

    console.log(`\n  🔍 ${tradeId}… "${question}"`);

    // Verify CLOB is dead
    const alive = await clobIsAlive(tokenId);
    if (alive) {
      console.log(`    ⏭ CLOB still alive — skipping`);
      skipped++;
      continue;
    }

    // Strategy 1: Gamma by slug
    let won: boolean | null = null;
    let source = "";

    if (slug) {
      const market = await gammaLookupBySlug(slug);
      if (market) {
        won = determineWinLossFromGamma(market, tokenId);
        if (won !== null) source = "Gamma-slug";
      }
    }

    // Strategy 2: Gamma by token ID
    if (won === null) {
      const market = await gammaLookupByTokenId(tokenId);
      if (market) {
        won = determineWinLossFromGamma(market, tokenId);
        if (won !== null) source = "Gamma-tokenId";
      }
    }

    // Strategy 3: Whale activity history
    if (won === null && conditionId && wallet) {
      const activities = await getWhaleActivity(wallet);
      for (const act of activities) {
        const actType = String(act.type || "").toUpperCase();
        const actCondition = String(act.conditionId || "");
        if (actCondition !== conditionId) continue;

        if (actType === "REDEEM" || actType === "PAYOUT") {
          const actAsset = String(act.asset || "");
          if (actAsset === tokenId) {
            won = true;
            source = "whale-REDEEM(our-token)";
            break;
          } else if (actAsset) {
            won = false;
            source = "whale-REDEEM(opposite-token)";
            break;
          }
        }
      }
    }

    // Strategy 4: Force as LOST
    if (won === null) {
      won = false;
      source = "FORCE(no signal found)";
    }

    // ── Resolve the trade ──
    const numShares = trade.num_shares as number;
    const investmentAmount = trade.paper_investment_amount as number;
    const isLive = trade.is_live as boolean;

    if (won) {
      const payout = numShares * 1; // each share pays $1
      trade.pnl = payout - investmentAmount;
      trade.exit_price = 1;
      trade.status = "Resolved_Won";
      if (!isLive) {
        (systemState.current_balance as number) += payout;
      }
      resolvedWon++;
    } else {
      trade.pnl = -investmentAmount;
      trade.exit_price = 0;
      trade.status = "Resolved_Lost";
      // For paper: balance was already deducted on open
      if (source.startsWith("FORCE")) resolvedForce++;
      else resolvedLost++;
    }

    trade.resolved_at = new Date();
    await trade.save();

    const emoji = won ? "✅" : "❌";
    const pnlSign = (trade.pnl as number) >= 0 ? "+" : "";
    console.log(
      `    ${emoji} ${won ? "WON" : "LOST"} via ${source} | PnL: ${pnlSign}$${(trade.pnl as number).toFixed(2)}`,
    );

    // Small delay to be polite to APIs
    await new Promise((r) => setTimeout(r, 300));
  }

  // Save updated balance
  await systemState.save();

  console.log(`\n──────────────────────────────`);
  console.log(`✅ Resolved WON:   ${resolvedWon}`);
  console.log(`❌ Resolved LOST:  ${resolvedLost}`);
  console.log(`⚠️  Force LOST:    ${resolvedForce}`);
  console.log(`⏭ Skipped:        ${skipped}`);
  console.log(
    `💰 Balance after:  $${(systemState.current_balance as number).toFixed(2)}`,
  );
  console.log(`──────────────────────────────\n`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
