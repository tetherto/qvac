const { spawn } = require("child_process");

exports.config = {
    runner: "local",
    port: 4723,
    path: "/wd/hub",
    specs: ["*.spec.js", "*.test.js"],
    exclude: [],
    maxInstances: 1,
    capabilities: [
      {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:appPackage": "io.tether.test.qvac",
        "appium:appActivity": "io.tether.test.qvac.MainActivity",
        "appium:newCommandTimeout": 300,
        "appium:autoGrantPermissions": true,  // Auto-grant runtime permissions (microphone, etc.)
        "appium:autoAcceptAlerts": true,       // Auto-accept all dialogs
        "appium:noReset": true
      },
    ],
    logLevel: "info",
    bail: 0,
    baseUrl: "http://localhost",
    waitforTimeout: 1000 * 60 * 10,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    services: ["appium"],
    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: {
      ui: "bdd",
      timeout: 1000 * 60 * 20,  // Increased to 20 minutes to accommodate model loading
    },
    onPrepare: async () => {
      // Set up adb reverse to ensure Android device can reach Metro on localhost
      try {
        const adb = spawn("adb", ["reverse", "tcp:8081", "tcp:8081"], {
          stdio: "inherit",
        });
        await new Promise((resolve, reject) => {
          adb.on("close", (code) => {
            if (code === 0) {
              console.log("✓ Successfully set up adb reverse for Metro bundler");
              resolve();
            } else {
              reject(new Error(`adb reverse failed with code ${code}`));
            }
          });
          adb.on("error", reject);
        });
      } catch (error) {
        console.warn("Warning: Could not set up adb reverse:", error.message);
        console.warn("Make sure Metro is accessible to the Android device/emulator");
      }
    },
  };