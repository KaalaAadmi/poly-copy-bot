import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * PolymarketAPI - Handles all interactions with the Polymarket REST APIs.
 *
 * Gamma API  → markets & events (public, no auth)
 * CLOB API   → prices & order books (public for reads)
 * Data API   → user activity, positions, trades
 */

// ---------- Response types ----------

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string; // JSON-stringified array, e.g. '["Yes","No"]'
  outcomePrices: string; // JSON-stringified array, e.g. '["0.55","0.45"]'
  clobTokenIds: string; // JSON-stringified array, e.g. '["token1","token2"]'
  active: boolean;
  closed: boolean;
  volume: string;
  enableOrderBook: boolean;
  neg_risk: boolean;
  minimum_tick_size: string;
  umaResolutionStatus?: string; // "resolved", "proposed", etc.
  [key: string]: unknown;
}

export interface UserActivity {
  id: string;
  type: string; // "TRADE", "SPLIT", "MERGE", etc.
  conditionId: string;
  asset: string; // token ID
  side: string; // "BUY" | "SELL"
  size: number | string;
  price: number | string;
  usdcSize?: number | string;
  timestamp: number;
  transactionHash: string;
  proxyWallet?: string;
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface ClobPrice {
  price: string;
  [key: string]: unknown;
}

export interface ClobMidpoint {
  mid: string;
  [key: string]: unknown;
}

// ---------- Service ----------

export class PolymarketAPI {
  private gamma: AxiosInstance;
  private clob: AxiosInstance;
  private data: AxiosInstance;

  constructor() {
    this.gamma = axios.create({
      baseURL: config.gammaApiUrl,
      timeout: 15_000,
    });

    this.clob = axios.create({
      baseURL: config.clobApiUrl,
      timeout: 15_000,
    });

    this.data = axios.create({
      baseURL: config.dataApiUrl,
      timeout: 15_000,
    });
  }

  // ===== Gamma API (Markets & Events) =====

  /**
   * Fetch a market by its condition ID.
   *
   * IMPORTANT: The Gamma API ignores the condition_id filter when no
   * match is found and returns an unrelated market (usually id=12).
   * We MUST verify the returned conditionId matches our query.
   */
  async getMarketByConditionId(
    conditionId: string,
  ): Promise<GammaMarket | null> {
    try {
      const resp = await this.gamma.get("/markets", {
        params: { condition_id: conditionId, limit: 1 },
      });
      const markets: GammaMarket[] = resp.data;
      if (markets.length === 0) return null;

      // Verify the returned market actually matches the requested conditionId.
      // The Gamma API silently returns unrelated results on a miss.
      const market = markets[0];
      if (market.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
        logger.debug(
          `Gamma API returned wrong market for condition ${conditionId.slice(0, 16)}… ` +
            `(got "${market.question}" with condition ${market.conditionId.slice(0, 16)}…)`,
        );
        return null;
      }

      return market;
    } catch (err) {
      logger.error(
        `Error fetching market for condition ${conditionId}: ${err}`,
      );
      return null;
    }
  }

  /**
   * Fetch a market by slug.
   */
  async getMarketBySlug(slug: string): Promise<GammaMarket | null> {
    try {
      const resp = await this.gamma.get("/markets", {
        params: { slug, limit: 1 },
      });
      const markets: GammaMarket[] = resp.data;
      if (markets.length === 0) return null;

      // Verify the returned market slug actually matches
      const market = markets[0];
      if (market.slug !== slug) {
        logger.debug(
          `Gamma API returned wrong market for slug "${slug}" (got "${market.slug}")`,
        );
        return null;
      }
      return market;
    } catch (err) {
      logger.error(`Error fetching market by slug ${slug}: ${err}`);
      return null;
    }
  }

  /**
   * Fetch a market by its Gamma market ID.
   */
  async getMarketById(marketId: string): Promise<GammaMarket | null> {
    try {
      const resp = await this.gamma.get(`/markets/${marketId}`);
      return resp.data as GammaMarket;
    } catch (err) {
      logger.error(`Error fetching market ${marketId}: ${err}`);
      return null;
    }
  }

  /**
   * Search markets matching a query string.
   */
  async searchMarkets(query: string, limit = 10): Promise<GammaMarket[]> {
    try {
      const resp = await this.gamma.get("/markets", {
        params: { active: true, closed: false, limit, _q: query },
      });
      return resp.data as GammaMarket[];
    } catch (err) {
      logger.error(`Error searching markets: ${err}`);
      return [];
    }
  }

  /**
   * Fetch a market by one of its CLOB token IDs.
   * Useful as a fallback when conditionId and slug lookups fail.
   */
  async getMarketByTokenId(tokenId: string): Promise<GammaMarket | null> {
    try {
      const resp = await this.gamma.get("/markets", {
        params: { clob_token_ids: tokenId, limit: 5 },
      });
      const markets: GammaMarket[] = resp.data;
      if (markets.length === 0) return null;

      // Verify the returned market actually contains our token ID
      for (const market of markets) {
        try {
          const tokenIds: string[] = JSON.parse(market.clobTokenIds);
          if (tokenIds.includes(tokenId)) return market;
        } catch {
          continue;
        }
      }

      logger.debug(
        `Gamma API returned markets for token ${tokenId.slice(0, 16)}… but none contained the token`,
      );
      return null;
    } catch (err) {
      logger.debug(
        `Error fetching market by token ${tokenId.slice(0, 16)}…: ${err}`,
      );
      return null;
    }
  }

  // ===== CLOB API (Prices) =====

  /**
   * Fetch the midpoint price for a specific token ID.
   */
  async getMidpointPrice(tokenId: string): Promise<number | null> {
    try {
      const resp = await this.clob.get("/midpoint", {
        params: { token_id: tokenId },
      });
      const data = resp.data as ClobMidpoint;
      return data.mid ? parseFloat(data.mid) : null;
    } catch (err) {
      const axiosErr = err as { response?: { status?: number } };
      // 404 = no orderbook (resolved/expired market) — totally expected, don't spam logs
      if (axiosErr.response?.status === 404) {
        logger.debug(
          `No orderbook for midpoint token ${tokenId.slice(0, 16)}… (404)`,
        );
        return null;
      }
      logger.error(`Error fetching midpoint for token ${tokenId}: ${err}`);
      return null;
    }
  }

  /**
   * Fetch the price for a specific token ID.
   */
  async getPrice(tokenId: string): Promise<number | null> {
    try {
      const resp = await this.clob.get("/price", {
        params: { token_id: tokenId, side: "buy" },
      });
      const data = resp.data as ClobPrice;
      return data.price ? parseFloat(data.price) : null;
    } catch (err) {
      const axiosErr = err as { response?: { status?: number } };
      // 404 = no orderbook (resolved/expired market) — totally expected, don't spam logs
      if (axiosErr.response?.status === 404) {
        logger.debug(
          `No orderbook for price token ${tokenId.slice(0, 16)}… (404)`,
        );
        return null;
      }
      logger.error(`Error fetching price for token ${tokenId}: ${err}`);
      return null;
    }
  }

  /**
   * Fetch prices for multiple tokens at once.
   */
  async getPrices(tokenIds: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    try {
      const resp = await this.clob.get("/prices", {
        params: { token_ids: tokenIds.join(",") },
      });
      const data = resp.data as Record<string, string>;
      for (const [tokenId, price] of Object.entries(data)) {
        priceMap.set(tokenId, parseFloat(price));
      }
    } catch (err) {
      logger.error(`Error fetching prices: ${err}`);
    }
    return priceMap;
  }

  // ===== Data API (User Activity / Positions) =====

  /** Track whether we've logged a successful /activity call (to reduce noise). */
  private activityLoggedOnce = false;
  /** Track whether we've logged a successful /positions call (to reduce noise). */
  private positionsLoggedOnce = false;

  /**
   * Fetch recent trading activity for a wallet address.
   * This is the core method the Poller uses to detect whale trades.
   */
  async getUserActivity(walletAddress: string): Promise<UserActivity[]> {
    try {
      const resp = await this.data.get("/activity", {
        params: { user: walletAddress.toLowerCase() },
      });

      // The API may return the data at different paths
      const activities: UserActivity[] = Array.isArray(resp.data)
        ? resp.data
        : (resp.data?.history ?? resp.data?.data ?? []);

      // Log detailed response info only on the first successful call
      if (!this.activityLoggedOnce && activities.length > 0) {
        this.activityLoggedOnce = true;
        logger.info(
          `API /activity first success: status=${resp.status}, count=${activities.length}, ` +
            `keys=[${Object.keys(activities[0]).join(", ")}]`,
        );
        logger.info(
          `API /activity sample: ${JSON.stringify(activities[0]).slice(0, 500)}`,
        );
      }

      return activities;
    } catch (err) {
      // Handle rate limiting gracefully
      const axiosErr = err as {
        response?: { status?: number; data?: unknown };
      };
      if (axiosErr.response?.status === 429) {
        logger.warn(
          `Rate limited while fetching activity for ${walletAddress}. Will retry next cycle.`,
        );
        return [];
      }
      logger.error(
        `Error fetching activity for ${walletAddress}: ${err}` +
          (axiosErr.response
            ? ` (status=${axiosErr.response.status}, body=${JSON.stringify(axiosErr.response.data).slice(0, 200)})`
            : ""),
      );
      return [];
    }
  }

  /**
   * Fetch ALL positions for a wallet address, paginating through the
   * Data API (which returns at most 100 per request).
   *
   * Heavy traders can have 500-1000+ positions. Without pagination we
   * only see the first 100 (sorted by size desc), which are typically
   * old resolved positions — causing the catchup service to find
   * "0 active positions".
   */
  async getUserPositions(
    walletAddress: string,
  ): Promise<Record<string, unknown>[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20; // safety cap: 2000 positions max
    const allPositions: Record<string, unknown>[] = [];

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const resp = await this.data.get("/positions", {
          params: {
            user: walletAddress.toLowerCase(),
            limit: PAGE_SIZE,
            offset,
          },
        });

        const positions: Record<string, unknown>[] = Array.isArray(resp.data)
          ? resp.data
          : (resp.data?.positions ?? []);

        // Log detailed response info only on the first successful call
        if (!this.positionsLoggedOnce && positions.length > 0) {
          this.positionsLoggedOnce = true;
          logger.info(
            `API /positions first success: status=${resp.status}, count=${positions.length}, ` +
              `keys=[${Object.keys(positions[0]).join(", ")}]`,
          );
          logger.info(
            `API /positions sample: ${JSON.stringify(positions[0]).slice(0, 500)}`,
          );
        }

        allPositions.push(...positions);

        // If we got fewer than PAGE_SIZE, we've reached the end
        if (positions.length < PAGE_SIZE) break;

        // Small delay between pages to respect rate limits
        await new Promise((r) => setTimeout(r, 300));
      }

      if (allPositions.length > 0) {
        logger.debug(
          `API /positions total for ${walletAddress.slice(0, 8)}…: ${allPositions.length} position(s)`,
        );
      }

      return allPositions;
    } catch (err) {
      const axiosErr = err as {
        response?: { status?: number; data?: unknown };
      };
      logger.error(
        `Error fetching positions for ${walletAddress}: ${err}` +
          (axiosErr.response
            ? ` (status=${axiosErr.response.status}, body=${JSON.stringify(axiosErr.response.data).slice(0, 200)})`
            : ""),
      );
      // Return whatever we've collected so far (partial data is better than none)
      return allPositions;
    }
  }
  /**
   * Quick connectivity test – try hitting the Gamma API and CLOB API.
   * Returns a summary string for startup diagnostics.
   */
  async connectivityTest(): Promise<string> {
    const results: string[] = [];

    // Test Gamma API
    try {
      const resp = await this.gamma.get("/markets", {
        params: { limit: 1, active: true },
      });
      const markets = Array.isArray(resp.data) ? resp.data : [];
      results.push(`Gamma API: ✅ (${markets.length} market(s))`);
    } catch (err) {
      results.push(`Gamma API: ❌ (${err})`);
    }

    // Test CLOB API
    try {
      const resp = await this.clob.get("/time");
      results.push(`CLOB API: ✅ (server_time=${resp.data})`);
    } catch (err) {
      results.push(`CLOB API: ❌ (${err})`);
    }

    // Test Data API
    try {
      const resp = await this.data.get("/activity", {
        params: { user: "0x0000000000000000000000000000000000000000" },
      });
      results.push(
        `Data API: ✅ (status=${resp.status}, isArray=${Array.isArray(resp.data)})`,
      );
    } catch (err) {
      const axiosErr = err as { response?: { status?: number } };
      results.push(
        `Data API: ❌ (status=${axiosErr.response?.status ?? "?"}, ${err})`,
      );
    }

    return results.join("\n  ");
  }

  /**
   * Fetch the endDate for a specific token from a wallet's positions.
   * Returns the end date string (e.g. "2026-03-25") or null if not found.
   */
  async getTokenEndDate(
    walletAddress: string,
    tokenId: string,
  ): Promise<string | null> {
    try {
      const positions = await this.getUserPositions(walletAddress);
      for (const pos of positions) {
        const asset = String(pos.asset || pos.asset_id || pos.token_id || "");
        if (asset === tokenId && pos.endDate) {
          return String(pos.endDate);
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const polymarketApi = new PolymarketAPI();
