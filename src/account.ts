import { ParsedTransaction } from './steemParser.js';
import { Transaction } from './transactions/index.js';
import cache from './cache.js';
import logger from './logger.js';
import mongo from './mongo.js';
import { AccountDoc } from './mongo.js';
import { toDbString } from './utils/bigint.js';
import config from './config.js';

const possibleAccountFields = ['target', 'receiver', 'owner', 'delegate', 'to', 'from', 'account'];

export async function upsertAccountsReferencedInTx(tx: ParsedTransaction | Transaction): Promise<void> {
  const usernamesInTx = new Set<string>();

  if (tx.sender && typeof tx.sender === 'string' && tx.sender.trim() !== '') {
    usernamesInTx.add(tx.sender.trim());
  }

  const fieldsToScan = possibleAccountFields || [];

  for (const field of fieldsToScan) {
    if (tx.data && typeof tx.data[field] === 'string' && tx.data[field].trim() !== '') {
      usernamesInTx.add(tx.data[field].trim());
    }
  }
  const uniqueUsernames = Array.from(usernamesInTx);

  for (const username of uniqueUsernames) {
    if (!username) continue;

    logger.debug(`Ensuring account exists: ${username}`);

    let accountFromCache: AccountDoc | undefined | null = cache.accounts[username] as (AccountDoc | undefined | null);
    let accountFromDb: AccountDoc | null = null;

    if (!accountFromCache) {
      try {
        accountFromDb = await mongo.getDb().collection<AccountDoc>('accounts').findOne({ name: username });
        if (accountFromDb) {
          cache.accounts[username] = accountFromDb;
          logger.debug(`Cache updated for ${username} with data from DB.`);
        }
      } catch (dbError) {
        logger.error(`Error fetching account ${username} from DB:`, dbError);
        throw dbError;
      }
    }

    const finalAccountState = cache.accounts[username] || accountFromDb;

    if (!finalAccountState) {
      const newAccountData: AccountDoc = {
        name: username,
        created: new Date(),
        balances: { [config.nativeTokenSymbol]: toDbString(BigInt(0)) },
        nfts: {},
        totalVoteWeight: toDbString(BigInt(0)),
        votedWitnesses: []
      };
      try {
        const insertResult = await mongo.getDb().collection<AccountDoc>('accounts').insertOne(newAccountData);
        if (!insertResult.insertedId) {
          logger.error(`Failed to insert new account ${username} into DB, no insertedId returned.`);
          throw new Error(`DB insert failed for ${username}`);
        }
        cache.accounts[username] = newAccountData;
        logger.debug(`New account ${username} inserted into DB and live cache populated.`);
      } catch (insertError) {
        logger.error(`Failed to insert new account ${username} into DB or update cache:`, insertError);
        throw insertError;
      }
    } else {
      logger.debug(`Account ${username} already exists in cache or DB.`);
    }
  }
}
