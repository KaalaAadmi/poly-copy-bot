import crypto from "crypto";

function uuidv4(): string {
  return crypto.randomUUID();
}

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  TrackedWallet,
  ProcessedSignal,
  PaperTrade,
  SystemState,
} from "../db/models/index.js";
import { polymarketApi, GammaMarket } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";
import { liveTrader } from "./liveTrader.js";

/**
 * CatchupService – Scans tracked wallets' open positions and copies
 * any trades where the price hasn't drifted beyond the configured
 * slippage threshold.
 *
 * Triggered on:
 *   1. Bot startup
 *   2. Mode switch (/golive or /gopaper)
 *   3. New wallet added (/addwallet)
 *
 * Uses ProcessedSignal for idempotency – a catchup position is tagged
 * with a synthetic ID so it won't be re-opened on subsequent restarts.
 */
export class CatchupService {
  private sendAlert: ((msg: string) => Promise<void>) | null = null;

  setAlertCallback(fn: (msg: string) => Promise<void>): void {
    this.sendAlert = fn;
  }

  // ──────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────

  /**
   * Run catchup for ALL tracked wallets.
   * Called on bot startup and mode switches.
   */
  async catchupAll(): Promise<void> {
    if (!config.catchupEnabled) {
      logger.info("Catchup is disabled via CATCHUP_ENABLED=false – skipping");
      return;
    }

    const wallets = await TrackedWallet.find({ active_status: true });
    if (wallets.length === 0) {
      logger.info("Catchup: no active wallets to scan");
      return;
    }

    logger.info(
      `🔄 Catchup: scanning ${wallets.length} wallet(s) for open positions…`,
    );
    if (this.sendAlert) {
      await this.sendAlert(
        `🔄 <b>Catchup scan starting</b> — checking ${wallets.length} wallet(s) for copyable positions…`,
      );
    }

    let totalCopied = 0;
    let totalSkipped = 0;

    for (const wallet of wallets) {
      try {
        const { copied, skipped } = await this.catchupWallet(
          wallet.wallet_address,
        );
        totalCopied += copied;
        totalSkipped += skipped;
      } catch (err) {
        logger.error(
          `Catchup error for wallet ${wallet.wallet_address}: ${err}`,
        );
      }
      // Small delay between wallets to respect rate limits
      await this.sleep(1500);
    }

    const summary =
      `🔄 <b>Catchup complete</b>\n` +
      `  Copied: ${totalCopied} | Skipped: ${totalSkipped}`;
    logger.info(summary);
    if (this.sendAlert) await this.sendAlert(summary);
  }

  /**
   * Run catchup for a SINGLE wallet.
   * Called when a new wallet is added via /addwallet.
   */
  async catchupWallet(
    walletAddress: string,
  ): Promise<{ copied: number; skipped: number }> {
    if (!config.catchupEnabled) {
      return { copied: 0, skipped: 0 };
    }

    let copied = 0;
    let skipped = 0;

    const allPositions = await polymarketApi.getUserPositions(walletAddress);
    if (!allPositions || allPositions.length === 0) {
      logger.info(
        `Catchup: no positions found for ${walletAddress.slice(0, 8)}…`,
      );
      return { copied, skipped };
    }

    // Pre-filter: skip resolved/redeemable/mergeable/expired positions to
    // avoid hammering the CLOB API with 404s for dead markets.
    const positions = allPositions.filter((pos) => {
      const curPrice = parseFloat(String(pos.curPrice ?? "-1"));
      if (Boolean(pos.redeemable) || Boolean(pos.mergeable) || curPrice === 0) {
        return false;
      }
      if (pos.endDate) {
        const endDate = new Date(String(pos.endDate));
        if (!isNaN(endDate.getTime()) && endDate.getTime() < Date.now()) {
          return false;
        }
      }
      const size = parseFloat(String(pos.size || "0"));
      return size > 0;
    });

    const filtered = allPositions.length - positions.length;
    logger.info(
      `Catchup: found ${allPositions.length} position(s) for ${walletAddress.slice(0, 8)}… ` +
        `(${filtered} resolved/expired filtered out, ${positions.length} active to evaluate)`,
    );

    // Bulk-mark filtered positions as processed so we don't re-check them
    if (filtered > 0) {
      const filteredOnes = allPositions.filter((p) => !positions.includes(p));
      for (const pos of filteredOnes) {
        const tokenId = String(pos.asset || pos.asset_id || pos.token_id || "");
        if (tokenId) {
          await this.markProcessed(
            `catchup:${walletAddress.toLowerCase()}:${tokenId}`,
            walletAddress,
          );
        }
      }
    }

    for (const pos of positions) {
      try {
        const result = await this.evaluatePosition(pos, walletAddress);
        if (result === "copied") copied++;
        else if (result === "skipped") skipped++;
        // "already_processed" is silent
      } catch (err) {
        logger.error(`Catchup position error: ${err}`);
        skipped++;
      }

      // Small delay between positions
      await this.sleep(500);
    }

    return { copied, skipped };
  }

  // ──────────────────────────────────────────────────────
  // Core evaluation logic
  // ──────────────────────────────────────────────────────

  private async evaluatePosition(
    pos: Record<string, unknown>,
    walletAddress: string,
  ): Promise<"copied" | "skipped" | "already_processed"> {
    // Extract position data
    const tokenId = String(pos.asset || pos.asset_id || pos.token_id || "");
    const size = parseFloat(String(pos.size || pos.shares || "0"));
    const whaleEntryPrice = parseFloat(
      String(pos.avg_price || pos.avgPrice || pos.price || "0"),
    );
    const conditionId = String(
      pos.conditionId || pos.condition_id || pos.market || "",
    );
    const outcome = String(pos.outcome || "");
    const posTitle = String(pos.title || pos.question || "");
    const posSlug = String(pos.eventSlug || pos.slug || "");
    const curPrice = parseFloat(String(pos.curPrice ?? "-1"));
    const redeemable = Boolean(pos.redeemable);
    const mergeable = Boolean(pos.mergeable);

    // Skip empty / zero positions
    if (!tokenId || size <= 0) return "skipped";

    // Skip resolved / expired positions – the Data API tells us via
    // curPrice=0, redeemable=true, or mergeable=true. Hitting the CLOB
    // for these just produces 404 errors.
    if (redeemable || mergeable || curPrice === 0) {
      logger.debug(
        `Catchup: position ${tokenId.slice(0, 12)}… is resolved/redeemable – skipping`,
      );
      await this.markProcessed(
        `catchup:${walletAddress.toLowerCase()}:${tokenId}`,
        walletAddress,
      );
      return "skipped";
    }

    // Skip positions whose end date is already in the past
    if (pos.endDate) {
      const endDate = new Date(String(pos.endDate));
      if (!isNaN(endDate.getTime()) && endDate.getTime() < Date.now()) {
        logger.debug(
          `Catchup: position ${tokenId.slice(0, 12)}… market ended ${endDate.toISOString()} – skipping`,
        );
        await this.markProcessed(
          `catchup:${walletAddress.toLowerCase()}:${tokenId}`,
          walletAddress,
        );
        return "skipped";
      }
    }

    // Idempotency: build a synthetic ID for this catchup position
    // Format: "catchup:<wallet>:<tokenId>" — unique per wallet+token combo
    const syntheticId = `catchup:${walletAddress.toLowerCase()}:${tokenId}`;

    // Check if we already processed this catchup position
    const alreadyProcessed = await ProcessedSignal.findOne({
      polymarket_trade_id: syntheticId,
    });
    if (alreadyProcessed) {
      return "already_processed";
    }

    // Also check if we already have ANY trade for this exact token
    // (open or resolved). This prevents re-opening a position that was
    // already copy-traded and subsequently resolved.
    const existingTrade = await PaperTrade.findOne({
      token_id: tokenId,
    });
    if (existingTrade) {
      // Mark as processed so we don't re-check
      await this.markProcessed(syntheticId, walletAddress);
      return "already_processed";
    }

    // Get current market price
    let currentPrice = await polymarketApi.getMidpointPrice(tokenId);
    if (currentPrice === null) {
      currentPrice = await polymarketApi.getPrice(tokenId);
    }
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) {
      logger.debug(`Catchup: invalid price for ${tokenId} – skipping`);
      await this.markProcessed(syntheticId, walletAddress);
      return "skipped";
    }

    // Check if market is still open
    let market: GammaMarket | null = null;
    if (conditionId) {
      market = await polymarketApi.getMarketByConditionId(conditionId);
      if (market?.closed) {
        logger.debug(`Catchup: market ${conditionId} is closed – skipping`);
        await this.markProcessed(syntheticId, walletAddress);
        return "skipped";
      }
    }

    // ── Slippage check ──
    const threshold = config.catchupMaxSlippage;
    const priceDiff = currentPrice - whaleEntryPrice;
    let withinThreshold: boolean;

    if (config.catchupMode === "absolute") {
      // Both directions: |current - whale| ≤ threshold
      withinThreshold = Math.abs(priceDiff) <= threshold;
    } else {
      // Relative: current ≤ whale + threshold (dips always OK)
      withinThreshold = currentPrice <= whaleEntryPrice + threshold;
    }

    if (!withinThreshold) {
      const direction = priceDiff > 0 ? "up" : "down";
      logger.info(
        `Catchup SKIP: ${tokenId.slice(0, 12)}… — ` +
          `whale entry: ${(whaleEntryPrice * 100).toFixed(1)}¢, ` +
          `current: ${(currentPrice * 100).toFixed(1)}¢ ` +
          `(${direction} ${(Math.abs(priceDiff) * 100).toFixed(1)}¢, threshold: ${(threshold * 100).toFixed(1)}¢)`,
      );

      if (this.sendAlert) {
        const question =
          posTitle ||
          market?.question ||
          conditionId?.slice(0, 20) ||
          tokenId.slice(0, 12);
        await this.sendAlert(
          `⏭ <b>Catchup skipped</b>\n` +
            `📌 ${question}\n` +
            `Whale entry: ${(whaleEntryPrice * 100).toFixed(1)}¢ → Now: ${(currentPrice * 100).toFixed(1)}¢\n` +
            `Price moved ${(Math.abs(priceDiff) * 100).toFixed(1)}¢ ${direction} (limit: ${(threshold * 100).toFixed(1)}¢)`,
        );
      }

      await this.markProcessed(syntheticId, walletAddress);
      return "skipped";
    }

    // ── Within threshold → execute the copy trade ──
    logger.info(
      `Catchup HIT: ${tokenId.slice(0, 12)}… — ` +
        `whale entry: ${(whaleEntryPrice * 100).toFixed(1)}¢, ` +
        `current: ${(currentPrice * 100).toFixed(1)}¢ ` +
        `(diff: ${(Math.abs(priceDiff) * 100).toFixed(1)}¢ ≤ ${(threshold * 100).toFixed(1)}¢)`,
    );

    // Delegate to risk engine via a synthetic signal
    // This ensures exposure checks, sizing, and paper/live branching all apply
    await this.executeCatchupTrade(
      tokenId,
      conditionId,
      currentPrice,
      whaleEntryPrice,
      walletAddress,
      outcome,
      market,
      syntheticId,
      posTitle,
      posSlug,
    );

    return "copied";
  }

  // ──────────────────────────────────────────────────────
  // Trade execution (respects risk engine rules)
  // ──────────────────────────────────────────────────────

  private async executeCatchupTrade(
    tokenId: string,
    conditionId: string,
    currentPrice: number,
    whaleEntryPrice: number,
    walletAddress: string,
    outcome: string,
    market: GammaMarket | null,
    syntheticId: string,
    posTitle: string,
    posSlug: string,
  ): Promise<void> {
    const system = await riskEngine.getSystemState();

    // Exposure check
    const todayExposure = await riskEngine.getTodayExposure();
    const maxExposure = system.daily_starting_balance * config.dailyMaxExposure;

    if (todayExposure >= maxExposure) {
      logger.warn(`Catchup: daily exposure limit reached – skipping`);
      await this.markProcessed(syntheticId, walletAddress);
      return;
    }

    // Sizing (same as riskEngine: 2% of daily starting balance)
    const investmentAmount =
      system.daily_starting_balance * config.positionSizePct;

    if (investmentAmount > system.current_balance) {
      logger.warn(`Catchup: insufficient balance – skipping`);
      await this.markProcessed(syntheticId, walletAddress);
      return;
    }

    // Use Data API position metadata as primary source (Gamma API can return wrong market)
    const question = posTitle || market?.question || "Unknown Market";
    const slug = posSlug || market?.slug || "";
    const numShares = investmentAmount / currentPrice;

    // Determine direction from outcome field
    const direction: "Yes" | "No" =
      outcome.toLowerCase() === "no" ? "No" : "Yes";

    // Check if live mode
    const isLive = system.live_mode && liveTrader.isReady();
    let liveOrderId = "";

    if (isLive) {
      const tickSize = market?.minimum_tick_size ?? "0.01";
      const negRisk = market?.neg_risk ?? false;

      const orderResult = await liveTrader.placeBuyOrder(
        tokenId,
        numShares,
        currentPrice,
        tickSize,
        negRisk,
      );

      if (!orderResult.success) {
        logger.error(`Catchup live order FAILED: ${orderResult.errorMsg}`);
        if (this.sendAlert) {
          await this.sendAlert(
            `⚠️ Catchup live order FAILED\n` +
              `Market: ${question}\nError: ${orderResult.errorMsg}`,
          );
        }
        await this.markProcessed(syntheticId, walletAddress);
        return;
      }

      liveOrderId = orderResult.orderID;
    }

    // Record the trade
    const internalId = uuidv4();
    await PaperTrade.create({
      internal_trade_id: internalId,
      contract_id: tokenId,
      condition_id: conditionId,
      market_slug: slug,
      question,
      direction,
      trade_type: "catchup",
      paper_investment_amount: investmentAmount,
      num_shares: numShares,
      entry_price: currentPrice,
      status: "Open",
      whale_wallet: walletAddress,
      token_id: tokenId,
      opened_at: new Date(),
      is_live: isLive,
      live_order_id: liveOrderId,
    });

    // Deduct from balance
    if (isLive) {
      const realBalance = await liveTrader.getUsdcBalance();
      if (realBalance !== null) {
        system.current_balance = realBalance;
      } else {
        system.current_balance -= investmentAmount;
      }
    } else {
      system.current_balance -= investmentAmount;
    }
    await system.save();

    // Mark as processed (idempotency)
    await this.markProcessed(syntheticId, walletAddress);

    // Notify
    const modeLabel = isLive ? "🔴 LIVE" : "📝 PAPER";
    const priceDiff = currentPrice - whaleEntryPrice;
    const diffLabel =
      priceDiff >= 0
        ? `+${(priceDiff * 100).toFixed(1)}¢`
        : `${(priceDiff * 100).toFixed(1)}¢`;

    const notif =
      `🔄 <b>Catchup Trade Opened!</b> [${modeLabel}]\n` +
      `─────────────────────\n` +
      `📌 Market: ${question}\n` +
      `🎯 Direction: ${direction}\n` +
      `💰 Investment: $${investmentAmount.toFixed(2)}\n` +
      `📊 Entry: ${(currentPrice * 100).toFixed(1)}¢ (whale: ${(whaleEntryPrice * 100).toFixed(1)}¢, diff: ${diffLabel})\n` +
      `🔢 Shares: ${numShares.toFixed(2)}\n` +
      `🔗 Whale: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}\n` +
      (liveOrderId ? `📋 Order ID: ${liveOrderId.slice(0, 12)}…\n` : "") +
      `🆔 Trade: ${internalId.slice(0, 8)}`;

    logger.info(notif);
    if (this.sendAlert) await this.sendAlert(notif);
  }

  // ──────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────

  private async markProcessed(
    syntheticId: string,
    walletAddress: string,
  ): Promise<void> {
    // Use upsert to avoid duplicate key errors if already exists
    await ProcessedSignal.updateOne(
      { polymarket_trade_id: syntheticId },
      {
        $setOnInsert: {
          polymarket_trade_id: syntheticId,
          wallet_address: walletAddress.toLowerCase(),
          timestamp_processed: new Date(),
        },
      },
      { upsert: true },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const catchupService = new CatchupService();
