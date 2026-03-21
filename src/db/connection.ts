import mongoose from "mongoose";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    logger.info("Connected to MongoDB successfully");
  } catch (error) {
    logger.error("Failed to connect to MongoDB", error);
    process.exit(1);
  }
}
