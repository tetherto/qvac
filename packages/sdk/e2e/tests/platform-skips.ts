import type { SkipInfo, TestDefinition } from '@qvac/test-suite'

/**
 * Which platforms a definition does not apply to, as data.
 *
 * Two rules matching one definition merge into one `skip`, never a list: a reader that met a list
 * would read `skip.platforms` as undefined and silently stop skipping.
 */
type Rule = {
  /** Test ids this applies to: a prefix pattern or an explicit list. */
  match: RegExp | string[]
  skip: SkipInfo
}

const RULES: Rule[] = [
  {
    match: /^decisions-/,
    skip: {
      reason: 'Laya decision tests require the local QVAC_LAYA_MODEL desktop fixture',
      platforms: ['mobile']
    }
  },
  // ── every leg but Snap ───────────────────────────────────────────────────
  {
    match: /^snap-storage-/,
    skip: {
      reason: 'Snap storage tests require the strict-confined Snap consumer',
      platforms: ['desktop', 'desktop-python', 'electron', 'mobile']
    }
  },

  // ── the packaged Electron app, Snap included ─────────────────────────────
  {
    match: /^(diffusion-|addon-logging-diffusion$)/,
    skip: {
      reason:
        'The packaged Electron pass, Snap included, skips diffusion: image generation takes too long for it',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^world-/,
    skip: {
      reason:
        'ABot-World needs a dedicated GPU and a 13.3 GB model set, beyond the packaged Electron pass and Snap',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^audio-(gen|edit|understand)-/,
    skip: {
      reason:
        'AudioGen e2e is desktop-only: the ACE-Step stack is four GGUFs, too heavy for the packaged pass',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^finetune-/,
    skip: {
      reason:
        'The packaged Electron pass, Snap included, skips finetune: training takes too long for it',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^no-lingering-bare-/,
    skip: {
      reason:
        'Spawns standalone Bare workers outside the packaged app lifecycle, on Electron and Snap alike',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^worker-restart-/,
    skip: {
      reason:
        'Asserts on Bare worker processes outside the packaged app lifecycle, on Electron and Snap alike',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^vla-/,
    skip: {
      reason:
        'The packaged Electron pass, Snap included, skips VLA: model execution takes too long for it',
      platforms: ['electron', 'snap']
    }
  },

  // ── mobile, both OSes ────────────────────────────────────────────────────
  {
    match: /^http-(?:sharded|archive)-embed-/,
    skip: { reason: 'HTTP test disabled on mobile (OOM)', platforms: ['mobile'] }
  },
  {
    match: /^finetune-/,
    skip: { reason: 'Finetune tests disabled on mobile', platforms: ['mobile'] }
  },
  {
    match: /^world-/,
    skip: {
      reason:
        'ABot-World disabled on mobile: a walk session needs a dedicated GPU with GBs of free VRAM, and world operations have no delegated route',
      platforms: ['mobile']
    }
  },
  {
    match: /^multi-gpu-/,
    skip: {
      reason: 'Multi-GPU tests disabled on mobile (not supported on single-GPU devices)',
      platforms: ['mobile']
    }
  },
  {
    match: /^deferred-tools-(?!prompt-cost$|load-then-call$)/,
    skip: {
      reason:
        'Deferred tools: only the smoke cases run on mobile (no tools-qwen35 resource, model reloads too slow)',
      platforms: ['mobile']
    }
  },
  {
    match: /^tools-(?!simple-function$|no-function-match$)/,
    skip: { reason: 'Tools test disabled on mobile', platforms: ['mobile'] }
  },
  {
    match: /^(diffusion-|addon-logging-diffusion$)/,
    skip: {
      reason: 'SD v2.1 1B Q8_0 cold-load is too heavy for Device Farm devices (OOM, 3+GB)',
      platforms: ['mobile']
    }
  },
  {
    match: /^audio-(gen|edit|understand)-/,
    skip: {
      reason: 'ACE-Step AudioGen loads four large GGUFs and is covered by desktop e2e',
      platforms: ['mobile']
    }
  },
  {
    match: /^vla-pi05-/,
    skip: {
      reason:
        'π₀.₅ q_aggressive GGUF (3.9 GB) exceeds the iOS jetsam ~3 GB per-process limit (OOM) and is deferred on Android Device Farm until a CDN-fronted mirror exists; SmolVLA covers mobile VLA, desktop covers pi05',
      platforms: ['mobile']
    }
  },
  {
    match: /^translation-bergamot-.+-cache-reload$/,
    skip: {
      reason:
        'Server-side Bare code path, identical across platforms — desktop coverage is source of truth',
      platforms: ['mobile']
    }
  },
  {
    match: /^bci-/,
    skip: {
      reason: 'BCI addon tests are desktop-only until mobile support is enabled',
      platforms: ['mobile']
    }
  },
  {
    match: /^parakeet-indic-conformer-/,
    skip: {
      reason:
        'Indic Conformer e2e is desktop-only; the parakeet-indic-conformer resource is not defined on mobile',
      platforms: ['mobile']
    }
  },
  {
    match: /^vla-groot-/,
    skip: {
      reason: 'GR00T e2e is desktop-only; the vla-groot resource is not defined on mobile',
      platforms: ['mobile']
    }
  },
  {
    match: /^(ocr-doctr-|model-load-ocr-doctr$)/,
    skip: {
      reason:
        'DocTR OCR e2e is desktop-only; the pipeline/detector auto-derivation under test (QVAC-22514) is server-side Bare code identical across platforms, and the doctr resource is not defined on mobile',
      platforms: ['mobile']
    }
  },
  {
    match: [
      'tts-cosyvoice3-emotion-conditioning',
      'tts-cosyvoice3-streaming',
      'tts-cosyvoice3-native-streaming',
      'tts-cosyvoice3-sentence-streaming',
      'tts-cosyvoice3-duplex-streaming'
    ],
    skip: {
      reason:
        'Redundant CosyVoice3 e2e coverage overlapping other TTS tests, and slow on Device Farm; only tts-cosyvoice3-default and tts-cosyvoice3-invalid-emotion are kept on mobile',
      platforms: ['mobile']
    }
  },

  // ── model fit ────────────────────────────────────────────────────────────
  // The assessment describes a load without running one, so it runs everywhere. The probe
  // reads the projection back off a resident model, so it only runs where that model loads.
  {
    match: /^model-fit-(?:probe-)?(?:audiogen|diffusion)$/,
    skip: {
      reason:
        'Neither set runs in the packaged Electron pass or Snap -- both are far beyond it -- so neither the load-time probe nor the fit assessment is checked there',
      platforms: ['electron', 'snap']
    }
  },
  {
    match: /^model-fit-probe-(?:audiogen|diffusion)$/,
    skip: {
      reason:
        'Reading the projection needs a resident model, and both sets are too heavy to load on Device Farm devices; the assessment needs no load and still runs',
      platforms: ['mobile']
    }
  },
  {
    match: ['model-fit-probe-bci'],
    skip: {
      reason:
        'BCI is desktop-only until mobile support is enabled; the assessment needs no load and still runs',
      platforms: ['mobile']
    }
  },

  // ── Apple only: the leg has to be able to run Core ML ────────────────────
  {
    match: ['parakeet-unified-coreml-ios'],
    skip: {
      reason:
        'The Core ML sidecar cache check is an iOS device check: it asserts the bundle landed in the app cache',
      platforms: ['desktop', 'desktop-python', 'electron', 'snap', 'mobile-android']
    }
  },
  {
    match: ['tts-audio8-coreml'],
    skip: {
      reason: 'Core ML runs on macOS and iOS only',
      platforms: [
        'desktop-linux',
        'desktop-windows',
        'desktop-python',
        'electron-linux',
        'electron-windows',
        'snap',
        'mobile-android'
      ]
    }
  },

  // ── the Python client ────────────────────────────────────────────────────
  // Skipped because the claim belongs to the JS client rather than to the SDK: the same
  // test id on Python would be asserting something else. This is not the place to record
  // a body that is merely still to be written -- that one reports `incomplete`, which is
  // the number the release matrix exists to shrink.
  {
    match: /^(no-lingering-bare-|worker-restart-)/,
    skip: {
      reason:
        "Asserts on the Bare worker processes the JS client spawns, by reading this process's own child table. The Python client spawns its own worker with its own lifecycle, so a body here would be testing a different thing under the same name; the JS leg is where this claim lives",
      platforms: ['desktop-python']
    }
  },
  {
    match: ['error-invalid-response-type', 'error-structured-error-code'],
    skip: {
      reason:
        "Reads the JS package's exported error-code tables, which are a property of one client's module surface rather than of the shared contract. The equivalent claim for Python is covered by its own unit tests",
      platforms: ['desktop-python']
    }
  },
  {
    match: /^rpc-server-device-map/,
    skip: {
      reason:
        "Exercises getRpcDeviceMap, a pure JS helper in the SDK's module surface with no RPC behind it. The Python SDK exposes the RPC server methods, not this helper",
      platforms: ['desktop-python']
    }
  },

  // ── one mobile OS only ───────────────────────────────────────────────────
  {
    match: ['parakeet-stream-eou', 'parakeet-stream-iterator-throw'],
    skip: {
      reason: 'Parakeet streaming EOU/iterator recovery is flaky on Android',
      platforms: ['mobile-android']
    }
  },
  {
    match: [
      'ocr-sign-image',
      'ocr-chart-image',
      'ocr-no-text-image',
      'ocr-large-image',
      'ocr-low-quality',
      'ocr-mixed-language',
      'ocr-single-language',
      'ocr-blurry-text',
      'ocr-horizontally-inverted',
      'ocr-vertically-inverted',
      'ocr-misaligned-text',
      'ocr-multi-sized-text',
      'ocr-multiple-fonts',
      'addon-logging-ocr'
    ],
    skip: { reason: 'OCR disabled on iOS (ONNX/CoreML OOM)', platforms: ['mobile-ios'] }
  }
]

/** Attach the platform policy to the catalog. */
export function applyPlatformSkips(tests: TestDefinition[]): void {
  for (const test of tests) {
    const matched = RULES.filter((rule) =>
      Array.isArray(rule.match) ? rule.match.includes(test.testId) : rule.match.test(test.testId)
    )
    if (matched.length === 0) continue

    const existing = test.skip
    const platforms = new Set<string>(existing?.platforms ?? [])
    const reasons: string[] = []
    // Prefixed with its own platforms, like the rules below: a merged reason that names the
    // platforms for every clause but one reads as if that clause applied everywhere.
    if (existing?.reason && existing.platforms?.length) {
      reasons.push(`${existing.platforms.join(', ')}: ${existing.reason}`)
    }

    for (const rule of matched) {
      for (const platform of rule.skip.platforms ?? []) platforms.add(platform)
      const group = (rule.skip.platforms ?? []).join(', ')
      reasons.push(group ? `${group}: ${rule.skip.reason}` : rule.skip.reason)
    }

    // An unconditional skip already in place stays unconditional -- the producer drops it before
    // any leg, and narrowing it to a platform list would quietly start running it everywhere else.
    if (existing && !existing.platforms?.length) continue

    test.skip = {
      ...(existing ?? {}),
      reason: reasons.join(' | '),
      platforms: [...platforms]
    }
  }
}
