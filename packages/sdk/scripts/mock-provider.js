#!/usr/bin/env bun

// This temporary script simulates a delegated inference provider
// Loads a mock model with progress updates

import Hyperswarm from "hyperswarm";
import RPC from "bare-rpc";
import process from "bare-process";

const topic = process.argv[2]
  ? Buffer.from(process.argv[2], "hex")
  : Buffer.alloc(32, "qvac-test-topic");
console.log(`Joining topic: ${topic.toString("hex")}`);

const seed = Buffer.alloc(32, "qvac-test-seed");

const swarm = new Hyperswarm({ seed });

console.log(`Swarm key pair: ${swarm.keyPair.publicKey.toString("hex")}`);

// Join topic as server (provider)
const discovery = swarm.join(topic, { server: true, client: false });

// Wait for the topic to be fully announced on the DHT
await discovery.flushed();
console.log(`✅ Topic announced: ${topic.toString("hex")}`);

// Wait for connections
await swarm.flush();
console.log(`🎯 Ready to accept connections`);

swarm.on("connection", (conn) => {
  console.log(
    `📡 New connection established from: ${conn.remotePublicKey?.toString("hex")}`,
  );

  // Create RPC instance on the Hyperswarm connection
  const rpc = new RPC(conn, async (req) => {
    try {
      const message = JSON.parse(req.data.toString());
      console.log(`📨 Received RPC request:`, message.type);

      // Handle based on message type, ignore command number
      if (message.type === "loadModel") {
        try {
          console.log(
            `🔧 Processing loadModel request for: ${message.modelIdOrPath}`,
          );

          if (message.withProgress) {
            console.log(
              "📊 Progress streaming enabled - using RPC response stream",
            );

            // Use bare-rpc's built-in response streaming
            const responseStream = req.createResponseStream();

            // Simulate progress updates
            const totalSize = 750 * 1024 * 1024; // 750MB model
            let downloaded = 0;
            const chunkSize = 5 * 1024 * 1024; // 5MB chunks

            const sendProgress = () => {
              if (downloaded < totalSize) {
                downloaded += chunkSize;
                if (downloaded > totalSize) downloaded = totalSize;

                const progressUpdate = {
                  type: "modelProgress",
                  downloaded,
                  total: totalSize,
                  percentage: (downloaded / totalSize) * 100,
                };

                // Send progress through the RPC response stream
                console.log(
                  `📤 Streaming progress: ${progressUpdate.percentage.toFixed(1)}%`,
                );
                responseStream.write(
                  JSON.stringify(progressUpdate) + "\n",
                  "utf-8",
                );

                // Continue sending progress updates
                setTimeout(sendProgress, 16); // 16ms between updates for ~1.6 second total (3x faster)
              } else {
                // Send final response
                const response = {
                  type: "loadModel",
                  success: true,
                  modelId: message.modelIdOrPath || `delegated-${Date.now()}`,
                };

                console.log(
                  "📤 Sending final response through stream:",
                  response,
                );
                responseStream.write(JSON.stringify(response) + "\n", "utf-8");
                responseStream.end();
              }
            };

            // Start progress simulation
            setTimeout(sendProgress, 33); // 3x faster start delay
          } else {
            // No progress - send immediate response
            const response = {
              type: "loadModel",
              success: true,
              modelId: message.modelIdOrPath || `delegated-${Date.now()}`,
            };

            console.log("📤 Sending response:", response);
            req.reply(JSON.stringify(response));
          }
        } catch (error) {
          console.error("❌ Failed to process loadModel request:", error);
          req.reply(
            JSON.stringify({
              type: "loadModel",
              success: false,
              error: error.message,
            }),
          );
        }
      } else if (message.type === "completionStream") {
        console.log(
          `🔧 Processing completion request for model: ${message.modelId}`,
        );

        // Mock completion response - use response stream like client expects
        const responseStream = req.createResponseStream();

        const tokens = [
          "This is",
          " a test",
          " response",
          " from",
          " the",
          " mock",
          " provider",
        ];

        let seq = 0;
        let rawText = "";

        for (const token of tokens) {
          rawText += token;

          const response = {
            type: "completionStream",
            events: [{ type: "contentDelta", seq: seq++, text: token }],
          };
          console.log("📤 Sending completion event via stream:", response);
          responseStream.write(JSON.stringify(response) + "\n");

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const finalResponse = {
          type: "completionStream",
          done: true,
          events: [
            {
              type: "completionDone",
              seq: seq++,
              raw: { fullText: rawText },
            },
          ],
        };
        responseStream.write(JSON.stringify(finalResponse) + "\n");

        console.log(
          "📤 Sending completion final response via stream:",
          finalResponse,
        );
        responseStream.end();
      } else {
        console.log(`❓ Unknown message type: ${message.type}`);
        const responseStream = req.createResponseStream();
        responseStream.end(
          JSON.stringify({
            type: "error",
            error: `Unknown message type: ${message.type}`,
          }) + "\n",
        );
      }
    } catch (error) {
      console.error("❌ Failed to process request:", error);
      try {
        const responseStream = req.createResponseStream();
        responseStream.end(
          JSON.stringify({
            type: "error",
            error: `Request processing failed: ${error.message}`,
          }) + "\n",
        );
      } catch (streamError) {
        console.error("❌ Failed to send error response:", streamError);
        // Fallback to reply if stream fails
        try {
          req.reply(
            JSON.stringify({
              type: "error",
              error: `Request processing failed: ${error.message}`,
            }),
          );
        } catch (replyError) {
          console.error("❌ All response methods failed:", replyError);
        }
      }
    }
  });

  conn.on("close", () => {
    console.log(`🔌 Connection closed`);
  });

  conn.on("error", (err) => {
    console.error(`🚨 Connection error:`, err);
  });
});

process.on("SIGINT", () => {
  swarm.destroy();
  process.exit(0);
});
