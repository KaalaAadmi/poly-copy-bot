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
};
