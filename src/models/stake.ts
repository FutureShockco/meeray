import mongoose, { Schema, Document } from 'mongoose';

export interface IStake extends Document {
  stakeId: string;
  farmId: string;
  staker: string;
  amount: number;
  rewardDebt: number;
  created: number;
  updated: number;
  metadata: Record<string, any>;
}

const StakeSchema = new Schema<IStake>({
  stakeId: { type: String, required: true, unique: true, index: true },
  farmId: { type: String, required: true },
  staker: { type: String, required: true },
  amount: { type: Number, required: true },
  rewardDebt: { type: Number, default: 0 },
  created: { type: Number, required: true },
  updated: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { versionKey: false });

export const Stake = mongoose.model<IStake>('Stake', StakeSchema); 