'use strict'

const { spawn } = require('child_process')

async function spawnProcess (command, args = [], options) {
  return new Promise((resolve, reject) => {
    const spawnPs = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options
    })

    const closeFunc = (code) => {
      if (code === 0) {
        resolve(spawnPs)
      } else {
        reject(new Error(`Error: ${command} exited with code: ${code}`))
      }
    }

    // for bare node
    spawnPs.on('exit', closeFunc)
    // for nodejs
    spawnPs.on('close', closeFunc)

    spawnPs.on('error', (err) => {
      reject(err)
    })
  })
}

module.exports = { spawnProcess }
