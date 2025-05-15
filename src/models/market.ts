import mongoose, { Schema, Document } from 'mongoose';

export interface IMarket extends Document {
  marketId: string;
  baseToken: string;
  quoteToken: string;
  type: string;
  creator: string;
  created: number;
  metadata: Record<string, any>;
}

const MarketSchema = new Schema<IMarket>({
  marketId: { type: String, required: true, unique: true, index: true },
  baseToken: { type: String, required: true },
  quoteToken: { type: String, required: true },
  type: { type: String, required: true },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { versionKey: false });

export const Market = mongoose.model<IMarket>('Market', MarketSchema); 