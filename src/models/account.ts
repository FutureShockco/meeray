import mongoose, { Schema, Document } from 'mongoose';
import { ParsedTransaction } from '../steemParser.js';
import { Transaction } from '../transactions/index.js';

export interface IAccount extends Document {
  _id: string;
  name: string;
  tokens?: Record<string, number>;
  nfts?: Record<string, any>;
  witnessVotes?: number;
  votedWitnesses?: string[];
  witnessPublicKey?: string;
  created: Date;
}

const AccountSchema = new Schema({
  _id: { type: String, required: true }, // Account name
  name: { type: String, required: true },
  tokens: { type: Object, default: { ECH: 0 } },
  nfts: { type: Object, default: {} },
  witnessVotes: { type: Number, default: 0 }, // Total votes received for witness
  votedWitnesses: { type: [String], default: [] }, // List of witnesses this account has voted for
  witnessPublicKey: { type: String, default: null }, // Public key for witness duties
  created: { type: Date, default: Date.now }
}, { versionKey: false }); // Disable versioning

export const Account = mongoose.model<IAccount>('Account', AccountSchema);

const possibleAccountFields = ['target', 'user', 'receiver', 'account', 'delegatee', 'from', 'to'];

export function extractUsernamesFromTx(tx: ParsedTransaction | Transaction): string[] {
  const usernames = new Set<string>();
  usernames.add(tx.sender);
  for (const field of possibleAccountFields) {
    if (tx.data && tx.data[field]) {
      usernames.add(tx.data[field]);
    }
  }
  return Array.from(usernames);
}

export async function upsertAccounts(usernames: string[]) {
  const now = new Date();
  for (const name of usernames) {
    await Account.updateOne(
      { _id: name },
      {
        $setOnInsert: {
          _id: name,
          createdAt: now,
          tokens: {},
          nfts: {},
          witnessVotes: 0,
          votedWitnesses: []
        }
      },
      { upsert: true }
    );
  }
} 