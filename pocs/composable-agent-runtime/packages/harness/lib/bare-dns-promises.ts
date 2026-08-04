import dns from 'bare-dns'
import type { DnsPromises } from './dns-promises-types.ts'

const dnsPromises: DnsPromises = {
  lookup(hostname: string) {
    return new Promise<readonly { address: string; family: 4 | 6 }[]>(
      (resolve, reject) => {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) reject(error)
          else resolve(addresses ?? [])
        })
      }
    )
  }
}

export default dnsPromises
