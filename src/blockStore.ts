import assert from 'assert';
import * as BSON from 'bson';
import fs from 'fs';

import chain from './chain.js';
import config from './config.js';
import logger from './logger.js';
import { toBigInt } from './utils/bigint.js';

const isRebuild = process.env.REBUILD_STATE === '1';

export const blocks: any = {
    fd: 0 as number,
    fdIndex: 0 as number,
    height: 0 as number,
    bsonSize: toBigInt(0),
    dataDir: process.env.BLOCKS_DIR ? process.env.BLOCKS_DIR.replace(/\/$/, '') : '',
    isOpen: false,
    notOpenError: 'Blockchain is not open',
    init: async (state: any) => {
        if (!process.env.BLOCKS_DIR) return;

        const bsonPath = blocks.dataDir + '/blocks.bson';
        const indexPath = blocks.dataDir + '/blocks.index';

        // If blocks.bson does not exist, initialize genesis state
        if (!fs.existsSync(bsonPath)) {
            if (isRebuild) {
                logger.fatal('Cannot rebuild from non-existent blocks.bson file');
                process.exit(1);
            }
            // await mongo.initGenesis();
        }

        // Create files if not exists already
        blocks.touch();

        // Open blocks.bson file
        logger.info('Opening blockchain database at ' + blocks.dataDir + '...');
        blocks.fd = fs.openSync(bsonPath, 'a+');
        blocks.bsonSize = toBigInt(fs.statSync(bsonPath).size);

        // Open blocks.index file
        blocks.fdIndex = fs.openSync(indexPath, 'a+');

        const indexSize = fs.statSync(indexPath).size;
        blocks.height = indexSize / 8 - 1;
        blocks.isOpen = true;

        // Determine if resumption of index creation is required
        if (indexSize > 0) {
            assert(indexSize % 8 === 0, 'Size of index file should be in multiple of 8');
            let docPosition = toBigInt(0);
            const docSizeBuf = Buffer.alloc(4);
            const docIndexBuf = Buffer.alloc(8);
            fs.readSync(blocks.fdIndex, docIndexBuf, { offset: 0, position: indexSize - 8, length: 8 });
            docPosition = toBigInt(Number(toBigInt(docIndexBuf.readUInt32LE(0)) << 8n) + docIndexBuf.readUInt32LE(4));
            assert(docPosition < blocks.bsonSize, 'Latest indexed position greater than or equal to blocks.bson size');
            fs.readSync(blocks.fd, docSizeBuf, { offset: 0, position: docPosition, length: 4 });
            const docSize = toBigInt(docSizeBuf.readInt32LE(0));
            docPosition += docSize;
            if (docPosition < blocks.bsonSize) {
                logger.info('Resuming index creation from block ' + blocks.height);
                blocks.reconstructIndex(docSizeBuf, docPosition, blocks.height + 1);
            }
        }

        // Reconstruct index file if empty
        if (blocks.bsonSize > 0n && blocks.height === -1) blocks.reconstructIndex();
        else if (blocks.bsonSize === 0n)
            if (blocks.height > -1) {
                logger.fatal('Could not read empty blockchain and non-empty index file');
                blocks.close();
                process.exit(1);
            } else {
                logger.info('Inserting Block #0 with hash ' + (typeof config !== 'undefined' ? config.originHash : '[originHash]'));
                // blocks.appendBlock(chain.getGenesisBlock());
            }
        else {
            logger.info('Opened blockchain with latest block #' + blocks.height);
        }

        const hasState = state && state.headBlock;
        if (hasState && state.headBlock > blocks.height) {
            logger.fatal('Head block state exceeds blockchain height');
            blocks.close();
            process.exit(1);
        }

        // if (isRebuild && !hasState) {
        //     await db.dropDatabase();
        //     await mongo.initGenesis();
        // }
        // if (isRebuild) chain.restoredBlocks = blocks.height;
    },
    touch: () => {
        const bsonPath = blocks.dataDir + '/blocks.bson';
        const indexPath = blocks.dataDir + '/blocks.index';
        if (!fs.existsSync(bsonPath)) fs.closeSync(fs.openSync(bsonPath, 'w'));
        if (!fs.existsSync(indexPath)) fs.closeSync(fs.openSync(indexPath, 'w'));
    },
    reconstructIndex: (currentDocSizeBuf?: Buffer, currentDocPosition?: bigint, currentBlockHeight?: number) => {
        assert(blocks.isOpen, blocks.notOpenError);
        logger.info('Reconstructing blocks BSON index file...');

        const startTime = new Date().getTime();
        const indexBuf = Buffer.alloc(8);
        const docSizeBuf = currentDocSizeBuf || Buffer.alloc(4);
        let docPosition = currentDocPosition || toBigInt(0);
        let blockHeight = currentBlockHeight || 0;
        while (docPosition < blocks.bsonSize) {
            fs.readSync(blocks.fd, docSizeBuf, { offset: 0, position: Number(docPosition), length: 4 });
            indexBuf.writeUInt32LE(Number(docPosition >> 8n), 0);
            indexBuf.writeUInt32LE(Number(docPosition & 0xffn), 4);
            fs.writeSync(blocks.fdIndex, indexBuf);
            docPosition += toBigInt(docSizeBuf.readInt32LE(0));
            blockHeight++;
        }
        blocks.height = blockHeight - 1;

        logger.info('Index reconstructed up to block #' + blocks.height + ' in ' + (new Date().getTime() - startTime) + 'ms');
    },
    appendBlock: (newBlock: any) => {
        assert(blocks.isOpen, blocks.notOpenError);
        assert(newBlock._id === blocks.height + 1, 'could not append non-next block');
        const serializedBlock = BSON.serialize(newBlock);
        const newBlockSize = toBigInt(serializedBlock.length);
        fs.writeSync(blocks.fd, serializedBlock);
        blocks.appendIndex(blocks.bsonSize);
        blocks.bsonSize += newBlockSize;
        blocks.height++;
    },
    appendIndex: (pos: bigint) => {
        assert(blocks.isOpen, blocks.notOpenError);
        const indexBuf = Buffer.alloc(8);
        indexBuf.writeUInt32LE(Number(pos >> 8n), 0);
        indexBuf.writeUInt32LE(Number(pos & 0xffn), 4);
        fs.writeSync(blocks.fdIndex, indexBuf);
    },
    read: (blockNum: number = 0) => {
        if (!blocks.isOpen) throw new Error(blocks.notOpenError);
        else if (isNaN(blockNum) || parseInt(blockNum.toString()) < 0) throw new Error('Block number must be a valid non-negative integer');
        else if (blockNum > blocks.height) throw new Error('Block not found');

        // Read position of block from index
        const indexBuf = Buffer.alloc(8);
        fs.readSync(blocks.fdIndex, indexBuf, { offset: 0, position: blockNum * 8, length: 8 });
        const docPosition = Number(toBigInt(indexBuf.readUInt32LE(0)) << 8n) + indexBuf.readUInt32LE(4);
        assert(toBigInt(docPosition) < blocks.bsonSize, 'Bson position out of range');

        // Read blocks BSON at position of block
        const docSizeBuf = Buffer.alloc(4);
        fs.readSync(blocks.fd, docSizeBuf, { offset: 0, position: docPosition, length: 4 });
        const docSize = docSizeBuf.readInt32LE(0);
        const docBuf = Buffer.alloc(docSize);
        fs.readSync(blocks.fd, docBuf, { offset: 0, position: docPosition, length: docSize });
        return BSON.deserialize(docBuf);
    },
    readRange: (start: number, end: number) => {
        if (!blocks.isOpen) throw new Error(blocks.notOpenError);
        else if (isNaN(start)) throw new Error('Start block must be a valid non-negative integer');
        else if (isNaN(end) || parseInt(end.toString()) < 0) throw new Error('End block must be a valid non-negative integer');
        else if (start > end) throw new Error('Start block cannot be greater than end block');
        if (parseInt(start.toString()) < 0) start = 0;
        if (start > blocks.height) return [];
        if (end > blocks.height) end = blocks.height;

        // Read position of start block and end block from index
        const indexBuf = Buffer.alloc(8);
        const indexBufEnd = Buffer.alloc(8);
        fs.readSync(blocks.fdIndex, indexBuf, { offset: 0, position: start * 8, length: 8 });
        fs.readSync(blocks.fdIndex, indexBufEnd, { offset: 0, position: end * 8, length: 8 });
        const docPosition = Number(toBigInt(indexBuf.readUInt32LE(0)) << 8n) + indexBuf.readUInt32LE(4);
        const docPositionEnd = Number(toBigInt(indexBufEnd.readUInt32LE(0)) << 8n) + indexBufEnd.readUInt32LE(4);
        assert(toBigInt(docPosition) < blocks.bsonSize && toBigInt(docPositionEnd) < blocks.bsonSize, 'Bson position out of range');

        // Read blocks BSON from start position to end position of last block
        const docSizeBufEnd = Buffer.alloc(4);
        fs.readSync(blocks.fd, docSizeBufEnd, { offset: 0, position: docPositionEnd, length: 4 });
        const docSizeEnd = docSizeBufEnd.readInt32LE(0);
        const rangeSize = docPositionEnd - docPosition + docSizeEnd;
        const docBuf = Buffer.alloc(rangeSize);
        const docArr: any[] = [];
        fs.readSync(blocks.fd, docBuf, { offset: 0, position: docPosition, length: rangeSize });
        BSON.deserializeStream(docBuf, 0, end - start + 1, docArr, 0, {});
        return docArr;
    },
    fillInMemoryBlocks: (headBlock: number = blocks.height + 1) => {
        assert(blocks.isOpen, blocks.notOpenError);
        const end = headBlock - 1;
        const start = end - config.memoryBlocks || 0 + 1;
        chain.recentBlocks = blocks.readRange(start, end);
    },
    lastBlock: () => blocks.read(blocks.height),
    close: () => {
        if (blocks.isOpen) {
            fs.closeSync(blocks.fd);
            fs.closeSync(blocks.fdIndex);
            logger.info('Blocks BSON file closed successfully');
        }
    },
};

export default blocks;
