import mqtt from "mqtt";
import { env } from "./env";
import * as os from "os";
import { TestExecutor } from "./test-executor";
import { DesktopConsumer } from "./consumer-logic";

export class BatchConsumer {
	private consumer: DesktopConsumer;

	constructor(brokerUrl: string, runId: string, platform: string = "desktop") {
		const consumerId = `consumer-${platform}-${os.hostname()}-${Date.now()}`;
		const client = mqtt.connect(brokerUrl);
		const executor = new TestExecutor();

		this.consumer = new DesktopConsumer(
			client,
			consumerId,
			platform,
			runId,
			executor,
			{
				log: (msg) => console.log(msg),
				updateStats: () => {},
				onShutdown: () => process.exit(0),
			}
		);

		process.on("unhandledRejection", (reason: any) => {
			console.warn(`⚠️  Unhandled promise rejection: ${reason?.message || reason}`);
		});

		this.consumer.setupMqttHandlers();
	}

	public async initialize() {
		console.log("🔧 Initializing consumer...");
		console.log(`📱 Platform: desktop`);
		console.log(`🆔 Consumer ID: ${this.consumer['consumerId']}`);
		console.log(`🔑 Run ID: ${this.consumer['runId']}\n`);
	}

	public forceShutdown() {
		this.consumer.forceShutdown();
	}
}

const consumer = new BatchConsumer(env.MQTT_BROKER_URL, env.RUN_ID);

consumer.initialize().catch((err) => {
	console.error("❌ Fatal error:", err);
	process.exit(1);
});

process.on("SIGINT", () => consumer.forceShutdown());
process.on("SIGTERM", () => consumer.forceShutdown());

