'use strict'

// =========================================================================
// NOTICE Generator — Constants & Configuration
// =========================================================================
//
// Edit this file to control license policy and normalization rules.
// Internal wiring lives in lib/config.js; this file is the human-facing
// configuration surface.
//

// ---------------------------------------------------------------------------
// Allowed licenses (allowlist)
//
// When EMPTY every license passes (open gate).
// Once you add entries, only those canonical SPDX ids are accepted;
// everything else becomes a violation in check-forbidden-licenses.js.
//
// Use lowercase canonical SPDX identifiers. The normalization map below
// ensures that all common variations (e.g. "Apache 2.0", "MIT License",
// "BSD 3-Clause License") resolve to these canonical forms automatically.
// ---------------------------------------------------------------------------
const ALLOWED_LICENSES = [
  'apache-2.0',
  'mit',
  'mit-cmu',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'mpl-2.0',
  'cc-by-4.0',
  'lgpl-2.1',
  'apache-2.0-with-llvm-exception',

  // Model-specific
  'llama3.2',
  'gemma',
  'health-ai-developer-foundations',
  'openrail',
  'openrail++',
]

// ---------------------------------------------------------------------------
// License normalization map
//
// Maps every known variation of a license string (as returned by npm, PyPI,
// GitHub API, HuggingFace, vcpkg, etc.) to a canonical lowercase SPDX id.
//
// Used for:
//   1. Grouping in NOTICE files (all Apache variants under one heading)
//   2. Allowlist comparison (adding 'apache-2.0' covers all variations)
//
// Add new entries here when you encounter a license string that doesn't
// group correctly.
// ---------------------------------------------------------------------------
const LICENSE_NORMALIZE_MAP = {
  // Apache
  'apache-2.0': 'apache-2.0',
  'apache 2.0': 'apache-2.0',
  'apache 2.0 license': 'apache-2.0',
  'apache license 2.0': 'apache-2.0',
  'apache license, version 2.0': 'apache-2.0',
  'apache software license': 'apache-2.0',
  apache: 'apache-2.0',

  // Apache with LLVM exception
  'apache-2.0 with llvm-exception': 'apache-2.0-with-llvm-exception',
  'apache 2.0 with llvm exception': 'apache-2.0-with-llvm-exception',

  // MIT
  mit: 'mit',
  'mit license': 'mit',
  'the mit license': 'mit',
  'mit/x11': 'mit',

  // BSD
  'bsd-2-clause': 'bsd-2-clause',
  'bsd 2-clause': 'bsd-2-clause',
  'bsd 2 clause': 'bsd-2-clause',
  'bsd-2-clause license': 'bsd-2-clause',
  'bsd 2-clause license': 'bsd-2-clause',
  'bsd 2 clause license': 'bsd-2-clause',
  'simplified bsd': 'bsd-2-clause',
  'bsd-3-clause': 'bsd-3-clause',
  'bsd 3-clause': 'bsd-3-clause',
  'bsd 3 clause': 'bsd-3-clause',
  'bsd-3-clause license': 'bsd-3-clause',
  'bsd 3-clause license': 'bsd-3-clause',
  'bsd 3 clause license': 'bsd-3-clause',
  'new bsd': 'bsd-3-clause',
  'bsd license': 'bsd-3-clause',
  bsd: 'bsd-3-clause',

  // ISC
  isc: 'isc',
  'isc license': 'isc',

  // MPL
  'mpl-2.0': 'mpl-2.0',
  'mozilla public license 2.0': 'mpl-2.0',
  'mozilla public license 2.0 (mpl 2.0)': 'mpl-2.0',

  // CC
  'cc-by-4.0': 'cc-by-4.0',
  'cc by 4.0': 'cc-by-4.0',
  'creative commons attribution 4.0': 'cc-by-4.0',
  'creative commons attribution 4.0 international': 'cc-by-4.0',
  'cc0-1.0': 'cc0-1.0',
  'cc0 1.0': 'cc0-1.0',
  'creative commons zero 1.0': 'cc0-1.0',
  'creative commons zero 1.0 universal': 'cc0-1.0',
  'cc-by-nc-4.0': 'cc-by-nc-4.0',
  'cc by nc 4.0': 'cc-by-nc-4.0',
  'creative commons noncommercial 4.0': 'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0': 'cc-by-nc-sa-4.0',
  'cc by nc sa 4.0': 'cc-by-nc-sa-4.0',
  'cc-by-nc-nd-4.0': 'cc-by-nc-nd-4.0',
  'cc by nc nd 4.0': 'cc-by-nc-nd-4.0',
  'cc-by-sa-4.0': 'cc-by-sa-4.0',
  'cc by sa 4.0': 'cc-by-sa-4.0',
  'creative commons attribution sharealike 4.0': 'cc-by-sa-4.0',

  // GPL
  'gpl-2.0': 'gpl-2.0',
  'gpl 2.0': 'gpl-2.0',
  'gpl-2.0-only': 'gpl-2.0',
  'gpl-2.0-or-later': 'gpl-2.0-or-later',
  'gnu general public license v2.0': 'gpl-2.0',
  'gnu gpl v2': 'gpl-2.0',
  'gpl-3.0': 'gpl-3.0',
  'gpl 3.0': 'gpl-3.0',
  'gpl-3.0-only': 'gpl-3.0',
  'gpl-3.0-or-later': 'gpl-3.0-or-later',
  'gnu general public license v3.0': 'gpl-3.0',
  'gnu gpl v3': 'gpl-3.0',

  // AGPL
  'agpl-3.0': 'agpl-3.0',
  'agpl 3.0': 'agpl-3.0',
  'agpl-3.0-only': 'agpl-3.0',
  'agpl-3.0-or-later': 'agpl-3.0-or-later',
  'gnu affero general public license v3.0': 'agpl-3.0',

  // LGPL
  'lgpl-2.1': 'lgpl-2.1',
  'lgpl 2.1': 'lgpl-2.1',
  'lgpl-2.1-only': 'lgpl-2.1',
  'lgpl-2.1-or-later': 'lgpl-2.1-or-later',
  'gnu lesser general public license v2.1': 'lgpl-2.1',
  'lgpl-3.0': 'lgpl-3.0',
  'lgpl 3.0': 'lgpl-3.0',
  'lgpl-3.0-only': 'lgpl-3.0',
  'lgpl-3.0-or-later': 'lgpl-3.0-or-later',
  'gnu lesser general public license v3.0': 'lgpl-3.0',

  // Other common
  unlicense: 'unlicense',
  'the unlicense': 'unlicense',
  '0bsd': '0bsd',
  'zero-clause bsd': '0bsd',
  zlib: 'zlib',
  'zlib license': 'zlib',
  'python-2.0': 'python-2.0',
  'psf-2.0': 'python-2.0',
  'python software foundation license': 'python-2.0',
  'artistic-2.0': 'artistic-2.0',
  'perl artistic license': 'artistic-2.0',
  wtfpl: 'wtfpl',

  // Model-specific
  'llama3.2': 'llama3.2',
  'llama-3.2': 'llama3.2',
  gemma: 'gemma',
  'qwen-research': 'qwen-research',
  qwen: 'qwen-research',
  'health-ai-developer-foundations': 'health-ai-developer-foundations',
  'openrail': 'openrail',
  'openrail++': 'openrail++'
}

// ---------------------------------------------------------------------------
// Copyright
// ---------------------------------------------------------------------------
const COPYRIGHT_HOLDER = 'Tether Data, S.A. de C.V.'
const COPYRIGHT_YEAR = '2026'

module.exports = {
  ALLOWED_LICENSES,
  LICENSE_NORMALIZE_MAP,
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR
}
