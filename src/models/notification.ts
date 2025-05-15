import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  u: string;
  tx: any;
  ts: number;
}

const NotificationSchema = new Schema<INotification>({
  u: { type: String, required: true },
  tx: { type: Schema.Types.Mixed, required: true },
  ts: { type: Number, required: true }
}, { versionKey: false });

export const NotificationModel = mongoose.model<INotification>('Notification', NotificationSchema); 