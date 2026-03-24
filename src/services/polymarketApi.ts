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
  [key: string]: unknown;
}

export interface UserActivity {
  id: string;
  type: string; // "TRADE", "SPLIT", "MERGE", etc.
  conditionId: string;
  asset: string; // token ID
  side: string; // "BUY" | "SELL"
  size: string;
  price: string;
  timestamp: number;
  transactionHash: string;
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
   */
  async getMarketByConditionId(
    conditionId: string,
  ): Promise<GammaMarket | null> {
    try {
      const resp = await this.gamma.get("/markets", {
        params: { condition_id: conditionId, limit: 1 },
      });
      const markets: GammaMarket[] = resp.data;
      return markets.length > 0 ? markets[0] : null;
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
      return markets.length > 0 ? markets[0] : null;
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

  /**
   * Fetch recent trading activity for a wallet address.
   * This is the core method the Poller uses to detect whale trades.
   */
  async getUserActivity(walletAddress: string): Promise<UserActivity[]> {
    try {
      const url = `/activity`;
      logger.info(
        `API → GET ${config.dataApiUrl}${url}?user=${walletAddress.slice(0, 10)}…`,
      );

      const resp = await this.data.get(url, {
        params: { user: walletAddress.toLowerCase() },
      });

      logger.info(
        `API ← /activity status=${resp.status}, ` +
          `type=${typeof resp.data}, isArray=${Array.isArray(resp.data)}, ` +
          `length=${Array.isArray(resp.data) ? resp.data.length : "N/A"}`,
      );

      // Log a sample of what we got back (first 300 chars)
      if (resp.data && !Array.isArray(resp.data)) {
        logger.info(
          `API ← /activity body sample: ${JSON.stringify(resp.data).slice(0, 300)}`,
        );
      }

      // The API may return the data at different paths
      const activities: UserActivity[] = Array.isArray(resp.data)
        ? resp.data
        : (resp.data?.history ?? resp.data?.data ?? []);

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
   * Fetch current positions for a wallet address.
   */
  async getUserPositions(
    walletAddress: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const url = `/positions`;
      logger.info(
        `API → GET ${config.dataApiUrl}${url}?user=${walletAddress.slice(0, 10)}…`,
      );

      const resp = await this.data.get(url, {
        params: { user: walletAddress.toLowerCase() },
      });

      const positions = Array.isArray(resp.data)
        ? resp.data
        : (resp.data?.positions ?? []);

      logger.info(
        `API ← /positions status=${resp.status}, count=${positions.length}`,
      );

      // Log sample position keys on first non-empty response
      if (positions.length > 0) {
        logger.info(
          `API ← /positions sample keys: ${Object.keys(positions[0]).join(", ")}`,
        );
        logger.info(
          `API ← /positions sample: ${JSON.stringify(positions[0]).slice(0, 400)}`,
        );
      }

      return positions;
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
      return [];
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
      const resp = await this.clob.get("/midpoint", {
        params: {
          token_id:
            "71321045679252212594626385532706912750332728571942532289631379312455583992563",
        },
      });
      results.push(`CLOB API: ✅ (midpoint=${resp.data?.mid ?? "?"})`);
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
}

export const polymarketApi = new PolymarketAPI();
