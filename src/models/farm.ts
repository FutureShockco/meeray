import mongoose, { Schema, Document } from 'mongoose';

export interface IFarm extends Document {
  farmId: string;
  token: string;
  rewardToken: string;
  creator: string;
  created: number;
  totalStaked: number;
  rewardRate: number;
  metadata: Record<string, any>;
}

const FarmSchema = new Schema<IFarm>({
  farmId: { type: String, required: true, unique: true, index: true },
  token: { type: String, required: true },
  rewardToken: { type: String, required: true },
  creator: { type: String, required: true },
  created: { type: Number, required: true },
  totalStaked: { type: Number, default: 0 },
  rewardRate: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { versionKey: false });

export const Farm = mongoose.model<IFarm>('Farm', FarmSchema); 