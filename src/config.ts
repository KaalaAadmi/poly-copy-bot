import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",

  // MongoDB
  mongodbUri: process.env.MONGODB_URI || "mongodb://localhost:27017/polybot",

  // Trading parameters
  initialBalance: parseFloat(process.env.INITIAL_BALANCE || "215"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "12000", 10),
  dailyMaxExposure: parseFloat(process.env.DAILY_MAX_EXPOSURE || "0.10"),
  positionSizePct: parseFloat(process.env.POSITION_SIZE_PCT || "0.02"),

  // Polymarket API URLs
  gammaApiUrl: process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com",
  clobApiUrl: process.env.CLOB_API_URL || "https://clob.polymarket.com",
  dataApiUrl: process.env.DATA_API_URL || "https://data-api.polymarket.com",

  // Live trading – Polymarket CLOB SDK
  privateKey: process.env.POLYMARKET_PRIVATE_KEY || "",
  signatureType: parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || "0", 10), // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
  funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || "",

  // WebSocket
  clobWsUrl:
    process.env.CLOB_WS_URL ||
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",

  // Catchup – copy existing whale positions on startup / mode switch / wallet add
  catchupEnabled:
    (process.env.CATCHUP_ENABLED || "true").toLowerCase() === "true",
  catchupMaxSlippage: parseFloat(process.env.CATCHUP_MAX_SLIPPAGE || "0.08"),
  // Mode: "absolute" = |current_price - whale_entry_price| ≤ threshold
  //        "relative" = current_price ≤ whale_entry_price + threshold  (only if price went UP)
  catchupMode: (process.env.CATCHUP_MODE || "relative") as
    | "absolute"
    | "relative",

  // ── Conviction-Weighted Sizing ──
  // When enabled, the investment amount is scaled by a multiplier based on
  // how much USDC the whale bet. Bigger whale bets → higher conviction → we
  // size up proportionally.
  convictionSizingEnabled:
    (process.env.CONVICTION_SIZING_ENABLED || "true").toLowerCase() === "true",

  // Tiers: [minUsdcSize, multiplier]
  // The whale's usdcSize is matched against these tiers (highest matching tier wins).
  // Default tiers based on real whale data distribution:
  //   <$10    → 1.0x (noise / small plays)
  //   $10-50  → 1.25x (moderate interest)
  //   $50-200 → 1.5x  (solid conviction)
  //   $200+   → 2.0x  (high conviction, whale going big)
  convictionTiers: JSON.parse(
    process.env.CONVICTION_TIERS ||
      '[{"min":0,"multiplier":1},{"min":10,"multiplier":1.25},{"min":50,"multiplier":1.5},{"min":200,"multiplier":2}]',
  ) as { min: number; multiplier: number }[],

  // Safety cap: maximum multiplier regardless of whale bet size.
  // Prevents runaway sizing if you misconfigure tiers.
  convictionMaxMultiplier: parseFloat(
    process.env.CONVICTION_MAX_MULTIPLIER || "2",
  ),

  // ── Price Monitor: Stop-Loss / Take-Profit ──
  // Periodically checks prices on all open trades and exits automatically
  // when thresholds are breached. This prevents holding losers to $0.
  priceMonitorEnabled:
    (process.env.PRICE_MONITOR_ENABLED || "true").toLowerCase() === "true",
  priceMonitorIntervalMs: parseInt(
    process.env.PRICE_MONITOR_INTERVAL_MS || "60000",
    10,
  ), // 60s

  // Stop-loss: exit if current price drops this far below entry price.
  // E.g. 0.30 means if you bought at 50¢ and price drops to 20¢, exit.
  stopLossThreshold: parseFloat(process.env.STOP_LOSS_THRESHOLD || "0.30"),

  // Take-profit: exit if current price rises this far above entry price.
  // E.g. 0.20 means if you bought at 50¢ and price rises to 70¢, lock in gains.
  takeProfitThreshold: parseFloat(process.env.TAKE_PROFIT_THRESHOLD || "0.20"),

  // ── Trade Filters ──
  // Minimum whale bet size (USDC) to copy. Bets below this are noise.
  minWhaleBetSize: parseFloat(process.env.MIN_WHALE_BET_SIZE || "5"),

  // Maximum entry price. Don't buy when the price is already this high
  // (little upside, all downside). E.g. 0.85 = skip markets priced > 85¢.
  maxEntryPrice: parseFloat(process.env.MAX_ENTRY_PRICE || "0.85"),

  // Minimum entry price. Don't buy extremely cheap long-shots.
  // E.g. 0.05 = skip markets priced < 5¢.
  minEntryPrice: parseFloat(process.env.MIN_ENTRY_PRICE || "0.05"),
};
