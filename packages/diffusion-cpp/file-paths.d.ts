import type { DiffusionFiles } from './index';
/** The keys a video file set adds on top of `DiffusionFiles`. */
export interface DiffusionVideoFiles {
    clipVision?: string;
    audioVae?: string;
    embeddingsConnectors?: string;
}
/**
 * Rejects a file set the engine could only report as an opaque error. Shared
 * so a fit refuses the same paths a load refuses.
 */
export declare function assertFilePaths(files: DiffusionFiles & DiffusionVideoFiles): void;
/** The file-path half of `SdConfigurationParams`, without `config`. */
export interface DiffusionFilePaths {
    path: string;
    diffusionModelPath: string;
    highNoiseDiffusionModelPath: string;
    uncondDiffusionModelPath: string;
    clipLPath: string;
    clipGPath: string;
    t5XxlPath: string;
    llmPath: string;
    vaePath: string;
    clipVisionPath: string;
    esrganPath: string;
    audioVaePath: string;
    embeddingsConnectorsPath: string;
}
/**
 * Maps a file set onto the keys the engine reads. A split layout carries the
 * diffusion weights under their own key and leaves `path` empty, which is how
 * the engine tells the two layouts apart.
 *
 * Shared with the image load so a fit of the same files describes them the
 * same way. The video load maps its own, keeping the weights under
 * `diffusionModelPath` whatever the companion set holds.
 */
export declare function toFilePaths(files: DiffusionFiles & DiffusionVideoFiles): DiffusionFilePaths;
