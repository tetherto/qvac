// Compile-only checks of the published request and info types (tsc --strict,
// npm run test:types:consumer): shapes upstream accepts must type-check.
import type { DecisionEngineInfo, DecisionEngineQuestion, DecisionEngineRequest } from '../..'

// openbmb-minicpm-ocr-jev: one fixed question, no instructions.
export const ocrNoul: DecisionEngineQuestion = { type: 'noul' }
export const ocrNoulNull: DecisionEngineQuestion = { type: 'noul', instructions: null }
export const ocrChoice: DecisionEngineQuestion = {
  type: 'choice',
  criteria: { 0: null, 1: null }
}
export const ocrRequest: DecisionEngineRequest = {
  state: 'the recognized text',
  files: ['data:image/png;base64,', 'data:image/png;base64,'],
  questions: { consistent: ocrNoul }
}

// Models that take instructions.
export const route: DecisionEngineQuestion = {
  type: 'choice',
  instructions: 'Which team?',
  criteria: { support: 'Account questions', billing: null }
}
// h2o-lightning: a score from one level.
export const oneLevel: DecisionEngineQuestion = {
  type: 'score',
  instructions: { ask: 'How sure?' },
  criteria: ['sure']
}

// A model without score questions reports no levels.
export function scoreLimits(info: DecisionEngineInfo): string {
  if (info.score_levels === null || info.score === null) return 'no score questions'
  return `${info.score_levels.min}-${info.score_levels.max} levels, ${info.score}`
}
