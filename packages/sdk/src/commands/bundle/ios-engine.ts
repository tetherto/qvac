/** The JavaScript engines Bare Kit can run an iOS worker with. */
export const IOS_ENGINES = ['javascriptcore', 'v8'] as const

export type IosEngine = (typeof IOS_ENGINES)[number]

/**
 * JavaScriptCore runs on every Apple developer account. V8 needs the
 * extended virtual addressing entitlement, which free accounts cannot sign with.
 */
export const DEFAULT_IOS_ENGINE: IosEngine = 'javascriptcore'

/** The entitlement an iOS app needs to run Bare Kit's V8. */
export const IOS_V8_ENTITLEMENT = 'com.apple.developer.kernel.extended-virtual-addressing'
