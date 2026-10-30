export interface ParakeetSpeakerAttributionConfig {
    /** Path to the separate diarization GGUF used with the ASR model. */
    modelPath: string;
    mergeSameSpeaker?: boolean;
    minSegmentMs?: number;
    padSegmentMs?: number;
}
export declare function validateParakeetBackend(backend: unknown): void;
export declare function validateSpeakerAttribution(config: unknown): void;
