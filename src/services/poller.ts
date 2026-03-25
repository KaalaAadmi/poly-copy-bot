import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { TrackedWallet, PaperTrade } from "../db/models/index.js";
import { polymarketApi, UserActivity } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";

/**
 * The Poller – Wallet Tracker.
 *
 * Queries the Polymarket Data API on a configurable interval to fetch
 * recent activity of all tracked wallets. New trades are forwarded to
 * the Risk Engine for processing.
 *
 * Uses a high-water-mark per wallet (latest seen timestamp) to avoid
 * re-processing old activity entries.
 */
export class Poller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  /**
   * High-water marks: walletAddress → latest processed timestamp.
   * Prevents re-processing old trades across polling cycles.
   */
  private highWaterMarks: Map<string, number> = new Map();

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.interval) {
      logger.warn("Poller is already running");
      return;
    }

    logger.info(`Starting Poller – interval ${config.pollIntervalMs / 1000}s`);

    // Immediate first poll, then repeating
    void this.poll();
    this.interval = setInterval(() => void this.poll(), config.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info("Poller stopped");
    }
  }

  /**
   * Track poll count so we log a heartbeat periodically (not every cycle).
   */
  private pollCount = 0;

  /**
   * Single polling cycle.
   */
  private async poll(): Promise<void> {
    if (this.isRunning) {
      logger.debug("Poller cycle skipped – previous cycle still running");
      return;
    }

    this.isRunning = true;

    try {
      const wallets = await TrackedWallet.find({ active_status: true });

      if (wallets.length === 0) {
        logger.info(
          "Poller: no active wallets to track (add one with /addwallet)",
        );
        return;
      }

      logger.debug(`Poller: polling ${wallets.length} wallet(s)…`);
      this.pollCount++;

      // Log a heartbeat every ~5 minutes (25 cycles × 12s = 300s) so
      // the operator knows the poller is still alive without log spam.
      if (this.pollCount % 25 === 1) {
        logger.info(
          `Poller heartbeat: cycle #${this.pollCount}, tracking ${wallets.length} wallet(s)`,
        );
      }

      for (const wallet of wallets) {
        try {
          await this.pollWallet(wallet.wallet_address);
        } catch (err) {
          logger.error(`Error polling wallet ${wallet.wallet_address}: ${err}`);
        }

        // Small delay between wallets to respect rate limits
        await this.sleep(1000);
      }
    } catch (err) {
      logger.error(`Poller cycle error: ${err}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Poll a single wallet for new trading activity.
   */
  private async pollWallet(address: string): Promise<void> {
    const hwm = this.highWaterMarks.get(address) || 0;

    // Pass HWM as sinceTimestamp so the API client stops paginating
    // once it reaches activities we've already seen. On the first poll
    // (hwm=0), this fetches ALL history to set the correct HWM.
    const activities = await polymarketApi.getUserActivity(address, hwm);

    logger.debug(
      `Poller [${address.slice(0, 8)}…]: API returned ${activities?.length ?? 0} activity item(s)`,
    );

    if (!activities || activities.length === 0) return;

    // Log the first activity for debugging API response shape
    if (activities.length > 0 && !this.highWaterMarks.has(address)) {
      logger.info(
        `Poller [${address.slice(0, 8)}…]: sample activity keys: ${Object.keys(activities[0]).join(", ")}`,
      );
      logger.info(
        `Poller [${address.slice(0, 8)}…]: sample activity: ${JSON.stringify(activities[0]).slice(0, 500)}`,
      );
    }

    // Filter to only TRADE-type activities
    const trades = activities.filter(
      (a) =>
        (a.type || "").toUpperCase() === "TRADE" ||
        (a.type || "").toUpperCase() === "BUY" ||
        (a.type || "").toUpperCase() === "SELL",
    );

    logger.debug(
      `Poller [${address.slice(0, 8)}…]: ${trades.length} trade-type activity(ies) out of ${activities.length}`,
    );

    if (trades.length === 0) {
      // Log all types we received to help debug
      const types = [...new Set(activities.map((a) => a.type || "undefined"))];
      logger.debug(
        `Poller [${address.slice(0, 8)}…]: non-trade activity types seen: ${types.join(", ")}`,
      );
      return;
    }

    const isFirstPoll = hwm === 0;

    // Sort by timestamp ascending so we process oldest first
    const newTrades = trades
      .filter((t) => (t.timestamp || 0) > hwm)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (newTrades.length === 0) {
      logger.debug(
        `Poller [${address.slice(0, 8)}…]: 0 new trades above HWM ${hwm}`,
      );
      return;
    }

    // On the FIRST poll for this wallet, we only set the high-water mark to
    // "catch up" with history. We don't process these as copy signals because
    // the catchup service handles existing positions separately.
    if (isFirstPoll) {
      const latestTs = Math.max(...newTrades.map((t) => t.timestamp || 0));
      this.highWaterMarks.set(address, latestTs);
      logger.info(
        `Poller [${address.slice(0, 8)}…]: first poll – set HWM to ${latestTs} ` +
          `(skipped ${newTrades.length} historical trade(s))`,
      );
      return;
    }

    logger.info(
      `Found ${newTrades.length} new trade(s) from ${address.slice(0, 8)}…`,
    );

    for (const trade of newTrades) {
      // Log whale trade details so we know exactly what the tracked wallet did
      logger.info(
        `🐋 Whale trade detected:\n` +
          `  Wallet: ${address}\n` +
          `  Type: ${trade.type} | Side: ${trade.side}\n` +
          `  Token: ${trade.asset}\n` +
          `  Condition: ${trade.conditionId || "N/A"}\n` +
          `  Size: ${trade.size} | Price: ${trade.price}\n` +
          `  TxHash: ${trade.transactionHash || "N/A"}`,
      );

      const side = (trade.side || "").toUpperCase();

      if (side === "SELL") {
        // ── Whale EXIT detection ──
        // Check if we have an open trade on the same token
        const openTrade = await PaperTrade.findOne({
          token_id: trade.asset,
          status: "Open",
          whale_wallet: address.toLowerCase(),
        });

        if (openTrade) {
          logger.info(
            `🚪 Whale SELL detected on token ${trade.asset.slice(0, 12)}… ` +
              `– we have open trade ${openTrade.internal_trade_id.slice(0, 8)} – triggering exit`,
          );
          await riskEngine.exitTrade(trade.asset, trade);
        } else {
          logger.debug(
            `Whale SELL on token ${trade.asset.slice(0, 12)}… – no matching open trade, ignoring`,
          );
        }
      } else {
        // ── Whale BUY – standard copy-trade flow ──
        await riskEngine.processSignal(trade, address);
      }
    }

    // Update high-water mark
    const latestTs = Math.max(...newTrades.map((t) => t.timestamp || 0));
    if (latestTs > hwm) {
      this.highWaterMarks.set(address, latestTs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const poller = new Poller();
