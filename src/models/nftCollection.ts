import mongoose, { Schema, Document } from 'mongoose';

export interface INFTCollection extends Document {
  symbol: string;
  name: string;
  creator: string;
  created: number;
  metadata: Record<string, any>;
}

const NFTCollectionSchema = new Schema<INFTCollection>({
  symbol: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { versionKey: false });

export const NFTCollection = mongoose.model<INFTCollection>('NFTCollection', NFTCollectionSchema); 