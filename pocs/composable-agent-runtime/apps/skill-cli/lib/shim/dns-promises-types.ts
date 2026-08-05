export interface DnsLookupAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface DnsPromises {
  lookup(hostname: string): Promise<readonly DnsLookupAddress[]>
}
