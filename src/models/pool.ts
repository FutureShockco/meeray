import mongoose, { Schema, Document } from 'mongoose';

export interface IPool extends Document {
  _id: string;
  token0: string;
  token1: string;
  pairKey: string;
  reserve0: number;
  reserve1: number;
  totalLiquidity: number;
  creator: string;
  created: number;
  fee: number;
}

const PoolSchema = new Schema<IPool>({
  _id: { type: String, required: true },
  token0: { type: String, required: true },
  token1: { type: String, required: true },
  pairKey: { type: String, required: true, index: true },
  reserve0: { type: Number, default: 0 },
  reserve1: { type: Number, default: 0 },
  totalLiquidity: { type: Number, default: 0 },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  fee: { type: Number, required: true }
}, { versionKey: false });

export const PoolModel = mongoose.model<IPool>('Pool', PoolSchema); 