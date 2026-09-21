'use strict'

const test = require('brittle')
const inferBase = require('../..')
const QvacResponse = require('../../src/QvacResponse')
const createJobHandler = require('../../src/utils/createJobHandler')
const exclusiveRunQueue = require('../../src/utils/exclusiveRunQueue')
const getApiDefinition = require('../../src/utils/getApiDefinition')

test('package root preserves CommonJS exports', (t) => {
  t.alike(
    Object.keys(inferBase),
    ['QvacResponse', 'exclusiveRunQueue', 'getApiDefinition', 'createJobHandler'],
    'root exports retain their names and order'
  )
  t.is(inferBase.QvacResponse, QvacResponse, 'QvacResponse identity is preserved')
  t.is(inferBase.createJobHandler, createJobHandler, 'createJobHandler identity is preserved')
  t.is(inferBase.exclusiveRunQueue, exclusiveRunQueue, 'exclusiveRunQueue identity is preserved')
  t.is(inferBase.getApiDefinition, getApiDefinition, 'getApiDefinition identity is preserved')
})
