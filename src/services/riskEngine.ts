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
  MissedTrade,
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

    // 1b. Minimum whale bet size filter – skip noise trades
    const whaleUsdcSizeRaw = parseFloat(String(activity.usdcSize || "0"));
    if (whaleUsdcSizeRaw < config.minWhaleBetSize) {
      logger.debug(
        `Signal ${tradeId} ignored – whale bet $${whaleUsdcSizeRaw.toFixed(2)} ` +
          `< min $${config.minWhaleBetSize} (noise filter)`,
      );
      await this.markProcessed(tradeId, walletAddress);
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

    // 3. Size calculation  (base: 2% of daily starting balance, scaled by conviction)
    const baseInvestment =
      system.daily_starting_balance * config.positionSizePct;

    // Conviction-weighted sizing: scale based on whale's bet size (USDC)
    const whaleUsdcSize = parseFloat(String(activity.usdcSize || "0"));
    const convictionMultiplier = this.getConvictionMultiplier(whaleUsdcSize);
    const investmentAmount = baseInvestment * convictionMultiplier;

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

      // ── Store as a missed trade for later retry ──
      await this.storeMissedTrade(activity, walletAddress, "copy");

      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // Funds available → reset the suppression flags
    this.insufficientBalanceNotified = false;
    this.exposureLimitNotified = false;

    // 3b. Duplicate position guard – don't open a second trade on the
    // same token if we already have one open.
    const tokenId = activity.asset;
    const existingOpen = await PaperTrade.findOne({
      token_id: tokenId,
      status: "Open",
    });
    if (existingOpen) {
      logger.info(
        `Signal ${tradeId}: already have open trade ${existingOpen.internal_trade_id.slice(0, 8)} ` +
          `on token ${tokenId.slice(0, 12)}… – skipping duplicate`,
      );
      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // 4. Execution – fetch *current* market price from CLOB
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

    // 4b. Entry price filter – skip if price is too high (little upside)
    //     or too low (extreme long-shot)
    if (currentPrice > config.maxEntryPrice) {
      logger.info(
        `Signal ${tradeId} skipped – price ${(currentPrice * 100).toFixed(1)}¢ > max entry ` +
          `${(config.maxEntryPrice * 100).toFixed(0)}¢ (little upside, high downside)`,
      );
      await this.markProcessed(tradeId, walletAddress);
      return;
    }
    if (currentPrice < config.minEntryPrice) {
      logger.info(
        `Signal ${tradeId} skipped – price ${(currentPrice * 100).toFixed(1)}¢ < min entry ` +
          `${(config.minEntryPrice * 100).toFixed(0)}¢ (extreme long-shot)`,
      );
      await this.markProcessed(tradeId, walletAddress);
      return;
    }

    // ── Market metadata ──
    // The Data API activity already includes title, slug, outcome, eventSlug.
    // Use those as the PRIMARY source — they're always correct because they
    // come from the same API that told us about the trade.
    // The Gamma API lookup is unreliable (returns wrong markets on cache miss).
    const conditionId = activity.conditionId ?? "";
    let question = activity.title || "";
    let slug = activity.eventSlug || activity.slug || "";

    // Only fall back to Gamma if the activity didn't include metadata
    let market: GammaMarket | null = null;
    if (!question && conditionId) {
      market = await this.lookupMarket(conditionId);
      if (market) {
        question = market.question;
        slug = market.slug;
      }
    } else if (conditionId) {
      // Still try Gamma for fields we need for live trading (tick_size, neg_risk)
      // but don't trust it for question/slug
      market = await this.lookupMarket(conditionId);
    }

    if (!question) question = "Unknown Market";

    // Build the Polymarket URL — use eventSlug for the event page
    const marketUrl = slug ? `https://polymarket.com/event/${slug}` : "";

    // Notify: whale trade details (what the tracked wallet placed)
    const outcomeLabel = activity.outcome || direction;
    const whaleNotif =
      `🐋 <b>Whale Trade Detected</b>\n` +
      `─────────────────────\n` +
      `👤 Wallet: <code>${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}</code>\n` +
      `📌 Market: ${question}\n` +
      `🎯 Side: ${activity.side || "BUY"} ${outcomeLabel}\n` +
      `💲 Whale Price: ${activity.price || "N/A"}\n` +
      `📦 Whale Size: ${activity.size || "N/A"} shares ($${whaleUsdcSize.toFixed(2)} USDC)\n` +
      (convictionMultiplier > 1
        ? `🔥 Conviction: ${convictionMultiplier}x (whale bet $${whaleUsdcSize.toFixed(0)})\n`
        : "") +
      `🔗 Token: <code>${tokenId.slice(0, 12)}…</code>\n` +
      (marketUrl ? `🌐 ${marketUrl}\n` : "") +
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
    // Fetch event end date from the whale's positions (Data API)
    let eventEndDate: Date | null = null;
    try {
      const endDateStr = await polymarketApi.getTokenEndDate(
        walletAddress,
        tokenId,
      );
      if (endDateStr) {
        const parsed = new Date(endDateStr);
        if (!isNaN(parsed.getTime())) eventEndDate = parsed;
      }
    } catch {
      // Non-critical, proceed without end date
    }

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
      event_end_date: eventEndDate,
      whale_usdc_size: whaleUsdcSize,
      conviction_multiplier: convictionMultiplier,
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
    const convictionLabel =
      convictionMultiplier > 1
        ? `\n🔥 Conviction: ${convictionMultiplier}x (whale: $${whaleUsdcSize.toFixed(0)})`
        : "";
    const notif =
      `✅ <b>Copy Trade Opened!</b> [${modeLabel}]\n` +
      `─────────────────────\n` +
      `📌 Market: ${question}\n` +
      `🎯 Direction: ${direction}\n` +
      `💰 Investment: $${investmentAmount.toFixed(2)}` +
      (convictionMultiplier > 1
        ? ` (base $${baseInvestment.toFixed(2)} × ${convictionMultiplier}x)`
        : "") +
      `\n📊 Entry Price: ${(currentPrice * 100).toFixed(1)}¢\n` +
      `🔢 Shares: ${numShares.toFixed(2)}${convictionLabel}\n` +
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
   * Exit an open trade early because the whale sold the position.
   * Sells at the current market price instead of waiting for binary resolution.
   *
   * @param tokenId – The token ID the whale sold
   * @param whaleActivity – Optional: the whale SELL activity for logging
   */
  async exitTrade(
    tokenId: string,
    whaleActivity?: UserActivity,
  ): Promise<void> {
    const trade = await PaperTrade.findOne({
      token_id: tokenId,
      status: "Open",
    });
    if (!trade) {
      logger.debug(
        `exitTrade: no open trade found for token ${tokenId.slice(0, 12)}…`,
      );
      return;
    }

    // Fetch current market price to determine exit price
    let exitPrice = await polymarketApi.getMidpointPrice(tokenId);
    if (exitPrice === null) {
      exitPrice = await polymarketApi.getPrice(tokenId);
    }
    if (exitPrice === null) {
      // If we can't get a price (market may be closed), use the whale's sell price as fallback
      if (whaleActivity?.price) {
        exitPrice = parseFloat(String(whaleActivity.price));
      }
    }
    if (exitPrice === null || isNaN(exitPrice) || exitPrice < 0) {
      logger.warn(
        `exitTrade: cannot determine exit price for token ${tokenId.slice(0, 12)}… – aborting exit`,
      );
      return;
    }

    const state = await this.getSystemState();
    const isLive = trade.is_live;

    // If live mode, place a real sell order
    let liveSellOrderId = "";
    if (isLive && liveTrader.isReady()) {
      // Look up market metadata for tick size and neg_risk
      let tickSize = "0.01";
      let negRisk = false;
      if (trade.condition_id) {
        const market = await this.lookupMarket(trade.condition_id);
        if (market) {
          tickSize = market.minimum_tick_size ?? "0.01";
          negRisk = market.neg_risk ?? false;
        }
      }

      const sellResult = await liveTrader.placeSellOrder(
        tokenId,
        trade.num_shares,
        exitPrice,
        tickSize,
        negRisk,
      );

      if (!sellResult.success) {
        const msg =
          `⚠️ Live SELL order FAILED for whale-exit on ${trade.question}\n` +
          `Error: ${sellResult.errorMsg}`;
        logger.error(msg);
        if (this.sendAlert) await this.sendAlert(msg);
        // Don't abort — still close the paper record so we don't keep trying
      } else {
        liveSellOrderId = sellResult.orderID;
      }
    }

    // Calculate PnL: (exitPrice × numShares) - investment
    const proceeds = exitPrice * trade.num_shares;
    const pnl = proceeds - trade.paper_investment_amount;

    trade.exit_price = exitPrice;
    trade.pnl = pnl;
    trade.status = "Exited";
    trade.resolved_at = new Date();
    await trade.save();

    // Credit proceeds back to balance
    if (isLive) {
      const realBalance = await liveTrader.getUsdcBalance();
      if (realBalance !== null) {
        state.current_balance = realBalance;
      } else {
        state.current_balance += proceeds;
      }
    } else {
      state.current_balance += proceeds;
    }
    await state.save();

    // Reset suppression flags – balance changed
    this.insufficientBalanceNotified = false;
    this.exposureLimitNotified = false;

    const pnlSign = pnl >= 0 ? "+" : "";
    const modeLabel = isLive ? "🔴 LIVE" : "📝 PAPER";
    const typeLabel = trade.trade_type === "catchup" ? "🔄 Catchup" : "📋 Copy";
    const whaleInfo = whaleActivity
      ? `\n🐋 Whale sold: ${whaleActivity.size || "?"} @ ${whaleActivity.price || "?"}`
      : "";

    const msg =
      `🚪 <b>Trade Exited – Whale Sold</b> [${modeLabel}] [${typeLabel}]\n` +
      `─────────────────────\n` +
      `📌 Market: ${trade.question}\n` +
      `🎯 Direction: ${trade.direction}\n` +
      `💲 Entry: ${(trade.entry_price * 100).toFixed(1)}¢ → Exit: ${(exitPrice * 100).toFixed(1)}¢\n` +
      `🔢 Shares: ${trade.num_shares.toFixed(2)}\n` +
      `💰 Investment: $${trade.paper_investment_amount.toFixed(2)}\n` +
      `📈 PnL: <code>${pnlSign}$${pnl.toFixed(2)}</code>\n` +
      (!isLive ? `💼 Balance: $${state.current_balance.toFixed(2)}\n` : "") +
      whaleInfo +
      `\n🔗 Whale: ${trade.whale_wallet.slice(0, 6)}…${trade.whale_wallet.slice(-4)}` +
      (liveSellOrderId
        ? `\n📋 Sell Order: ${liveSellOrderId.slice(0, 12)}…`
        : "") +
      `\n🆔 Trade: ${trade.internal_trade_id.slice(0, 8)}`;

    logger.info(msg);
    if (this.sendAlert) await this.sendAlert(msg);
  }

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

    // ── After resolution, try to execute any missed trades ──
    // Balance may have freed up (especially on wins or partial losses).
    await this.retryMissedTrades();
  }

  // ──────────────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────────────

  /**
   * Calculate the conviction multiplier based on the whale's bet size (USDC).
   * Larger bets signal higher conviction → we scale up our position.
   *
   * Tiers are defined in config.convictionTiers (sorted ascending by min).
   * The highest matching tier wins. Capped by config.convictionMaxMultiplier.
   */
  getConvictionMultiplier(whaleUsdcSize: number): number {
    if (!config.convictionSizingEnabled || whaleUsdcSize <= 0) return 1;

    const tiers = [...config.convictionTiers].sort((a, b) => a.min - b.min);
    let multiplier = 1;

    for (const tier of tiers) {
      if (whaleUsdcSize >= tier.min) {
        multiplier = tier.multiplier;
      } else {
        break; // tiers are sorted ascending, no need to check further
      }
    }

    return Math.min(multiplier, config.convictionMaxMultiplier);
  }

  // ──────────────────────────────────────────────────────
  // Missed Trades – store / retry / cleanup
  // ──────────────────────────────────────────────────────

  /**
   * Store a missed trade when we don't have enough balance to copy it.
   * These will be retried once funds become available (after resolution).
   */
  private async storeMissedTrade(
    activity: UserActivity,
    walletAddress: string,
    tradeType: "copy" | "catchup",
  ): Promise<void> {
    const signalId = activity.id || activity.transactionHash;
    const direction = this.inferDirection(activity);
    const whaleEntryPrice = parseFloat(String(activity.price || "0"));
    const whaleUsdcSize = parseFloat(String(activity.usdcSize || "0"));

    // Don't store duplicates
    const existing = await MissedTrade.findOne({ signal_id: signalId });
    if (existing) return;

    // Don't store if we already have a trade (open or resolved) on this token
    const existingTrade = await PaperTrade.findOne({
      token_id: activity.asset,
    });
    if (existingTrade) return;

    await MissedTrade.create({
      signal_id: signalId,
      whale_wallet: walletAddress.toLowerCase(),
      token_id: activity.asset,
      condition_id: activity.conditionId || "",
      question: activity.title || "Unknown Market",
      market_slug: activity.eventSlug || activity.slug || "",
      direction,
      whale_entry_price: whaleEntryPrice,
      whale_usdc_size: whaleUsdcSize,
      trade_type: tradeType,
      status: "pending",
      missed_at: new Date(),
      original_activity: activity as unknown as Record<string, unknown>,
    });

    logger.info(
      `📝 Missed trade stored: ${activity.title || activity.asset?.slice(0, 12)} ` +
        `(whale entry: ${(whaleEntryPrice * 100).toFixed(1)}¢, $${whaleUsdcSize.toFixed(2)} USDC)`,
    );
  }

  /**
   * After a trade resolves (freeing up balance), check if any pending
   * missed trades can now be executed.
   *
   * For each pending missed trade:
   *   1. Check if we have enough balance
   *   2. Check if current price ≤ whale_entry_price + slippage
   *   3. If yes → execute the trade and mark as "executed"
   *   4. If no → leave it pending (will be cleaned up after 24h)
   */
  async retryMissedTrades(): Promise<void> {
    const pendingMissed = await MissedTrade.find({ status: "pending" }).sort({
      missed_at: 1,
    }); // oldest first (FIFO)

    if (pendingMissed.length === 0) return;

    logger.info(
      `🔄 Checking ${pendingMissed.length} missed trade(s) for retry…`,
    );

    const system = await this.getSystemState();

    for (const missed of pendingMissed) {
      // Re-check balance each iteration (it changes as we execute trades)
      const freshState = await this.getSystemState();

      const baseInvestment =
        freshState.daily_starting_balance * config.positionSizePct;
      const convictionMultiplier = this.getConvictionMultiplier(
        missed.whale_usdc_size,
      );
      const investmentAmount = baseInvestment * convictionMultiplier;

      // Not enough balance → stop trying (remaining trades need even more or same)
      if (investmentAmount - freshState.current_balance > 0.005) {
        logger.debug(
          `Missed trade retry: insufficient balance for ${missed.question?.slice(0, 30)}… ` +
            `(need $${investmentAmount.toFixed(2)}, have $${freshState.current_balance.toFixed(2)})`,
        );
        continue;
      }

      // Check if we already have an open trade on this token
      const existingOpen = await PaperTrade.findOne({
        token_id: missed.token_id,
        status: "Open",
      });
      if (existingOpen) {
        // Already have a position — mark this missed trade as done
        missed.status = "executed";
        missed.resolved_at = new Date();
        await missed.save();
        continue;
      }

      // Get current market price
      let currentPrice = await polymarketApi.getMidpointPrice(missed.token_id);
      if (currentPrice === null) {
        currentPrice = await polymarketApi.getPrice(missed.token_id);
      }
      if (currentPrice === null || currentPrice <= 0 || currentPrice >= 1) {
        logger.debug(
          `Missed trade retry: invalid price for ${missed.token_id.slice(0, 12)}… – skipping`,
        );
        continue;
      }

      // Entry price filter: same as processSignal
      if (currentPrice > config.maxEntryPrice) {
        logger.debug(
          `Missed trade retry: price ${(currentPrice * 100).toFixed(1)}¢ > max ` +
            `${(config.maxEntryPrice * 100).toFixed(0)}¢ for ${missed.question?.slice(0, 30)}… – skipping`,
        );
        continue;
      }
      if (currentPrice < config.minEntryPrice) {
        logger.debug(
          `Missed trade retry: price ${(currentPrice * 100).toFixed(1)}¢ < min ` +
            `${(config.minEntryPrice * 100).toFixed(0)}¢ for ${missed.question?.slice(0, 30)}… – skipping`,
        );
        continue;
      }

      // Slippage check: current price must be ≤ whale's entry + slippage
      const slippage = config.catchupMaxSlippage;
      if (currentPrice > missed.whale_entry_price + slippage) {
        const diff = currentPrice - missed.whale_entry_price;
        logger.debug(
          `Missed trade retry: price too high for ${missed.question?.slice(0, 30)}… ` +
            `(current: ${(currentPrice * 100).toFixed(1)}¢, whale: ${(missed.whale_entry_price * 100).toFixed(1)}¢, ` +
            `diff: +${(diff * 100).toFixed(1)}¢ > limit: ${(slippage * 100).toFixed(1)}¢)`,
        );
        continue;
      }

      // ── Execute the trade ──
      logger.info(
        `✅ Missed trade retry: executing ${missed.question} ` +
          `(current: ${(currentPrice * 100).toFixed(1)}¢, whale: ${(missed.whale_entry_price * 100).toFixed(1)}¢)`,
      );

      // Reconstruct the activity object for processSignal
      const syntheticActivity: UserActivity = {
        id: missed.signal_id + ":retry",
        type: "TRADE",
        conditionId: missed.condition_id,
        asset: missed.token_id,
        side: "BUY",
        size: 0,
        price: missed.whale_entry_price,
        usdcSize: missed.whale_usdc_size,
        timestamp: Date.now(),
        transactionHash: missed.signal_id + ":retry",
        title: missed.question,
        slug: missed.market_slug,
        eventSlug: missed.market_slug,
        outcomeIndex: missed.direction === "Yes" ? 0 : 1,
        outcome: missed.direction,
      };

      await this.processSignal(syntheticActivity, missed.whale_wallet);

      // Mark as executed
      missed.status = "executed";
      missed.resolved_at = new Date();
      await missed.save();

      // Small delay between retries
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * FIFO cleanup: delete pending missed trades older than 24 hours.
   * Called periodically (e.g., from the daily reset cron or a separate interval).
   */
  async cleanupExpiredMissedTrades(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const expired = await MissedTrade.find({
      status: "pending",
      missed_at: { $lt: cutoff },
    }).sort({ missed_at: 1 }); // FIFO: oldest first

    if (expired.length === 0) return;

    logger.info(
      `🗑 Cleaning up ${expired.length} expired missed trade(s) (>24h old)`,
    );

    for (const trade of expired) {
      trade.status = "expired";
      trade.resolved_at = new Date();
      await trade.save();
    }

    if (this.sendAlert) {
      await this.sendAlert(
        `🗑 Cleaned up ${expired.length} expired missed trade(s) (older than 24h)`,
      );
    }
  }

  private inferDirection(activity: UserActivity): "Yes" | "No" {
    // Use the outcome field from the Data API if available — it tells us
    // exactly which outcome the whale bought (e.g. "Knicks", "Yes", "Over").
    // For binary markets, outcomeIndex 0 = Yes, 1 = No.
    if (activity.outcomeIndex !== undefined) {
      return activity.outcomeIndex === 0 ? "Yes" : "No";
    }
    // Fallback: infer from side
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
