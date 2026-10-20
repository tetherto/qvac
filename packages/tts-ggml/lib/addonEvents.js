"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddonEventRouter = void 0;
const sentenceStream_1 = require("./sentenceStream");
class AddonEventRouter {
    host;
    constructor(host) {
        this.host = host;
    }
    route(event, data, error) {
        if (typeof error === "string" && error.length > 0)
            this.onError(error);
        else if ((0, sentenceStream_1.isAudioOutputEvent)(data))
            this.onOutput(data);
        else if ((0, sentenceStream_1.isStatsEvent)(data))
            this.onStats(data);
        else
            this.host.logger().debug(`Received TTS event: ${String(event)}`);
    }
    /** Ends the job, forwarding the stats only when the caller asked for them. */
    endJob(stats) {
        if (this.host.reportStats())
            this.host.job.end(stats);
        else
            this.host.job.end();
    }
    onError(error) {
        this.host.logger().error(`TTS job failed with error: ${error}`);
        this.host.stream.rejectActiveChunk(new Error(error));
        this.host.job.fail(error);
    }
    onOutput(data) {
        const logger = this.host.logger();
        try {
            logger.debug(`TTS job produced output: ${(0, sentenceStream_1.ttsOutputDebugString)(data)}`);
        }
        catch (error) {
            if (!(error instanceof RangeError))
                throw error;
            logger.debug("TTS job produced output: [data too large]");
        }
        const { stream } = this.host;
        this.host.job.output(stream.ctx ? stream.enrich(data) : data);
    }
    onStats(data) {
        this.host.logger().info(`TTS job completed. Stats: ${JSON.stringify(data)}`);
        if (!this.host.stream.onStats(data))
            this.endJob(data);
    }
}
exports.AddonEventRouter = AddonEventRouter;
