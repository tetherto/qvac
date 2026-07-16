import test from 'brittle'
import type { Request, Response } from '../src/schemas'
import type { HandlerEntry } from '../src/handlers/types'
import { selectHandler } from '../src/selection'

function localHandler() {
  return { type: 'heartbeat' } as Response
}

function delegatedHandler() {
  return { type: 'heartbeat' } as Response
}

function delegatedRequest() {
  return { type: 'heartbeat', delegate: true } as unknown as Request
}

function localRequest() {
  return { type: 'heartbeat' } as Request
}

function createEntry(): HandlerEntry {
  return {
    type: 'reply',
    handler: localHandler as HandlerEntry['handler'],
    delegatedHandler: delegatedHandler as HandlerEntry['handler'],
    isDelegated: function (request) {
      return request.type === 'heartbeat' && 'delegate' in request
    }
  }
}

test('selectHandler chooses delegated handler when predicate matches', function (t) {
  const selection = selectHandler(createEntry(), delegatedRequest())

  t.is(selection.handler, delegatedHandler)
  t.is(selection.isDelegated, true)
})

test('selectHandler keeps local handler when predicate does not match', function (t) {
  const selection = selectHandler(createEntry(), localRequest())

  t.is(selection.handler, localHandler)
  t.is(selection.isDelegated, false)
})

test('selectHandler keeps local handler when entry has no delegated handler', function (t) {
  const entry: HandlerEntry = {
    type: 'reply',
    handler: localHandler as HandlerEntry['handler']
  }

  const selection = selectHandler(entry, delegatedRequest())

  t.is(selection.handler, localHandler)
  t.is(selection.isDelegated, false)
})
