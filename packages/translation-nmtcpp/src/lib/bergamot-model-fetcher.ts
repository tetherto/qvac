/**
 * Bergamot Model Fetcher
 *
 * Downloads Bergamot (Firefox Translations) model files from the
 * Firefox Remote Settings CDN — the same source Firefox browser uses.
 *
 * This module does NOT touch OPUS or IndicTrans models.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

// ============================================================================
// Firefox Remote Settings CDN
// ============================================================================

const FIREFOX_RECORDS_URL =
  "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records";
const FIREFOX_ATTACHMENT_BASE =
  "https://firefox-settings-attachments.cdn.mozilla.net";

interface FirefoxAttachment {
  location?: string;
  filename?: string;
}

interface FirefoxRecord {
  fromLang?: string;
  toLang?: string;
  name?: string;
  attachment?: FirefoxAttachment;
}

// Minimal surface of `bare-fetch` used here. The shipped bare-fetch typings
// omit the `redirect`/`follow` options this module relies on, so we describe
// only what we call and resolve the module lazily via require().
interface BareFetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}
type BareFetch = (
  url: string,
  options?: { redirect?: string; follow?: number },
) => Promise<BareFetchResponse>;

/** Filenames expected for a Bergamot language pair. */
export interface BergamotFileNames {
  modelName: string;
  srcVocabName: string;
  dstVocabName: string;
  lexName: string;
}

// ============================================================================
// Helpers
// ============================================================================

// Firefox Remote Settings uses BCP 47 language tags (`zh-Hans`) while QVAC
// and Mozilla's `firefox-translations-models` repo use ISO 639-1 short codes
// (`zh`). Without normalization, the record filter below silently fails for
// Chinese pairs: the only mismatch in the current catalog. Keep the mapping
// narrow — add entries only when a concrete Firefox record requires it.
const BCP47_LANG_ALIASES: Record<string, string> = Object.freeze({
  zh: "zh-Hans",
});

export function normalizeBcp47Lang(lang: string): string {
  return BCP47_LANG_ALIASES[lang] || lang;
}

/**
 * Returns expected Bergamot model filenames for a language pair.
 * CJK target languages (zh, ja, ko) use separate src/trg vocabs.
 */
export function getBergamotFileNames(
  srcLang: string,
  dstLang: string,
): BergamotFileNames {
  const pair = `${srcLang}${dstLang}`;
  const cjk = ["zh", "ja", "ko"];
  const separateVocab =
    cjk.includes(dstLang) ||
    (cjk.includes(srcLang) && dstLang === "en" && srcLang !== "en");

  return {
    modelName: `model.${pair}.intgemm.alphas.bin`,
    srcVocabName: separateVocab ? `srcvocab.${pair}.spm` : `vocab.${pair}.spm`,
    dstVocabName: separateVocab ? `trgvocab.${pair}.spm` : `vocab.${pair}.spm`,
    lexName: `lex.50.50.${pair}.s2t.bin`,
  };
}

/**
 * Checks whether a directory already contains a valid Bergamot model
 * (at minimum an .intgemm model file and a .spm vocab file).
 */
export function hasBergamotModelFiles(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir);
    return (
      files.some((f) => f.includes(".intgemm")) &&
      files.some((f) => f.endsWith(".spm"))
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Download via Firefox Remote Settings CDN
// ============================================================================

// Minimum plausible size (bytes) for a completed Bergamot artifact.
// Real files are 800KB+ (vocab) to 30MB+ (intgemm). Anything under 1KB is
// either a stub or a truncated/failed download and should be re-fetched.
const MIN_VALID_FILE_BYTES = 1024;

/**
 * Returns true if `destPath` already exists as a non-trivially-sized file.
 * Used to skip re-downloads across invocations (per pivot sub-test) and
 * across duplicate records within a single invocation (Firefox's records
 * collection has production + dev variants sharing the same filename).
 */
function _isDownloadedFile(destPath: string): boolean {
  try {
    const stat = fs.statSync(destPath);
    return stat.isFile() && stat.size >= MIN_VALID_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Downloads a single file from a URL to a local path.
 * Follows redirects via bare-fetch.
 * Skips the fetch entirely if the file already exists with non-trivial size.
 */
async function downloadFile(url: string, destPath: string): Promise<number> {
  if (_isDownloadedFile(destPath)) {
    return fs.statSync(destPath).size;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-fetch is loaded lazily so production installs without it stay usable.
  const fetch = require("bare-fetch") as BareFetch;

  const response = await fetch(url, { redirect: "follow", follow: 5 });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
  return buffer.byteLength;
}

/**
 * Downloads Bergamot model files from Mozilla's Firefox Remote Settings CDN.
 * This is the same source Firefox itself uses for translation models.
 */
export async function downloadBergamotFromFirefox(
  srcLang: string,
  dstLang: string,
  destDir: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-fetch is loaded lazily so production installs without it stay usable.
  const fetch = require("bare-fetch") as BareFetch;

  console.log(
    `[bergamot-fetcher] Downloading ${srcLang}-${dstLang} from Firefox Remote Settings CDN...`,
  );

  const res = await fetch(FIREFOX_RECORDS_URL);
  if (!res.ok)
    throw new Error(`Failed to fetch Firefox model records: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: FirefoxRecord[] };
  const records = body.data || [];

  const fromLangMatch = normalizeBcp47Lang(srcLang);
  const toLangMatch = normalizeBcp47Lang(dstLang);

  const pairRecords = records.filter(
    (r) =>
      r.fromLang === fromLangMatch && r.toLang === toLangMatch && r.attachment,
  );

  if (pairRecords.length === 0) {
    throw new Error(
      `No Firefox Translations model found for ${srcLang}-${dstLang}. ` +
        "Check https://github.com/mozilla/firefox-translations-models for supported pairs.",
    );
  }

  fs.mkdirSync(destDir, { recursive: true });

  // Firefox's translations-models collection exposes multiple variants per
  // language pair (production + dev/beta), several of which share the same
  // `filename`. Without dedup we'd download (and overwrite) the same file
  // 2–3× per invocation — a real case observed on Samsung Device Farm: a
  // `runPivotBergamot` test spent 20 min redundantly re-fetching ~30MB
  // .intgemm variants and timed out. Process one filename per invocation,
  // taking the first matching record.
  const seenFilenames = new Set<string>();
  for (const record of pairRecords) {
    const att = record.attachment;
    if (!att || !att.location) continue;

    const filename = record.name || att.filename || path.basename(att.location);
    if (seenFilenames.has(filename)) continue;
    seenFilenames.add(filename);

    const url = `${FIREFOX_ATTACHMENT_BASE}/${att.location}`;
    const dest = path.join(destDir, filename);

    if (_isDownloadedFile(dest)) {
      const existingMB = fs.statSync(dest).size / 1024 / 1024;
      console.log(
        `[bergamot-fetcher]   ✓ ${filename} (${existingMB.toFixed(1)}MB, cached)`,
      );
      continue;
    }

    console.log(`[bergamot-fetcher]   Downloading ${filename}...`);
    const bytes = await downloadFile(url, dest);
    console.log(
      `[bergamot-fetcher]   ✓ ${filename} (${(bytes / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  if (!hasBergamotModelFiles(destDir)) {
    throw new Error(
      "Firefox CDN download incomplete — missing model or vocab files",
    );
  }

  console.log(`[bergamot-fetcher] Firefox CDN download complete → ${destDir}`);
  return destDir;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Ensures Bergamot model files are present in destDir for a given language pair.
 *
 *   1. If model files already exist in destDir → returns immediately
 *   2. Downloads from Firefox Remote Settings CDN
 *
 * @param srcLang  Source language code (e.g. 'en')
 * @param dstLang  Target language code (e.g. 'it')
 * @param destDir  Directory to store model files
 * @returns Resolved path to the model directory
 */
export async function ensureBergamotModelFiles(
  srcLang: string,
  dstLang: string,
  destDir: string,
): Promise<string> {
  if (hasBergamotModelFiles(destDir)) {
    console.log(`[bergamot-fetcher] Model already available at ${destDir}`);
    return destDir;
  }

  return await downloadBergamotFromFirefox(srcLang, dstLang, destDir);
}
