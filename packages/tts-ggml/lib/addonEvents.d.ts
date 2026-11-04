/**
 * Native output callbacks, routed to the job handler and the sentence stream:
 * an error fails the job, audio goes out as output (enriched while a sentence
 * stream is active) and stats end the job unless the stream consumes them.
 */
import type { JobHandler } from "@qvac/infer-base";
import type QvacLoggerType from "@qvac/logging";
import { type SentenceStreamer } from "./sentenceStream";
import type { NativeStats, RuntimeStats } from "./types";
export interface AddonEventHost {
    readonly job: JobHandler;
    readonly stream: SentenceStreamer;
    logger(): QvacLoggerType;
    /** Whether stats reach the response (`opts.stats`). */
    reportStats(): boolean;
}
export declare class AddonEventRouter {
    private readonly host;
    constructor(host: AddonEventHost);
    route(event: unknown, data: unknown, error: unknown): void;
    /** Ends the job, forwarding the stats only when the caller asked for them. */
    endJob(stats: RuntimeStats | NativeStats): void;
    private onError;
    private onOutput;
    private onStats;
}
