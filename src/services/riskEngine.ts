import crypto from "crypto";

function uuidv4(): string {
  return crypto.randomUUID();
}
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  SystemState,
  ProcessedSignal,
  PaperTrade,
} from "../db/models/index.js";
import { polymarketApi, UserActivity, GammaMarket } from "./polymarketApi.js";
import { liveTrader } from "./liveTrader.js";

/**
 * The Risk & Execution Engine.
 *
 * When the Poller detects a new whale trade, this engine processes it
 * through the following pipeline:
 *   1. Idempotency check  – skip if trade_id already processed
 *   2. Exposure check     – skip if daily exposure limit exceeded
 *   3. Size calculation   – 2% of daily starting balance
 *   4. Execution (paper)  – fetch current market price, record trade
 *   5. Logging            – store in PaperTrades + ProcessedSignals
 */
export class RiskEngine {
  private sendAlert: ((msg: string) => Promise<void>) | null = null;

  /**
   * Tracks whether we've already notified about insufficient balance.
   * Once set, subsequent "insufficient balance" signals are logged at
   * debug level only (no Telegram spam). Reset when balance is
   * replenished via trade resolution or daily reset.
   */
  private insufficientBalanceNotified = false;

  /**
   * Tracks whether we've already notified about daily exposure limit.
   * Same logic – notify once, then go quiet until the next day.
   */
  private exposureLimitNotified = false;

  /**
   * Attach a Telegram alert callback so the engine can send messages.
   */
  setAlertCallback(fn: (msg: string) => Promise<void>): void {
    this.sendAlert = fn;
  }

  // ──────────────────────────────────────────────────────
  // Main entry – process a detected whale trade signal
  // ──────────────────────────────────────────────────────

  async processSignal(
    activity: UserActivity,
    walletAddress: string,
  ): Promise<void> {
    const tradeId = activity.id || activity.transactionHash;

    // 1. Idempotency check
    const exists = await ProcessedSignal.findOne({
      polymarket_trade_id: tradeId,
    });
    if (exists) {
      logger.debug(`Signal ${tradeId} already processed – skipping.`);
      return;
    }

    // 2. Exposure check
    const system = await this.getSystemState();
    const todayExposure = await this.getTodayExposure();
    const maxExposure = system.daily_starting_balance * config.dailyMaxExposure;

    if (todayExposure >= maxExposure) {
      if (!this.exposureLimitNotified) {
        this.exposureLimitNotified = true;
        const msg = `⚠️ Signal ignored: Daily exposure limit reached.\nDeployed today: $${todayExposure.toFixed(2)} / $${maxExposure.toFixed(2)}\n<i>(Further signals will be logged silently until reset)</i>`;
        logger.warn(msg);
        if (this.sendAlert) await this.sendAlert(msg);
      } else {
        logger.debug(
          `Signal ${tradeId} ignored – daily exposure limit (${todayExposure.toFixed(2)} / ${maxExposure.toFixed(2)})`,
        );
      }
      // Still mark as processed so we don't re-alert
      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // 3. Size calculation  (2 % of daily starting balance)
    const investmentAmount =
      system.daily_starting_balance * config.positionSizePct;

    // Check we have enough liquid balance (small epsilon to avoid
    // floating-point edge cases like 2.150000001 > 2.15)
    if (investmentAmount - system.current_balance > 0.005) {
      if (!this.insufficientBalanceNotified) {
        this.insufficientBalanceNotified = true;
        const openCount = await PaperTrade.countDocuments({ status: "Open" });
        const msg =
          `⚠️ Signal ignored: Insufficient balance.\n` +
          `Needed: $${investmentAmount.toFixed(2)} | Available: $${system.current_balance.toFixed(2)}\n` +
          `📊 ${openCount} open trade(s) — waiting for resolutions to free up funds.\n` +
          `<i>(Further signals will be logged silently until balance is replenished)</i>`;
        logger.warn(msg);
        if (this.sendAlert) await this.sendAlert(msg);
      } else {
        logger.debug(
          `Signal ${tradeId} ignored – insufficient balance ` +
            `(need $${investmentAmount.toFixed(2)}, have $${system.current_balance.toFixed(2)})`,
        );
      }
      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // Funds available → reset the suppression flags
    this.insufficientBalanceNotified = false;
    this.exposureLimitNotified = false;

    // 4. Execution – fetch *current* market price from CLOB
    const tokenId = activity.asset;
    const direction = this.inferDirection(activity);
    let currentPrice = await polymarketApi.getMidpointPrice(tokenId);
    if (currentPrice === null) {
      currentPrice = await polymarketApi.getPrice(tokenId);
    }
    if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) {
      logger.warn(
        `Invalid price for token ${tokenId} – skipping signal ${tradeId}`,
      );
      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // Look up market metadata from Gamma
    const market = await this.lookupMarket(activity.conditionId);
    const question = market?.question ?? "Unknown Market";
    const slug = market?.slug ?? "";
    const conditionId = activity.conditionId ?? "";

    // Notify: whale trade details (what the tracked wallet placed)
    const whaleNotif =
      `🐋 <b>Whale Trade Detected</b>\n` +
      `─────────────────────\n` +
      `👤 Wallet: <code>${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}</code>\n` +
      `📌 Market: ${question}\n` +
      `🎯 Side: ${activity.side || "BUY"} ${direction}\n` +
      `💲 Whale Price: ${activity.price || "N/A"}\n` +
      `📦 Whale Size: ${activity.size || "N/A"}\n` +
      `🔗 Token: <code>${tokenId.slice(0, 12)}…</code>\n` +
      (slug ? `🌐 https://polymarket.com/event/${slug}\n` : "") +
      `⏱ Processing copy-trade…`;

    logger.info(
      `Whale trade: ${walletAddress} → ${question} (${activity.side} ${direction})`,
    );
    if (this.sendAlert) await this.sendAlert(whaleNotif);

    // Calculate the number of shares: investment / price-per-share
    // On Polymarket each share pays $1 if correct, so price IS the cost per share.
    const numShares = investmentAmount / currentPrice;

    // Determine if we're in live mode
    const isLive = system.live_mode && liveTrader.isReady();
    let liveOrderId = "";

    // If live mode, place a real order on Polymarket
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
        const msg =
          `⚠️ Live order FAILED for signal ${tradeId}\n` +
          `Error: ${orderResult.errorMsg}`;
        logger.error(msg);
        if (this.sendAlert) await this.sendAlert(msg);
        await this.markProcessed(tradeId, walletAddress);
        return;
      }

      liveOrderId = orderResult.orderID;
    }

    // 5. Log the trade
    const internalId = uuidv4();
    await PaperTrade.create({
      internal_trade_id: internalId,
      contract_id: tokenId,
      condition_id: conditionId,
      market_slug: slug,
      question,
      direction,
      trade_type: "copy",
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

    // Deduct from current balance
    if (isLive) {
      // For live trades, re-sync from Polymarket so the internal ledger
      // reflects the actual on-chain balance after the order.
      const realBalance = await liveTrader.getUsdcBalance();
      if (realBalance !== null) {
        system.current_balance = realBalance;
      } else {
        // Fallback: optimistically deduct
        system.current_balance -= investmentAmount;
      }
    } else {
      system.current_balance -= investmentAmount;
    }
    await system.save();

    // Mark signal processed
    await this.markProcessed(tradeId, walletAddress);

    // Notify via Telegram
    const modeLabel = isLive ? "🔴 LIVE" : "📝 PAPER";
    const notif =
      `� <b>Copy Trade Opened!</b> [${modeLabel}]\n` +
      `─────────────────────\n` +
      `📌 Market: ${question}\n` +
      `🎯 Direction: ${direction}\n` +
      `💰 Investment: $${investmentAmount.toFixed(2)}\n` +
      `📊 Entry Price: ${(currentPrice * 100).toFixed(1)}¢\n` +
      `🔢 Shares: ${numShares.toFixed(2)}\n` +
      `🔗 Whale: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}\n` +
      (liveOrderId ? `📋 Order ID: ${liveOrderId.slice(0, 12)}…\n` : "") +
      `🆔 Trade: ${internalId.slice(0, 8)}`;

    logger.info(notif);
    if (this.sendAlert) await this.sendAlert(notif);
  }

  // ──────────────────────────────────────────────────────
  // System state helpers
  // ──────────────────────────────────────────────────────

  /**
   * Get or initialise the global SystemState document.
   */
  async getSystemState() {
    let state = await SystemState.findOne();
    if (!state) {
      state = await SystemState.create({
        current_balance: config.initialBalance,
        daily_starting_balance: config.initialBalance,
        initial_balance: config.initialBalance,
        last_daily_reset: new Date(),
      });
      logger.info(
        `Initialised SystemState with balance $${config.initialBalance}`,
      );
    }
    return state;
  }

  /**
   * Calculate total capital deployed in open trades opened today (UTC).
   */
  async getTodayExposure(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const todayTrades = await PaperTrade.find({
      status: "Open",
      opened_at: { $gte: startOfDay },
    });

    return todayTrades.reduce(
      (sum: number, t: { paper_investment_amount: number }) =>
        sum + t.paper_investment_amount,
      0,
    );
  }

  /**
   * Snapshot the daily starting balance at midnight UTC.
   * Should be called by a cron job at 00:00 UTC.
   */
  async resetDailyBalance(): Promise<void> {
    const state = await this.getSystemState();
    state.daily_starting_balance = state.current_balance;
    state.last_daily_reset = new Date();
    await state.save();

    // New day → reset suppression flags
    this.insufficientBalanceNotified = false;
    this.exposureLimitNotified = false;

    logger.info(
      `Daily balance reset. Starting balance: $${state.daily_starting_balance.toFixed(2)}`,
    );
    if (this.sendAlert) {
      await this.sendAlert(
        `🔄 Daily Reset\nStarting balance: $${state.daily_starting_balance.toFixed(2)}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────
  // Trade resolution
  // ──────────────────────────────────────────────────────

  /**
   * Resolve an open paper trade.
   * Called when the underlying market resolves.
   *
   * @param tradeId – internal_trade_id
   * @param won – whether the bet was won
   */
  async resolveTrade(tradeId: string, won: boolean): Promise<void> {
    const trade = await PaperTrade.findOne({ internal_trade_id: tradeId });
    if (!trade || trade.status !== "Open") return;

    const state = await this.getSystemState();
    const isLive = trade.is_live;

    if (won) {
      // Each share pays $1 on a correct outcome
      const payout = trade.num_shares * 1; // num_shares × $1
      trade.pnl = payout - trade.paper_investment_amount;
      trade.exit_price = 1;
      trade.status = "Resolved_Won";

      if (isLive) {
        // For live trades the real payout happens on Polymarket.
        // Re-sync the internal balance from Polymarket so it stays accurate.
        const realBalance = await liveTrader.getUsdcBalance();
        if (realBalance !== null) {
          state.current_balance = realBalance;
        } else {
          // Fallback: optimistically credit the payout to the internal ledger
          state.current_balance += payout;
        }
      } else {
        state.current_balance += payout;
      }
    } else {
      // Shares are worthless – entire investment is lost
      trade.pnl = -trade.paper_investment_amount;
      trade.exit_price = 0;
      trade.status = "Resolved_Lost";

      if (isLive) {
        // Re-sync from Polymarket
        const realBalance = await liveTrader.getUsdcBalance();
        if (realBalance !== null) {
          state.current_balance = realBalance;
        }
        // If we can't fetch, the balance was already deducted on open — no further change needed
      }
      // For paper: balance was already deducted on open, nothing to add back
    }

    trade.resolved_at = new Date();
    await trade.save();
    await state.save();

    // Balance changed – reset suppression flags so the next signal
    // gets a fresh check (and a Telegram alert if still insufficient).
    this.insufficientBalanceNotified = false;
    this.exposureLimitNotified = false;

    const emoji = won ? "✅" : "❌";
    const modeLabel = isLive ? "🔴 LIVE" : "📝 PAPER";
    const typeLabel = trade.trade_type === "catchup" ? "🔄 Catchup" : "📋 Copy";
    const pnlSign = trade.pnl >= 0 ? "+" : "";
    const msg =
      `${emoji} <b>Trade Resolved – ${won ? "WON" : "LOST"}</b> [${modeLabel}] [${typeLabel}]\n` +
      `─────────────────────\n` +
      `📌 Market: ${trade.question}\n` +
      `🎯 Direction: ${trade.direction}\n` +
      `� Entry: ${(trade.entry_price * 100).toFixed(1)}¢ → Exit: ${(trade.exit_price! * 100).toFixed(1)}¢\n` +
      `🔢 Shares: ${trade.num_shares.toFixed(2)}\n` +
      `�💰 Investment: $${trade.paper_investment_amount.toFixed(2)}\n` +
      `📈 PnL: <code>${pnlSign}$${trade.pnl.toFixed(2)}</code>\n` +
      (!isLive ? `💼 Balance: $${state.current_balance.toFixed(2)}\n` : "") +
      `🔗 Whale: ${trade.whale_wallet.slice(0, 6)}…${trade.whale_wallet.slice(-4)}\n` +
      (trade.live_order_id
        ? `📋 Order: ${trade.live_order_id.slice(0, 12)}…\n`
        : "") +
      `🆔 Trade: ${trade.internal_trade_id.slice(0, 8)}`;

    logger.info(msg);
    if (this.sendAlert) await this.sendAlert(msg);
  }

  // ──────────────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────────────

  private inferDirection(activity: UserActivity): "Yes" | "No" {
    // The token at index 0 in clobTokenIds is the "Yes" token
    // If the user is buying, direction matches the side. If selling, it's the opposite.
    const side = (activity.side || "BUY").toUpperCase();
    if (side === "BUY") return "Yes";
    return "No";
  }

  private async markProcessed(
    tradeId: string,
    walletAddress: string,
  ): Promise<void> {
    await ProcessedSignal.create({
      polymarket_trade_id: tradeId,
      wallet_address: walletAddress,
      timestamp_processed: new Date(),
    });
  }

  private async lookupMarket(conditionId: string): Promise<GammaMarket | null> {
    if (!conditionId) return null;
    return polymarketApi.getMarketByConditionId(conditionId);
  }
}

export const riskEngine = new RiskEngine();
