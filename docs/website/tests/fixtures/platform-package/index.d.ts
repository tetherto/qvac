/** How a model is loaded. */
export type LoadMode = 'eager' | 'lazy'

/** Options of {@link translate}. */
export interface TranslateOptions {
  /** Target language, as a BCP 47 tag. */
  to: string
  /** Source language; detected when omitted. */
  from?: string
  /** How the model is loaded. */
  mode?: LoadMode
}

/** The result of a translation. */
export type Translation = {
  /** The translated text. */
  text: string
  /** Tokens generated. */
  tokens: number
}

/** Engine log levels. */
export declare enum LogLevel {
  Error = 0,
  Info = 1,
}

/** The version this package implements. */
export declare const ENGINE_VERSION: string

/**
 * Translates a text.
 * @param text The text to translate.
 * @param options Where to translate it.
 * @returns The translation.
 */
export declare function translate(text: string, options: TranslateOptions): Promise<Translation>
/**
 * Translates several texts, in order.
 * @param texts The texts to translate.
 * @param options Where to translate them.
 */
export declare function translate(texts: string[], options: TranslateOptions): Promise<Translation[]>

/** A loaded translation model. */
export declare class Translator {
  /** @param path Where the model is. */
  constructor(path: string)
  /** Where the model was loaded from. */
  readonly path: string
  /** Releases the model. */
  unload(): Promise<void>
}

/**
 * @deprecated Use {@link translate}.
 */
export declare function legacyTranslate(text: string): string
