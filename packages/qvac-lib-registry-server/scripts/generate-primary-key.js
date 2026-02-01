'use strict'

const { command, flag } = require('paparam')
const { generatePrimaryKey, generateWriterKeyPair } = require('../utils/key-generator')

const generateCmd = command('generate-primary-key',
  flag('--passphrase [text]', 'Passphrase for deterministic key generation (testing only)'),
  flag('--writer-keypair', 'Generate ed25519 writer keypair instead of primary key'),
  async function ({ flags }) {
    const passphrase = flags.passphrase || null

    if (flags.writerKeypair) {
      const { publicKey, secretKey } = generateWriterKeyPair(passphrase)
      const pubHex = publicKey.toString('hex')
      const secHex = secretKey.toString('hex')

      console.log('Writer keypair generated:\n')
      console.log('QVAC_WRITER_PUBLIC_KEY=' + pubHex)
      console.log('QVAC_WRITER_SECRET_KEY=' + secHex)
      console.log('\nUsage in CI (.github/secrets or .env):')
      console.log('  Set both environment variables above.')
      console.log('\nNote: The public key must be added to QVAC_ALLOWED_WRITER_KEYS')
      console.log('on the registry server for write access.')

      if (passphrase) {
        console.log('\n⚠️  Warning: Deterministic keys are for testing/development only.')
        console.log('   Using the same passphrase will always generate the same keypair.')
      }
      return
    }

    const primaryKey = generatePrimaryKey(passphrase)
    const hex = primaryKey.toString('hex')

    console.log('Primary key (hex):', hex)
    console.log('\nUsage:')
    console.log('For registry service:')
    console.log(`  node scripts/bin.js run --primary-key ${hex}`)
    console.log('  Or set in .env: QVAC_PRIMARY_KEY=' + hex)
    console.log('\nFor writer scripts (add-model, add-all-models):')
    console.log(`  node scripts/add-model.js <url> --primary-key ${hex}`)
    console.log('  Or set in .env: QVAC_WRITER_PRIMARY_KEY=' + hex)

    if (passphrase) {
      console.log('\n⚠️  Warning: Deterministic keys are for testing/development only.')
      console.log('   Using the same passphrase will always generate the same key.')
    }
  }
)

generateCmd.parse()
