'use strict'

const fs = require('fs')
const path = require('path')

const { downloadAndSaveGithubFile } = require('../utils/github')
const { parseFileDependencies } = require('../utils/fileParsers')
const { spawnProcess } = require('../utils/spawn')
const { TerminalLoader } = require('../utils/terminalLoader')

const aliasPackageMap = require('../../mappers/alias.package.json')

class QvacPackageManager {
  bootstrapDir = '.'

  constructor (config) {
    this.config = config
  }

  list () {
    return Object.keys(aliasPackageMap)
  }

  async bootstrap (packageName) {
    // Step 0: Get package info from json mapper
    const packageAlias = packageName.toLowerCase().trim()
    const packageInfo = aliasPackageMap[packageAlias]

    if (!packageInfo) {
      throw new Error(`Package ${packageName} not supported`)
    }

    // Step 1: Download package files from github, store in current directory
    console.info(`- Downloading package ${packageName} files`)
    const packageDir = process.cwd()

    for (const file of packageInfo.bootstrap.files) {
      await downloadAndSaveGithubFile(
        packageInfo.git, file, packageDir, this.config.ghToken
      )
    }

    // Load Root package.json to map quickstart dependencies correctly
    const rootPackageJsonBuffer = await downloadAndSaveGithubFile(
      packageInfo.git, 'package.json', packageDir, this.config.ghToken, true
    )
    let rootPackageJson = null

    try {
      rootPackageJson = JSON.parse(rootPackageJsonBuffer.toString())
    } catch (error) {
      throw new Error(`Error parsing ${packageName} root package.json: ${error.message}`)
    }

    if (!rootPackageJson) {
      throw new Error(`${packageName} root package.json is empty`)
    }

    // Step 2: Parse main file for requires/imports
    console.info('- Parsing main file for dependencies')

    const mainFile = packageInfo.bootstrap.main
    const mainFilePath = path.join(packageDir, mainFile)
    const dependencies = parseFileDependencies(mainFilePath, ['./example.config.json'])

    // Map dependencies version to root package.json versions
    const mappedDependencies = this._mapRootDependenciesVersions(rootPackageJson, dependencies)

    // Create run command
    const runArgs = packageInfo.bootstrap.args || ['.']
    const runCommand = `bare ./${mainFile} ${runArgs.join(' ')}`

    // Step 3: Create project package.json
    this._writePackageJson(
      packageName,
      runCommand,
      packageDir
    )

    // Remove after we go public
    this._checkNpmrc()

    // Step 4: Npm install in directory
    console.info('- Installing dependencies')

    TerminalLoader.instance.stop()
    await spawnProcess('npm', ['install', ...mappedDependencies, '--save-exact'])
    TerminalLoader.instance.start()
  }

  _mapRootDependenciesVersions (rootPackageJson, dependencies) {
    return dependencies.map(dep => {
      if (rootPackageJson.dependencies && rootPackageJson.dependencies[dep]) {
        return `${dep}@${rootPackageJson.dependencies[dep]}`
      }

      if (rootPackageJson.devDependencies && rootPackageJson.devDependencies[dep]) {
        return `${dep}@${rootPackageJson.devDependencies[dep]}`
      }

      return dep
    })
  }

  _writePackageJson (packageName, runScript, directory) {
    const packageJson = {
      name: `${packageName}-bootstrap`,
      version: '1.0.0',
      description: 'Quickstart package for Qvac project',
      main: 'index.js',
      scripts: {
        start: runScript
      },
      author: '',
      license: 'ISC'
    }
    const filePath = path.join(directory, 'package.json')
    fs.writeFileSync(filePath, JSON.stringify(packageJson, null, 2))
  }

  _checkNpmrc () {
    const npmrcPath = path.join(process.cwd(), '.npmrc')
    if (!fs.existsSync(npmrcPath)) {
      throw new Error(
        'No .npmrc file found in current directory.' +
        'Please create one with your npm configuration.'
      )
    }
  }
}

module.exports = { QvacPackageManager }
