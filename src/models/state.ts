import mongoose, { Schema, Document } from 'mongoose';

export interface IState extends Document {
  _id: number;
  headBlock: number;
}

const StateSchema = new Schema({
  _id: { type: Number, required: true },
  headBlock: { type: Number, required: true },
}, { versionKey: false });

export const StateModel = mongoose.model<IState>('State', StateSchema);

export default StateModel; 