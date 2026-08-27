'use strict'

const test = require('brittle')
const {
  DIRECT_FIXTURES_URL,
  FIXTURES_ASSET_NAME,
  RELEASE_API_URL,
  findAssetApiUrl,
  resolveFixturesSource
} = require('../../scripts/lib/fixtures-source')

test('[fixtures-source] BCI_FIXTURES_URL overrides everything and stays unauthenticated', (t) => {
  const source = resolveFixturesSource({
    BCI_FIXTURES_URL: 'https://example.com/fixtures.tar.gz',
    GITHUB_TOKEN: 'token-a'
  })
  t.is(source.kind, 'direct')
  t.is(source.url, 'https://example.com/fixtures.tar.gz')
  t.absent(source.headers.Authorization, 'override URL is fetched without credentials')
})

test('[fixtures-source] GITHUB_TOKEN routes through the release API with a bearer header', (t) => {
  const source = resolveFixturesSource({ GITHUB_TOKEN: 'token-a' })
  t.is(source.kind, 'release-api')
  t.is(source.releaseUrl, RELEASE_API_URL)
  t.is(source.assetName, FIXTURES_ASSET_NAME)
  t.is(source.headers.Authorization, 'Bearer token-a')
})

test('[fixtures-source] GH_TOKEN works as the fallback token variable', (t) => {
  const source = resolveFixturesSource({ GH_TOKEN: 'token-b' })
  t.is(source.kind, 'release-api')
  t.is(source.headers.Authorization, 'Bearer token-b')
})

test('[fixtures-source] no token falls back to the plain release URL', (t) => {
  const source = resolveFixturesSource({})
  t.is(source.kind, 'direct')
  t.is(source.url, DIRECT_FIXTURES_URL)
  t.absent(source.headers.Authorization)
})

test('[fixtures-source] findAssetApiUrl picks the named asset', (t) => {
  const release = {
    assets: [
      { name: 'other.tar.gz', url: 'https://api.github.com/assets/1' },
      { name: FIXTURES_ASSET_NAME, url: 'https://api.github.com/assets/2' }
    ]
  }
  t.is(findAssetApiUrl(release, FIXTURES_ASSET_NAME), 'https://api.github.com/assets/2')
})

test('[fixtures-source] findAssetApiUrl returns null when the asset is missing', (t) => {
  t.is(findAssetApiUrl({ assets: [{ name: 'other.tar.gz', url: 'x' }] }, FIXTURES_ASSET_NAME), null)
  t.is(findAssetApiUrl({}, FIXTURES_ASSET_NAME), null)
  t.is(findAssetApiUrl(null, FIXTURES_ASSET_NAME), null)
})
