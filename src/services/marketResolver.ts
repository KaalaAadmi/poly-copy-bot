import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PaperTrade, IPaperTrade } from "../db/models/index.js";
import { polymarketApi } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";

/**
 * MarketResolver – Detects when open trades' underlying markets have resolved.
 *
 * Uses a two-pronged approach:
 *   1. **WebSocket (primary):** Subscribes to the Polymarket CLOB WS and
 *      listens for `market_resolved` events in real time.
 *   2. **Polling (fallback):** Every 5 minutes, queries the Gamma API for
 *      all open-trade condition IDs and checks their `closed` flag.
 *
 * When resolution is detected, it determines whether each trade won or lost
 * and calls riskEngine.resolveTrade().
 */
export class MarketResolver {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private subscribedTokenIds: Set<string> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ──────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────

  start(): void {
    // Start polling fallback
    if (!this.pollInterval) {
      logger.info("MarketResolver started – polling every 5 min + WebSocket");
      this.pollCheck();
      this.pollInterval = setInterval(() => this.pollCheck(), 5 * 60 * 1000);
    }

    // Start WebSocket
    this.connectWebSocket();
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("MarketResolver stopped");
  }

  // ──────────────────────────────────────────────────────
  // WebSocket – real-time market_resolved detection
  // ──────────────────────────────────────────────────────

  private connectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(config.clobWsUrl);

      this.ws.on("open", async () => {
        logger.info("MarketResolver WS connected");
        await this.refreshSubscriptions();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString());
          this.handleWsMessage(parsed);
        } catch {
          // ignore non-JSON messages
        }
      });

      this.ws.on("close", () => {
        logger.warn("MarketResolver WS disconnected – reconnecting in 10s");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        logger.error(`MarketResolver WS error: ${err}`);
        this.scheduleReconnect();
      });
    } catch (err) {
      logger.error(`MarketResolver WS connect failed: ${err}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 10_000);
  }

  /**
   * Subscribe to all token IDs that have open trades.
   * Called on WS connect and periodically to pick up new trades.
   */
  async refreshSubscriptions(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const openTrades = await PaperTrade.find({ status: "Open" });
    const tokenIds = Array.from(
      new Set(openTrades.map((t: IPaperTrade) => t.token_id).filter(Boolean)),
    );

    if (tokenIds.length === 0) return;

    // Unsubscribe from tokens we no longer care about
    const toUnsub = Array.from(this.subscribedTokenIds).filter(
      (id) => !tokenIds.includes(id),
    );
    if (toUnsub.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ assets_ids: toUnsub, operation: "unsubscribe" }),
      );
      for (const id of toUnsub) this.subscribedTokenIds.delete(id);
    }

    // Subscribe to new tokens
    const toSub = tokenIds.filter((id) => !this.subscribedTokenIds.has(id));
    if (toSub.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "market",
          assets_ids: toSub,
          custom_feature_enabled: true, // enables market_resolved events
        }),
      );
      for (const id of toSub) this.subscribedTokenIds.add(id);
      logger.debug(`MarketResolver WS subscribed to ${toSub.length} token(s)`);
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private async handleWsMessage(msg: Record<string, unknown>): Promise<void> {
    const eventType = msg.event_type as string | undefined;

    if (eventType === "market_resolved") {
      const winningAssetId = msg.winning_asset_id as string | undefined;
      const assetId = msg.asset_id as string | undefined;

      logger.info(
        `WS market_resolved – winning_asset_id: ${winningAssetId}, asset: ${assetId}`,
      );

      // Find all open trades whose token matches either the winning or losing asset
      const openTrades = await PaperTrade.find({ status: "Open" });
      for (const trade of openTrades as IPaperTrade[]) {
        // Check if this trade is related to the resolved market
        if (trade.token_id === winningAssetId) {
          await riskEngine.resolveTrade(trade.internal_trade_id, true);
        } else if (trade.token_id === assetId && assetId !== winningAssetId) {
          await riskEngine.resolveTrade(trade.internal_trade_id, false);
        }
      }

      // Refresh subscriptions since some trades are now resolved
      await this.refreshSubscriptions();
    }
  }

  // ──────────────────────────────────────────────────────
  // Polling fallback – catches anything the WS missed
  // ──────────────────────────────────────────────────────

  private async pollCheck(): Promise<void> {
    try {
      const openTrades = await PaperTrade.find({ status: "Open" });
      if (openTrades.length === 0) return;

      logger.debug(
        `MarketResolver poll: checking ${openTrades.length} open trade(s)`,
      );

      // Also refresh WS subscriptions during poll
      await this.refreshSubscriptions();

      // Group by condition_id to reduce API calls
      const conditionIds: string[] = Array.from(
        new Set(
          openTrades
            .map((t: IPaperTrade) => t.condition_id)
            .filter((id: string) => Boolean(id)),
        ),
      );

      for (const conditionId of conditionIds) {
        try {
          const market =
            await polymarketApi.getMarketByConditionId(conditionId);
          if (!market) continue;

          // ── Only resolve when the market is truly resolved ──
          // `closed` alone means trading is halted; the resolution may
          // still be pending.  We require BOTH closed AND either:
          //   • umaResolutionStatus === "resolved", OR
          //   • outcomePrices shows a clear 1/0 split
          if (!market.closed) continue;

          // Parse outcome prices
          let outcomePrices: number[] = [];
          try {
            outcomePrices = JSON.parse(market.outcomePrices).map(Number);
          } catch {
            continue;
          }

          let clobTokenIds: string[] = [];
          try {
            clobTokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            continue;
          }

          // Check if the market is actually resolved (not just closed)
          const resolutionStatus = market.umaResolutionStatus ?? "";
          const hasResolved = resolutionStatus.toLowerCase() === "resolved";

          // Find which outcome won (price = 1 or very close to 1)
          const winningIndex = outcomePrices.findIndex(
            (p: number) => p >= 0.99,
          );
          const losingIndex = outcomePrices.findIndex((p: number) => p <= 0.01);

          // Only proceed if we have a definitive resolution:
          //   1. The market says "resolved" explicitly, OR
          //   2. The prices clearly show a 1/0 split (one ≥0.99 AND one ≤0.01)
          if (!hasResolved && winningIndex < 0) {
            logger.debug(
              `MarketResolver: condition ${conditionId.slice(0, 12)}… is closed ` +
                `but not resolved (status="${resolutionStatus}", ` +
                `prices=[${outcomePrices.join(",")}]) – waiting`,
            );
            continue;
          }

          // If status says resolved but prices don't show a clear winner
          // (e.g. [0, 0] for old markets), skip to avoid incorrect resolution
          if (winningIndex < 0) {
            logger.warn(
              `MarketResolver: condition ${conditionId.slice(0, 12)}… marked ` +
                `resolved but no winning outcome found ` +
                `(prices=[${outcomePrices.join(",")}]) – skipping`,
            );
            continue;
          }

          const winningTokenId = clobTokenIds[winningIndex] ?? null;

          // Resolve all trades for this condition
          const conditionTrades = openTrades.filter(
            (t: IPaperTrade) => t.condition_id === conditionId,
          );

          logger.info(
            `MarketResolver: resolving ${conditionTrades.length} trade(s) ` +
              `for condition ${conditionId.slice(0, 12)}… ` +
              `(winner: token index ${winningIndex}, status="${resolutionStatus}")`,
          );

          for (const trade of conditionTrades) {
            const won = trade.token_id === winningTokenId;
            await riskEngine.resolveTrade(trade.internal_trade_id, won);
          }
        } catch (err) {
          logger.error(`Error resolving condition ${conditionId}: ${err}`);
        }
      }
    } catch (err) {
      logger.error(`MarketResolver poll cycle error: ${err}`);
    }
  }
}

export const marketResolver = new MarketResolver();
