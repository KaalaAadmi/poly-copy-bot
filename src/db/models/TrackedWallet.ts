import mongoose, { Schema, Document } from "mongoose";

export interface ITrackedWallet extends Document {
  wallet_address: string;
  label: string;
  date_added: Date;
  active_status: boolean;
}

const TrackedWalletSchema = new Schema<ITrackedWallet>(
  {
    wallet_address: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    label: { type: String, default: "" },
    date_added: { type: Date, default: Date.now },
    active_status: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const TrackedWallet = mongoose.model<ITrackedWallet>(
  "TrackedWallet",
  TrackedWalletSchema,
);
