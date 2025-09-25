import { Db, ObjectId } from 'mongodb';

import logger from '../../logger.js';
import { SteemBlock } from '../../steemParser.js';

export interface CmsPost {
    _id?: ObjectId;
    author: string;
    permlink: string;
    title: string;
    body: string;
    category: string;
    timestamp: number;
    json_metadata?: any;
    tags: string;
    createdAt: Date;
}

export interface CmsConfig {
    enabled: boolean;
    tags: string[]; // List of Steem Tags to track for CMS content
}

interface SteemCommentOperationData {
    parent_author: string;
    parent_permlink: string;
    author: string;
    permlink: string;
    title: string;
    body: string;
    json_metadata: string;
}

let dbInstance: Db | null = null;
const cmsConfig: CmsConfig = {
    enabled: false,
    tags: [],
};

export const cms = {
    init: async (db: Db, config?: Partial<CmsConfig>): Promise<void> => {
        try {
            dbInstance = db;
            if (config) {
                if (config.enabled !== undefined) {
                    cmsConfig.enabled = config.enabled;
                }
                if (config.tags) {
                    cmsConfig.tags = config.tags;
                }
            }
            if (dbInstance && cmsConfig.enabled) {
                await dbInstance.collection<CmsPost>('cms_posts').createIndex({ steemTag: 1 });
                await dbInstance.collection<CmsPost>('cms_posts').createIndex({ author: 1 });
                await dbInstance.collection<CmsPost>('cms_posts').createIndex({ permlink: 1 });
                await dbInstance.collection<CmsPost>('cms_posts').createIndex({ timestamp: 1 });

                logger.info('[CMS] Module initialized with config:', cmsConfig);
            } else {
                logger.info('[CMS] Module disabled or database not available');
            }
        } catch (error) {
            logger.error('[CMS] Initialization error:', error);
        }
    },
    addSteemTag: (steemTag: string): void => {
        if (steemTag && !cmsConfig.tags.includes(steemTag)) {
            cmsConfig.tags.push(steemTag);
            logger.info(`[CMS] Added Steem ID to track: ${steemTag}`);
        }
    },
    removeSteemTag: (steemTag: string): void => {
        if (steemTag && cmsConfig.tags.includes(steemTag)) {
            cmsConfig.tags = cmsConfig.tags.filter(id => id !== steemTag);
            logger.info(`[CMS] Removed Steem ID from tracking: ${steemTag}`);
        }
    },
    getConfig: (): CmsConfig => {
        return { ...cmsConfig };
    },
    setEnabled: (enabled: boolean): void => {
        cmsConfig.enabled = enabled;
        logger.info(`[CMS] Module ${enabled ? 'enabled' : 'disabled'}`);
    },
    processBlock: async (steemBlock: SteemBlock, blockNum: number): Promise<void> => {
        if (!cmsConfig.enabled || cmsConfig.tags.length === 0 || !dbInstance) {
            return;
        }

        try {
            for (const tx of steemBlock.transactions) {
                for (const op of tx.operations) {
                    try {
                        const [opType, opDataRaw] = op;
                        if (opType === 'comment') {
                            const opData = opDataRaw as unknown as SteemCommentOperationData;
                            if (opData.parent_author !== '') {
                                continue;
                            }
                            let jsonMetadata: any = {};
                            if (opData.json_metadata) {
                                try {
                                    jsonMetadata = JSON.parse(opData.json_metadata);
                                } catch {
                                    logger.warn(`[CMS] Failed to parse JSON metadata in block ${blockNum} for post ${opData.author}/${opData.permlink}`);
                                }
                            }
                            const tags = jsonMetadata.tags || [];
                            const shouldStore = cmsConfig.tags.some(id => tags.includes(id) || (opData.parent_permlink && opData.parent_permlink === id));
                            if (shouldStore) {
                                const cmsPost: CmsPost = {
                                    tags: tags,
                                    author: opData.author,
                                    permlink: opData.permlink,
                                    title: opData.title,
                                    body: opData.body,
                                    category: opData.parent_permlink,
                                    timestamp: new Date(steemBlock.timestamp + 'Z').getTime(),
                                    json_metadata: jsonMetadata,
                                    createdAt: new Date(),
                                };
                                await dbInstance
                                    .collection<CmsPost>('cms_posts')
                                    .updateOne({ author: cmsPost.author, permlink: cmsPost.permlink }, { $set: cmsPost }, { upsert: true });

                                logger.info(`[CMS] Stored post: ${cmsPost.author}/${cmsPost.permlink} for Steem ID: ${cmsPost.tags}`);
                            }
                        }
                    } catch (error) {
                        logger.error(`[CMS] Error processing operation in block ${blockNum}:`, error);
                    }
                }
            }
        } catch (error) {
            logger.error(`[CMS] Error processing block ${blockNum}:`, error);
        }
    },
};

export default cms;
