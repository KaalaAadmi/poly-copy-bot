import mongoose, { Schema, Document } from "mongoose";

export interface ISystemState extends Document {
  current_balance: number;
  daily_starting_balance: number;
  initial_balance: number;
  last_daily_reset: Date;
  live_mode: boolean;
}

const SystemStateSchema = new Schema<ISystemState>(
  {
    current_balance: { type: Number, required: true },
    daily_starting_balance: { type: Number, required: true },
    initial_balance: { type: Number, required: true },
    last_daily_reset: { type: Date, required: true, default: Date.now },
    live_mode: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const SystemState = mongoose.model<ISystemState>(
  "SystemState",
  SystemStateSchema,
);
