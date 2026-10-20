/**
 * Native output callbacks, routed to the job handler and the sentence stream:
 * an error fails the job, audio goes out as output (enriched while a sentence
 * stream is active) and stats end the job unless the stream consumes them.
 */
import type { JobHandler } from "@qvac/infer-base";
import type QvacLoggerType from "@qvac/logging";
import {
  isAudioOutputEvent,
  isStatsEvent,
  ttsOutputDebugString,
  type SentenceStreamer,
} from "./sentenceStream";
import type { NativeOutputChunk, NativeStats, RuntimeStats } from "./types";

export interface AddonEventHost {
  readonly job: JobHandler;
  readonly stream: SentenceStreamer;
  logger(): QvacLoggerType;
  /** Whether stats reach the response (`opts.stats`). */
  reportStats(): boolean;
}

export class AddonEventRouter {
  constructor(private readonly host: AddonEventHost) {}

  route(event: unknown, data: unknown, error: unknown): void {
    if (typeof error === "string" && error.length > 0) this.onError(error);
    else if (isAudioOutputEvent(data)) this.onOutput(data);
    else if (isStatsEvent(data)) this.onStats(data);
    else this.host.logger().debug(`Received TTS event: ${String(event)}`);
  }

  /** Ends the job, forwarding the stats only when the caller asked for them. */
  endJob(stats: RuntimeStats | NativeStats): void {
    if (this.host.reportStats()) this.host.job.end(stats);
    else this.host.job.end();
  }

  private onError(error: string): void {
    this.host.logger().error(`TTS job failed with error: ${error}`);
    this.host.stream.rejectActiveChunk(new Error(error));
    this.host.job.fail(error);
  }

  private onOutput(data: NativeOutputChunk): void {
    const logger = this.host.logger();
    try {
      logger.debug(`TTS job produced output: ${ttsOutputDebugString(data)}`);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      logger.debug("TTS job produced output: [data too large]");
    }
    const { stream } = this.host;
    this.host.job.output(stream.ctx ? stream.enrich(data) : data);
  }

  private onStats(data: NativeStats): void {
    this.host.logger().info(`TTS job completed. Stats: ${JSON.stringify(data)}`);
    if (!this.host.stream.onStats(data)) this.endJob(data);
  }
}
