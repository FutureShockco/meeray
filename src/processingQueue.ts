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
                    // Log the error from the queued task
                    console.error('Error in ProcessingQueue task:', err);
                    // Depending on the desired behavior, you might want to stop processing,
                    // retry, or implement more sophisticated error handling.
                    // For now, just logging and continuing.
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