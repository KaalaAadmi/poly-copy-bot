import mongoose, { Schema, Document } from "mongoose";

export interface IProcessedSignal extends Document {
  polymarket_trade_id: string;
  wallet_address: string;
  timestamp_processed: Date;
}

const ProcessedSignalSchema = new Schema<IProcessedSignal>(
  {
    polymarket_trade_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    wallet_address: { type: String, required: true, lowercase: true },
    timestamp_processed: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const ProcessedSignal = mongoose.model<IProcessedSignal>(
  "ProcessedSignal",
  ProcessedSignalSchema,
);
