import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PaperTrade, IPaperTrade } from "../db/models/index.js";
import { polymarketApi } from "./polymarketApi.js";
import { riskEngine } from "./riskEngine.js";

/**
 * MarketResolver – Detects when open trades' underlying markets have resolved.
 *
 * Uses a five-pronged approach:
 *   1. **WebSocket (primary):** Subscribes to the Polymarket CLOB WS and
 *      listens for `market_resolved` events in real time.
 *   2. **Gamma API polling by conditionId (fallback #1):** Every 5 minutes,
 *      queries the Gamma API for open-trade condition IDs and checks status.
 *   3. **Gamma API polling by slug (fallback #2):** For trades where the
 *      conditionId lookup fails (Gamma returns null), tries looking up the
 *      market by its slug instead.
 *   4. **Data API polling (fallback #3):** Checks the whale's positions on
 *      the Data API. If a position is marked redeemable with curPrice=0,
 *      the token is worthless → trade lost. If curPrice≈1, the token won.
 *   5. **Event expiry + CLOB 404 (fallback #4):** If the event_end_date
 *      has passed AND the CLOB returns 404 for the token, the market is
 *      definitively dead. Uses the whale's activity history to determine
 *      win/loss, or marks as lost if no payout detected.
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

      // Track which trades get resolved so later phases skip them.
      const resolvedTradeIds = new Set<string>();

      // ── Phase 1: Gamma API check by conditionId ──
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
          if (!market) continue; // Gamma can't find it → slug fallback

          const resolved = await this.tryResolveFromGammaMarket(
            market,
            openTrades.filter(
              (t: IPaperTrade) => t.condition_id === conditionId,
            ),
            "Gamma-conditionId",
          );
          for (const id of resolved) resolvedTradeIds.add(id);
        } catch (err) {
          logger.error(`Error resolving condition ${conditionId}: ${err}`);
        }
      }

      // ── Phase 1b: Gamma API check by slug (for trades Gamma couldn't find by conditionId) ──
      const unresolvedAfterCondition = openTrades.filter(
        (t: IPaperTrade) => !resolvedTradeIds.has(t.internal_trade_id),
      );

      // Collect unique slugs from unresolved trades
      const slugsToCheck = new Map<string, IPaperTrade[]>();
      for (const trade of unresolvedAfterCondition) {
        const slug = trade.market_slug;
        if (!slug) continue;
        if (!slugsToCheck.has(slug)) slugsToCheck.set(slug, []);
        slugsToCheck.get(slug)!.push(trade);
      }

      for (const [slug, slugTrades] of slugsToCheck) {
        try {
          const market = await polymarketApi.getMarketBySlug(slug);
          if (!market) continue;

          const resolved = await this.tryResolveFromGammaMarket(
            market,
            slugTrades,
            "Gamma-slug",
          );
          for (const id of resolved) resolvedTradeIds.add(id);
        } catch (err) {
          logger.error(`Error resolving slug "${slug}": ${err}`);
        }
      }

      // ── Phase 1c: Gamma API check by token ID (for trades with no slug or failed slug) ──
      const unresolvedAfterSlug = openTrades.filter(
        (t: IPaperTrade) => !resolvedTradeIds.has(t.internal_trade_id),
      );

      // Deduplicate by token_id
      const tokensToCheck = new Map<string, IPaperTrade[]>();
      for (const trade of unresolvedAfterSlug) {
        if (!trade.token_id) continue;
        if (!tokensToCheck.has(trade.token_id)) tokensToCheck.set(trade.token_id, []);
        tokensToCheck.get(trade.token_id)!.push(trade);
      }

      for (const [tokenId, tokenTrades] of tokensToCheck) {
        try {
          const market = await polymarketApi.getMarketByTokenId(tokenId);
          if (!market) continue;

          const resolved = await this.tryResolveFromGammaMarket(
            market,
            tokenTrades,
            "Gamma-tokenId",
          );
          for (const id of resolved) resolvedTradeIds.add(id);
        } catch (err) {
          logger.error(`Error resolving token "${tokenId.slice(0, 12)}…": ${err}`);
        }
      }

      // ── Phase 2: Data API fallback (whale positions) ──
      const unresolvedAfterGamma = openTrades.filter(
        (t: IPaperTrade) => !resolvedTradeIds.has(t.internal_trade_id),
      );

      if (unresolvedAfterGamma.length > 0) {
        const dataApiResolved =
          await this.dataApiFallbackCheck(unresolvedAfterGamma);
        for (const id of dataApiResolved) resolvedTradeIds.add(id);
      }

      // ── Phase 3: Event expiry + CLOB 404 (last resort) ──
      const stillUnresolved = openTrades.filter(
        (t: IPaperTrade) => !resolvedTradeIds.has(t.internal_trade_id),
      );

      if (stillUnresolved.length > 0) {
        await this.expiryFallbackCheck(stillUnresolved);
      }
    } catch (err) {
      logger.error(`MarketResolver poll cycle error: ${err}`);
    }
  }

  /**
   * Shared helper: given a GammaMarket, determine if it's resolved and
   * resolve matching trades. Returns a list of resolved internal_trade_ids.
   */
  private async tryResolveFromGammaMarket(
    market: import("./polymarketApi.js").GammaMarket,
    trades: IPaperTrade[],
    source: string,
  ): Promise<string[]> {
    const resolved: string[] = [];

    if (!market.closed) return resolved;

    // Parse outcome prices
    let outcomePrices: number[] = [];
    try {
      outcomePrices = JSON.parse(market.outcomePrices).map(Number);
    } catch {
      return resolved;
    }

    let clobTokenIds: string[] = [];
    try {
      clobTokenIds = JSON.parse(market.clobTokenIds);
    } catch {
      return resolved;
    }

    // Check if the market is actually resolved (not just closed)
    const resolutionStatus = market.umaResolutionStatus ?? "";
    const hasResolved = resolutionStatus.toLowerCase() === "resolved";

    const winningIndex = outcomePrices.findIndex((p: number) => p >= 0.99);

    if (!hasResolved && winningIndex < 0) {
      logger.debug(
        `MarketResolver [${source}]: "${market.question}" is closed ` +
          `but not resolved (status="${resolutionStatus}", ` +
          `prices=[${outcomePrices.join(",")}]) – waiting`,
      );
      return resolved;
    }

    if (winningIndex < 0) {
      logger.warn(
        `MarketResolver [${source}]: "${market.question}" marked ` +
          `resolved but no winning outcome found ` +
          `(prices=[${outcomePrices.join(",")}]) – skipping`,
      );
      return resolved;
    }

    const winningTokenId = clobTokenIds[winningIndex] ?? null;

    logger.info(
      `MarketResolver [${source}]: resolving ${trades.length} trade(s) ` +
        `for "${market.question}" ` +
        `(winner: token index ${winningIndex}, status="${resolutionStatus}")`,
    );

    for (const trade of trades) {
      const won = trade.token_id === winningTokenId;
      await riskEngine.resolveTrade(trade.internal_trade_id, won);
      resolved.push(trade.internal_trade_id);
    }

    return resolved;
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
   *   • Whale position: redeemable=true, curPrice≈1  → token won
   *
   * Returns an array of resolved internal_trade_ids.
   */
  private async dataApiFallbackCheck(trades: IPaperTrade[]): Promise<string[]> {
    const resolved: string[] = [];
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
                resolved.push(trade.internal_trade_id);
                continue;
              }

              if (whalePos.redeemable && whalePos.curPrice >= 0.99) {
                // Token paid out → trade WON
                logger.info(
                  `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                    `"${trade.question}" WON (whale pos: redeemable=true, curPrice=${whalePos.curPrice})`,
                );
                await riskEngine.resolveTrade(trade.internal_trade_id, true);
                resolved.push(trade.internal_trade_id);
                continue;
              }

              // Position exists but not redeemable → market still active
              continue;
            }

            // ── Case 2: Whale position not found → check opposite token ──
            // The whale likely redeemed already. Check if any opposite token
            // for the same condition_id is still visible as redeemable.
            if (trade.condition_id) {
              let resolvedViaOpposite = false;
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
                    logger.info(
                      `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                        `"${trade.question}" WON (opposite token redeemable @ curPrice=${oCurPrice})`,
                    );
                    await riskEngine.resolveTrade(
                      trade.internal_trade_id,
                      true,
                    );
                    resolved.push(trade.internal_trade_id);
                    resolvedViaOpposite = true;
                    break;
                  }

                  if (oRedeemable && oCurPrice >= 0.99) {
                    logger.info(
                      `MarketResolver [DataAPI]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                        `"${trade.question}" LOST (opposite token redeemable @ curPrice=${oCurPrice})`,
                    );
                    await riskEngine.resolveTrade(
                      trade.internal_trade_id,
                      false,
                    );
                    resolved.push(trade.internal_trade_id);
                    resolvedViaOpposite = true;
                    break;
                  }
                }
              }
              if (resolvedViaOpposite) continue;
            }

            // Not resolved via Data API → will be handled by expiry fallback
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

    return resolved;
  }

  // ──────────────────────────────────────────────────────
  // Event expiry fallback – last resort for stale trades
  // ──────────────────────────────────────────────────────

  /**
   * For trades that survived all previous phases:
   * If the event_end_date is in the past AND the CLOB returns 404,
   * the market is definitively dead. Try to determine outcome via:
   *   1. Gamma slug lookup (may have been indexed since last check)
   *   2. Whale activity history (check for REDEEM on this conditionId)
   *   3. Last resort: mark as lost (entire investment lost)
   *
   * We add a grace period of 6 hours after event_end_date to allow
   * Polymarket to settle the market before we force-resolve.
   */
  private async expiryFallbackCheck(trades: IPaperTrade[]): Promise<void> {
    const now = Date.now();
    const GRACE_HOURS = 6; // hours after event_end_date before force-resolving

    for (const trade of trades) {
      try {
        // Only process trades with a known event_end_date that has passed
        if (!trade.event_end_date) continue;
        const endDate = new Date(trade.event_end_date);
        if (isNaN(endDate.getTime())) continue;

        const deadlineMs = endDate.getTime() + GRACE_HOURS * 60 * 60 * 1000;
        if (now < deadlineMs) {
          // Still within grace period — skip
          continue;
        }

        // Event ended + grace period passed. Confirm CLOB is dead.
        const midpoint = await polymarketApi.getMidpointPrice(trade.token_id);
        if (midpoint !== null) {
          // CLOB still alive → market still trading (unlikely but possible)
          logger.debug(
            `MarketResolver [Expiry]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
              `"${trade.question}" — event ended but CLOB still has price (${midpoint}). Skipping.`,
          );
          continue;
        }

        // CLOB is dead. Try Gamma by slug one more time (may be newly indexed).
        // Also try by token ID as another fallback.
        let resolvedViaGamma = false;

        const slugOrTokenLookups: (() => Promise<import("./polymarketApi.js").GammaMarket | null>)[] = [];
        if (trade.market_slug) {
          slugOrTokenLookups.push(() =>
            polymarketApi.getMarketBySlug(trade.market_slug),
          );
        }
        slugOrTokenLookups.push(() =>
          polymarketApi.getMarketByTokenId(trade.token_id),
        );

        for (const lookupFn of slugOrTokenLookups) {
          if (resolvedViaGamma) break;
          try {
            const market = await lookupFn();
            if (market && market.closed) {
              let outcomePrices: number[] = [];
              let clobTokenIds: string[] = [];
              try {
                outcomePrices = JSON.parse(market.outcomePrices).map(Number);
                clobTokenIds = JSON.parse(market.clobTokenIds);
              } catch {
                continue;
              }

              const winningIndex = outcomePrices.findIndex(
                (p: number) => p >= 0.99,
              );
              if (winningIndex >= 0 && clobTokenIds[winningIndex]) {
                const won = trade.token_id === clobTokenIds[winningIndex];
                logger.info(
                  `MarketResolver [Expiry-Gamma]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                    `"${trade.question}" ${won ? "WON" : "LOST"} (resolved via Gamma lookup)`,
                );
                await riskEngine.resolveTrade(trade.internal_trade_id, won);
                resolvedViaGamma = true;
              }
            }
          } catch {
            // try next lookup
          }
        }

        if (resolvedViaGamma) continue;

        // Gamma slug didn't help. Check whale's activity for REDEEM events
        // on this condition_id to determine if the whale won or lost.
        let resolvedViaActivity = false;
        if (trade.condition_id && trade.whale_wallet) {
          try {
            const activities = await polymarketApi.getUserActivity(
              trade.whale_wallet,
            );

            // Look for REDEEM or payout activity on the same conditionId
            for (const act of activities) {
              const actType = (act.type || "").toUpperCase();
              const actCondition = act.conditionId || "";

              if (actCondition !== trade.condition_id) continue;

              if (actType === "REDEEM" || actType === "PAYOUT") {
                // The whale redeemed. If the redeemed asset matches our token,
                // they got paid → we won. If it's the opposite token, we lost.
                const actAsset = act.asset || "";
                if (actAsset === trade.token_id) {
                  logger.info(
                    `MarketResolver [Expiry-Activity]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                      `"${trade.question}" WON (whale redeemed our token)`,
                  );
                  await riskEngine.resolveTrade(trade.internal_trade_id, true);
                  resolvedViaActivity = true;
                  break;
                } else if (actAsset) {
                  logger.info(
                    `MarketResolver [Expiry-Activity]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
                      `"${trade.question}" LOST (whale redeemed opposite token)`,
                  );
                  await riskEngine.resolveTrade(trade.internal_trade_id, false);
                  resolvedViaActivity = true;
                  break;
                }
              }
            }
          } catch (err) {
            logger.error(
              `Expiry activity check error for trade ${trade.internal_trade_id.slice(0, 8)}: ${err}`,
            );
          }
        }

        if (resolvedViaActivity) continue;

        // ── Absolute last resort ──
        // The event ended 6+ hours ago, CLOB is 404, Gamma can't help,
        // whale activity doesn't show a clear signal.
        // Mark as LOST. This is conservative — the investment was deployed
        // and the market is dead. Better to book the loss than leave it
        // open forever.
        logger.warn(
          `MarketResolver [Expiry-ForceResolve]: trade ${trade.internal_trade_id.slice(0, 8)}… ` +
            `"${trade.question}" — event ended ${endDate.toISOString()}, CLOB dead, ` +
            `no resolution signal found. Force-resolving as LOST.`,
        );
        await riskEngine.resolveTrade(trade.internal_trade_id, false);
      } catch (err) {
        logger.error(
          `Expiry fallback error for trade ${trade.internal_trade_id.slice(0, 8)}: ${err}`,
        );
      }
    }
  }
}

export const marketResolver = new MarketResolver();
