'use strict'

const https = require('https')
const fs = require('fs')
const path = require('path')

/**
 * Downloads a file from a GitHub repo.
 *
 * - If rawFile is false/undefined: saves file to outputPath and resolves with file path.
 * - If rawFile is true: returns Buffer with file content (does not save to disk).
 *
 * @param {string} repo       Format: owner/repo
 * @param {string} filePath   Path in repo
 * @param {string} outputPath Local output dir
 * @param {string} token      GitHub token
 * @param {boolean} rawFile   If true, resolve with Buffer instead of saving to disk
 * @returns {Promise<string|Buffer>}
 */
async function downloadAndSaveGithubFile (
  repo,
  filePath,
  outputPath,
  token,
  rawFile = false
) {
  return new Promise((resolve, reject) => {
    const [owner, repoName] = repo.split('/')
    // Change to https://raw.githubusercontent.com/ when we go public
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`

    const options = {
      method: 'GET',
      headers: {
        'User-Agent': 'Node.js',
        ...(token && { Authorization: `Bearer ${token}` }),
        Accept: 'application/vnd.github.v3.raw',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }

    const fileName = path.basename(filePath)

    const outputFilePath = path.join(outputPath, fileName)

    const file = fs.createWriteStream(outputFilePath)

    const request = https.request(url, options, (response) => {
      if (response.statusCode !== 200) {
        fs.unlink(outputFilePath, () => { })
        request.end()
        reject(new Error(`Failed to download file ${fileName}: ${response.statusCode}`))
        return
      }

      if (rawFile) {
        const chunks = []
        response.on('data', (chunk) => {
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve(Buffer.concat(chunks))
        })
      } else {
        response.pipe(file)

        file.on('finish', () => {
          resolve(outputFilePath)
        })

        request.on('error', (err) => {
          fs.unlink(outputFilePath, () => { })
          reject(err)
        })
      }
    })

    request.end()
  })
}

module.exports = { downloadAndSaveGithubFile }
