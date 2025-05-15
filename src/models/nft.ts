import mongoose, { Schema, Document } from 'mongoose';

export interface INFT extends Document {
  tokenId: string;
  symbol: string;
  owner: string;
  creator: string;
  created: number;
  metadata: Record<string, any>;
}

const NFTSchema = new Schema<INFT>({
  tokenId: { type: String, required: true, unique: true, index: true },
  symbol: { type: String, required: true },
  owner: { type: String, required: true },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { versionKey: false });

export const NFTModel = mongoose.model<INFT>('NFT', NFTSchema); 