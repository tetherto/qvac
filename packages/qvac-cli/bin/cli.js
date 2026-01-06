#!/usr/bin/env bare
'use strict'

const { QvacCliApp } = require('../src/cli')
const process = require('bare-process')

const cli = new QvacCliApp()
cli.run(process.argv)
