'use strict'

// Standalone on purpose: helpers.js and parakeet-helpers.js both load the
// native addon at module scope, so anything that requires them is unusable
// from `test:unit` (no prebuild on the sanity-check runner). This file needs
// nothing but bare-fs/bare-os, so the unit suite and the Parakeet mobile
// package can both take it.
//
// iOS kills an app that dirties more than 4 GiB in 24h, and there the staged
// file already sits in the app's own writable Documents dir — so copying it
// into the model dir spends that whole budget for nothing. Hardlink instead:
// same inode, zero bytes. On Android the staging dir is a different filesystem,
// so link() fails EXDEV and we fall back to the copy that has always run there.
// `link`/`copy` are injectable so that fallback is unit-testable.
const fs = require('bare-fs')
const os = require('bare-os')

function linkOrCopySync({ src, dest, link = fs.linkSync, copy = fs.copyFileSync }) {
  try {
    fs.unlinkSync(dest)
  } catch (_) {}

  try {
    link(src, dest)
    return 'link'
  } catch (err) {
    console.log(
      `[prestage] hardlink failed on ${os.platform()} (${err.message}); ` +
        'falling back to a byte copy'
    )
  }

  copy(src, dest)
  return 'copy'
}

module.exports = { linkOrCopySync }
