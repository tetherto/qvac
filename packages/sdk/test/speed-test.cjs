const Hyperdrive = require("hyperdrive");
const Corestore = require("corestore");
const Hyperswarm = require("hyperswarm");
const os = require("bare-os");
const path = require("bare-path");

async function speedTest() {
  console.log("Connecting...");
  const tempDir = path.join(os.tmpdir(), `speed-test-${Date.now()}`);
  const corestore = new Corestore(tempDir);
  await corestore.ready();

  const drive = new Hyperdrive(
    corestore,
    Buffer.from(
      "afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3",
      "hex",
    ),
  );
  await drive.ready();

  const swarm = new Hyperswarm();
  swarm.join(drive.discoveryKey, { server: false, client: true });
  swarm.on("connection", (connection) => {
    console.log("Peer connected");
    corestore.replicate(connection);
  });

  console.log("Finding peers...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("Starting download...");
  const startTime = Date.now();
  let downloadedBytes = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  await drive.download("/Llama-3.2-1B-Instruct-Q4_0.gguf");

  const readStream = drive.createReadStream("/Llama-3.2-1B-Instruct-Q4_0.gguf");

  readStream.on("data", (chunk) => {
    downloadedBytes += chunk.length;
    const now = Date.now();
    const timeDiff = (now - lastTime) / 1000;

    // Update speed every second
    if (timeDiff >= 1) {
      const bytesDiff = downloadedBytes - lastBytes;
      const speedMbps = (bytesDiff * 8) / (1024 * 1024 * timeDiff);
      console.log(`${speedMbps.toFixed(2)} Mbps`);

      lastTime = now;
      lastBytes = downloadedBytes;
    }
  });

  readStream.on("end", () => {
    const totalTime = (Date.now() - startTime) / 1000;
    const avgSpeedMbps = (downloadedBytes * 8) / (1024 * 1024 * totalTime);
    console.log(`Final: ${avgSpeedMbps.toFixed(2)} Mbps`);
    process.exit(0);
  });

  readStream.on("error", (err) => {
    console.log(`Error: ${err.message}`);
    console.log("Speed: 0 Mbps");
    process.exit(1);
  });
}

speedTest();
