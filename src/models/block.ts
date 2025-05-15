import mongoose, { Schema, Document } from 'mongoose';

export interface IBlock extends Document {
  _id: number;
  blockNum: number;
  steemBlockNum: number;
  steemBlockTimestamp: number;
  phash: string;
  timestamp: number;
  txs: any[];
  witness: string;
  missedBy?: string;
  dist?: number;
  signature?: string;
  hash: string;
  sync: boolean;
}

const BlockSchema = new Schema<IBlock>({
  _id: { type: Number, required: true },
  blockNum: { type: Number, required: true, index: true },
  steemBlockNum: { type: Number, required: true },
  steemBlockTimestamp: { type: Number, required: true },
  hash: { type: String, required: true },
  phash: { type: String, required: true },
  timestamp: { type: Number, required: true },
  witness: { type: String, required: true },
  txs: { type: [{ type: Schema.Types.Mixed }], default: [] },
  dist: { type: Number },
  signature: { type: String },
  sync: { type: Boolean, default: false }
}, { versionKey: false });

export const BlockModel = mongoose.model<IBlock>('Block', BlockSchema); 