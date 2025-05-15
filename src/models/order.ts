import mongoose, { Schema, Document } from 'mongoose';

export interface IOrder extends Document {
  orderId: string;
  marketId: string;
  owner: string;
  side: string;
  price: number;
  amount: number;
  filled: number;
  status: string;
  created: number;
  updated: number;
}

const OrderSchema = new Schema<IOrder>({
  orderId: { type: String, required: true, unique: true, index: true },
  marketId: { type: String, required: true },
  owner: { type: String, required: true },
  side: { type: String, required: true },
  price: { type: Number, required: true },
  amount: { type: Number, required: true },
  filled: { type: Number, default: 0 },
  status: { type: String, required: true },
  created: { type: Number, required: true },
  updated: { type: Number, required: true }
}, { versionKey: false });

export const Order = mongoose.model<IOrder>('Order', OrderSchema); 