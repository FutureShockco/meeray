import 'winston';

declare module 'winston' {
    interface Logger {
        trace: LeveledLogMethod;
        perf: LeveledLogMethod;
        cons: LeveledLogMethod;
        fatal: LeveledLogMethod;
    }
}