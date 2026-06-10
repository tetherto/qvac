'use strict'
// QVAC-19178: offline metric-tuning harness. Re-scores REAL model predictions (captured
// from a CI run's [VLMROW] markers) with the current aggregate.js scorers, so the
// quality metric can be fine-tuned without re-running inference. Run: node score-check.cjs
const { score } = require('./aggregate.js')

// Real qwen3.5 predictions from run 27154438683 (base preset, 3 samples/task, addon/cpu).
const DATA = {
  textvqa: {
    metric: 'vqa',
    items: [
      { gold: ['philippe molitor', 'philippe molitor', 'philippe molitor', 'philippe molitor', 'clardajne', 'phillipe molida', 'l', 'no', 'phillipe meltow', 'philippe molitar'], pred: 'Philippe Molitor' },
      { gold: ['2010', '2010', '2010', '2010', '2010', '2010', '2010', '2010', 'unanswerable', '2010'], pred: '2010' },
      { gold: ['50', ' 50', '50', '50', '50', '50', '50', '50', '50', '50'], pred: '50' }
    ]
  },
  vizwiz: {
    metric: 'vqa',
    items: [
      { gold: ['no text identifying identification on side card', 'yes', 'unanswerable', 'no', 'no', 'unanswerable', 'unanswerable', 'no', 'no', 'no'], pred: 'yes' },
      { gold: ['every now then', 'every now then', 'every no then', 'every now then', 'every now then', 'every now then', 'every now then', 'every now then', 'every now then', 'every now then'], pred: 'The title is "Every Now and Then"' },
      { gold: ['already booted', 'already booted', 'booted', 'already booted', 'already booted', 'no', 'already booted', 'yes booted', 'booted', 'already booted'], pred: 'Yes' }
    ]
  },
  gqa: {
    metric: 'vqa',
    items: [
      { gold: ['girl'], pred: 'Dhammika Heenpella' },
      { gold: ['picture'], pred: 'chocolate' },
      { gold: ['yes'], pred: 'No' }
    ]
  },
  docvqa: {
    metric: 'anls',
    items: [
      { gold: ['To'], pred: 'from' },
      { gold: ['Address', 'ADDRESS'], pred: 'NAME' },
      { gold: ['10 pounds'], pred: '10' }
    ]
  },
  ai2d: {
    metric: 'mc',
    items: [
      { gold: ['D'], pred: 'C' },
      { gold: ['A'], pred: 'C' },
      { gold: ['A'], pred: 'D' }
    ]
  }
}

const pct = x => (100 * x).toFixed(1).padStart(6)
let sum = 0; let n = 0
console.log('task     metric  per-item scores            mean %')
console.log('-------------------------------------------------------')
for (const [task, { metric, items }] of Object.entries(DATA)) {
  const s = items.map(it => score(metric, it.pred, it.gold))
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  sum += mean; n++
  console.log(`${task.padEnd(8)} ${metric.padEnd(6)} [${s.map(x => x.toFixed(2)).join(', ')}]   ${pct(mean)}`)
}
console.log('-------------------------------------------------------')
console.log(`Overall % (equal-weight mean across tasks):       ${pct(sum / n)}`)
