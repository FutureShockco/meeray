import mongoose, { Schema, Document } from 'mongoose';

export interface IConfigChange extends Document {
  key: string;
  value: any;
  effectiveBlock: number;
  proposer: string;
  created: number;
}

const ConfigChangeSchema = new Schema<IConfigChange>({
  key: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  effectiveBlock: { type: Number, required: true },
  proposer: { type: String, required: true },
  created: { type: Number, required: true }
}, { versionKey: false });

export const ConfigChange = mongoose.model<IConfigChange>('ConfigChange', ConfigChangeSchema); 