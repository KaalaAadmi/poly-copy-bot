import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PaperTrade, IPaperTrade } from "../db/models/index.js";
import { polymarketApi } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";

/**
 * MarketResolver – Detects when open trades' underlying markets have resolved.
 *
 * Uses a three-pronged approach:
 *   1. **WebSocket (primary):** Subscribes to the Polymarket CLOB WS and
 *      listens for `market_resolved` events in real time.
 *   2. **Gamma API polling (fallback #1):** Every 5 minutes, queries the
 *      Gamma API for open-trade condition IDs and checks resolution status.
 *   3. **Data API polling (fallback #2):** For trades that Gamma can't look
 *      up (returns null due to conditionId mismatch), checks the whale's
 *      positions on the Data API. If a position is marked redeemable with
 *      curPrice=0, the token is worthless → trade lost. If curPrice≈1,
 *      the token won. Also uses CLOB 404 as an additional resolution signal.
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

      // Track which trades get resolved by Gamma so the Data API fallback
      // only processes the remainder.
      const resolvedTradeIds = new Set<string>();

      // ── Phase 1: Gamma API check (works when conditionId is indexed) ──
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
          if (!market) continue; // Gamma can't find it → Data API fallback will handle

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

          const winningIndex = outcomePrices.findIndex(
            (p: number) => p >= 0.99,
          );

          if (!hasResolved && winningIndex < 0) {
            logger.debug(
              `MarketResolver: condition ${conditionId.slice(0, 12)}… is closed ` +
                `but not resolved (status="${resolutionStatus}", ` +
                `prices=[${outcomePrices.join(",")}]) – waiting`,
            );
            continue;
          }

          if (winningIndex < 0) {
            logger.warn(
              `MarketResolver: condition ${conditionId.slice(0, 12)}… marked ` +
                `resolved but no winning outcome found ` +
                `(prices=[${outcomePrices.join(",")}]) – skipping`,
            );
            continue;
          }

          const winningTokenId = clobTokenIds[winningIndex] ?? null;

          const conditionTrades = openTrades.filter(
            (t: IPaperTrade) => t.condition_id === conditionId,
          );

          logger.info(
            `MarketResolver [Gamma]: resolving ${conditionTrades.length} trade(s) ` +
              `for condition ${conditionId.slice(0, 12)}… ` +
              `(winner: token index ${winningIndex}, status="${resolutionStatus}")`,
          );

          for (const trade of conditionTrades) {
            const won = trade.token_id === winningTokenId;
            await riskEngine.resolveTrade(trade.internal_trade_id, won);
            resolvedTradeIds.add(trade.internal_trade_id);
          }
        } catch (err) {
          logger.error(`Error resolving condition ${conditionId}: ${err}`);
        }
      }

      // ── Phase 2: Data API fallback for trades Gamma couldn't resolve ──
      const unresolvedTrades = openTrades.filter(
        (t: IPaperTrade) => !resolvedTradeIds.has(t.internal_trade_id),
      );

      if (unresolvedTrades.length > 0) {
        await this.dataApiFallbackCheck(unresolvedTrades);
      }
    } catch (err) {
      logger.error(`MarketResolver poll cycle error: ${err}`);
    }
  }

  // ──────────────────────────────────────────────────────
  // Data API fallback – resolves trades Gamma can't look up
  // ──────────────────────────────────────────────────────

  /**
   * For trades whose conditionId isn't indexed by Gamma, check the whale's
   * positions on the Data API and the CLOB orderbook status.
   *
   * Resolution signals:
   *   • Whale position: redeemable=true, curPrice=0  → token lost
   *   • Whale position: redeemable=true, curPrice≈1  → token won (rare: whale usually redeems fast)
   *   • CLOB 404 + no whale position                 → market resolved but outcome unknown
   *     (in this case, fall back to checking if endDate has passed)
   */
  private async dataApiFallbackCheck(
    trades: IPaperTrade[],
  ): Promise<void> {
    // Group trades by whale_wallet to batch Data API calls
    const tradesByWallet = new Map<string, IPaperTrade[]>();
    for (const trade of trades) {
      const wallet = trade.whale_wallet.toLowerCase();
      if (!tradesByWallet.has(wallet)) {
        tradesByWallet.set(wallet, []);
      }
      tradesByWallet.get(wallet)!.push(trade);
    }

    for (const [wallet, walletTrades] of tradesByWallet) {
      try {
        // Fetch the whale's current positions from the Data API
        const positions = await polymarketApi.getUserPositions(wallet);

        // Build a lookup: token_id → position data
        const positionMap = new Map<
          string,
          { curPrice: number; redeemable: boolean; endDate: string }
        >();
        for (const pos of positions) {
          const asset = String(pos.asset || pos.asset_id || pos.token_id || "");
          if (asset) {
            positionMap.set(asset, {
              curPrice: parseFloat(String(pos.curPrice ?? "-1")),
              redeemable: Boolean(pos.redeemable),
              endDate: String(pos.endDate || ""),
            });
          }
        }

        for (const trade of walletTrades) {
          try {
            const whalePos = positionMap.get(trade.token_id);

            if (whalePos) {
              // ── Case 1: Whale still has the position ──
              if (whalePos.redeemable && whalePos.curPrice <= 0.01) {
                // Token is worthless → trade LOST
                logger.info(
                  `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                    `"${trade.question}" LOST (whale pos: redeemable=true, curPrice=${whalePos.curPrice})`,
                );
                await riskEngine.resolveTrade(trade.internal_trade_id, false);
                continue;
              }

              if (whalePos.redeemable && whalePos.curPrice >= 0.99) {
                // Token paid out → trade WON
                logger.info(
                  `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                    `"${trade.question}" WON (whale pos: redeemable=true, curPrice=${whalePos.curPrice})`,
                );
                await riskEngine.resolveTrade(trade.internal_trade_id, true);
                continue;
              }

              // Position exists but not redeemable → market still active
              continue;
            }

            // ── Case 2: Whale position not found (redeemed or API limit) ──
            // Check CLOB – if 404, market is resolved
            const midpoint = await polymarketApi.getMidpointPrice(
              trade.token_id,
            );

            if (midpoint !== null) {
              // CLOB returned a price → market still active
              continue;
            }

            // CLOB returned null (404) → market likely resolved
            // But we don't know win/loss from the whale's position (it's gone).
            // Additional heuristic: check if the trade's endDate has passed.
            // If so, try the price endpoint as a final confirmation.
            const price = await polymarketApi.getPrice(trade.token_id);
            if (price !== null) {
              // Still got a price → market active, just no midpoint
              continue;
            }

            // Both CLOB endpoints returned 404.
            // The market is definitely resolved. Since we can't determine
            // win/loss from the whale's position (they already redeemed),
            // check if any OTHER whale position for the same condition_id
            // is redeemable with curPrice=0 (the opposite token).
            let resolvedViaOpposite = false;
            if (trade.condition_id) {
              for (const pos of positions) {
                const posCondition = String(
                  pos.conditionId || pos.condition_id || "",
                );
                const posAsset = String(pos.asset || "");
                if (
                  posCondition === trade.condition_id &&
                  posAsset !== trade.token_id
                ) {
                  const oRedeemable = Boolean(pos.redeemable);
                  const oCurPrice = parseFloat(String(pos.curPrice ?? "-1"));

                  if (oRedeemable && oCurPrice <= 0.01) {
                    // The OPPOSITE token is worthless → OUR token WON
                    logger.info(
                      `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                        `"${trade.question}" WON (opposite token redeemable @ curPrice=${oCurPrice})`,
                    );
                    await riskEngine.resolveTrade(
                      trade.internal_trade_id,
                      true,
                    );
                    resolvedViaOpposite = true;
                    break;
                  }

                  if (oRedeemable && oCurPrice >= 0.99) {
                    // The OPPOSITE token paid out → OUR token LOST
                    logger.info(
                      `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                        `"${trade.question}" LOST (opposite token redeemable @ curPrice=${oCurPrice})`,
                    );
                    await riskEngine.resolveTrade(
                      trade.internal_trade_id,
                      false,
                    );
                    resolvedViaOpposite = true;
                    break;
                  }
                }
              }
            }

            if (!resolvedViaOpposite) {
              // Absolute last resort: CLOB is dead, whale position gone,
              // no opposite token found. Log it for manual inspection.
              logger.warn(
                `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                  `"${trade.question}" — CLOB 404, whale position gone, ` +
                  `cannot determine outcome. Will retry next cycle.`,
              );
            }
          } catch (err) {
            logger.error(
              `DataAPI fallback error for trade ${trade.internal_trade_id.slice(0, 8)}: ${err}`,
            );
          }
        }
      } catch (err) {
        logger.error(
          `DataAPI fallback error for wallet ${wallet.slice(0, 10)}: ${err}`,
        );
      }
    }
  }
}

export const marketResolver = new MarketResolver();
