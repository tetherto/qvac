/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 */
declare function getApiDefinition(): string;
export = getApiDefinition;
