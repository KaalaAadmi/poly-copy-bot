# PRD: Polymarket Copy-Trading Telegram Bot (Paper Trading V1)

## 1. Product Overview

Objective: To build an automated, server-side bot that monitors specified "whale" wallets on Polymarket, simulates copy-trading their bets using a 2% fixed-fractional sizing strategy, and manages the entire portfolio via a Telegram interface.
Initial Scope: Paper trading only. Starting simulated bankroll equivalent to 200 EUR (~215 USDC).
Target Platform: Polygon Blockchain (via Polymarket Data API).

## 2. Tech Stack

- **Language:** TypeScript (Node.js)

- **Market Data:** Polymarket Data API (Polling mechanism)

- **Database:** MongoDB Atlas (Mongoose ORM)

- **Interface:** Telegram Bot API (using `telegraf` or `node-telegram-bot-api`)

- **Hosting:** A lightweight VPS (like DigitalOcean, AWS EC2, or Heroku)

## 3. Core Engine Mechanics

### A. The Poller (Wallet Tracker)

**Function:** Queries the Polymarket API every 10–15 seconds to fetch the recent activity of all wallets saved in the database.

**Requirement:** Must handle API rate limits gracefully without crashing.

### B. The Risk & Execution Engine (The Guardrails)

When the Poller detects a new trade from a tracked wallet, the engine must execute the following logic in strict order:

- **Idempotency Check:** Query MongoDB (ProcessedSignals collection). If the trade_id already exists, drop the signal and do nothing.

- **Exposure Check:** Calculate total capital deployed today. If it exceeds the 10% Daily Max Exposure, drop the signal and send a Telegram alert: "Signal ignored: Daily exposure limit reached."

- **Size Calculation:** Calculate exactly 2% of the Daily Starting Balance.

- **Execution (Paper):** Fetch the current market price for that specific contract from the Polymarket API.

- **Logging:** Record the simulated trade in MongoDB at the current market price (not the whale's price) and mark the trade_id as processed.

## 4. Telegram Interface Requirements

The Telegram bot acts as the sole user interface. It must respond to the following commands:

### Portfolio Management

`/balance` - Returns the initial bank balance, the daily starting balance, and current available (liquid) balance.

`/pnl` - Returns the total Profit and Loss (All-Time, Monthly, and Daily).

`/activebets` - Lists all unresolved paper trades currently open.

`/history` - Returns a list of the last 10 resolved trades (Wins/Losses).

### Bot Configuration

`/addwallet [address]` - Adds a new Polygon wallet address to the tracking database.

`/removewallet [address]` - Removes a wallet from the tracking database.

`/wallets` - Lists all wallets currently being monitored.

`/help` - Displays a list of all available commands and what they do.

## 5. Database Schema (MongoDB Outline)

To make this work flawlessly, the database needs four primary collections (tables):

1. `SystemState:` Stores your global variables.
   - `current_balance` (Updates after every resolved bet)

   - `daily_starting_balance` (Snapshots at midnight UTC every day)

2. TrackedWallets:
   - `wallet_address`

   - `date_added`

   - `active_status` (Boolean)

3. ProcessedSignals:
   - `polymarket_trade_id` (String - unique index to prevent double-spending)

   - `timestamp_processed`

4. PaperTrades:
   - `internal_trade_id`

   - `contract_id` (Which event)

   - `direction` (Yes/No)

   - `paper_investment_amount` (The 2% calculation)

   - `entry_price`

   - `status` (Open / Resolved_Won / Resolved_Lost)
