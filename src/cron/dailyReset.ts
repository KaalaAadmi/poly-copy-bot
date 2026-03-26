import cron from "node-cron";
import { logger } from "../utils/logger.js";
import { riskEngine } from "../services/riskEngine.js";

/**
 * Schedules a midnight-UTC cron job to snapshot the daily starting balance
 * and clean up expired missed trades.
 */
export function scheduleDailyReset(): void {
  // Cron expression: "0 0 * * *" → every day at 00:00 UTC
  cron.schedule(
    "0 0 * * *",
    async () => {
      logger.info("Running daily balance reset (midnight UTC)…");
      try {
        await riskEngine.resetDailyBalance();
      } catch (err) {
        logger.error(`Daily reset error: ${err}`);
      }

      // Clean up missed trades older than 24 hours (FIFO)
      try {
        await riskEngine.cleanupExpiredMissedTrades();
      } catch (err) {
        logger.error(`Missed trades cleanup error: ${err}`);
      }
    },
    { timezone: "UTC" },
  );
  logger.info("Scheduled daily balance reset at 00:00 UTC");

  // Also run missed trades cleanup every hour (in case trades expire mid-day)
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        await riskEngine.cleanupExpiredMissedTrades();
      } catch (err) {
        logger.error(`Hourly missed trades cleanup error: ${err}`);
      }
    },
    { timezone: "UTC" },
  );
  logger.info("Scheduled hourly missed trades cleanup");
}
