import express, { Request, RequestHandler, Response, Router } from 'express';
import { ObjectId } from 'mongodb';

import cache from '../../cache.js';
import logger from '../../logger.js';
import { mongo } from '../../mongo.js';
import { toBigInt, toDbString } from '../../utils/bigint.js';
import { formatTokenAmountForResponse, transformTransactionData } from '../../utils/http.js';

const router: Router = express.Router();


const getPagination = (req: Request) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    return { limit, skip: offset, page: Math.floor(offset / limit) + 1 };
};

const transformNftCollectionData = (collectionData: any): any => {
    if (!collectionData) return collectionData;
    const transformed = { ...collectionData };
    

    
    const collectionSymbol = transformed.symbol || transformed._id || 'UNKNOWN';

    
    const numericFields = ['mintPrice'];
    for (const field of numericFields) {
        if (transformed[field]) {
            const formatted = formatTokenAmountForResponse(transformed[field], collectionSymbol);
            transformed[field] = formatted.amount;
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
        }
    }

    
    if (transformed.royaltyFeePercentage) {
        transformed.royaltyFeePercentage = toBigInt(transformed.royaltyFeePercentage).toString();
    }

    return transformed;
};

const transformNftInstanceData = (instanceData: any): any => {
    if (!instanceData) return instanceData;
    const transformed = { ...instanceData };

    if (transformed.saleData) {
        const sd = { ...transformed.saleData };
        const saleNumericFields = ['price', 'minBid', 'buyNowPrice'];
        for (const field of saleNumericFields) {
            if (sd[field]) {
                
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
                
                const formatted = formatTokenAmountForResponse(ad[field], 'STEEM');
                ad[field] = formatted.amount;
                ad[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = formatted.rawAmount;
            }
        }
        transformed.auctionData = ad;
    }
    
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
            
            const value = transformed[field];
            if (typeof value === 'string') {
                
                transformed[field] = value;
            } else {
                
                transformed[field] = toDbString(toBigInt(value));
            }
        }
    }

    
    for (const field of priceFields) {
        if (transformed[field]) {
            transformed[`raw${field.charAt(0).toUpperCase() + field.slice(1)}`] = transformed[field];
        }
    }

    return transformed;
};




router.get('/collections', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {};

        
        if (req.query.creator) {
            query.creator = req.query.creator;
        }

        
        if (req.query.allowDelegation !== undefined) {
            query.allowDelegation = req.query.allowDelegation === 'true';
        }

        
        if (req.query.createdAfter) {
            query.createdAt = { $gte: new Date(req.query.createdAfter as string) };
        }

        if (req.query.createdBefore) {
            if (!query.createdAt) query.createdAt = {};
            query.createdAt.$lte = new Date(req.query.createdBefore as string);
        }

        
        if (req.query.nameSearch) {
            query.name = { $regex: req.query.nameSearch, $options: 'i' };
        }

        
        const sortField = (req.query.sortBy as string) || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const collectionsFromDB = await cache.findPromise('nftCollections', query, {
            limit,
            skip,
            sort,
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
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT collections:', error);
        res.status(500).json({ message: 'Error fetching NFT collections', error: error.message });
    }
}) as RequestHandler);


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
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching collections for creator ${creatorName}:`, error);
        res.status(500).json({ message: 'Error fetching collections by creator', error: error.message });
    }
}) as RequestHandler);



router.get('/instances', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {};

        
        if (req.query.collectionSymbol) {
            query.collectionId = req.query.collectionSymbol as string;
        }

        
        if (req.query.owner) {
            query.seller = req.query.owner as string;
        }

        
        if (req.query.createdAfter) {
            query.createdAt = { $gte: new Date(req.query.createdAfter as string) };
        }

        if (req.query.createdBefore) {
            if (!query.createdAt) query.createdAt = {};
            query.createdAt.$lte = new Date(req.query.createdBefore as string);
        }

        
        if (req.query.metadataKey && req.query.metadataValue) {
            try {
                
                
                const key = req.query.metadataKey as string;
                const value = req.query.metadataValue as string;
                query[`metadata.${key}`] = { $regex: value, $options: 'i' };
            } catch (e) {
                logger.warn('Invalid metadata search parameters', e);
            }
        }

        
        const sortField = (req.query.sortBy as string) || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const instancesFromDB = await cache.findPromise('nfts', query, {
            limit,
            skip,
            sort,
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
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT instances:', error);
        res.status(500).json({ message: 'Error fetching NFT instances', error: error.message });
    }
}) as RequestHandler);


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
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching NFT instances for collection ${collectionSymbol}:`, error);
        res.status(500).json({ message: 'Error fetching NFT instances for collection', error: error.message });
    }
}) as RequestHandler);


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
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching NFT instances for owner ${ownerName}:`, error);
        res.status(500).json({ message: 'Error fetching NFT instances by owner', error: error.message });
    }
}) as RequestHandler);



router.get('/instances/id/:nftId', (async (req: Request, res: Response) => {
    const { nftId } = req.params;
    
    const normalizedNftId = (nftId || '').replace(/-/g, '_');
    try {
        const instanceFromDB = await cache.findOnePromise('nfts', { _id: normalizedNftId });
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



router.get('/instances/id/:nftId/history', (async (req: Request, res: Response) => {
    const { nftId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        
        const normalizedNftId = (nftId || '').replace(/-/g, '_');
        const nft = await cache.findOnePromise('nfts', { _id: normalizedNftId });
        if (!nft) {
            return res.status(404).json({ message: `NFT instance with ID ${nftId} not found.` });
        }

        
        const parts = normalizedNftId.split('_');
        const collectionSymbol = parts[0];
        const instanceId = parts.slice(1).join('_');

        
        const query = {
            $or: [
                
                { type: 2, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                
                { type: 3, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                
                { type: 4, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                
                { type: 5, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
                
                { type: 6, 'data.collectionSymbol': collectionSymbol, 'data.instanceId': instanceId },
            ],
        };

        const transactionsFromDB = await mongo
            .getDb()
            .collection('transactions')
            .find(query)
            .sort({ ts: -1 }) 
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
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching history for NFT ${nftId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT history', error: error.message });
    }
}) as RequestHandler);



router.get('/listings', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const status = (req.query.status as string) || 'active';
    const query: any = { status: status };

    if (req.query.collectionSymbol) {
        query.collectionSymbol = req.query.collectionSymbol as string;
    }
    if (req.query.seller) {
        query.seller = req.query.seller as string;
    }
    if (req.query.paymentToken) {
        query.paymentToken = req.query.paymentToken as string;
    }

    
    if (req.query.minPrice) {
        try {
            query.price = { $gte: toDbString(toBigInt(req.query.minPrice as string)) };
        } catch (e) {
            logger.warn('Invalid minPrice provided to listings search', e);
        }
    }
    if (req.query.maxPrice) {
        try {
            if (!query.price) query.price = {};
            query.price.$lte = toDbString(toBigInt(req.query.maxPrice as string));
        } catch (e) {
            logger.warn('Invalid maxPrice provided to listings search', e);
        }
    }

    
    const sortField = (req.query.sortBy as string) || 'createdAt';
    const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
    const sort: any = {};
    sort[sortField] = sortDirection;

    try {
        const listingsFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort,
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
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT listings:', error);
        res.status(500).json({ message: 'Error fetching NFT listings', error: error.message });
    }
}) as RequestHandler);


router.get('/listings/id/:listingId', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    try {
        let listingObjectId;
        try {
            listingObjectId = new ObjectId(listingId);
        } catch {
           
        }

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


router.get('/listings/nft/:nftInstanceId', (async (req: Request, res: Response) => {
    const { nftInstanceId } = req.params;
    try {
        
        const normalized = (nftInstanceId || '').replace(/-/g, '_');
        const parts = normalized.split('_');
        let collectionSymbol, instanceIdPart;
        if (parts.length >= 2) {
            collectionSymbol = parts[0];
            instanceIdPart = parts.slice(1).join('_');
        } else {
            return res.status(400).json({ message: 'Invalid nftInstanceId format. Expected format like COLLECTION_SYMBOL-INSTANCE_ID.' });
        }

        const listingFromDB = await cache.findOnePromise('nftListings', {
            collectionId: collectionSymbol,
            tokenId: instanceIdPart,
            status: 'active',
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

        
        const query = {
            collectionSymbol,
            instanceId: instanceIdPart,
            
        };

        const sortOptions = { createdAt: 'desc' as const }; 

        const listingHistoryFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort: sortOptions,
        });

        
        const salesQuery = {
            type: 6, 
            'data.collectionSymbol': collectionSymbol,
            'data.instanceId': instanceIdPart,
        };

        const salesHistoryFromDB = await mongo.getDb().collection('transactions').find(salesQuery).sort({ ts: -1 }).limit(limit).skip(skip).toArray();

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
                total: totalListings,
            },
            sales: {
                data: salesHistory,
                total: totalSales,
            },
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching price history for NFT ${nftInstanceId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT price history', error: error.message });
    }
}) as RequestHandler);


router.get('/collections/stats', (async (req: Request, res: Response) => {
    try {
        
        const collectionStatsFromDB = await mongo
            .getDb()
            .collection('nftCollections')
            .aggregate([
                {
                    $lookup: {
                        from: 'nfts',
                        localField: '_id',
                        foreignField: 'collectionSymbol',
                        as: 'nfts',
                    },
                },
                {
                    $project: {
                        symbol: '$_id',
                        name: 1,
                        creator: 1,
                        totalNfts: { $size: '$nfts' },
                        createdAt: 1,
                    },
                },
                { $sort: { totalNfts: -1 } },
                { $limit: 10 },
            ])
            .toArray();

        
        const collectionStats = collectionStatsFromDB.map(collection => {
            
            
            
            const { _id, ...rest } = collection; 
            return { id: _id, symbol: _id, ...rest }; 
        });

        
        const salesStatsFromDB = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                { $match: { type: 6 } }, 
                {
                    $group: {
                        _id: '$data.collectionSymbol',
                        totalSales: { $sum: 1 },
                        
                        totalVolume: { $sum: { $toDecimal: '$data.price' } },
                    },
                },
                { $sort: { totalSales: -1 } },
                { $limit: 10 },
            ])
            .toArray();

        const salesStats = salesStatsFromDB.map((stat: any) => {
            const { _id, totalSales, totalVolume } = stat;
            return {
                collectionSymbol: _id,
                totalSales,
                totalVolume: totalVolume ? totalVolume.toString() : '0', 
            };
        });

        res.json({
            topCollectionsBySize: collectionStats,
            topCollectionsBySales: salesStats,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT collection stats:', error);
        res.status(500).json({ message: 'Error fetching NFT collection statistics', error: error.message });
    }
}) as RequestHandler);




router.get('/bids', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {};

        
        if (req.query.listingId) {
            query.listingId = req.query.listingId;
        }

        
        if (req.query.bidder) {
            query.bidder = req.query.bidder;
        }

        
        if (req.query.status) {
            query.status = req.query.status;
        }

        
        if (req.query.minBid) {
            query.bidAmount = { $gte: req.query.minBid };
        }
        if (req.query.maxBid) {
            if (!query.bidAmount) query.bidAmount = {};
            query.bidAmount.$lte = req.query.maxBid;
        }

        
        const sortField = (req.query.sortBy as string) || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort,
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB || bidsFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT bids:', error);
        res.status(500).json({ message: 'Error fetching NFT bids', error: error.message });
    }
}) as RequestHandler);


router.get('/bids/listing/:listingId', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query: any = { listingId };

        
        if (req.query.status) {
            query.status = req.query.status;
        }

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { bidAmount: -1, createdAt: -1 }, 
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching bids for listing ${listingId}:`, error);
        res.status(500).json({ message: 'Error fetching listing bids', error: error.message });
    }
}) as RequestHandler);


router.get('/bids/user/:username', (async (req: Request, res: Response) => {
    const { username } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query: any = { bidder: username };
        
        if (req.query.status) {
            query.status = req.query.status;
        }

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { createdAt: -1 }, 
        });

        const total = await mongo.getDb().collection('nftBids').countDocuments(query);

        if (!bidsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: bidsFromDB,
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching bids for user ${username}:`, error);
        res.status(500).json({ message: 'Error fetching user bids', error: error.message });
    }
}) as RequestHandler);


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


router.get('/auctions', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {
            status: 'active',
            listingType: { $in: ['AUCTION', 'RESERVE_AUCTION'] },
        };

        
        if (req.query.collectionSymbol) {
            query.collectionId = req.query.collectionSymbol;
        }

        
        if (req.query.seller) {
            query.seller = req.query.seller;
        }

        
        if (req.query.endingSoon === 'true') {
            const soonThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000); 
            query.auctionEndTime = { $lte: soonThreshold.toISOString() };
        }

        
        const sortField = (req.query.sortBy as string) || 'auctionEndTime';
        const sortDirection = req.query.sortDirection === 'desc' ? -1 : 1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const auctionsFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort,
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
        });
    } catch (error: any) {
        logger.error('Error fetching NFT auctions:', error);
        res.status(500).json({ message: 'Error fetching NFT auctions', error: error.message });
    }
}) as RequestHandler);


router.get('/auctions/:listingId/bids', (async (req: Request, res: Response) => {
    const { listingId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        
        const listing = await cache.findOnePromise('nftListings', { _id: listingId });
        if (!listing) {
            return res.status(404).json({ message: `Auction with ID ${listingId} not found.` });
        }

        if (listing.listingType !== 'AUCTION' && listing.listingType !== 'RESERVE_AUCTION') {
            return res.status(400).json({ message: `Listing ${listingId} is not an auction.` });
        }

        const query = {
            listingId,
            status: { $in: ['active', 'winning', 'outbid', 'won', 'lost'] },
        };

        const bidsFromDB = await cache.findPromise('nftBids', query, {
            limit,
            skip,
            sort: { bidAmount: -1, createdAt: -1 }, 
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
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching auction bids for ${listingId}:`, error);
        res.status(500).json({ message: 'Error fetching auction bids', error: error.message });
    }
}) as RequestHandler);


router.get('/auctions/ending-soon', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const hours = parseInt(req.query.hours as string) || 24; 

    try {
        const endThreshold = new Date(Date.now() + hours * 60 * 60 * 1000);

        const query = {
            status: 'active',
            listingType: { $in: ['AUCTION', 'RESERVE_AUCTION'] },
            auctionEndTime: {
                $lte: endThreshold.toISOString(),
                $gt: new Date().toISOString(), 
            },
        };

        const auctionsFromDB = await cache.findPromise('nftListings', query, {
            limit,
            skip,
            sort: { auctionEndTime: 1 }, 
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
            endingWithinHours: hours,
        });
    } catch (error: any) {
        logger.error('Error fetching ending soon auctions:', error);
        res.status(500).json({ message: 'Error fetching ending soon auctions', error: error.message });
    }
}) as RequestHandler);


router.get('/user/:userId/bidding', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        
        const activeBids = await cache.findPromise('nftBids', {
            bidder: userId,
            status: { $in: ['active', 'winning'] },
        });

        if (!activeBids || activeBids.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        
        const listingIds = [...new Set(activeBids.map(bid => bid.listingId))];

        
        const listingsFromDB = await cache.findPromise(
            'nftListings',
            {
                _id: { $in: listingIds },
                status: 'active',
            },
            { limit, skip, sort: { auctionEndTime: 1 } }
        );

        if (!listingsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        
        const enhancedListings = listingsFromDB.map(listing => {
            const userBid = activeBids.find(bid => bid.listingId === listing._id);
            return {
                ...transformNftListingData(listing),
                userBid: userBid
                    ? {
                          bidId: userBid._id,
                          bidAmount: userBid.bidAmount,
                          status: userBid.status,
                          isHighestBid: userBid.isHighestBid,
                          createdAt: userBid.createdAt,
                      }
                    : null,
            };
        });

        res.json({
            data: enhancedListings,
            total: listingIds.length,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching bidding auctions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching user bidding auctions', error: error.message });
    }
}) as RequestHandler);


router.get('/user/:username/winning', (async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        
        const winningBids = await cache.findPromise('nftBids', {
            bidder: userId,
            status: 'winning',
            isHighestBid: true,
        });

        if (!winningBids || winningBids.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        
        const listingIds = [...new Set(winningBids.map(bid => bid.listingId))];

        
        const listingsFromDB = await cache.findPromise(
            'nftListings',
            {
                _id: { $in: listingIds },
                status: 'active',
            },
            { limit, skip, sort: { auctionEndTime: 1 } }
        );

        if (!listingsFromDB) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        
        const enhancedListings = listingsFromDB.map(listing => {
            const winningBid = winningBids.find(bid => bid.listingId === listing._id);
            return {
                ...transformNftListingData(listing),
                winningBid: winningBid
                    ? {
                          bidId: winningBid._id,
                          bidAmount: winningBid.bidAmount,
                          createdAt: winningBid.createdAt,
                      }
                    : null,
            };
        });

        res.json({
            data: enhancedListings,
            total: listingIds.length,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching winning auctions for user ${userId}:`, error);
        res.status(500).json({ message: 'Error fetching user winning auctions', error: error.message });
    }
}) as RequestHandler);

router.get('/collections/:symbol/analytics', (async (req: Request, res: Response) => {
    const { symbol } = req.params;
    const days = parseInt(req.query.days as string) || 7; 

    try {
        
        const collection = await cache.findOnePromise('nftCollections', { _id: symbol });
        if (!collection) {
            return res.status(404).json({ message: `Collection ${symbol} not found.` });
        }

        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        
        const totalNfts = await mongo.getDb().collection('nfts').countDocuments({ collectionSymbol: symbol });

        
        const totalListed = await mongo.getDb().collection('nftListings').countDocuments({
            collectionId: symbol,
            status: 'active',
        });

        
        const ownersData = await mongo
            .getDb()
            .collection('nfts')
            .aggregate([{ $match: { collectionSymbol: symbol } }, { $group: { _id: '$owner' } }, { $count: 'totalOwners' }])
            .toArray();
        const totalOwners = ownersData[0]?.totalOwners || 0;

        
        const floorPriceData = await mongo
            .getDb()
            .collection('nftListings')
            .aggregate([
                {
                    $match: {
                        collectionId: symbol,
                        status: 'active',
                        listingType: { $in: ['FIXED_PRICE', 'AUCTION'] },
                    },
                },
                { $sort: { price: 1 } },
                { $limit: 1 },
                { $project: { price: 1, paymentToken: 1 } },
            ])
            .toArray();
        const floorPrice = floorPriceData[0] || null;

        
        const salesData = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        'data.collectionSymbol': symbol,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: 1 },
                        totalVolume: { $sum: { $toDecimal: '$data.price' } },
                        avgPrice: { $avg: { $toDecimal: '$data.price' } },
                    },
                },
            ])
            .toArray();

        const sales = salesData[0] || { totalSales: 0, totalVolume: 0, avgPrice: 0 };

        
        const dailySales = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        'data.collectionSymbol': symbol,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: '%Y-%m-%d',
                                date: { $toDate: { $multiply: ['$ts', 1000] } },
                            },
                        },
                        sales: { $sum: 1 },
                        volume: { $sum: { $toDecimal: '$data.price' } },
                    },
                },
                { $sort: { _id: 1 } },
            ])
            .toArray();

        
        const topTraders = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        'data.collectionSymbol': symbol,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: '$data.buyer',
                        purchases: { $sum: 1 },
                        totalSpent: { $sum: { $toDecimal: '$data.price' } },
                    },
                },
                { $sort: { totalSpent: -1 } },
                { $limit: 10 },
            ])
            .toArray();

        res.json({
            collection: {
                symbol,
                name: collection.name,
                creator: collection.creator,
            },
            stats: {
                totalNfts,
                totalListed,
                totalOwners,
                listedPercentage: totalNfts > 0 ? ((totalListed / totalNfts) * 100).toFixed(2) : '0',
                floorPrice: floorPrice
                    ? {
                          price: floorPrice.price,
                          token: floorPrice.paymentToken,
                      }
                    : null,
            },
            analytics: {
                period: `${days} days`,
                totalSales: sales.totalSales,
                totalVolume: sales.totalVolume ? sales.totalVolume.toString() : '0',
                averagePrice: sales.avgPrice ? sales.avgPrice.toString() : '0',
                dailySales: dailySales.map(day => ({
                    date: day._id,
                    sales: day.sales,
                    volume: day.volume ? day.volume.toString() : '0',
                })),
                topTraders: topTraders.map(trader => ({
                    buyer: trader._id,
                    purchases: trader.purchases,
                    totalSpent: trader.totalSpent ? trader.totalSpent.toString() : '0',
                })),
            },
        });
    } catch (error: any) {
        logger.error(`Error fetching analytics for collection ${symbol}:`, error);
        res.status(500).json({ message: 'Error fetching collection analytics', error: error.message });
    }
}) as RequestHandler);


router.get('/collections/trending', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const days = parseInt(req.query.days as string) || 7;

    try {
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        
        const trendingData = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: '$data.collectionSymbol',
                        totalSales: { $sum: 1 },
                        totalVolume: { $sum: { $toDecimal: '$data.price' } },
                        avgPrice: { $avg: { $toDecimal: '$data.price' } },
                        uniqueBuyers: { $addToSet: '$data.buyer' },
                    },
                },
                {
                    $project: {
                        collectionSymbol: '$_id',
                        totalSales: 1,
                        totalVolume: 1,
                        avgPrice: 1,
                        uniqueBuyers: { $size: '$uniqueBuyers' },
                    },
                },
                { $sort: { totalVolume: -1 } },
                { $skip: skip },
                { $limit: limit },
            ])
            .toArray();

        
        const collectionSymbols = trendingData.map(item => item.collectionSymbol);
        const collections = await cache.findPromise('nftCollections', { _id: { $in: collectionSymbols } });

        const enhancedTrending = trendingData.map(trend => {
            const collection = collections?.find(c => c._id === trend.collectionSymbol);
            return {
                ...trend,
                collection: collection ? transformNftCollectionData(collection) : null,
                totalVolume: trend.totalVolume ? trend.totalVolume.toString() : '0',
                avgPrice: trend.avgPrice ? trend.avgPrice.toString() : '0',
            };
        });

        const total = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                { $group: { _id: '$data.collectionSymbol' } },
                { $count: 'total' },
            ])
            .toArray();

        res.json({
            data: enhancedTrending,
            total: total[0]?.total || 0,
            period: `${days} days`,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching trending collections:', error);
        res.status(500).json({ message: 'Error fetching trending collections', error: error.message });
    }
}) as RequestHandler);




router.get('/search', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);
    const searchTerm = req.query.q as string;
    const searchType = (req.query.type as string) || 'all'; 

    if (!searchTerm) {
        return res.status(400).json({ message: 'Search term (q) is required' });
    }

    try {
        const results: any = {};

        
        if (searchType === 'collections' || searchType === 'all') {
            const collectionQuery: any = {
                $or: [
                    { name: { $regex: searchTerm, $options: 'i' } }, 
                    { creator: { $regex: searchTerm, $options: 'i' } }, 
                    { description: { $regex: searchTerm, $options: 'i' } }, 
                ],
            };

            
            if (searchTerm.length > 0) {
                collectionQuery.$or.push({ _id: { $regex: `^${searchTerm}`, $options: 'i' } });
            }

            const collectionsFromDB = await cache.findPromise('nftCollections', collectionQuery, {
                limit: searchType === 'collections' ? limit : 10,
                skip: searchType === 'collections' ? skip : 0,
                sort: { createdAt: -1 },
            });

            results.collections = {
                data: collectionsFromDB ? collectionsFromDB.map(transformNftCollectionData) : [],
                total: await mongo.getDb().collection('nftCollections').countDocuments(collectionQuery),
            };
        }

        
        if (searchType === 'nfts' || searchType === 'all') {
            const nftQuery: any = {
                $or: [
                    { collectionSymbol: { $regex: searchTerm, $options: 'i' } }, 
                    { owner: { $regex: searchTerm, $options: 'i' } }, 
                    { 'metadata.name': { $regex: searchTerm, $options: 'i' } }, 
                    { 'metadata.description': { $regex: searchTerm, $options: 'i' } }, 
                ],
            };

            
            if (searchTerm.length > 0) {
                nftQuery.$or.push({ _id: { $regex: `^${searchTerm}`, $options: 'i' } });
            }

            const nftsFromDB = await cache.findPromise('nfts', nftQuery, {
                limit: searchType === 'nfts' ? limit : 10,
                skip: searchType === 'nfts' ? skip : 0,
                sort: { createdAt: -1 },
            });

            results.nfts = {
                data: nftsFromDB ? nftsFromDB.map(transformNftInstanceData) : [],
                total: await mongo.getDb().collection('nfts').countDocuments(nftQuery),
            };
        }

        
        if (searchType === 'listings' || searchType === 'all') {
            const listingQuery = {
                status: 'active',
                $or: [{ collectionId: { $regex: searchTerm, $options: 'i' } }, { seller: { $regex: searchTerm, $options: 'i' } }],
            };

            const listingsFromDB = await cache.findPromise('nftListings', listingQuery, {
                limit: searchType === 'listings' ? limit : 5,
                skip: searchType === 'listings' ? skip : 0,
                sort: { createdAt: -1 },
            });

            results.listings = {
                data: listingsFromDB ? listingsFromDB.map(transformNftListingData) : [],
                total: await mongo.getDb().collection('nftListings').countDocuments(listingQuery),
            };
        }

        res.json({
            searchTerm,
            searchType,
            results,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error('Error performing NFT search:', error);
        res.status(500).json({ message: 'Error performing search', error: error.message });
    }
}) as RequestHandler);




router.get('/user/:username/activity', (async (req: Request, res: Response) => {
    const { username } = req.params;
    const { limit, skip } = getPagination(req);
    const activityType = req.query.type as string; 

    try {
        const activities: any[] = [];

        
        if (!activityType || activityType === 'purchases' || activityType === 'all') {
            const purchases = await mongo
                .getDb()
                .collection('transactions')
                .find({
                    type: 6, 
                    'data.buyer': username,
                })
                .sort({ ts: -1 })
                .limit(activityType === 'purchases' ? limit : 20)
                .toArray();

            purchases.forEach(tx => {
                activities.push({
                    type: 'purchase',
                    timestamp: tx.ts,
                    transactionId: tx._id,
                    nftId: `${tx.data.collectionSymbol}_${tx.data.instanceId}`,
                    collectionSymbol: tx.data.collectionSymbol,
                    price: tx.data.price,
                    paymentToken: tx.data.paymentToken,
                    from: tx.data.seller,
                    to: tx.data.buyer,
                });
            });
        }

        
        if (!activityType || activityType === 'sales' || activityType === 'all') {
            const sales = await mongo
                .getDb()
                .collection('transactions')
                .find({
                    type: 6, 
                    'data.seller': username,
                })
                .sort({ ts: -1 })
                .limit(activityType === 'sales' ? limit : 20)
                .toArray();

            sales.forEach(tx => {
                activities.push({
                    type: 'sale',
                    timestamp: tx.ts,
                    transactionId: tx._id,
                    nftId: `${tx.data.collectionSymbol}_${tx.data.instanceId}`,
                    collectionSymbol: tx.data.collectionSymbol,
                    price: tx.data.price,
                    paymentToken: tx.data.paymentToken,
                    from: tx.data.seller,
                    to: tx.data.buyer,
                });
            });
        }

        
        if (!activityType || activityType === 'listings' || activityType === 'all') {
            const listings = await mongo
                .getDb()
                .collection('transactions')
                .find({
                    type: 4, 
                    'data.seller': username,
                })
                .sort({ ts: -1 })
                .limit(activityType === 'listings' ? limit : 20)
                .toArray();

            listings.forEach(tx => {
                activities.push({
                    type: 'listing',
                    timestamp: tx.ts,
                    transactionId: tx._id,
                    nftId: `${tx.data.collectionSymbol}_${tx.data.instanceId}`,
                    collectionSymbol: tx.data.collectionSymbol,
                    price: tx.data.price,
                    paymentToken: tx.data.paymentToken,
                    listingType: tx.data.listingType,
                    seller: tx.data.seller,
                });
            });
        }

        
        if (!activityType || activityType === 'transfers' || activityType === 'all') {
            const transfers = await mongo
                .getDb()
                .collection('transactions')
                .find({
                    type: 3, 
                    $or: [{ 'data.from': username }, { 'data.to': username }],
                })
                .sort({ ts: -1 })
                .limit(activityType === 'transfers' ? limit : 20)
                .toArray();

            transfers.forEach(tx => {
                activities.push({
                    type: tx.data.from === username ? 'transfer_out' : 'transfer_in',
                    timestamp: tx.ts,
                    transactionId: tx._id,
                    nftId: `${tx.data.collectionSymbol}_${tx.data.instanceId}`,
                    collectionSymbol: tx.data.collectionSymbol,
                    from: tx.data.from,
                    to: tx.data.to,
                });
            });
        }

        
        if (!activityType || activityType === 'mints' || activityType === 'all') {
            const mints = await mongo
                .getDb()
                .collection('transactions')
                .find({
                    type: 2, 
                    'data.to': username,
                })
                .sort({ ts: -1 })
                .limit(activityType === 'mints' ? limit : 20)
                .toArray();

            mints.forEach(tx => {
                activities.push({
                    type: 'mint',
                    timestamp: tx.ts,
                    transactionId: tx._id,
                    nftId: `${tx.data.collectionSymbol}_${tx.data.instanceId}`,
                    collectionSymbol: tx.data.collectionSymbol,
                    to: tx.data.to,
                });
            });
        }

        
        activities.sort((a, b) => b.timestamp - a.timestamp);
        const paginatedActivities = activities.slice(skip, skip + limit);

        res.json({
            username,
            activityType: activityType || 'all',
            data: paginatedActivities,
            total: activities.length,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching user activity for ${username}:`, error);
        res.status(500).json({ message: 'Error fetching user activity', error: error.message });
    }
}) as RequestHandler);


router.get('/user/:username/stats', (async (req: Request, res: Response) => {
    const { username } = req.params;
    const days = parseInt(req.query.days as string) || 30; 

    try {
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        
        const ownedNfts = await mongo.getDb().collection('nfts').countDocuments({ owner: username });

        
        const activeListings = await mongo.getDb().collection('nftListings').countDocuments({
            seller: username,
            status: 'active',
        });

        
        const salesStats = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        'data.seller': username,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: 1 },
                        totalEarned: { $sum: { $toDecimal: '$data.price' } },
                        avgSalePrice: { $avg: { $toDecimal: '$data.price' } },
                    },
                },
            ])
            .toArray();

        
        const purchaseStats = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        'data.buyer': username,
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalPurchases: { $sum: 1 },
                        totalSpent: { $sum: { $toDecimal: '$data.price' } },
                        avgPurchasePrice: { $avg: { $toDecimal: '$data.price' } },
                    },
                },
            ])
            .toArray();

        
        const collectionsOwned = await mongo
            .getDb()
            .collection('nfts')
            .aggregate([{ $match: { owner: username } }, { $group: { _id: '$collectionSymbol', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
            .toArray();

        const sales = salesStats[0] || { totalSales: 0, totalEarned: 0, avgSalePrice: 0 };
        const purchases = purchaseStats[0] || { totalPurchases: 0, totalSpent: 0, avgPurchasePrice: 0 };

        res.json({
            username,
            period: `${days} days`,
            portfolio: {
                ownedNfts,
                activeListings,
                collectionsOwned: collectionsOwned.length,
                topCollections: collectionsOwned.slice(0, 5),
            },
            trading: {
                sales: {
                    total: sales.totalSales,
                    volume: sales.totalEarned ? sales.totalEarned.toString() : '0',
                    averagePrice: sales.avgSalePrice ? sales.avgSalePrice.toString() : '0',
                },
                purchases: {
                    total: purchases.totalPurchases,
                    volume: purchases.totalSpent ? purchases.totalSpent.toString() : '0',
                    averagePrice: purchases.avgPurchasePrice ? purchases.avgPurchasePrice.toString() : '0',
                },
                netVolume: sales.totalEarned && purchases.totalSpent ? (sales.totalEarned - purchases.totalSpent).toString() : '0',
            },
        });
    } catch (error: any) {
        logger.error(`Error fetching user stats for ${username}:`, error);
        res.status(500).json({ message: 'Error fetching user statistics', error: error.message });
    }
}) as RequestHandler);




router.get('/offers', (async (req: Request, res: Response) => {
    const { limit, skip } = getPagination(req);

    try {
        const query: any = {};

        
        if (req.query.status) {
            query.status = req.query.status;
        } else {
            query.status = 'active'; 
        }

        
        if (req.query.targetType) {
            query.targetType = req.query.targetType;
        }

        
        if (req.query.offerer) {
            query.offerer = req.query.offerer;
        }

        
        if (req.query.target) {
            query.target = req.query.target;
        }

        
        if (req.query.minOffer) {
            query.offerAmount = { $gte: req.query.minOffer };
        }
        if (req.query.maxOffer) {
            if (!query.offerAmount) query.offerAmount = {};
            query.offerAmount.$lte = req.query.maxOffer;
        }

        
        const sortField = (req.query.sortBy as string) || 'createdAt';
        const sortDirection = req.query.sortDirection === 'asc' ? 1 : -1;
        const sort: any = {};
        sort[sortField] = sortDirection;

        const offersFromDB = await cache.findPromise('nftOffers', query, {
            limit,
            skip,
            sort,
        });

        const total = await mongo.getDb().collection('nftOffers').countDocuments(query);

        if (!offersFromDB || offersFromDB.length === 0) {
            return res.status(200).json({ data: [], total: 0, limit, skip });
        }

        res.json({
            data: offersFromDB,
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error('Error fetching NFT offers:', error);
        res.status(500).json({ message: 'Error fetching NFT offers', error: error.message });
    }
}) as RequestHandler);


router.get('/offers/nft/:nftId', (async (req: Request, res: Response) => {
    const { nftId } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query = {
            targetType: 'NFT',
            target: nftId,
            status: 'active',
        };

        const offersFromDB = await cache.findPromise('nftOffers', query, {
            limit,
            skip,
            sort: { offerAmount: -1, createdAt: -1 }, 
        });

        const total = await mongo.getDb().collection('nftOffers').countDocuments(query);

        res.json({
            nftId,
            data: offersFromDB || [],
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching offers for NFT ${nftId}:`, error);
        res.status(500).json({ message: 'Error fetching NFT offers', error: error.message });
    }
}) as RequestHandler);


router.get('/offers/collection/:symbol', (async (req: Request, res: Response) => {
    const { symbol } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query = {
            targetType: 'COLLECTION',
            target: symbol,
            status: 'active',
        };

        const offersFromDB = await cache.findPromise('nftOffers', query, {
            limit,
            skip,
            sort: { offerAmount: -1, createdAt: -1 }, 
        });

        const total = await mongo.getDb().collection('nftOffers').countDocuments(query);

        res.json({
            collectionSymbol: symbol,
            data: offersFromDB || [],
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching offers for collection ${symbol}:`, error);
        res.status(500).json({ message: 'Error fetching collection offers', error: error.message });
    }
}) as RequestHandler);


router.get('/offers/user/:username', (async (req: Request, res: Response) => {
    const { username } = req.params;
    const { limit, skip } = getPagination(req);

    try {
        const query: any = { offerer: username };

        
        if (req.query.status) {
            query.status = req.query.status;
        }

        const offersFromDB = await cache.findPromise('nftOffers', query, {
            limit,
            skip,
            sort: { createdAt: -1 }, 
        });

        const total = await mongo.getDb().collection('nftOffers').countDocuments(query);

        res.json({
            username,
            data: offersFromDB || [],
            total,
            limit,
            skip,
        });
    } catch (error: any) {
        logger.error(`Error fetching offers for user ${username}:`, error);
        res.status(500).json({ message: 'Error fetching user offers', error: error.message });
    }
}) as RequestHandler);


router.get('/offers/:offerId', (async (req: Request, res: Response) => {
    const { offerId } = req.params;

    try {
        const offer = await cache.findOnePromise('nftOffers', { _id: offerId });

        if (!offer) {
            return res.status(404).json({ message: `Offer with ID ${offerId} not found.` });
        }

        res.json(offer);
    } catch (error: any) {
        logger.error(`Error fetching offer ${offerId}:`, error);
        res.status(500).json({ message: 'Error fetching offer', error: error.message });
    }
}) as RequestHandler);




router.get('/marketplace/stats', (async (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 7;

    try {
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        
        const totalCollections = await mongo.getDb().collection('nftCollections').countDocuments();

        
        const totalNfts = await mongo.getDb().collection('nfts').countDocuments();

        
        const totalOwnersData = await mongo
            .getDb()
            .collection('nfts')
            .aggregate([{ $group: { _id: '$owner' } }, { $count: 'totalOwners' }])
            .toArray();
        const totalOwners = totalOwnersData[0]?.totalOwners || 0;

        
        const activeListings = await mongo.getDb().collection('nftListings').countDocuments({ status: 'active' });

        
        const salesStats = await mongo
            .getDb()
            .collection('transactions')
            .aggregate([
                {
                    $match: {
                        type: 6, 
                        ts: { $gte: cutoffDate.getTime() / 1000 },
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: 1 },
                        totalVolume: { $sum: { $toDecimal: '$data.price' } },
                        avgPrice: { $avg: { $toDecimal: '$data.price' } },
                        uniqueBuyers: { $addToSet: '$data.buyer' },
                        uniqueSellers: { $addToSet: '$data.seller' },
                    },
                },
                {
                    $project: {
                        totalSales: 1,
                        totalVolume: 1,
                        avgPrice: 1,
                        uniqueBuyers: { $size: '$uniqueBuyers' },
                        uniqueSellers: { $size: '$uniqueSellers' },
                    },
                },
            ])
            .toArray();

        const sales = salesStats[0] || {
            totalSales: 0,
            totalVolume: 0,
            avgPrice: 0,
            uniqueBuyers: 0,
            uniqueSellers: 0,
        };

        
        const activeBids = await mongo.getDb().collection('nftBids').countDocuments({ status: 'active' });
        const activeOffers = await mongo.getDb().collection('nftOffers').countDocuments({ status: 'active' });

        res.json({
            period: `${days} days`,
            overview: {
                totalCollections,
                totalNfts,
                totalOwners,
                activeListings,
                activeBids,
                activeOffers,
                listingRate: totalNfts > 0 ? ((activeListings / totalNfts) * 100).toFixed(2) : '0',
            },
            trading: {
                totalSales: sales.totalSales,
                totalVolume: sales.totalVolume ? sales.totalVolume.toString() : '0',
                averagePrice: sales.avgPrice ? sales.avgPrice.toString() : '0',
                uniqueBuyers: sales.uniqueBuyers,
                uniqueSellers: sales.uniqueSellers,
            },
        });
    } catch (error: any) {
        logger.error('Error fetching marketplace stats:', error);
        res.status(500).json({ message: 'Error fetching marketplace statistics', error: error.message });
    }
}) as RequestHandler);

export default router;
