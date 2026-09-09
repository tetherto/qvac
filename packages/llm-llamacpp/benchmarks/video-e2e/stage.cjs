'use strict'
const fs = require('fs')
const path = require('path')
const { models } = require('./video-config.cjs')
const root = path.resolve(__dirname, '../..')
const integration = path.join(root, 'test/integration')
for (const file of ['video-config.cjs', 'video-core.cjs', 'video-addon.cjs', 'video-e2e.test.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(integration, file))
}
const packageFile = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(packageFile))
pkg.dependencies['bare-ffmpeg'] = '1.5.0'
pkg.dependencies['bare-https'] = '3.1.0'
fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n')
const groupsFile = path.join(root, 'test/mobile/test-groups.json')
const groups = JSON.parse(fs.readFileSync(groupsFile))
for (const platform of Object.keys(groups)) groups[platform].videoE2e = ['runVideoE2eTest']
fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 2) + '\n')
const manifestFile = path.join(root, 'test/mobile/model-manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestFile))
const pinned = JSON.parse(fs.readFileSync(path.join(integration, 'models.manifest.json'))).models
manifest.runVideoE2eTest = models
  .flatMap((model) => [model.modelName, model.projectorName])
  .map((name) => {
    if (!pinned[name]) throw new Error('no pinned model: ' + name)
    return { name, url: pinned[name].urls[0] }
  })
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
console.log('Video benchmark staged; one filtered test, two small models, pinned FFmpeg.')
