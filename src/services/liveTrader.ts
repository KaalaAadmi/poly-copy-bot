import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { polymarketApi } from "./polymarketApi.js";

type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

/**
 * LiveTrader – Manages the authenticated Polymarket CLOB client
 * for placing real orders and querying on-chain positions/PnL.
 *
 * Only initialised when the user enables live trading mode (/golive).
 * The CLOB client requires a private key for EIP-712 order signing
 * and L2 HMAC credentials for API authentication.
 */

export interface LiveOrderResult {
  success: boolean;
  orderID: string;
  status: string;
  errorMsg: string;
}

export interface LivePosition {
  asset: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  currentPrice: number;
  unrealisedPnl: number;
  market: string;
  outcome: string;
  [key: string]: unknown;
}

export class LiveTrader {
  private client: ClobClient | null = null;
  private signer: Wallet | null = null;
  private ready = false;

  /**
   * Initialise the CLOB client with the user's private key.
   * Must be called before any live trading operation.
   */
  async init(): Promise<boolean> {
    if (!config.privateKey) {
      logger.error("LiveTrader: POLYMARKET_PRIVATE_KEY is not set");
      return false;
    }

    try {
      this.signer = new Wallet(config.privateKey);

      // Step 1: derive L2 API credentials
      const tempClient = new ClobClient(config.clobApiUrl, 137, this.signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();

      // Step 2: initialise the full trading client
      const funder = config.funderAddress || this.signer.address;
      this.client = new ClobClient(
        config.clobApiUrl,
        137,
        this.signer,
        apiCreds,
        config.signatureType,
        funder,
      );

      this.ready = true;
      logger.info(
        `LiveTrader initialised – wallet: ${this.signer.address}, funder: ${funder}, sigType: ${config.signatureType}`,
      );
      return true;
    } catch (err) {
      logger.error(`LiveTrader init failed: ${err}`);
      this.ready = false;
      return false;
    }
  }

  isReady(): boolean {
    return this.ready && this.client !== null;
  }

  getWalletAddress(): string {
    return this.signer?.address ?? "";
  }

  // ──────────────────────────────────────────────────────
  // Balance
  // ──────────────────────────────────────────────────────

  /**
   * Fetch the bot wallet's USDC balance from the Polymarket Data API.
   * Returns the balance in dollars, or null if unavailable.
   */
  async getUsdcBalance(): Promise<number | null> {
    const walletAddress = config.funderAddress || this.signer?.address || "";
    if (!walletAddress) return null;

    try {
      const { default: axiosDefault } = await import("axios");
      // Try the balance endpoint
      const resp = await axiosDefault.get(`${config.dataApiUrl}/balance`, {
        params: { user: walletAddress.toLowerCase() },
        timeout: 10_000,
      });
      const data = resp.data;
      // The API might return { balance: "123.45" } or similar
      const balance = parseFloat(
        String(data?.balance ?? data?.usdc ?? data?.available ?? "0"),
      );
      if (!isNaN(balance) && balance > 0) {
        return balance;
      }
      return null;
    } catch (err) {
      logger.warn(`getUsdcBalance: could not fetch balance – ${err}`);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────
  // Order placement
  // ──────────────────────────────────────────────────────

  /**
   * Place a live limit-buy order on Polymarket at the current market price.
   *
   * Uses GTC (Good-Til-Cancelled) with price set at the current best ask
   * so it fills immediately like a market order. `amount` is the dollar
   * amount to spend (USDC), and `numShares` is the computed share count.
   *
   * @param tokenId  – The CLOB token ID (Yes or No token)
   * @param numShares – Number of shares to buy
   * @param price    – Limit price per share (should be the current ask)
   * @param tickSize – Market tick size
   * @param negRisk  – Whether this is a neg-risk (multi-outcome) market
   */
  async placeBuyOrder(
    tokenId: string,
    numShares: number,
    price: number,
    tickSize: string,
    negRisk: boolean,
  ): Promise<LiveOrderResult> {
    if (!this.client) {
      return {
        success: false,
        orderID: "",
        status: "",
        errorMsg: "LiveTrader not initialised",
      };
    }

    try {
      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size: numShares,
          side: Side.BUY,
        },
        {
          tickSize: tickSize as TickSize,
          negRisk,
        },
        OrderType.GTC,
      );

      const result: LiveOrderResult = {
        success: response.success !== false,
        orderID: response.orderID || "",
        status: response.status || "",
        errorMsg: response.errorMsg || "",
      };

      if (result.success) {
        logger.info(
          `Live order placed – ID: ${result.orderID}, status: ${result.status}`,
        );
      } else {
        logger.warn(`Live order rejected – ${result.errorMsg}`);
      }

      return result;
    } catch (err) {
      logger.error(`LiveTrader placeBuyOrder error: ${err}`);
      return { success: false, orderID: "", status: "", errorMsg: String(err) };
    }
  }

  // ──────────────────────────────────────────────────────
  // Query positions & PnL from Polymarket
  // ──────────────────────────────────────────────────────

  /**
   * Fetch the bot's own open orders on Polymarket.
   */
  async getOpenOrders(): Promise<unknown[]> {
    if (!this.client) return [];
    try {
      return await this.client.getOpenOrders();
    } catch (err) {
      logger.error(`LiveTrader getOpenOrders error: ${err}`);
      return [];
    }
  }

  /**
   * Fetch the bot's trade history from Polymarket.
   */
  async getTrades(): Promise<unknown[]> {
    if (!this.client) return [];
    try {
      return await this.client.getTrades();
    } catch (err) {
      logger.error(`LiveTrader getTrades error: ${err}`);
      return [];
    }
  }

  /**
   * Fetch live positions and compute unrealised PnL from Polymarket Data API.
   * Returns enriched position objects with current price + unrealised PnL.
   */
  async getLivePositions(): Promise<LivePosition[]> {
    const walletAddress = config.funderAddress || this.signer?.address || "";
    if (!walletAddress) return [];

    try {
      const rawPositions = await polymarketApi.getUserPositions(walletAddress);
      const positions: LivePosition[] = [];

      for (const pos of rawPositions) {
        const asset = String(pos.asset || pos.asset_id || pos.token_id || "");
        const size = String(pos.size || pos.shares || "0");
        const avgPrice = String(
          pos.avg_price || pos.avgPrice || pos.price || "0",
        );
        const conditionId = String(
          pos.conditionId || pos.condition_id || pos.market || "",
        );
        const outcome = String(pos.outcome || "");
        const market = String(
          pos.title || pos.question || pos.market_slug || "",
        );

        if (!asset || parseFloat(size) === 0) continue;

        // Fetch current price for unrealised PnL
        let currentPrice = await polymarketApi.getMidpointPrice(asset);
        if (currentPrice === null) {
          currentPrice = await polymarketApi.getPrice(asset);
        }
        currentPrice = currentPrice ?? 0;

        const shares = parseFloat(size);
        const avg = parseFloat(avgPrice);
        const costBasis = shares * avg;
        const currentValue = shares * currentPrice;
        const unrealisedPnl = currentValue - costBasis;

        positions.push({
          asset,
          conditionId,
          size,
          avgPrice,
          currentPrice,
          unrealisedPnl,
          market,
          outcome,
        });
      }

      return positions;
    } catch (err) {
      logger.error(`LiveTrader getLivePositions error: ${err}`);
      return [];
    }
  }

  /**
   * Fetch closed positions from Polymarket Data API to compute realised PnL.
   */
  async getRealisedPnl(): Promise<{
    totalRealised: number;
    positions: Record<string, unknown>[];
  }> {
    const walletAddress = config.funderAddress || this.signer?.address || "";
    if (!walletAddress) return { totalRealised: 0, positions: [] };

    try {
      const { data } = await (
        await import("axios")
      ).default.get(`${config.dataApiUrl}/closed-positions`, {
        params: { user: walletAddress.toLowerCase() },
      });
      const closedPositions: Record<string, unknown>[] = Array.isArray(data)
        ? data
        : (data?.positions ?? data?.data ?? []);

      let totalRealised = 0;
      for (const pos of closedPositions) {
        const pnl = parseFloat(String(pos.pnl || pos.realized_pnl || "0"));
        totalRealised += pnl;
      }

      return { totalRealised, positions: closedPositions };
    } catch (err) {
      logger.error(`LiveTrader getRealisedPnl error: ${err}`);
      return { totalRealised: 0, positions: [] };
    }
  }
}

export const liveTrader = new LiveTrader();
