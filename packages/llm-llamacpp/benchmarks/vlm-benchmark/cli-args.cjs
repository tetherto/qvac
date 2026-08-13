'use strict'

// One cliArgs element is one CLI argument, and it has to survive a round trip through a
// shell variable: resolve-cli-model.cjs joins the array into cli-model.env and
// cli-fixture-runner.cjs splits it back. That only stays lossless while no element carries
// whitespace, which is what models.cjs enforces at parse time. Both halves live here so
// they cannot drift apart, since a drift is silent: an element with a space would pass the
// flag allowlist as one token and arrive as two.

function serializeCliArgs (args) {
  return (args || []).join(' ')
}

function parseCliArgs (value) {
  return String(value || '').split(/\s+/).filter(Boolean)
}

module.exports = { serializeCliArgs, parseCliArgs }
