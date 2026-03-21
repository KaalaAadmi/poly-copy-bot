import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { TrackedWallet } from "../db/models/index.js";
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
    this.poll();
    this.interval = setInterval(() => this.poll(), config.pollIntervalMs);
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
        logger.debug("No wallets to track");
        return;
      }

      logger.debug(`Polling ${wallets.length} wallet(s)…`);

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
    const activities = await polymarketApi.getUserActivity(address);

    if (!activities || activities.length === 0) return;

    // Filter to only TRADE-type activities
    const trades = activities.filter(
      (a) =>
        (a.type || "").toUpperCase() === "TRADE" ||
        (a.type || "").toUpperCase() === "BUY" ||
        (a.type || "").toUpperCase() === "SELL",
    );

    if (trades.length === 0) return;

    const hwm = this.highWaterMarks.get(address) || 0;

    // Sort by timestamp ascending so we process oldest first
    const newTrades = trades
      .filter((t) => (t.timestamp || 0) > hwm)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (newTrades.length === 0) return;

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

      await riskEngine.processSignal(trade, address);
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
