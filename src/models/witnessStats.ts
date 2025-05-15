import mongoose, { Schema, Document } from 'mongoose';

export interface IWitnessStats extends Document {
  _id: string; // witness name
  sinceTs?: number;
  sinceBlock?: number;
  produced: number;
  missed: number;
  voters: number;
  last: number;
}

const WitnessStatsSchema = new Schema({
  _id: { type: String, required: true },
  sinceTs: { type: Number, default: 0 },
  sinceBlock: { type: Number, default: 0 },
  produced: { type: Number, default: 0 },
  missed: { type: Number, default: 0 },
  voters: { type: Number, default: 0 },
  last: { type: Number, default: 0 },
}, { versionKey: false });

export const WitnessStatsModel = mongoose.model<IWitnessStats>('WitnessStats', WitnessStatsSchema);

export default WitnessStatsModel; 