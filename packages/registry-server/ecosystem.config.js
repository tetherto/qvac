'use strict'

module.exports = {
  apps: [
    {
      name: 'registry',
      script: 'scripts/bin.js',
      args: 'run --storage ./corestore --metrics-port 9210',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'health-check',
      script: 'node_modules/.bin/hyper-health-check',
      args: 'run --port 9091 --grace-period 600000',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
