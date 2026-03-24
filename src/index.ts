import { connectDatabase } from "./db/connection.js";
import { telegramBot } from "./bot/telegramBot.js";
import { poller } from "./services/poller.js";
import { marketResolver } from "./services/marketResolver.js";
import { scheduleDailyReset } from "./cron/dailyReset.js";
import { riskEngine } from "./services/riskEngine.js";
import { liveTrader } from "./services/liveTrader.js";
import { catchupService } from "./services/catchupService.js";
import { polymarketApi } from "./services/polymarketApi.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

/**
 * Main entry point for the Poly-Bot.
 *
 * Boot sequence:
 *   1. Connect to MongoDB
 *   2. Initialise SystemState (if first run)
 *   3. Optionally init live trader if key is configured & mode is live
 *   4. Launch Telegram bot
 *   5. Run catchup scan (copy existing whale positions)
 *   6. Start the Poller (wallet tracker)
 *   7. Start the Market Resolver (WebSocket + polling)
 *   8. Schedule midnight daily-balance reset
 */
async function main(): Promise<void> {
  logger.info("========================================");
  logger.info("  Poly-Bot – Polymarket Copy-Trader");
  logger.info("========================================");

  // 1. Database
  logger.info("[Boot 1/8] Connecting to MongoDB…");
  await connectDatabase();

  // 2. System state
  logger.info("[Boot 2/8] Loading SystemState…");
  const state = await riskEngine.getSystemState();
  logger.info(
    `  SystemState loaded – balance: $${state.current_balance.toFixed(2)}, ` +
      `live_mode: ${state.live_mode}`,
  );

  // 2b. API connectivity test
  logger.info("[Boot 2b] Testing Polymarket API connectivity…");
  try {
    const connResult = await polymarketApi.connectivityTest();
    logger.info(`  ${connResult}`);
  } catch (err) {
    logger.warn(`  Connectivity test failed: ${err}`);
  }

  // 3. Live trader (auto-init if private key set AND live mode was on)
  logger.info("[Boot 3/8] Checking live trader…");
  if (config.privateKey && state.live_mode) {
    try {
      await liveTrader.init();
      logger.info("  Live trader initialised (live_mode was enabled)");
    } catch (err) {
      logger.warn(`  Live trader init failed on startup: ${err}`);
    }
  } else {
    logger.info(
      `  Skipped – privateKey: ${config.privateKey ? "set" : "not set"}, ` +
        `live_mode: ${state.live_mode}`,
    );
  }

  // 4. Telegram
  logger.info("[Boot 4/8] Launching Telegram bot…");
  try {
    await telegramBot.launch();
    logger.info("  Telegram bot launched successfully");
  } catch (err) {
    logger.error(`  Telegram bot launch FAILED: ${err}`);
    throw err;
  }

  // 5. Catchup – scan tracked wallets and copy eligible positions
  //    (runs after Telegram is up so notifications are delivered)
  logger.info("[Boot 5/8] Running catchup scan…");
  catchupService.setAlertCallback((msg) => telegramBot.sendAlert(msg));
  try {
    await catchupService.catchupAll();
    logger.info("  Catchup scan completed");
  } catch (err) {
    logger.error(`  Catchup scan failed on startup: ${err}`);
  }

  // 6. Poller
  logger.info("[Boot 6/8] Starting Poller…");
  poller.start();

  // 7. Market Resolver
  logger.info("[Boot 7/8] Starting Market Resolver…");
  marketResolver.start();

  // 8. Cron
  logger.info("[Boot 8/8] Scheduling daily reset…");
  scheduleDailyReset();

  logger.info("========================================");
  logger.info("  All systems online ✅");
  logger.info("========================================");

  // Log config summary
  logger.info(
    `Config: poll=${config.pollIntervalMs}ms, exposure=${config.dailyMaxExposure}, ` +
      `size=${config.positionSizePct}, catchup=${config.catchupEnabled}, ` +
      `catchupMode=${config.catchupMode}, slippage=${config.catchupMaxSlippage}`,
  );
}

// Catch unhandled errors that might silently kill the process
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled promise rejection: ${reason}`);
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  console.error("Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  logger.error(`Fatal startup error: ${err}`);
  console.error("Fatal startup error:", err);
  process.exit(1);
});
