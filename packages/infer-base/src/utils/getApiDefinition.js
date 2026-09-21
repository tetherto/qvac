"use strict";
const bare_os_1 = require("bare-os");
const platformDefinitions = {
    android: 'vulkan',
    darwin: 'metal',
    ios: 'metal',
    win32: 'vulkan-32',
    linux: 'vulkan'
};
/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 */
function getApiDefinition() {
    return platformDefinitions[(0, bare_os_1.platform)()] ?? 'vulkan';
}
module.exports = getApiDefinition;
