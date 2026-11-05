import type { EngineSetup, SynthesisSettings } from "./engineSetup";
export declare function requestsChunkStreaming(settings: SynthesisSettings): boolean;
/** Native chunk streaming against what the engine can actually do. */
export declare function assertChunkStreamingSupport(setup: EngineSetup): void;
/** The LavaSR denoiser has no streaming form yet. */
export declare function assertDenoiserBatchOnly(setup: EngineSetup): void;
/** Sentence-level streaming (runStream / runStreaming / streamOutput). */
export declare function assertSentenceStreamingAllowed(setup: EngineSetup, where: string): void;
