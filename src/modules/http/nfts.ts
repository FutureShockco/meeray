import express, { Request, Response, Router, RequestHandler } from 'express';
import cache from '../../cache.js';
import { mongo } from '../../mongo.js';
import logger from '../../logger.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { ObjectId } from 'mongodb';
import { transformTransactionData, formatTokenAmountForResponse, formatTokenAmountSimple } from '../../utils/http.js';

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

    // Get the collection symbol for formatting
    const collectionSymbol = transformed.symbol || transformed._id || 'UNKNOWN';

    // Format collection amounts using the collection symbol
    const numericFields = ['mintPrice'];
    for (const field of numericFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], collectionSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    // Royalty fee is typically a percentage, so keep as raw value
    if (transformed.royaltyFeePercentage) {
        transformed.royaltyFeePercentage = toBigInt(transformed.royaltyFeePercentage).toString();
    }

    return transformed;
};

const transformNftInstanceData = (instanceData: any): any => {
    if (!instanceData) return instanceData;
    const transformed = { ...instanceData };
    // _id is nftId (string, e.g. SYMBOL-001), typically no transformation to 'id' needed.

    // Get the collection symbol for formatting
    const collectionSymbol = transformed.collectionSymbol || 'UNKNOWN';

    // instanceId is likely already a number, but if it could be a numeric string:
    // if (transformed.instanceId && typeof transformed.instanceId === 'string') {
    //     transformed.instanceId = toBigInt(transformed.instanceId).toString(); 
    // }

    if (transformed.saleData) {
        const sd = { ...transformed.saleData };
        const saleNumericFields = ['price', 'minBid', 'buyNowPrice'];
        for (const field of saleNumericFields) {
            if (sd[field]) {
                // Sale prices are typically in the native token (e.g., STEEM)
                const formatted = formatTokenAmountForResponse(sd[field], 'STEEM');
                sd[field] = formatted.amount;
                sd[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
            }
        }
        transformed.saleData = sd;
    }

    if (transformed.auctionData) {
        const ad = { ...transformed.auctionData };
        const auctionNumericFields = ['startPrice', 'currentBid', 'buyNowPrice', 'bidIncrement'];
        for (const field of auctionNumericFields) {
            if (ad[field]) {
                // Auction prices are typically in the native token (e.g., STEEM)
                const formatted = formatTokenAmountForResponse(ad[field], 'STEEM');
                ad[field] = formatted.amount;
                ad[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
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
    }


    const priceFields = ['price', 'startingPrice', 'currentPrice', 'endingPrice', 'royaltyFeeAmount'];
    for (const field of priceFields) {
        if (transformed[field] !== undefined && transformed[field] !== null) {
            // If already a string, keep as is; if number/Long, convert to BigInt then toDbString
            let value = transformed[field];
            if (typeof value === 'string') {
                // If it's a padded string, keep as is
                transformed[field] = value;
            } else {
                // Convert to BigInt then toDbString
                transformed[field] = toDbString(BigInt(value));
            }
        }
    }

    // Optionally, add raw fields for UI
    for (const field of priceFields) {
        if (transformed[field]) {
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = transformed[field];
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
            return res.status(400).json({ message: 'Invalid nftInstanceId format. Expected format like COLLECTION_SYMBOL-INSTANCE_ID.' })
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
            return res.status(400).json({ message: 'Invalid nftInstanceId format. Expected format like COLLECTION_SYMBOL-INSTANCE_ID.' });
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

// ===== NEW BIDDING AND AUCTION ENDPOINTS =====

// GET /nfts/bids - List all bids with filtering
router.get('/bids', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {};

        // Filter by listing
        if (req.query.listingId) {
            query.listingId = req.query.listingId;
        }

        // Filter by bidder
        if (req.query.bidder) {
            query.bidder = req.query.bidder;
        }

        // Filter by status
        if (req.query.status) {
            query.status = req.query.status;
        }

        // Filter by bid amount range
        if (req.query.minBid) {
            query.bidAmount = { $gte: req.query.minBid };
        }
        if (req.query.maxBid) {
            if (!query.bidAmount) query.bidAmount = {};
            query.bidAmount.$lte = req.query.maxBid;
        }

        // Sort options (default newest first)
        const sortField = req.query.sortBy as string || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB || bidsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error('Error fetching NFT bids:', error);
        res.status(500).json({ message: 'Error fetching NFT bids', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/bids/listing/:listingId - Get all bids for a specific listing
router.get('/bids/listing/:listingId', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query: any = { listingId };

        // Filter by status (default to active bids)
        if (req.query.status) {
            query.status = req.query.status;
        }

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { bidAmount: -1, createdAt: -1 } // Highest bids first, then newest
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching bids for listing ${listingId}:`, error);
        res.status(500).json({ message: 'Error fetching listing bids', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/bids/user/:username - Get all bids by a specific user
router.get('/bids/user/:username', (async (req: Request, res: Response) => {
    const { username } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query: any = { bidder: username };
        // Filter by status (default to active bids)
        if (req.query.status) {
            query.status = req.query.status;
        }

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { createdAt: -1 } // Newest first
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching bids for user ${username}:`, error);
        res.status(500).json({ message: 'Error fetching user bids', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/bids/:bidId - Get specific bid details
router.get('/bids/:bidId', (async (req: Request, res: Response) => {
    const { bidId } = req.params;

    try {
        const bid = await cache.findOnePromise('nftBids', { _id: bidId });

        if (!bid) {
            return res.status(404).json({ message: `Bid with ID ${bidId} not found.` });
        }

        res.json(bid);
    } catch (error: any) {
        logger.error(`Error fetching bid ${bidId}:`, error);
        res.status(500).json({ message: 'Error fetching bid', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/auctions - List active auctions
router.get('/auctions', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {
            status: 'active',
            listingType: { $in: ['AUCTION', 'RESERVE_AUCTION'] }
        };

        // Filter by collection
        if (req.query.collectionSymbol) {
            query.collectionId = req.query.collectionSymbol;
        }

        // Filter by seller
        if (req.query.seller) {
            query.seller = req.query.seller;
        }

        // Filter auctions ending soon
        if (req.query.endingSoon === 'true') {
            const soonThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000); // Next 24 hours
            query.auctionEndTime = { $lte: soonThreshold.toISOString() };
        }

        // Sort options (default by auction end time)
        const sortField = req.query.sortBy as string || 'auctionEndTime';
        const sortDirection = req.query.sortDirection === 'desc' ? -1 : 1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const auctionsFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort
        });

        const total = await mongo.getDb().collection('nftListings').countDocuments(query);

        if (!auctionsFromDB || auctionsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        const auctions = auctionsFromDB.map(transformNftListingData);
        res.json({
            data: auctions,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error('Error fetching NFT auctions:', error);
        res.status(500).json({ message: 'Error fetching NFT auctions', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/auctions/:listingId/bids - Get all bids for a specific auction
router.get('/auctions/:listingId/bids', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        // First verify this is actually an auction
        const listing = await cache.findOnePromise('nftListings', { _id: listingId });
        if (!listing) {
            return res.status(404).json({ message: `Auction with ID ${listingId} not found.` });
        }

        if (listing.listingType !== 'AUCTION' && listing.listingType !== 'RESERVE_AUCTION') {
            return res.status(400).json({ message: `Listing ${listingId} is not an auction.` });
        }

        const query = {
            listingId,
            status: { $in: ['ACTIVE', 'WINNING', 'OUTBID', 'WON', 'LOST'] }
        };

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { bidAmount: -1, createdAt: -1 } // Highest bids first
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            listingId,
            listingType: listing.listingType,
            auctionEndTime: listing.auctionEndTime,
            reservePrice: listing.reservePrice,
            currentHighestBid: listing.currentHighestBid,
            currentHighestBidder: listing.currentHighestBidder,
            data: bidsFromDB,
            total,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching auction bids for ${listingId}:`, error);
        res.status(500).json({ message: 'Error fetching auction bids', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/auctions/ending-soon - Get auctions ending in the next 24 hours
router.get('/auctions/ending-soon', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const hours = parseInt(req.query.hours as string) || 24; // Default 24 hours

    try {
        const endThreshold = new Date(Date.now() + hours * 60 * 60 * 1000);

        const query = {
            status: 'active',
            listingType: { $in: ['AUCTION', 'RESERVE_AUCTION'] },
            auctionEndTime: {
                $lte: endThreshold.toISOString(),
                $gt: new Date().toISOString() // Still active
            }
        };

        const auctionsFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort: { auctionEndTime: 1 } // Soonest first
        });

        const total = await mongo.getDb().collection('nftListings').countDocuments(query);

        if (!auctionsFromDB || auctionsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        const auctions = auctionsFromDB.map(transformNftListingData);
        res.json({
            data: auctions,
            total,
            limit,
            skip,
            endingWithinHours: hours
        });
    } catch (error: any) {
        logger.error('Error fetching ending soon auctions:', error);
        res.status(500).json({ message: 'Error fetching ending soon auctions', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/user/:username/bidding - Get auctions where user has active bids
router.get('/user/:userId/bidding', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        // Get user's active bids
        const activeBids = await cache.findPromise('nftBids', {
            bidder: userId,
            status: { $in: ['ACTIVE', 'WINNING'] }
        });

        if (!activeBids || activeBids.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        // Get unique listing IDs
        const listingIds = [...new Set(activeBids.map(bid => bid.listingId))];

        // Get the corresponding listings
        const listingsFromDB = await cache.findPromise('nftListings', {
            _id: { $in: listingIds },
            status: 'active'
        }, { limit, skip, sort: { auctionEndTime: 1 } });

        if (!listingsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        // Enhance listings with user's bid info
        const enhancedListings = listingsFromDB.map(listing => {
            const userBid = activeBids.find(bid => bid.listingId === listing._id);
            return {
                ...transformNftListingData(listing),
                userBid: userBid ? {
                    bidId: userBid._id,
                    bidAmount: userBid.bidAmount,
                    status: userBid.status,
                    isHighestBid: userBid.isHighestBid,
                    createdAt: userBid.createdAt
                } : null
            };
        });

        res.json({
            data: enhancedListings,
            total: listingIds.length,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching bidding auctions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching user bidding auctions', error: error.message });
    }
}) as RequestHandler);

// GET /nfts/user/:username/winning - Get auctions where user is currently winning
router.get('/user/:username/winning', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        // Get user's winning bids
        const winningBids = await cache.findPromise('nftBids', {
            bidder: userId,
            status: 'WINNING',
            isHighestBid: true
        });

        if (!winningBids || winningBids.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        // Get unique listing IDs
        const listingIds = [...new Set(winningBids.map(bid => bid.listingId))];

        // Get the corresponding active listings
        const listingsFromDB = await cache.findPromise('nftListings', {
            _id: { $in: listingIds },
            status: 'active'
        }, { limit, skip, sort: { auctionEndTime: 1 } });

        if (!listingsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        // Enhance listings with winning bid info
        const enhancedListings = listingsFromDB.map(listing => {
            const winningBid = winningBids.find(bid => bid.listingId === listing._id);
            return {
                ...transformNftListingData(listing),
                winningBid: winningBid ? {
                    bidId: winningBid._id,
                    bidAmount: winningBid.bidAmount,
                    createdAt: winningBid.createdAt
                } : null
            };
        });

        res.json({
            data: enhancedListings,
            total: listingIds.length,
            limit,
            skip
        });
    } catch (error: any) {
        logger.error(`Error fetching winning auctions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching user winning auctions', error: error.message });
    }
}) as RequestHandler);

export default router; 