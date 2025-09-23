import 'winston';
import { LeveledLogMethod } from 'winston';

declare module 'winston' {
    interface Logger {
        trace: LeveledLogMethod;
        perf: LeveledLogMethod;
        cons: LeveledLogMethod;
        fatal: LeveledLogMethod;
    }
}