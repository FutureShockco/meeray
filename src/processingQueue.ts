import logger from "./logger.js";

export class ProcessingQueue {
    queue: Array<(callback: (err: any, result?: any) => void) => void>;
    processing: boolean;

    constructor() {
        this.queue = [];
        this.processing = false;
    }

    push(f: (callback: (err: any, result?: any) => void) => void = (cb) => cb(null)): void {
        this.queue.push(f);
        if (!this.processing) {
            this.processing = true;
            this.execute();
        }
    }

    private execute(): void {
        const first = this.queue.shift();
        if (first) {
            first((err: any, result?: any) => {
                if (err) {
                    logger.error('Error in ProcessingQueue task:', err);
                }
                if (this.queue.length > 0) {
                    this.execute();
                } else {
                    this.processing = false;
                }
            });
        } else {
            this.processing = false;
        }
    }
}

export default ProcessingQueue;