import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt } from '../../utils/bigint-utils.js';
import { ObjectId } from 'mongodb';
import { transformTransactionData } from '../../utils/http-helpers.js';

const router: Router = express.Router();

// Helper for pagination
const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

const transformNftCollectionData = (collectionData: any): any => {
    if (!collectionData) return collectionData;
    const transformed = { ...collectionData };
    // _id is collectionSymbol (string), typically no transformation to 'id' needed unless for extreme consistency.

    const numericFields = ['maxSupply', 'currentSupply', 'mintPrice', 'royaltyFeePercentage']; // Added royaltyFeePercentage
    for (const field of numericFields) {
        if (transformed[field] && typeof transformed[field] === 'string') {
            transformed[field] = toBigInt(transformed[field]).toString();
        }
    }
    return transformed;
};

const transformNftInstanceData = (instanceData: any): any => {
    if (!instanceData) return instanceData;
    const transformed = { ...instanceData };
    // _id is nftId (string, e.g. SYMBOL-001), typically no transformation to 'id' needed.

    // instanceId is likely already a number, but if it could be a numeric string:
    // if (transformed.instanceId && typeof transformed.instanceId === 'string') {
    //     transformed.instanceId = toBigInt(transformed.instanceId).toString(); 
    // }

    if (transformed.saleData) {
        const sd = { ...transformed.saleData };
        const saleNumericFields = ['price', 'minBid', 'buyNowPrice'];
        for (const field of saleNumericFields) {
            if (sd[field] && typeof sd[field] === 'string') {
                sd[field] = toBigInt(sd[field]).toString();
            }
        }
        transformed.saleData = sd;
    }

    if (transformed.auctionData) {
        const ad = { ...transformed.auctionData };
        const auctionNumericFields = ['startPrice', 'currentBid', 'buyNowPrice', 'bidIncrement'];
        for (const field of auctionNumericFields) {
            if (ad[field] && typeof ad[field] === 'string') {
                ad[field] = toBigInt(ad[field]).toString();
            }
        }
        transformed.auctionData = ad;
    }
    // Add transformation for attributes if a known numeric attribute pattern exists
    return transformed;
};

const transformNftListingData = (listingData: any): any => {
    if (!listingData) return listingData;
    const transformed = { ...listingData };
    if (transformed._id && typeof transformed._id !== 'string') {
        transformed.id = transformed._id.toString();
        delete transformed._id;
    } else if (transformed._id) { // If _id is already string, ensure it's called id or keep as _id
        // transformed.id = transformed._id;
        // delete transformed._id;
    }
    const numericFields = ['price', 'startingPrice', 'currentPrice', 'endingPrice', 'royaltyFeeAmount'];
    for (const field of numericFields) {
        if (transformed[field] && typeof transformed[field] === 'string') {
            transformed[field] = toBigInt(transformed[field]).toString();
        }
    }
    return transformed;
};

// --- NFT Collections ---

// GET /nfts/collections - List all NFT collections
router.get('/collections', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    
    try {
        const query: any = {};
        
        // Filter by creator
        if (req.query.creator) {
            query.creator = req.query.creator;
        }
        
        // Filter by allowDelegation
        if (req.query.allowDelegation !== undefined) {
            query.allowDelegation = req.query.allowDelegation === 'true';
        }
        
        // Filter by creation date range
        if (req.query.createdAfter) {
            query.createdAt = { $gte: new Date(req.query.createdAfter as string) };
        }
        
        if (req.query.createdBefore) {
            if (!query.createdAt) query.createdAt = {};
            query.createdAt.$lte = new Date(req.query.createdBefore as string);
        }
        
        // Search by name (case insensitive)
        if (req.query.nameSearch) {
            query.name = { $regex: req.query.nameSearch, $options: 'i' };
        }
        
        // Sort options
        const sortField = req.query.sortBy as string || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;
        
        const collectionsFromDB = await cache.findPromise('nftCollections', query, { 
            limit, 
            skip, 
            sort
        });
        
        const total = await mongo.getDb().collection('nftCollections').countDocuments(query);
        
        if (!collectionsFromDB || collectionsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const collections = collectionsFromDB.map(transformNftCollectionData);
        res.json({
            data: collections,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error('Error fetching NFT collections:', error);
        res.status(500).json({ message: 'Error fetching NFT collections', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/collections/:collectionSymbol - Get a specific NFT collection by its symbol
router.get('/collections/:collectionSymbol', (async (req: Request, res: Response) => {
    const { collectionSymbol } = req.params;
    try {
        const collectionFromDB = await cache.findOnePromise('nftCollections', { _id: collectionSymbol });
        if (!collectionFromDB) {
            return res.status(404).json({ message: `NFT collection with symbol ${collectionSymbol} not found.` });
        }
        const collection = transformNftCollectionData(collectionFromDB);
        res.json(collection);
    } catch (error: any) {
        logger.error(`Error fetching NFT collection ${collectionSymbol}:`, error);
        res.status(500).json({ message: 'Error fetching NFT collection', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/collections/creator/:creatorName - List NFT collections by a specific creator
router.get('/collections/creator/:creatorName', (async (req: Request, res: Response) => {
    const { creatorName } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const collectionsFromDB = await cache.findPromise('nftCollections', { creator: creatorName }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('nftCollections').countDocuments({ creator: creatorName });

        if (!collectionsFromDB || collectionsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const collections = collectionsFromDB.map(transformNftCollectionData);
        res.json({
            data: collections,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching collections for creator ${creatorName}:`, error);
        res.status(500).json({ message: 'Error fetching collections by creator', error: error.message });
    }
}) as RequestHandler);

// --- NFT Instances (NFTs) ---
// GET /nfts/instances - Get all NFT instances with advanced filtering
router.get('/instances', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    
    try {
        const query: any = {};
        
        // Filter by collection
        if (req.query.collectionSymbol) {
            query.collectionSymbol = req.query.collectionSymbol;
        }
        
        // Filter by owner
        if (req.query.owner) {
            query.owner = req.query.owner;
        }
        
        // Filter by creation date range
        if (req.query.createdAfter) {
            query.createdAt = { $gte: new Date(req.query.createdAfter as string) };
        }
        
        if (req.query.createdBefore) {
            if (!query.createdAt) query.createdAt = {};
            query.createdAt.$lte = new Date(req.query.createdBefore as string);
        }
        
        // Search in metadata (this can be expensive, consider indexing common metadata fields)
        if (req.query.metadataKey && req.query.metadataValue) {
            try {
                // Assuming metadata is stored as a JSON string
                // This is a simplified approach - for production, consider indexing metadata fields
                const key = req.query.metadataKey as string;
                const value = req.query.metadataValue as string;
                query[`metadata.${key}`] = { $regex: value, $options: 'i' };
            } catch (e) {
                logger.warn('Invalid metadata search parameters', e);
            }
        }
        
        // Sort options
        const sortField = req.query.sortBy as string || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;
        
        const instancesFromDB = await cache.findPromise('nfts', query, { 
            limit, 
            skip, 
            sort 
        });
        
        const total = await mongo.getDb().collection('nfts').countDocuments(query);
        
        if (!instancesFromDB || instancesFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const instances = instancesFromDB.map(transformNftInstanceData);
        res.json({
            data: instances,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error('Error fetching NFT instances:', error);
        res.status(500).json({ message: 'Error fetching NFT instances', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/instances/collection/:collectionSymbol - List all NFT instances within a specific collection
router.get('/instances/collection/:collectionSymbol', (async (req: Request, res: Response) => {
    const { collectionSymbol } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const instancesFromDB = await cache.findPromise('nfts', { collectionSymbol: collectionSymbol }, { limit, skip, sort: { instanceId: 1 } });
        const total = await mongo.getDb().collection('nfts').countDocuments({ collectionSymbol: collectionSymbol });

        if (!instancesFromDB || instancesFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const instances = instancesFromDB.map(transformNftInstanceData);
        res.json({
            data: instances,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching NFT instances for collection ${collectionSymbol}:`, error);
        res.status(500).json({ message: 'Error fetching NFT instances for collection', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/instances/owner/:ownerName - List all NFT instances owned by a specific account
router.get('/instances/owner/:ownerName', (async (req: Request, res: Response) => {
    const { ownerName } = req.params;
    const { limit, skip } = getPagination(req);
    try {
        const instancesFromDB = await cache.findPromise('nfts', { owner: ownerName }, { limit, skip, sort: { _id: 1 } });
        const total = await mongo.getDb().collection('nfts').countDocuments({ owner: ownerName });
        
        if (!instancesFromDB || instancesFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const instances = instancesFromDB.map(transformNftInstanceData);
        res.json({
            data: instances,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching NFT instances for owner ${ownerName}:`, error);
        res.status(500).json({ message: 'Error fetching NFT instances by owner', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/instances/id/:nftId - Get a specific NFT instance by its full ID
router.get('/instances/id/:nftId', (async (req: Request, res: Response) => {
    const { nftId } = req.params; // e.g., "MYCOL-001"
    try {
        const instanceFromDB = await cache.findOnePromise('nfts', { _id: nftId });
        if (!instanceFromDB) {
            return res.status(404).json({ message: `NFT instance with ID ${nftId} not found.` });
        }
        const instance = transformNftInstanceData(instanceFromDB);
        res.json(instance);
    } catch (error: any) {
        logger.error(`Error fetching NFT instance ${nftId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT instance', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/instances/id/:nftId/history - Get ownership and transaction history for an NFT
router.get('/instances/id/:nftId/history', (async (req: Request, res: Response) => {
    const { nftId } = req.params;
    const { limit, skip } = getPagination(req);
    
    try {
        // First confirm the NFT exists
        const nft = await cache.findOnePromise('nfts', { _id: nftId });
        if (!nft) {
            return res.status(404).json({ message: `NFT instance with ID ${nftId} not found.` });
        }
        
        // Parse the collection symbol and instance ID from the nftId
        const parts = nftId.split('-');
        const collectionSymbol = parts[0];
        const instanceId = parts.slice(1).join('-');
        
        // Look for transactions related to this NFT (mint, transfer, listing, sale)
        const query = {
            $or: [
                // NFT mint
                { type: 2, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                // NFT transfer
                { type: 3, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                // NFT listing
                { type: 4, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                // NFT delisting
                { type: 5, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                // NFT buy
                { type: 6, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId }
            ]
        };
        
        const transactionsFromDB = await mongo.getDb().collection('transactions')
            .find(query)
            .sort({ ts: -1 })  // Most recent first
            .limit(limit)
            .skip(skip)
            .toArray();
            
        const total = await mongo.getDb().collection('transactions').countDocuments(query);
        
        const transactions = transactionsFromDB.map((tx: any) => {
            const { _id: txId, data, ...restOfTx } = tx;
            const transformedTx: any = { ...restOfTx, data: transformTransactionData(data) };
            if (txId) {
                transformedTx.id = txId.toString();
            }
            return transformedTx;
        });
        
        res.json({
            data: transactions,
            nftId,
            collectionSymbol,
            instanceId,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching history for NFT ${nftId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT history', error: error.message });
    }
}) as RequestHandler);

// --- NFT Listings ---
// GET /nfts/listings - List all active NFT listings
router.get('/listings', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const status = (req.query.status as string) || 'ACTIVE';
    const query: any = { status: status };

    if (req.query.collectionSymbol) {
        query.collectionSymbol = req.query.collectionSymbol as string;
    }
    if (req.query.seller) {
        query.seller = req.query.seller as string;
    }
    if (req.query.paymentTokenSymbol) {
        query.paymentTokenSymbol = req.query.paymentTokenSymbol as string;
    }
    
    // Price range filtering
    if (req.query.minPrice) {
        query.price = { $gte: parseFloat(req.query.minPrice as string) };
    }
    if (req.query.maxPrice) {
        if (!query.price) query.price = {};
        query.price.$lte = parseFloat(req.query.maxPrice as string);
    }
    
    // Sort options (default newest first)
    const sortField = req.query.sortBy as string || 'createdAt';
    const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
    const sort: any = {};
    sort[sortField] = sortDirection;

    try {
        const listingsFromDB = await cache.findPromise('nftListings', query, { 
            limit, 
            skip, 
            sort
        });
        
        const total = await mongo.getDb().collection('nftListings').countDocuments(query);

        if (!listingsFromDB || listingsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }
        const listings = listingsFromDB.map(transformNftListingData);
        res.json({
            data: listings,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error('Error fetching NFT listings:', error);
        res.status(500).json({ message: 'Error fetching NFT listings', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/listings/id/:listingId - Get a specific NFT listing by its ID
router.get('/listings/id/:listingId', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    try {
        let listingObjectId;
        try { listingObjectId = new ObjectId(listingId); } catch (e) { /* not an ObjectId */ }

        const listingFromDB = await cache.findOnePromise('nftListings', { _id: listingObjectId || listingId });
        if (!listingFromDB) {
            return res.status(404).json({ message: `NFT listing with ID ${listingId} not found.` });
        }
        const listing = transformNftListingData(listingFromDB);
        res.json(listing);
    } catch (error: any) {
        logger.error(`Error fetching NFT listing ${listingId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT listing', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/listings/nft/:nftInstanceId - Get the active listing for a specific NFT instance ID
router.get('/listings/nft/:nftInstanceId', (async (req: Request, res: Response) => {
    const { nftInstanceId } = req.params;
    try {
        const parts = nftInstanceId.split('-');
        let collectionSymbol, instanceIdPart;
        if (parts.length >= 2) {
            collectionSymbol = parts[0];
            instanceIdPart = parts.slice(1).join('-');
        } else {
             return res.status(400).json({ message: 'Invalid nftInstanceId format. Expected format like COLLECTION_SYMBOL-INSTANCE_ID.'})
        }

        const listingFromDB = await cache.findOnePromise('nftListings', { 
            collectionSymbol: collectionSymbol, 
            instanceId: instanceIdPart, 
            status: 'ACTIVE' 
        });

        if (!listingFromDB) {
            return res.status(404).json({ message: `No active listing found for NFT instance ${nftInstanceId}.` });
        }
        const listing = transformNftListingData(listingFromDB);
        res.json(listing);
    } catch (error: any) {
        logger.error(`Error fetching listing for NFT instance ${nftInstanceId}:`, error);
        res.status(500).json({ message: 'Error fetching listing for NFT instance', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/listings/nft/:nftInstanceId/history - Get price history for an NFT
router.get('/listings/nft/:nftInstanceId/history', (async (req: Request, res: Response) => {
    const { nftInstanceId } = req.params;
    const { limit, skip } = getPagination(req);
    
    try {
        const parts = nftInstanceId.split('-');
        if (parts.length < 2) {
            return res.status(400).json({ message: 'Invalid nftInstanceId format. Expected format like COLLECTION_SYMBOL-INSTANCE_ID.'});
        }
        
        const collectionSymbol = parts[0];
        const instanceIdPart = parts.slice(1).join('-');
        
        // Get all listings (active and sold) for this NFT
        const query = { 
            collectionSymbol, 
            instanceId: instanceIdPart,
            // Include any status: ACTIVE, SOLD, CANCELLED
        };
        
        const sortOptions = { createdAt: 'desc' as const }; // Latest first, using 'desc' string literal
        
        const listingHistoryFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort: sortOptions
        });
        
        // Also find all sales (NFT_BUY_ITEM transactions) for this NFT
        const salesQuery = {
            type: 6, // NFT_BUY_ITEM
            'data.collectionSymbol': collectionSymbol,
            'data.instanceId': instanceIdPart
        };
        
        const salesHistoryFromDB = await mongo.getDb().collection('transactions')
            .find(salesQuery)
            .sort({ ts: -1 })
            .limit(limit)
            .skip(skip)
            .toArray();
        
        const totalListings = await mongo.getDb().collection('nftListings').countDocuments(query);
        const totalSales = await mongo.getDb().collection('transactions').countDocuments(salesQuery);
        
        const listingHistory = (listingHistoryFromDB || []).map(transformNftListingData);
        const salesHistory = salesHistoryFromDB.map((tx: any) => {
            const { _id: txId, data, ...restOfTx } = tx;
            const transformedTx: any = { ...restOfTx, data: transformTransactionData(data) };
            if (txId) {
                transformedTx.id = txId.toString();
            }
            return transformedTx;
        });
        
        res.json({
            nftId: nftInstanceId,
            listings: {
                data: listingHistory,
                total: totalListings
            },
            sales: {
                data: salesHistory,
                total: totalSales
            },
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching price history for NFT ${nftInstanceId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT price history', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/collections/stats - Get NFT collection statistics
router.get('/collections/stats', (async (req: Request, res: Response) => {
    try {
        // Get collection with the most NFTs
        const collectionStatsFromDB = await mongo.getDb().collection('nftCollections').aggregate([
            {
                $lookup: {
                    from: 'nfts',
                    localField: '_id',
                    foreignField: 'collectionSymbol',
                    as: 'nfts'
                }
            },
            {
                $project: {
                    symbol: '$_id',
                    name: 1,
                    creator: 1,
                    totalNfts: { $size: '$nfts' },
                    createdAt: 1
                }
            },
            { $sort: { totalNfts: -1 } },
            { $limit: 10 }
        ]).toArray();
        
        // Transform collectionStats if needed (e.g. _id to id, though here _id is symbol)
        const collectionStats = collectionStatsFromDB.map(collection => {
            // Assuming transformNftCollectionData is not strictly needed here as fields are projected directly
            // or that the relevant numeric fields in collectionStats are already numbers (like totalNfts).
            // If any fields from nftCollections still need bigint string transform, apply it.
            const { _id, ...rest } = collection; // _id is the symbol
            return { id: _id, symbol: _id, ...rest }; // ensure id and symbol are present
        });

        // Get most active collections by sales
        const salesStatsFromDB = await mongo.getDb().collection('transactions').aggregate([
            { $match: { type: 6 } }, // NFT_BUY_ITEM
            {
                $group: {
                    _id: '$data.collectionSymbol',
                    totalSales: { $sum: 1 },
                    // Attempt to convert price to decimal for summing, then sum
                    totalVolume: { $sum: { $toDecimal: '$data.price' } } 
                }
            },
            { $sort: { totalSales: -1 } },
            { $limit: 10 }
        ]).toArray();

        const salesStats = salesStatsFromDB.map((stat: any) => {
            const { _id, totalSales, totalVolume } = stat;
            return {
                collectionSymbol: _id,
                totalSales,
                totalVolume: totalVolume ? totalVolume.toString() : '0' // Convert Decimal128 to string
            };
        });
        
        res.json({
            topCollectionsBySize: collectionStats,
            topCollectionsBySales: salesStats
        });
    } catch (error: any) {
        logger.error('Error fetching NFT collection stats:', error);
        res.status(500).json({ message: 'Error fetching NFT collection statistics', error: error.message });
    }
}) as RequestHandler);

export default router; 