import type { TTSConfigurationParams } from "../tts";
interface PocketFiles {
    modelDir?: string;
    pocketFlowModel?: string;
    pocketMimiModel?: string;
    pocketFrontend?: string;
    pocketVoice?: string;
}
export declare function buildPocketParams(files: PocketFiles, optionInput: object, configInput: object): TTSConfigurationParams;
export {};
