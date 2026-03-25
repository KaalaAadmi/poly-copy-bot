import mongoose, { Schema, Document } from "mongoose";

export type TradeStatus = "Open" | "Resolved_Won" | "Resolved_Lost" | "Exited";
export type TradeDirection = "Yes" | "No";
export type TradeType = "copy" | "catchup";

export interface IPaperTrade extends Document {
  internal_trade_id: string;
  contract_id: string;
  condition_id: string;
  market_slug: string;
  question: string;
  direction: TradeDirection;
  trade_type: TradeType;
  paper_investment_amount: number;
  num_shares: number;
  entry_price: number;
  exit_price: number | null;
  status: TradeStatus;
  whale_wallet: string;
  token_id: string;
  pnl: number;
  opened_at: Date;
  resolved_at: Date | null;
  is_live: boolean;
  live_order_id: string;
  event_end_date: Date | null;
}

const PaperTradeSchema = new Schema<IPaperTrade>(
  {
    internal_trade_id: { type: String, required: true, unique: true },
    contract_id: { type: String, required: true },
    condition_id: { type: String, default: "" },
    market_slug: { type: String, default: "" },
    question: { type: String, default: "Unknown Market" },
    direction: {
      type: String,
      enum: ["Yes", "No"],
      required: true,
    },
    trade_type: {
      type: String,
      enum: ["copy", "catchup"],
      default: "copy",
    },
    paper_investment_amount: { type: Number, required: true },
    num_shares: { type: Number, required: true },
    entry_price: { type: Number, required: true },
    exit_price: { type: Number, default: null },
    status: {
      type: String,
      enum: ["Open", "Resolved_Won", "Resolved_Lost", "Exited"],
      default: "Open",
    },
    whale_wallet: { type: String, required: true, lowercase: true },
    token_id: { type: String, required: true },
    pnl: { type: Number, default: 0 },
    opened_at: { type: Date, default: Date.now },
    resolved_at: { type: Date, default: null },
    is_live: { type: Boolean, default: false },
    live_order_id: { type: String, default: "" },
    event_end_date: { type: Date, default: null },
  },
  { timestamps: true },
);

export const PaperTrade = mongoose.model<IPaperTrade>(
  "PaperTrade",
  PaperTradeSchema,
);
