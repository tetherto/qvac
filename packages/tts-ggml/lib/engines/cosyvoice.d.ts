import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const COSYVOICE3_LLM_RE: RegExp;
export declare const COSYVOICE_DIALECTS: {
    readonly cantonese: "广东话";
    readonly northeastern: "东北话";
    readonly gansu: "甘肃话";
    readonly guizhou: "贵州话";
    readonly henan: "河南话";
    readonly hubei: "湖北话";
    readonly hunan: "湖南话";
    readonly jiangxi: "江西话";
    readonly minnan: "闽南话";
    readonly ningxia: "宁夏话";
    readonly shanxi: "山西话";
    readonly shaanxi: "陕西话";
    readonly shandong: "山东话";
    readonly shanghai: "上海话";
    readonly sichuan: "四川话";
    readonly tianjin: "天津话";
    readonly yunnan: "云南话";
};
export declare const COSYVOICE_VOLUMES: {
    readonly loud: "Please say a sentence as loudly as possible.";
    readonly soft: "Please say a sentence in a very soft voice.";
};
export declare const COSYVOICE_STYLES: {
    readonly peppa: "我想体验一下小猪佩奇风格，可以吗？";
    readonly robot: "你可以尝试用机器人的方式解答吗？";
};
/**
 * CosyVoice3 controls that have no canonical cross-engine vocabulary yet.
 * Emotion and speaking rate are NOT here -- use the top-level `emotion` /
 * `pace` options, which work the same way on every engine that supports them.
 * Exactly one field takes effect per synthesis, resolved by precedence
 * dialect > volume > style. Pass a raw string instead for an arbitrary
 * instruction (advanced escape hatch).
 */
export interface CosyvoiceInstruct {
    /** Chinese dialect; renders "请用{dialect}表达。". */
    dialect?: keyof typeof COSYVOICE_DIALECTS;
    /** Loudness. */
    volume?: keyof typeof COSYVOICE_VOLUMES;
    /** Playful style preset. */
    style?: keyof typeof COSYVOICE_STYLES;
}
/**
 * Render a CosyVoice3 `instruct` option to the trained instruction string.
 * A raw string passes through (trimmed); the structured form emits exactly one
 * control by precedence dialect > volume > style. Returns "" for no
 * instruction. An invalid structured key throws.
 */
export declare function renderCosyvoiceInstruct(instruct: string | CosyvoiceInstruct | undefined): string;
/**
 * CosyVoice3 per-call instruction. Same values as the constructor's
 * `instruct`; a per-call conditioning control replaces the configured one for
 * that synthesis, and one control takes effect per synthesis.
 */
export interface CosyvoiceJobFields {
    instruct?: string | CosyvoiceInstruct;
}
/**
 * True when `modelDir` contains a CosyVoice3 LLM GGUF (the sub-model that
 * unambiguously identifies a CosyVoice3 model directory).
 */
export declare function dirHasCosyvoice3(modelDir?: string): boolean;
/**
 * CosyVoice3 discovers its sub-model GGUFs from a model directory; the native
 * engine resolves the individual components. Explicit per-component paths win
 * over the directory.
 */
export declare function resolveCosyvoiceModelPaths(files: NormalizedFiles): Pick<ModelPaths, "cosyvoiceModelDir" | "cosyvoiceLlmModelPath" | "cosyvoiceFlowModelPath" | "cosyvoiceHiftModelPath" | "cosyvoiceS3tokModelPath" | "cosyvoiceCampplusModelPath" | "cosyvoiceVocabPath" | "cosyvoiceMergesPath" | "cosyvoiceVoiceModelPath">;
export declare function assertCosyvoiceOptionConsistency(setup: EngineSetup): void;
/**
 * `promptText` is deliberately not required: its absence selects
 * cross-lingual mode. With a model dir present but no cloning GGUFs in it,
 * the native load fail-closes instead.
 */
export declare function assertCosyvoiceCloneConsistent(setup: EngineSetup): void;
/**
 * CosyVoice3's per-call instruction, rendered like the constructor's. The
 * native layer reads it next to emotion/pace, and any of the three replaces
 * the configured conditioning for that synthesis.
 */
export declare function resolveJobInstruct(setup: EngineSetup, source: CosyvoiceJobFields | null | undefined, where: string): string | undefined;
export declare function buildCosyvoiceParams(setup: EngineSetup): TTSConfigurationParams;
