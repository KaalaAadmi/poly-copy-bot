import { connectDatabase } from "./db/connection.js";
import { telegramBot } from "./bot/telegramBot.js";
import { poller } from "./services/poller.js";
import { marketResolver } from "./services/marketResolver.js";
import { scheduleDailyReset } from "./cron/dailyReset.js";
import { riskEngine } from "./services/riskEngine.js";
import { liveTrader } from "./services/liveTrader.js";
import { catchupService } from "./services/catchupService.js";
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
  await connectDatabase();

  // 2. System state
  const state = await riskEngine.getSystemState();

  // 3. Live trader (auto-init if private key set AND live mode was on)
  if (config.privateKey && state.live_mode) {
    try {
      await liveTrader.init();
      logger.info("Live trader initialised (live_mode was enabled)");
    } catch (err) {
      logger.warn(`Live trader init failed on startup: ${err}`);
    }
  }

  // 4. Telegram
  await telegramBot.launch();

  // 5. Catchup – scan tracked wallets and copy eligible positions
  //    (runs after Telegram is up so notifications are delivered)
  catchupService.setAlertCallback((msg) => telegramBot.sendAlert(msg));
  try {
    await catchupService.catchupAll();
  } catch (err) {
    logger.error(`Catchup scan failed on startup: ${err}`);
  }

  // 6. Poller
  poller.start();

  // 7. Market Resolver
  marketResolver.start();

  // 8. Cron
  scheduleDailyReset();

  logger.info("All systems online ✅");
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err}`);
  process.exit(1);
});
