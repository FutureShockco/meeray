import mongoose, { Schema, Document } from 'mongoose';

export interface IEvent extends Document {
  type: string;
  txHash?: string;
  blockNum?: number;
  data: Record<string, any>;
  timestamp: number;
}

const EventSchema = new Schema<IEvent>({
  type: { type: String, required: true },
  txHash: { type: String },
  blockNum: { type: Number },
  data: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Number, required: true }
}, { versionKey: false });

export const Event = mongoose.model<IEvent>('Event', EventSchema); 