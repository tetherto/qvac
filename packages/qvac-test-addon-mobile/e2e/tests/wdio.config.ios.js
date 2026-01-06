exports.config = {
    runner: "local",
    port: 4723,
    path: "/wd/hub",
    specs: ["*.spec.js", "*.test.js"],
    exclude: [],
    maxInstances: 1,
    capabilities: [
      {
        platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:bundleId": "io.tether.test.qvac",
          "appium:newCommandTimeout": 300,
          "appium:autoAcceptAlerts": true,      // Auto-accept all alerts/permissions (microphone, etc.)
          "appium:autoDismissAlerts": false,    // Don't auto-dismiss (we want to accept)
          "appium:noReset": true
      },
    ],
    logLevel: "info",
    bail: 0,
    baseUrl: "http://localhost",
    waitforTimeout: 1000 * 60 * 10,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    services: [],
    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: {
      ui: "bdd",
      timeout: 1000 * 60 * 20,  // Increased to 20 minutes to accommodate model loading
    },
  };