import type { EngineSetup } from "./engineSetup";
import { type Audio8VoiceFields, type Audio8VoiceFieldsResolved } from "./engines/audio8";
import { type CosyvoiceJobFields } from "./engines/cosyvoice";
import { type MossSoundEffectFields } from "./engines/mossSoundEffect";
import { type MossSpeechFields, type MossSpeechJobFields } from "./engines/mossSpeech";
import { type ParlerDescFields, type ParlerJobSource } from "./engines/parler";
/** Per-call engine fields forwarded verbatim onto the native job object. */
export type JobFields = ParlerDescFields & Audio8VoiceFieldsResolved & MossSoundEffectFields & MossSpeechJobFields & {
    instruct?: string;
};
/** Everything a run input or streaming options object may carry per call. */
export type JobFieldSource = ParlerJobSource & Audio8VoiceFields & CosyvoiceJobFields & MossSoundEffectFields & MossSpeechFields & {
    input?: string;
};
/**
 * The per-call fields of whichever engine is loaded, if any are set. Parler
 * takes the full description/template surface, Audio8 its voice override,
 * and every engine the cross-engine conditioning it supports.
 */
export declare function resolveJobFields(setup: EngineSetup, source: JobFieldSource | null | undefined, where: string): JobFields | undefined;
