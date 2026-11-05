// Where the models cache keeps a registry model, for tooling that plans around
// the cache before downloading (the SDK e2e CI cache). Pure: no fs, runtime
// state or `bare-*` import, so it loads in Node as well as Bare.

export { getModelCacheLayout, type ModelCacheLayout } from '@/utils/cache/layout'
