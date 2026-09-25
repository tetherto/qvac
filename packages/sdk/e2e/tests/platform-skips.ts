import type { SkipInfo, TestDefinition } from '@qvac/test-suite'

/**
 * Which platforms a definition does not apply to, as data.
 *
 * This policy used to live as `SkipExecutor` registrations inside each
 * consumer entry: 25 regexes and id lists spread over three TypeScript files,
 * two of them branching on `Platform.OS` at runtime. A client in another
 * language could not see any of it, so the same catalog meant different things
 * on different legs and nothing said so.
 *
 * The rules are the same rules, in the same order, attached to the definitions
 * they name. The reasons travel with them, because the reasons are the only
 * record of why the matrix looks the way it does.
 *
 * A definition is often skipped on two legs for two different reasons --
 * diffusion is too slow for the Electron pass and does not fit on a phone --
 * so the rules are merged into one `skip` whose reason names each group.
 *
 * Merged rather than carried as a list, deliberately. `skip` is a single
 * object in the shared shape, and a reader that met a list would not fail: it
 * would read `skip.platforms` as undefined and silently stop skipping. That is
 * exactly how 91 iOS tests ran that should not have -- a consumer bundle
 * holding an older framework turned the whole platform policy off without a
 * word. A shape every reader already understands cannot degrade that way.
 */
type Rule = {
  /** Test ids this applies to: a prefix pattern or an explicit list. */
  match: RegExp | string[]
  skip: SkipInfo
}

const RULES: Rule[] = [
  // ── every leg but Snap ───────────────────────────────────────────────────
  {
    match: /^snap-storage-/,
    skip: {
      reason: 'Snap storage tests require the strict-confined Snap consumer',
      platforms: ['desktop', 'electron', 'mobile']
    }
  },

  // ── Electron ─────────────────────────────────────────────────────────────
  {
    match: /^(diffusion-|addon-logging-diffusion$)/,
    skip: {
      reason:
        'Electron skips diffusion tests because image generation takes too long for the stable Electron pass',
      platforms: ['electron']
    }
  },
  {
    match: /^world-/,
    skip: {
      reason:
        'Electron skips ABot-World: a walk session needs a dedicated GPU and the 13.3 GB model set is far beyond the stable Electron pass',
      platforms: ['electron']
    }
  },
  {
    match: /^audio-(gen|edit|understand)-/,
    skip: {
      reason:
        'AudioGen e2e is desktop-only: the ACE-Step stack is four GGUFs, too heavy for the stable Electron pass',
      platforms: ['electron']
    }
  },
  {
    match: /^finetune-/,
    skip: {
      reason:
        'Electron skips finetune tests because training operations take too long for the stable Electron pass',
      platforms: ['electron']
    }
  },
  {
    match: /^no-lingering-bare-/,
    skip: {
      reason:
        'Electron skips no-lingering-bare tests because they spawn and terminate standalone Bare workers outside the packaged app lifecycle',
      platforms: ['electron']
    }
  },
  {
    match: /^worker-restart-/,
    skip: {
      reason:
        'Electron skips the kv-cache worker-restart test because it asserts on Bare worker processes outside the packaged app lifecycle',
      platforms: ['electron']
    }
  },
  {
    match: /^vla-/,
    skip: {
      reason:
        'Electron skips VLA tests because VLA model execution takes too long for the stable Electron pass',
      platforms: ['electron']
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

/**
 * Attach the platform policy to the catalog.
 *
 * Appends rather than replaces: a definition that already declares its own
 * skip -- the Python client's unmigrated bodies, the multi-GPU runner
 * requirement -- keeps it and gains the platform rules alongside. Several
 * matching rules merge into one: the platforms union, and a reason that names
 * the group each half came from, so the record of why the matrix looks the way
 * it does survives the merge.
 */
export function applyPlatformSkips(tests: TestDefinition[]): void {
  for (const test of tests) {
    const matched = RULES.filter((rule) =>
      Array.isArray(rule.match) ? rule.match.includes(test.testId) : rule.match.test(test.testId)
    )
    if (matched.length === 0) continue

    const existing = test.skip
    const platforms = new Set<string>(existing?.platforms ?? [])
    const reasons: string[] = []
    if (existing?.reason && existing.platforms?.length) reasons.push(existing.reason)

    for (const rule of matched) {
      for (const platform of rule.skip.platforms ?? []) platforms.add(platform)
      const group = (rule.skip.platforms ?? []).join(', ')
      reasons.push(group ? `${group}: ${rule.skip.reason}` : rule.skip.reason)
    }

    // An unconditional skip already in place stays unconditional -- the
    // producer drops it before any leg, and narrowing it to a platform list
    // would quietly start running it everywhere else.
    if (existing && !existing.platforms?.length) continue

    test.skip = {
      ...(existing ?? {}),
      reason: reasons.join(' | '),
      platforms: [...platforms]
    }
  }
}
