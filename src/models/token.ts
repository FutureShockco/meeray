import mongoose, { Schema, Document } from 'mongoose';

export interface IToken extends Document {
  symbol: string;
  name: string;
  supply: number;
  creator: string;
  created: number;
  decimals: number;
}

const TokenSchema = new Schema<IToken>({
  symbol: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  supply: { type: Number, default: 0 },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  decimals: { type: Number, default: 0 }
}, { versionKey: false });

export const TokenModel = mongoose.model<IToken>('Token', TokenSchema); 