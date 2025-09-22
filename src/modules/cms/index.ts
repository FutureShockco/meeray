import { Db, ObjectId } from 'mongodb';
import logger from '../../logger.js';
import { SteemBlock } from '../../steemParser.js';

// Interface for CMS Posts
export interface CmsPost {
    _id?: ObjectId;
    steemTag: string;         // The Steem post identifier
    author: string;          // Author of the post
    permlink: string;        // Permlink of the post
    title: string;           // Title of the post
    body: string;            // Body/content of the post
    category: string;        // Category/tag of the post
    timestamp: number;       // Timestamp when post was created/updated
    json_metadata?: any;     // Additional metadata from the post
    createdAt: Date;         // When this entry was stored in our database
}

// Interface for CMS configuration
export interface CmsConfig {
    enabled: boolean;
    tags: string[];      // List of Steem Tags to track for CMS content
}

// Extended operation data for Steem comment operations
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
let cmsConfig: CmsConfig = {
    enabled: false,
    tags: []
};

export const cms = {
    /**
     * Initialize the CMS module
     * @param db MongoDB database instance
     * @param config Optional CMS configuration
     */
    init: async (db: Db, config?: Partial<CmsConfig>): Promise<void> => {
        try {
            dbInstance = db;
            
            // Set configuration
            if (config) {
                if (config.enabled !== undefined) {
                    cmsConfig.enabled = config.enabled;
                }
                if (config.tags) {
                    cmsConfig.tags = config.tags;
                }
            }

            // Create necessary MongoDB indexes if they don't exist
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

    /**
     * Add a Steem Tag to track for CMS content
     * @param steemTag The Steem Tag to track
     */
    addSteemTag: (steemTag: string): void => {
        if (steemTag && !cmsConfig.tags.includes(steemTag)) {
            cmsConfig.tags.push(steemTag);
            logger.info(`[CMS] Added Steem ID to track: ${steemTag}`);
        }
    },

    /**
     * Remove a Steem ID from tracking
     * @param steemTag The Steem ID to stop tracking
     */
    removeSteemTag: (steemTag: string): void => {
        if (steemTag && cmsConfig.tags.includes(steemTag)) {
            cmsConfig.tags = cmsConfig.tags.filter(id => id !== steemTag);
            logger.info(`[CMS] Removed Steem ID from tracking: ${steemTag}`);
        }
    },

    /**
     * Get the current CMS configuration
     */
    getConfig: (): CmsConfig => {
        return { ...cmsConfig };
    },

    /**
     * Set whether the CMS module is enabled
     * @param enabled Enable or disable the CMS module
     */
    setEnabled: (enabled: boolean): void => {
        cmsConfig.enabled = enabled;
        logger.info(`[CMS] Module ${enabled ? 'enabled' : 'disabled'}`);
    },

    /**
     * Process a Steem block for CMS content
     * @param steemBlock The Steem block to process
     * @param blockNum The block number
     */
    processBlock: async (steemBlock: SteemBlock, blockNum: number): Promise<void> => {
        if (!cmsConfig.enabled || cmsConfig.tags.length === 0 || !dbInstance) {
            return;
        }

        try {
            // Process each transaction in the block
            for (const tx of steemBlock.transactions) {
                for (const op of tx.operations) {
                    try {
                        const [opType, opDataRaw] = op;
                        
                        // Check if this is a comment operation (post or comment)
                        if (opType === 'comment') {
                            // Cast to our extended comment operation type
                            const opData = opDataRaw as unknown as SteemCommentOperationData;
                            
                            // Ignore comment replies (we only want posts)
                            if (opData.parent_author !== '') {
                                continue;
                            }
                            
                            // Parse JSON metadata if available
                            let jsonMetadata: any = {};
                            if (opData.json_metadata) {
                                try {
                                    jsonMetadata = JSON.parse(opData.json_metadata);
                                } catch (e) {
                                    logger.warn(`[CMS] Failed to parse JSON metadata in block ${blockNum} for post ${opData.author}/${opData.permlink}`);
                                }
                            }
                            
                            // Check if this post is tagged with one of our tracked Steem IDs
                            const tags = jsonMetadata.tags || [];
                            const shouldStore = cmsConfig.tags.some(id => 
                                tags.includes(id) || 
                                (opData.parent_permlink && opData.parent_permlink === id)
                            );
                            
                            if (shouldStore) {
                                // Store the post in our CMS collection
                                const cmsPost: CmsPost = {
                                    steemTag: opData.parent_permlink,
                                    author: opData.author,
                                    permlink: opData.permlink,
                                    title: opData.title,
                                    body: opData.body,
                                    category: opData.parent_permlink,
                                    timestamp: new Date(steemBlock.timestamp + 'Z').getTime(),
                                    json_metadata: jsonMetadata,
                                    createdAt: new Date()
                                };
                                
                                // Upsert in case this is an update to an existing post
                                await dbInstance.collection<CmsPost>('cms_posts').updateOne(
                                    { author: cmsPost.author, permlink: cmsPost.permlink },
                                    { $set: cmsPost },
                                    { upsert: true }
                                );
                                
                                logger.info(`[CMS] Stored post: ${cmsPost.author}/${cmsPost.permlink} for Steem ID: ${cmsPost.steemTag}`);
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
    }
};

export default cms;