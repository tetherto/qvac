"use strict";
// Model manifest for the ACE-Step music engine — the single source of truth for
// which GGUFs the addon needs and where they live in the QVAC model registry.
//
// The engine loads FOUR stages. Three are fixed (text encoder, LM, VAE); only
// the DiT changes, and it has a few interchangeable variants (quality/size vs
// speed). So callers pick a `ditVariant` and the other three are constant.
//
// This module is path/registry metadata only — it does NOT download anything.
// The addon's native lib always receives a local filesystem path; fetching the
// bytes (via @qvac/registry-client over hyperdrive, or any other means) is the
// job of the layer above (SDK `resolveModelPath`, a download script, etc.).
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DIT_VARIANT = exports.DIT_VARIANTS = exports.FIXED_MODELS = exports.REGISTRY_PREFIX = exports.REGISTRY_SOURCE = void 0;
exports.ditVariants = ditVariants;
exports.registryPath = registryPath;
exports.ditFilename = ditFilename;
exports.modelFilenames = modelFilenames;
exports.modelManifest = modelManifest;
exports.modelSources = modelSources;
exports.resolveDitModelPath = resolveDitModelPath;
exports.allRegistryPaths = allRegistryPaths;
/** Source name for the model registry (the `source` arg of downloadModel/getModel). */
exports.REGISTRY_SOURCE = 's3';
// Registry build folder holding the published ACE-Step GGUFs. Bump this (single
// edit point) when a newer model build is published to the registry.
exports.REGISTRY_PREFIX = 'qvac_models_compiled/ggml/acestep/2026-07-22';
// The three stages that never change.
exports.FIXED_MODELS = {
    textEnc: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    lm: 'acestep-5Hz-lm-0.6B-Q8_0.gguf',
    vae: 'vae-BF16.gguf'
};
// The one stage that varies: DiT variant -> GGUF filename.
//   turbo-q4  fastest / smallest (4-bit turbo, ~8-step schedule)
//   turbo-q8  turbo, higher precision (8-bit)
//   sft       supervised-fine-tuned, non-turbo (~50-step schedule)
exports.DIT_VARIANTS = {
    'turbo-q4': 'acestep-v15-turbo-Q4_K_M.gguf',
    'turbo-q8': 'acestep-v15-turbo-Q8_0.gguf',
    sft: 'acestep-v15-sft-Q8_0.gguf'
};
exports.DEFAULT_DIT_VARIANT = 'turbo-q4';
function ditVariants() {
    return Object.keys(exports.DIT_VARIANTS);
}
function registryPath(filename) {
    return `${exports.REGISTRY_PREFIX}/${filename}`;
}
// filename of the DiT GGUF for a variant (throws on an unknown variant).
function ditFilename(variant = exports.DEFAULT_DIT_VARIANT) {
    const name = exports.DIT_VARIANTS[variant];
    if (!name) {
        throw new Error(`unknown ditVariant "${variant}"; expected one of: ${ditVariants().join(', ')}`);
    }
    return name;
}
// The four stage filenames for a given DiT variant (bare names, no prefix).
function modelFilenames(variant = exports.DEFAULT_DIT_VARIANT) {
    return {
        textEnc: exports.FIXED_MODELS.textEnc,
        lm: exports.FIXED_MODELS.lm,
        dit: ditFilename(variant),
        vae: exports.FIXED_MODELS.vae
    };
}
// The four registry paths (prefix + filename) for a given DiT variant.
function modelManifest(variant = exports.DEFAULT_DIT_VARIANT) {
    const f = modelFilenames(variant);
    return {
        textEnc: registryPath(f.textEnc),
        lm: registryPath(f.lm),
        dit: registryPath(f.dit),
        vae: registryPath(f.vae)
    };
}
// Registry "*Src" object shaped for the SDK plugin's resolveConfig, which turns
// each Src into a local path via resolveModelPath before handing it to the lib.
function modelSources(variant = exports.DEFAULT_DIT_VARIANT) {
    const m = modelManifest(variant);
    return {
        textEncModelSrc: m.textEnc,
        lmModelSrc: m.lm,
        ditModelSrc: m.dit,
        vaeModelSrc: m.vae
    };
}
// Resolve the DiT GGUF path for the addon constructor. An explicit `ditModel`
// path always wins; otherwise a `ditVariant` enum selects which DiT GGUF to load
// from `modelDir` (the other three stages are fixed, so the variant is the only
// real choice). Returns undefined when neither is given (caller may still pass a
// `modelDir` and let the engine auto-classify). Throws if a variant is given
// without a `modelDir` to resolve it against.
function resolveDitModelPath({ modelDir, ditModel, ditVariant } = {}) {
    if (ditModel)
        return ditModel;
    if (!ditVariant)
        return undefined;
    if (!modelDir) {
        throw new Error('AudioGen: `ditVariant` needs `modelDir` (the folder holding the DiT ' +
            'GGUF); otherwise pass an explicit `ditModel` path.');
    }
    // Join with the separator the caller's path already uses so we never emit a
    // mixed path like `C:\models/file.gguf` on Windows. Strip trailing separators
    // first (without a backtracking-prone regex).
    const sep = modelDir.includes('\\') ? '\\' : '/';
    let dir = modelDir;
    while (dir.length > 1) {
        const last = dir[dir.length - 1];
        if (last !== '/' && last !== '\\')
            break;
        dir = dir.slice(0, -1);
    }
    return `${dir}${sep}${ditFilename(ditVariant)}`;
}
// Every distinct registry path across all variants (3 fixed + every DiT), for
// existence checks / prefetch of the whole model set.
function allRegistryPaths() {
    const names = [
        exports.FIXED_MODELS.textEnc,
        exports.FIXED_MODELS.lm,
        exports.FIXED_MODELS.vae,
        ...ditVariants().map((v) => exports.DIT_VARIANTS[v])
    ];
    return names.map(registryPath);
}
