'use strict'

// 32 support-ticket states of varied length, the same for both paths.
const subjects = [
  'My payment failed twice and I was charged both times.',
  'The app crashes every time I open the settings page.',
  'I would like to change the delivery address on my order.',
  'Your service was down for three hours this morning.',
  'I cannot log in after resetting my password.',
  'The invoice for October lists a plan I never subscribed to.',
  'Can you add dark mode to the mobile app?',
  'My package arrived damaged and the box was open.'
]
const details = [
  '',
  ' I already contacted support last week and nobody answered.',
  ' This is the third time this month and it is affecting my business, so I need someone to look at it today.',
  ' I have attached screenshots, the order number is 48213, and I am using the latest version on an Android phone. Please tell me what information you need from me to sort this out, because I have tried clearing the cache, reinstalling, and restarting the device without any change.'
]

const states = []
for (let i = 0; i < 32; i++) {
  states.push(subjects[i % subjects.length] + details[Math.floor(i / subjects.length) % details.length])
}

const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: {
      billing: 'payments, refunds, invoices',
      technical: 'bugs, outages, errors',
      logistics: 'shipping, delivery, returns'
    }
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
}

function stats (ms) {
  const s = [...ms].sort((a, b) => a - b)
  return {
    runs: s.length,
    median_ms: Math.round(s[Math.floor(s.length / 2)]),
    min_ms: Math.round(s[0]),
    max_ms: Math.round(s[s.length - 1])
  }
}

module.exports = { states, questions, stats }
