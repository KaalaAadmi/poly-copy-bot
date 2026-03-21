# 🐋 Poly-Bot — Polymarket Copy-Trading Telegram Bot

Copy-trade whale wallets on Polymarket via Telegram — paper or live mode.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Telegram Bot                            │
│  /balance  /pnl  /activebets  /history  /golive  /livepnl   │
│  /addwallet  /removewallet  /wallets  /mode  /gopaper        │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│                      Core Engine                             │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Poller   │→│ Risk Engine  │→│   Market Resolver        │ │
│  │ (12s poll)│  │ (Guardrails) │  │ (WebSocket + 5min poll)│ │
│  └──────────┘  └──────┬───────┘  └────────────────────────┘ │
│                        │                                     │
│              ┌─────────┴──────────┐                          │
│              ▼                    ▼                           │
│        Paper Trade          Live Order                       │
│        (DB record)       (CLOB SDK → Polymarket)             │
└───────────────────────┬──────────────────────────────────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
   Polymarket APIs   MongoDB      Cron (daily
   (Gamma/CLOB/Data) (Atlas)       balance reset)
```

## Quick Start — Local Testing

### 1. Prerequisites

- **Node.js** ≥ 18
- **MongoDB** — either [Atlas (free tier)](https://www.mongodb.com/atlas) or local
- **Telegram Bot Token** — create one via [@BotFather](https://t.me/BotFather)
- **Your Telegram Chat ID** — send a message to [@userinfobot](https://t.me/userinfobot)

### 2. Install

```bash
cd poly-bot
npm install
```

### 3. Configure `.env`

Open `.env` and fill in these **required** values:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...     # from BotFather
TELEGRAM_CHAT_ID=123456789               # your numeric chat ID
MONGODB_URI=mongodb://localhost:27017/polybot   # or your Atlas URI
INITIAL_BALANCE=215                      # paper trading starting balance (USDC)
```

For **live trading** (optional), also set:

```env
POLYMARKET_PRIVATE_KEY=0xabc123...       # your Polygon wallet private key
POLYMARKET_SIGNATURE_TYPE=0              # 0=EOA, 1=Poly Proxy, 2=Gnosis Safe
```

### 4. Start MongoDB (if local)

```bash
# macOS with Homebrew
brew services start mongodb-community

# Or with Docker
docker run -d -p 27017:27017 --name mongo mongo:7
```

Skip this if using MongoDB Atlas — just paste the connection string in `.env`.

### 5. Run

**Development (auto-restart on file changes):**

```bash
npm run dev:watch
```

**Development (single run):**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm start
```

### 6. Test the bot

1. Open Telegram → start a chat with your bot
2. `/start` → welcome message
3. `/help` → all commands
4. `/addwallet 0x<whale_address>` → add a whale to track
5. `/balance` → see your $215 paper balance
6. Wait for the whale to trade → you'll get:
   - 🐋 **Whale Trade Detected** alert (the exact trade details)
   - **New Trade Opened** notification (your copy-trade)
7. When the market resolves → ✅/❌ PnL notification

### Finding whale wallets

Go to [Polymarket](https://polymarket.com) → Leaderboard → click a top trader → copy the `0x...` address from their profile URL.

## Telegram Commands

| Command                | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `/start`               | Welcome message                                   |
| `/help`                | List all commands                                 |
| **Portfolio**          |                                                   |
| `/balance`             | View initial, daily starting, and current balance |
| `/pnl`                 | View PnL (all-time, monthly, daily)               |
| `/activebets`          | View all open trades                              |
| `/history`             | View last 10 resolved trades                      |
| **Live Trading**       |                                                   |
| `/golive`              | Enable live trading (real orders on Polymarket)   |
| `/gopaper`             | Switch back to paper trading                      |
| `/mode`                | Show current mode + SDK status                    |
| `/livepnl`             | Fetch real PnL from Polymarket positions          |
| **Configuration**      |                                                   |
| `/addwallet [addr]`    | Track a new whale wallet                          |
| `/removewallet [addr]` | Stop tracking a wallet                            |
| `/wallets`             | List all tracked wallets                          |

## How It Works

1. **Poller** queries the Polymarket Data API every ~12s for new trading activity on tracked wallets.
2. When a whale trade is detected, full details are logged and sent to Telegram (market, side, size, price, token).
3. The **Risk Engine** processes it:
   - **Idempotency** — skips already-processed trades
   - **Exposure check** — skips if daily exposure exceeds the cap
   - **Sizing** — allocates 2% of daily starting balance
   - **Execution** — records a paper trade at the current price, or places a real GTC order if in live mode
4. The **Market Resolver** uses WebSocket (primary) + 5-min polling (fallback) to detect when markets resolve, then settles trades.
5. A **midnight UTC cron job** snapshots the daily starting balance.

### How bet types work (spread / moneyline / totals)

On Polymarket, each bet variant (e.g. "Lakers -3.5 Spread", "Lakers Moneyline", "Total Over 210.5") is a **separate market** with its own unique `conditionId` and `token_id`. When the whale buys a specific spread token, the Poller captures that **exact token ID**. The Risk Engine then buys the **same token** — so the bot automatically mirrors the exact bet type. There's no ambiguity.

### Balance management

- **Paper mode:** Balance starts at `INITIAL_BALANCE` from `.env` (default $215). Tracked in MongoDB.
- **Live mode:** When you `/golive`, the bot syncs your USDC balance from Polymarket. All orders are real.

## Configuration

| Variable             | Default | Description                          |
| -------------------- | ------- | ------------------------------------ |
| `INITIAL_BALANCE`    | `215`   | Paper starting balance (USDC)        |
| `POLL_INTERVAL_MS`   | `12000` | Polling interval (ms)                |
| `DAILY_MAX_EXPOSURE` | `0.10`  | Max % of balance deployable per day  |
| `POSITION_SIZE_PCT`  | `0.02`  | Per-trade size as % of daily balance |

## Project Structure

```
src/
├── index.ts              # Entry point & boot sequence
├── config.ts             # Environment configuration
├── bot/
│   └── telegramBot.ts    # All Telegram command handlers
├── cron/
│   └── dailyReset.ts     # Midnight UTC balance snapshot
├── db/
│   ├── connection.ts     # MongoDB connection
│   └── models/
│       ├── index.ts      # Barrel exports
│       ├── SystemState.ts
│       ├── TrackedWallet.ts
│       ├── ProcessedSignal.ts
│       └── PaperTrade.ts
├── services/
│   ├── index.ts          # Barrel exports
│   ├── polymarketApi.ts  # Gamma / CLOB / Data API client
│   ├── poller.ts         # Wallet activity poller
│   ├── riskEngine.ts     # Risk & execution engine
│   ├── liveTrader.ts     # Authenticated CLOB SDK client
│   └── marketResolver.ts # WebSocket + polling market resolution
└── utils/
    └── logger.ts         # Winston logger
```
