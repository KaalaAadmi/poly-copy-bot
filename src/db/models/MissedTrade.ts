import mongoose, { Schema, Document } from "mongoose";

export type MissedTradeStatus = "pending" | "executed" | "expired";

export interface IMissedTrade extends Document {
  /** Unique key to prevent duplicates: polymarket_trade_id or synthetic catchup ID */
  signal_id: string;

  /** The whale wallet that originated the signal */
  whale_wallet: string;

  /** Token the whale bought */
  token_id: string;

  /** Condition ID for the market */
  condition_id: string;

  /** Human-readable market question */
  question: string;

  /** Market slug for URL building */
  market_slug: string;

  /** Direction the whale bet (Yes / No) */
  direction: "Yes" | "No";

  /** Whale's entry price at the time of the signal */
  whale_entry_price: number;

  /** Whale's USDC bet size (for conviction sizing) */
  whale_usdc_size: number;

  /** Whether this came from the poller (copy) or catchup service */
  trade_type: "copy" | "catchup";

  /** Status: pending = waiting for funds, executed = successfully traded, expired = 24h FIFO cleanup */
  status: MissedTradeStatus;

  /** When we first missed this trade */
  missed_at: Date;

  /** When it was executed or expired (null while pending) */
  resolved_at: Date | null;

  /** The full original activity JSON, so we can re-process if needed */
  original_activity: Record<string, unknown>;
}

const MissedTradeSchema = new Schema<IMissedTrade>(
  {
    signal_id: { type: String, required: true, unique: true },
    whale_wallet: { type: String, required: true, lowercase: true },
    token_id: { type: String, required: true },
    condition_id: { type: String, default: "" },
    question: { type: String, default: "Unknown Market" },
    market_slug: { type: String, default: "" },
    direction: { type: String, enum: ["Yes", "No"], default: "Yes" },
    whale_entry_price: { type: Number, required: true },
    whale_usdc_size: { type: Number, default: 0 },
    trade_type: { type: String, enum: ["copy", "catchup"], default: "copy" },
    status: {
      type: String,
      enum: ["pending", "executed", "expired"],
      default: "pending",
    },
    missed_at: { type: Date, default: Date.now },
    resolved_at: { type: Date, default: null },
    original_activity: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// Index for quick queries
MissedTradeSchema.index({ status: 1, missed_at: 1 });

export const MissedTrade = mongoose.model<IMissedTrade>(
  "MissedTrade",
  MissedTradeSchema,
);
