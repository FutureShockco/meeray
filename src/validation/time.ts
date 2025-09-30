import logger from '../logger.js';

export function time(time: string): boolean {
    const date = new Date(time);
    if (isNaN(date.getTime()) || time.length < 10) {
        logger.warn(`[time:validation] time is not a valid ISO string: ${time}`);
        return false;
    }
    if (date.getTime() <= Date.now()) {
        logger.warn(`[time:validation] time is not in the future: ${time}`);
        return false;
    }
    return true;
}

export function times(time1: string, time2?: string): boolean {
    if (!time(time1)) return false;
    if (time2 !== undefined) {
        if (!time(time2)) return false;
        const date1 = new Date(time1);
        const date2 = new Date(time2);
        if (date1.getTime() >= date2.getTime()) {
            logger.warn(`[time:validation] time1 is not before time2: time1=${time1}, time2=${time2}`);
            return false;
        }
    }
    return true;
}