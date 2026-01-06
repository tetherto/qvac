import { getArgValue } from "../shared-utils/args";

/**
 * Desktop Consumer Environment Configuration
 * CLI arguments: --run-id
 */

export const env = {
	MQTT_BROKER_URL: process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883",
	MQTT_TOPIC: process.env.MQTT_TOPIC || "qvac/test",
	RUN_ID: getArgValue("run-id") || process.env.RUN_ID || "*",
};
