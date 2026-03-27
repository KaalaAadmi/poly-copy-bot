import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PaperTrade, IPaperTrade } from "../db/models/index.js";
import { polymarketApi } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";

/**
 * PriceMonitor – Watches prices on all open trades and triggers
 * automatic exits when stop-loss or take-profit thresholds are hit.
 *
 * This is the single most impactful profitability improvement:
 * instead of holding every position to binary resolution ($0 or $1),
 * we cut losers early and lock in winners.
 *
 * Runs every 60 seconds (configurable via PRICE_MONITOR_INTERVAL_MS).
 *
 * Thresholds (configurable via env):
 *   STOP_LOSS_THRESHOLD  = 0.30  → exit if price drops 30¢ below entry
 *   TAKE_PROFIT_THRESHOLD = 0.20 → exit if price rises 20¢ above entry
 */
export class PriceMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private sendAlert: ((msg: string) => Promise<void>) | null = null;
  private checkCount = 0;

  setAlertCallback(fn: (msg: string) => Promise<void>): void {
    this.sendAlert = fn;
  }

  start(): void {
    if (!config.priceMonitorEnabled) {
      logger.info("PriceMonitor disabled via PRICE_MONITOR_ENABLED=false");
      return;
    }

    if (this.interval) {
      logger.warn("PriceMonitor already running");
      return;
    }

    const intervalSec = config.priceMonitorIntervalMs / 1000;
    logger.info(
      `PriceMonitor started – checking every ${intervalSec}s ` +
        `(SL: -${(config.stopLossThreshold * 100).toFixed(0)}¢, ` +
        `TP: +${(config.takeProfitThreshold * 100).toFixed(0)}¢)`,
    );

    // Immediate first check, then repeating
    void this.check();
    this.interval = setInterval(
      () => void this.check(),
      config.priceMonitorIntervalMs,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info("PriceMonitor stopped");
    }
  }

  private async check(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const openTrades = await PaperTrade.find({ status: "Open" });
      if (openTrades.length === 0) return;

      this.checkCount++;

      // Log heartbeat every ~5 minutes (5 checks × 60s)
      if (this.checkCount % 5 === 1) {
        logger.debug(
          `PriceMonitor heartbeat: checking ${openTrades.length} open trade(s)`,
        );
      }

      for (const trade of openTrades as IPaperTrade[]) {
        try {
          await this.evaluateTrade(trade);
        } catch (err) {
          logger.error(
            `PriceMonitor error on trade ${trade.internal_trade_id.slice(0, 8)}: ${err}`,
          );
        }

        // Tiny delay to avoid hammering the API
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      logger.error(`PriceMonitor check cycle error: ${err}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async evaluateTrade(trade: IPaperTrade): Promise<void> {
    const tokenId = trade.token_id;
    if (!tokenId) return;

    // Get current price
    let currentPrice = await polymarketApi.getMidpointPrice(tokenId);
    if (currentPrice === null) {
      currentPrice = await polymarketApi.getPrice(tokenId);
    }
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) {
      // Market might be resolved or dead — let marketResolver handle it
      return;
    }

    const entryPrice = trade.entry_price;
    const priceDiff = currentPrice - entryPrice;

    // ── Stop-Loss: price dropped too far below entry ──
    if (priceDiff <= -config.stopLossThreshold) {
      logger.info(
        `🛑 STOP-LOSS triggered: ${trade.question} ` +
          `(entry: ${(entryPrice * 100).toFixed(1)}¢ → current: ${(currentPrice * 100).toFixed(1)}¢, ` +
          `drop: ${(Math.abs(priceDiff) * 100).toFixed(1)}¢ > threshold: ${(config.stopLossThreshold * 100).toFixed(0)}¢)`,
      );
      await this.exitWithReason(trade, currentPrice, "stop-loss");
      return;
    }

    // ── Take-Profit: price rose enough above entry ──
    if (priceDiff >= config.takeProfitThreshold) {
      logger.info(
        `💰 TAKE-PROFIT triggered: ${trade.question} ` +
          `(entry: ${(entryPrice * 100).toFixed(1)}¢ → current: ${(currentPrice * 100).toFixed(1)}¢, ` +
          `gain: ${(priceDiff * 100).toFixed(1)}¢ > threshold: ${(config.takeProfitThreshold * 100).toFixed(0)}¢)`,
      );
      await this.exitWithReason(trade, currentPrice, "take-profit");
      return;
    }
  }

  /**
   * Exit a trade via the risk engine with a reason tag.
   */
  private async exitWithReason(
    trade: IPaperTrade,
    currentPrice: number,
    reason: "stop-loss" | "take-profit",
  ): Promise<void> {
    // Use riskEngine.exitTrade which handles paper + live + balance updates
    // We pass a synthetic "whale activity" so the exit is logged properly
    const syntheticActivity = {
      id: `${reason}:${trade.internal_trade_id}`,
      type: "SELL",
      conditionId: trade.condition_id,
      asset: trade.token_id,
      side: "SELL",
      size: trade.num_shares,
      price: currentPrice,
      usdcSize: currentPrice * trade.num_shares,
      timestamp: Date.now(),
      transactionHash: "",
      title: trade.question,
      slug: trade.market_slug,
    };

    await riskEngine.exitTrade(trade.token_id, syntheticActivity as any);

    // Send a specific alert about the reason
    const emoji = reason === "stop-loss" ? "🛑" : "💰";
    const entryPrice = trade.entry_price;
    const priceDiff = currentPrice - entryPrice;
    const proceeds = currentPrice * trade.num_shares;
    const pnl = proceeds - trade.paper_investment_amount;
    const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;

    const msg =
      `${emoji} <b>${reason === "stop-loss" ? "STOP-LOSS" : "TAKE-PROFIT"} EXIT</b>\n` +
      `─────────────────────\n` +
      `📌 ${trade.question}\n` +
      `📊 Entry: ${(entryPrice * 100).toFixed(1)}¢ → Now: ${(currentPrice * 100).toFixed(1)}¢ ` +
      `(${priceDiff >= 0 ? "+" : ""}${(priceDiff * 100).toFixed(1)}¢)\n` +
      `💰 PnL: <code>${pnlStr}</code>\n` +
      `<i>Automated exit — ${reason === "stop-loss" ? "cutting loss before binary resolution" : "locking in profit"}</i>`;

    if (this.sendAlert) await this.sendAlert(msg);
  }
}

export const priceMonitor = new PriceMonitor();
