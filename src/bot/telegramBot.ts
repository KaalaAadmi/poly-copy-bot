import { Telegraf, Context } from "telegraf";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  SystemState,
  TrackedWallet,
  PaperTrade,
  IPaperTrade,
} from "../db/models/index.js";
import { riskEngine } from "../services/riskEngine.js";
import { liveTrader } from "../services/liveTrader.js";
import { catchupService } from "../services/catchupService.js";

/**
 * Telegram Bot – The sole user interface.
 *
 * Commands:
 *   /balance      – Initial, daily starting, and current liquid balance
 *   /pnl          – Profit & Loss (all-time, monthly, daily)
 *   /activebets   – All open paper trades
 *   /history      – Last 10 resolved trades
 *   /addwallet    – Add a new wallet to track
 *   /removewallet – Remove a wallet from tracking
 *   /wallets      – List all tracked wallets
 *   /help         – Show available commands
 */
export class TelegramBot {
  private bot: Telegraf;

  constructor() {
    this.bot = new Telegraf(config.telegramBotToken);
    this.registerCommands();
  }

  // ──────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────

  async launch(): Promise<void> {
    // Wire up the Telegram alert callback in the Risk Engine
    riskEngine.setAlertCallback((msg) => this.sendAlert(msg));

    // Wire up the Telegram alert callback in the Catchup Service
    catchupService.setAlertCallback((msg) => this.sendAlert(msg));

    logger.info("Telegraf: calling bot.launch()…");
    await this.bot.launch({
      dropPendingUpdates: true, // Don't process old messages on restart
    });
    logger.info("Telegraf: bot.launch() resolved – long-polling active");

    process.once("SIGINT", () => this.bot.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
  }

  /**
   * Send a message to the configured chat (alerts / notifications).
   */
  async sendAlert(message: string): Promise<void> {
    try {
      if (config.telegramChatId) {
        await this.bot.telegram.sendMessage(config.telegramChatId, message, {
          parse_mode: "HTML",
        });
      }
    } catch (err) {
      logger.error(`Failed to send Telegram alert: ${err}`);
    }
  }

  // ──────────────────────────────────────────────────────
  // Command registration
  // ──────────────────────────────────────────────────────

  private registerCommands(): void {
    this.bot.start((ctx) =>
      ctx.reply(
        "🤖 <b>Poly-Bot</b> – Polymarket Copy-Trading Bot\n\n" +
          "Use /help to see all available commands.",
        { parse_mode: "HTML" },
      ),
    );

    this.bot.command("help", (ctx) => this.handleHelp(ctx));
    this.bot.command("balance", (ctx) => this.handleBalance(ctx));
    this.bot.command("pnl", (ctx) => this.handlePnl(ctx));
    this.bot.command("activebets", (ctx) => this.handleActiveBets(ctx));
    this.bot.command("history", (ctx) => this.handleHistory(ctx));
    this.bot.command("addwallet", (ctx) => this.handleAddWallet(ctx));
    this.bot.command("removewallet", (ctx) => this.handleRemoveWallet(ctx));
    this.bot.command("wallets", (ctx) => this.handleWallets(ctx));

    // Live trading commands
    this.bot.command("golive", (ctx) => this.handleGoLive(ctx));
    this.bot.command("gopaper", (ctx) => this.handleGoPaper(ctx));
    this.bot.command("mode", (ctx) => this.handleMode(ctx));
    this.bot.command("livepnl", (ctx) => this.handleLivePnl(ctx));

    // Catch-all
    this.bot.on("text", (ctx) =>
      ctx.reply("Unknown command. Use /help to see available commands."),
    );
  }

  // ──────────────────────────────────────────────────────
  // /help
  // ──────────────────────────────────────────────────────

  private async handleHelp(ctx: Context): Promise<void> {
    const text =
      `📖 <b>Poly-Bot Commands</b>\n\n` +
      `<b>Portfolio</b>\n` +
      `/balance – View balances (initial, daily start, current)\n` +
      `/pnl – View Profit & Loss (all-time, monthly, daily)\n` +
      `/activebets – View all open paper trades\n` +
      `/history – View last 10 resolved trades\n\n` +
      `<b>Live Trading</b>\n` +
      `/golive – Switch to live trading (real orders on Polymarket)\n` +
      `/gopaper – Switch back to paper trading\n` +
      `/mode – Show current trading mode\n` +
      `/livepnl – Fetch real PnL from Polymarket positions\n\n` +
      `<b>Configuration</b>\n` +
      `/addwallet [address] – Track a new whale wallet\n` +
      `/removewallet [address] – Stop tracking a wallet\n` +
      `/wallets – List all tracked wallets\n` +
      `/help – Show this message`;

    await ctx.reply(text, { parse_mode: "HTML" });
  }

  // ──────────────────────────────────────────────────────
  // /balance
  // ──────────────────────────────────────────────────────

  private async handleBalance(ctx: Context): Promise<void> {
    try {
      const state = await riskEngine.getSystemState();

      // Calculate liquid balance = current_balance (funds not in open trades)
      const openTrades = await PaperTrade.find({ status: "Open" });
      const deployedCapital = openTrades.reduce(
        (sum: number, t: IPaperTrade) => sum + t.paper_investment_amount,
        0,
      );

      const text =
        `💰 <b>Balance Overview</b>\n\n` +
        `🏦 Initial Balance: <code>$${state.initial_balance.toFixed(2)}</code>\n` +
        `📅 Daily Starting: <code>$${state.daily_starting_balance.toFixed(2)}</code>\n` +
        `💵 Current Balance: <code>$${state.current_balance.toFixed(2)}</code>\n` +
        `📊 Deployed Capital: <code>$${deployedCapital.toFixed(2)}</code>\n` +
        `💧 Liquid (Available): <code>$${state.current_balance.toFixed(2)}</code>`;

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/balance error: ${err}`);
      await ctx.reply("❌ Error fetching balance.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /pnl
  // ──────────────────────────────────────────────────────

  private async handlePnl(ctx: Context): Promise<void> {
    try {
      const state = await riskEngine.getSystemState();

      // All-time PnL
      const allTimePnl = state.current_balance - state.initial_balance;

      // Monthly PnL – resolved trades this calendar month
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      const monthlyTrades = await PaperTrade.find({
        status: { $in: ["Resolved_Won", "Resolved_Lost"] },
        resolved_at: { $gte: startOfMonth },
      });
      const monthlyPnl = monthlyTrades.reduce(
        (sum: number, t: IPaperTrade) => sum + t.pnl,
        0,
      );

      // Daily PnL – resolved trades today
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const dailyTrades = await PaperTrade.find({
        status: { $in: ["Resolved_Won", "Resolved_Lost"] },
        resolved_at: { $gte: startOfDay },
      });
      const dailyPnl = dailyTrades.reduce(
        (sum: number, t: IPaperTrade) => sum + t.pnl,
        0,
      );

      // Open PnL – unrealised gains/losses on active positions
      const openTrades = await PaperTrade.find({ status: "Open" });
      const openCount = openTrades.length;

      const fmt = (n: number) => `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;

      const text =
        `📈 <b>Profit & Loss</b>\n\n` +
        `📊 All-Time PnL: <code>${fmt(allTimePnl)}</code>\n` +
        `📅 Monthly PnL: <code>${fmt(monthlyPnl)}</code> (${monthlyTrades.length} trades)\n` +
        `🕐 Daily PnL: <code>${fmt(dailyPnl)}</code> (${dailyTrades.length} trades)\n` +
        `📂 Open Trades: <code>${openCount}</code>`;

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/pnl error: ${err}`);
      await ctx.reply("❌ Error fetching PnL.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /activebets
  // ──────────────────────────────────────────────────────

  private async handleActiveBets(ctx: Context): Promise<void> {
    try {
      const openTrades = await PaperTrade.find({ status: "Open" }).sort({
        opened_at: -1,
      });

      if (openTrades.length === 0) {
        await ctx.reply("📭 No active paper trades.");
        return;
      }

      let text = `📋 <b>Active Bets (${openTrades.length})</b>\n\n`;

      for (const trade of openTrades as IPaperTrade[]) {
        text +=
          `• <b>${trade.question}</b>\n` +
          `  Direction: ${trade.direction} | Entry: ${(trade.entry_price * 100).toFixed(1)}¢\n` +
          `  Amount: $${trade.paper_investment_amount.toFixed(2)} | Shares: ${trade.num_shares.toFixed(2)}\n` +
          `  Whale: ${trade.whale_wallet.slice(0, 6)}…\n` +
          `  Opened: ${trade.opened_at.toISOString().slice(0, 10)}\n\n`;
      }

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/activebets error: ${err}`);
      await ctx.reply("❌ Error fetching active bets.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /history
  // ──────────────────────────────────────────────────────

  private async handleHistory(ctx: Context): Promise<void> {
    try {
      const resolvedTrades = await PaperTrade.find({
        status: { $in: ["Resolved_Won", "Resolved_Lost"] },
      })
        .sort({ resolved_at: -1 })
        .limit(10);

      if (resolvedTrades.length === 0) {
        await ctx.reply("📭 No resolved trades yet.");
        return;
      }

      let text = `📜 <b>Recent History (last ${resolvedTrades.length})</b>\n\n`;

      for (const trade of resolvedTrades as IPaperTrade[]) {
        const emoji = trade.status === "Resolved_Won" ? "✅" : "❌";
        const pnlStr = `${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}`;
        text +=
          `${emoji} <b>${trade.question}</b>\n` +
          `  ${trade.direction} @ ${(trade.entry_price * 100).toFixed(1)}¢ → PnL: ${pnlStr}\n` +
          `  Resolved: ${trade.resolved_at?.toISOString().slice(0, 10) ?? "N/A"}\n\n`;
      }

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/history error: ${err}`);
      await ctx.reply("❌ Error fetching trade history.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /addwallet [address]
  // ──────────────────────────────────────────────────────

  private async handleAddWallet(ctx: Context): Promise<void> {
    try {
      const text = (ctx.message as { text?: string })?.text ?? "";
      const parts = text.split(/\s+/);
      const address = parts[1];

      if (!address || !address.startsWith("0x") || address.length !== 42) {
        await ctx.reply(
          "⚠️ Usage: /addwallet [0x…]\nPlease provide a valid Polygon wallet address.",
        );
        return;
      }

      const existing = await TrackedWallet.findOne({
        wallet_address: address.toLowerCase(),
      });

      if (existing) {
        if (!existing.active_status) {
          existing.active_status = true;
          await existing.save();
          await ctx.reply(`✅ Wallet re-activated: <code>${address}</code>`, {
            parse_mode: "HTML",
          });
        } else {
          await ctx.reply(
            `ℹ️ Wallet already being tracked: <code>${address}</code>`,
            { parse_mode: "HTML" },
          );
        }
        return;
      }

      await TrackedWallet.create({
        wallet_address: address.toLowerCase(),
        label: parts[2] || "",
        date_added: new Date(),
        active_status: true,
      });

      await ctx.reply(`✅ Now tracking wallet: <code>${address}</code>`, {
        parse_mode: "HTML",
      });
      logger.info(`Added wallet: ${address}`);

      // Run catchup scan for the newly added wallet
      try {
        const { copied, skipped } = await catchupService.catchupWallet(
          address.toLowerCase(),
        );
        if (copied > 0 || skipped > 0) {
          await ctx.reply(
            `🔄 Catchup complete for new wallet: ${copied} trade(s) copied, ${skipped} skipped.`,
          );
        }
      } catch (err) {
        logger.error(`Catchup on /addwallet failed: ${err}`);
      }
    } catch (err) {
      logger.error(`/addwallet error: ${err}`);
      await ctx.reply("❌ Error adding wallet.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /removewallet [address]
  // ──────────────────────────────────────────────────────

  private async handleRemoveWallet(ctx: Context): Promise<void> {
    try {
      const text = (ctx.message as { text?: string })?.text ?? "";
      const parts = text.split(/\s+/);
      const address = parts[1];

      if (!address || !address.startsWith("0x")) {
        await ctx.reply("⚠️ Usage: /removewallet [0x…]");
        return;
      }

      const wallet = await TrackedWallet.findOne({
        wallet_address: address.toLowerCase(),
      });

      if (!wallet) {
        await ctx.reply("⚠️ Wallet not found in tracking list.");
        return;
      }

      wallet.active_status = false;
      await wallet.save();

      await ctx.reply(`🗑 Wallet deactivated: <code>${address}</code>`, {
        parse_mode: "HTML",
      });
      logger.info(`Removed wallet: ${address}`);
    } catch (err) {
      logger.error(`/removewallet error: ${err}`);
      await ctx.reply("❌ Error removing wallet.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /wallets
  // ──────────────────────────────────────────────────────

  private async handleWallets(ctx: Context): Promise<void> {
    try {
      const wallets = await TrackedWallet.find({ active_status: true }).sort({
        date_added: -1,
      });

      if (wallets.length === 0) {
        await ctx.reply(
          "📭 No wallets being tracked.\nUse /addwallet [address] to add one.",
        );
        return;
      }

      let text = `🐋 <b>Tracked Wallets (${wallets.length})</b>\n\n`;

      for (const w of wallets) {
        const label = w.label ? ` (${w.label})` : "";
        text += `• <code>${w.wallet_address}</code>${label}\n  Added: ${w.date_added.toISOString().slice(0, 10)}\n\n`;
      }

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/wallets error: ${err}`);
      await ctx.reply("❌ Error listing wallets.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /golive – Enable live trading mode
  // ──────────────────────────────────────────────────────

  private async handleGoLive(ctx: Context): Promise<void> {
    try {
      // Guard: private key must be configured
      if (!config.privateKey) {
        await ctx.reply(
          "⚠️ Cannot enable live trading.\n" +
            "<code>POLYMARKET_PRIVATE_KEY</code> is not set in the environment.",
          { parse_mode: "HTML" },
        );
        return;
      }

      const state = await riskEngine.getSystemState();

      if (state.live_mode) {
        await ctx.reply("ℹ️ Live trading is already enabled.");
        return;
      }

      // Initialise the live trader SDK (derives API creds, etc.)
      await liveTrader.init();

      // In live mode, sync balance from Polymarket if possible
      const liveBalance = await liveTrader.getUsdcBalance();
      let balanceMsg = "";
      if (liveBalance !== null) {
        state.current_balance = liveBalance;
        state.daily_starting_balance = liveBalance;
        balanceMsg = `\n💰 Polymarket USDC Balance: $${liveBalance.toFixed(2)} (synced)`;
      }

      // Flip the flag
      state.live_mode = true;
      await state.save();

      await ctx.reply(
        "🔴 <b>LIVE TRADING ENABLED</b>\n\n" +
          "All new copy-trades will be placed as real orders on Polymarket.\n" +
          balanceMsg +
          "\nUse /gopaper to switch back.",
        { parse_mode: "HTML" },
      );
      logger.info("Switched to LIVE trading mode");

      // Run catchup scan – copy eligible whale positions as live trades
      try {
        await catchupService.catchupAll();
      } catch (err) {
        logger.error(`Catchup on /golive failed: ${err}`);
      }
    } catch (err) {
      logger.error(`/golive error: ${err}`);
      await ctx.reply("❌ Failed to enable live trading. Check logs.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /gopaper – Disable live trading mode
  // ──────────────────────────────────────────────────────

  private async handleGoPaper(ctx: Context): Promise<void> {
    try {
      const state = await riskEngine.getSystemState();

      if (!state.live_mode) {
        await ctx.reply("ℹ️ Already in paper trading mode.");
        return;
      }

      state.live_mode = false;
      await state.save();

      await ctx.reply(
        "📝 <b>PAPER TRADING MODE</b>\n\n" +
          "All new copy-trades will be simulated (no real orders).\n" +
          "Use /golive to switch back.",
        { parse_mode: "HTML" },
      );
      logger.info("Switched to PAPER trading mode");

      // Run catchup scan – copy eligible whale positions as paper trades
      try {
        await catchupService.catchupAll();
      } catch (err) {
        logger.error(`Catchup on /gopaper failed: ${err}`);
      }
    } catch (err) {
      logger.error(`/gopaper error: ${err}`);
      await ctx.reply("❌ Error switching to paper mode.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /mode – Show current trading mode
  // ──────────────────────────────────────────────────────

  private async handleMode(ctx: Context): Promise<void> {
    try {
      const state = await riskEngine.getSystemState();
      const modeEmoji = state.live_mode ? "🔴" : "📝";
      const modeLabel = state.live_mode ? "LIVE" : "PAPER";
      const sdkReady = liveTrader.isReady()
        ? "✅ Connected"
        : "❌ Not initialised";

      let text =
        `${modeEmoji} <b>Current Mode: ${modeLabel}</b>\n\n` +
        `SDK Status: ${sdkReady}\n` +
        `Private Key: ${config.privateKey ? "✅ Configured" : "❌ Missing"}`;

      if (state.live_mode) {
        const openLiveTrades = await PaperTrade.countDocuments({
          status: "Open",
          is_live: true,
        });
        text += `\nOpen Live Trades: ${openLiveTrades}`;
      }

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/mode error: ${err}`);
      await ctx.reply("❌ Error fetching mode.");
    }
  }

  // ──────────────────────────────────────────────────────
  // /livepnl – Fetch real PnL from Polymarket
  // ──────────────────────────────────────────────────────

  private async handleLivePnl(ctx: Context): Promise<void> {
    try {
      if (!liveTrader.isReady()) {
        await ctx.reply(
          "⚠️ Live trader is not initialised.\n" +
            "Use /golive first to connect to Polymarket.",
        );
        return;
      }

      await ctx.reply("⏳ Fetching live positions from Polymarket…");

      const [positions, realisedData] = await Promise.all([
        liveTrader.getLivePositions(),
        liveTrader.getRealisedPnl(),
      ]);

      const realisedPnl = realisedData.totalRealised;

      // ── Open positions ──
      let text = `📊 <b>Live Polymarket PnL</b>\n\n`;

      if (positions.length === 0) {
        text += `<i>No open positions on Polymarket.</i>\n\n`;
      } else {
        text += `<b>Open Positions (${positions.length})</b>\n`;
        let totalUnrealised = 0;

        for (const p of positions) {
          const unrealised = p.unrealisedPnl ?? 0;
          totalUnrealised += unrealised;
          const pnlStr = `${unrealised >= 0 ? "+" : ""}$${unrealised.toFixed(2)}`;
          const side = p.outcome === "Yes" ? "YES" : "NO";
          text +=
            `• <b>${p.market || p.conditionId?.slice(0, 8) || "?"}</b>\n` +
            `  ${side} | Size: ${Number(p.size).toFixed(2)} shares\n` +
            `  Avg Entry: ${(Number(p.avgPrice) * 100).toFixed(1)}¢ | Current: ${(p.currentPrice * 100).toFixed(1)}¢\n` +
            `  Unrealised: <code>${pnlStr}</code>\n\n`;
        }

        const totalStr = `${totalUnrealised >= 0 ? "+" : ""}$${totalUnrealised.toFixed(2)}`;
        text += `📈 Total Unrealised: <code>${totalStr}</code>\n\n`;
      }

      // ── Realised PnL ──
      const realisedStr = `${realisedPnl >= 0 ? "+" : ""}$${realisedPnl.toFixed(2)}`;
      text += `✅ Realised PnL (closed): <code>${realisedStr}</code>`;

      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error(`/livepnl error: ${err}`);
      await ctx.reply("❌ Error fetching live PnL from Polymarket.");
    }
  }
}

export const telegramBot = new TelegramBot();
