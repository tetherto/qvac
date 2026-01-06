#!/usr/bin/env node

/**
 * WebSocket-Enabled MQTT Broker
 * 
 * Provides both MQTT (port 1883) and WebSocket (port 8080) protocols
 * for QVAC test framework.
 * 
 * Usage:
 *   node mqtt-websocket-broker.js
 *   OR
 *   bun mqtt-websocket-broker.js
 */

const aedes = require('aedes')();
const server = require('net').createServer(aedes.handle);
const httpServer = require('http').createServer();
const ws = require('websocket-stream');

const MQTT_PORT = 1883;
const WS_PORT = 8080;

// MQTT TCP server (for desktop consumers and producer)
server.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`✅ MQTT broker listening on port ${MQTT_PORT} (mqtt://0.0.0.0:${MQTT_PORT})`);
});

// WebSocket server (for mobile consumers)
ws.createServer({ server: httpServer }, aedes.handle);
httpServer.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`✅ WebSocket MQTT listening on port ${WS_PORT} (ws://0.0.0.0:${WS_PORT})`);
  console.log(`\n📱 Mobile devices should connect to: ws://YOUR_PC_IP:${WS_PORT}`);
  console.log(`   Example: ws://192.168.1.131:${WS_PORT}\n`);
});

// Event logging
aedes.on('client', (client) => {
  console.log(`📡 Client connected: ${client.id}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`📡 Client disconnected: ${client.id}`);
});

aedes.on('subscribe', (subscriptions, client) => {
  console.log(`📬 Client ${client.id} subscribed to:`, subscriptions.map(s => s.topic).join(', '));
});

aedes.on('publish', (packet, client) => {
  if (client && packet.topic && !packet.topic.startsWith('$SYS')) {
    console.log(`📨 Message from ${client.id} on topic: ${packet.topic}`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down MQTT broker...');
  server.close();
  httpServer.close();
  process.exit(0);
});

