import dns from 'node:dns/promises'
import type { DnsPromises } from './dns-promises-types.ts'

const dnsPromises: DnsPromises = {
  async lookup(hostname) {
    const addresses = await dns.lookup(hostname, { all: true })
    return addresses.flatMap((entry) =>
      entry.family === 4 || entry.family === 6
        ? [{
            address: entry.address,
            family: entry.family === 4 ? 4 : 6
          }]
        : []
    )
  }
}

export default dnsPromises
