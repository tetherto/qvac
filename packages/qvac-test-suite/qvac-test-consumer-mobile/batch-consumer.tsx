import { useEffect, useState, useRef } from "react";
import { View, Text, StyleSheet, ScrollView, Platform } from "react-native";
import Constants from "expo-constants";
import { env } from "@/env";
import { TestExecutor } from "./test-executor";
import { MobileConsumer } from "./consumer-logic";

interface BatchStats {
	testsCompleted: number;
	testsPassed: number;
	testsFailed: number;
	totalTests: number;
	currentTest: string;
	isComplete: boolean;
}

export default function BatchConsumer() {
	const [logs, setLogs] = useState<string[]>([]);
	const [stats, setStats] = useState<BatchStats>({
		testsCompleted: 0,
		testsPassed: 0,
		testsFailed: 0,
		totalTests: 0,
		currentTest: "",
		isComplete: false,
	});
	const [consumerId] = useState(
		`consumer-mobile-${Constants.deviceName || Constants.sessionId || "unknown"}-${Date.now()}`
	);
	const [runId] = useState(env.RUN_ID);
	const consumerRef = useRef<MobileConsumer | null>(null);

	const addLog = (message: string) => {
		console.log(message);
		setLogs((prev) => [...prev.slice(-50), message]);
	};

	useEffect(() => {
		let client: any;
		let isInitialized = false;

		(async () => {
			if (isInitialized) return;
			isInitialized = true;

			try {
				addLog("🔧 Initializing consumer...");
				addLog(`📱 Device: ${Constants.deviceName || "Unknown"}`);
				addLog(`🆔 ID: ${consumerId.substring(0, 30)}...`);
				addLog(`🔑 Run ID: ${runId}\n`);

				const executor = new TestExecutor();

				addLog("📦 Loading MQTT client...");
				const mqttModule = await import("mqtt");
				const mqtt = mqttModule.default || mqttModule;

				const protocol = env.useSsl ? "wss" : "ws";
				const port = env.useSsl ? env.EXPO_PUBLIC_MQTT_PORT_SSL : env.EXPO_PUBLIC_MQTT_PORT;
				const brokerUrl = `${protocol}://${env.EXPO_PUBLIC_MQTT_HOST}:${port}${env.EXPO_PUBLIC_MQTT_PATH}`;

				addLog("📡 Connecting to MQTT...");
				addLog(`   URL: ${brokerUrl}`);

				client = mqtt.connect(brokerUrl, {
					connectTimeout: 10000,
					reconnectPeriod: 5000,
					keepalive: 60,
					clean: true,
				});

				const consumer = new MobileConsumer(
					client,
					consumerId,
					`mobile-${Platform.OS}`,
					runId,
					executor,
					{
						log: addLog,
						updateStats: (update) => {
							setStats((prev) => ({ ...prev, ...update }));
						},
					}
				);
				consumerRef.current = consumer;

				consumer.setupMqttHandlers();

				client.on("error", (err: any) => {
					addLog(`❌ MQTT error: ${err.message}`);
				});

				client.on("close", () => {
					addLog("⚠️ MQTT closed");
				});

			} catch (error: any) {
				addLog(`❌ Fatal error: ${error.message}`);
			}
		})();

		return () => {
			if (consumerRef.current) {
				consumerRef.current.forceShutdown();
			}
			if (client) {
				client.end();
			}
		};
	}, []);

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title}>QVAC Batch Consumer (Mobile)</Text>
				<Text style={styles.consumerId}>{consumerId.substring(0, 40)}...</Text>
			</View>

			<View style={styles.statsContainer}>
				<View style={styles.statBox}>
					<Text style={styles.statValue}>{stats.testsCompleted}</Text>
					<Text style={styles.statLabel}>Completed</Text>
				</View>
				<View style={styles.statBox}>
					<Text style={[styles.statValue, { color: "#4ade80" }]}>{stats.testsPassed}</Text>
					<Text style={styles.statLabel}>Passed</Text>
				</View>
				<View style={styles.statBox}>
					<Text style={[styles.statValue, { color: "#f87171" }]}>{stats.testsFailed}</Text>
					<Text style={styles.statLabel}>Failed</Text>
				</View>
				<View style={styles.statBox}>
					<Text style={styles.statValue}>{stats.totalTests}</Text>
					<Text style={styles.statLabel}>Total</Text>
				</View>
			</View>

			{stats.currentTest && !stats.isComplete && (
				<View style={styles.currentTestContainer}>
					<Text style={styles.currentTestLabel}>Current Test:</Text>
					<Text style={styles.currentTest}>{stats.currentTest}</Text>
				</View>
			)}

			{stats.isComplete && (
				<View style={styles.completeContainer}>
					<Text style={styles.completeText}>✅ Batch Complete!</Text>
				</View>
			)}

			<View style={styles.logsContainer}>
				<Text style={styles.logsTitle}>Console Logs</Text>
				<ScrollView style={styles.logsScroll} contentContainerStyle={styles.logsContent}>
					{logs.map((log, index) => (
						<Text key={index} style={styles.logLine}>
							{log}
						</Text>
					))}
				</ScrollView>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: "#0a0a0a", padding: 16 },
	header: { marginBottom: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: "#333" },
	title: { fontSize: 20, fontWeight: "bold", color: "#fff", marginBottom: 4 },
	consumerId: { fontSize: 10, color: "#888", fontFamily: "monospace" },
	statsContainer: { flexDirection: "row", justifyContent: "space-around", marginBottom: 20, gap: 8 },
	statBox: { flex: 1, backgroundColor: "#1a1a1a", padding: 12, borderRadius: 8, alignItems: "center" },
	statValue: { fontSize: 24, fontWeight: "bold", color: "#60a5fa", marginBottom: 4 },
	statLabel: { fontSize: 10, color: "#888", textTransform: "uppercase" },
	currentTestContainer: { backgroundColor: "#1a1a1a", padding: 12, borderRadius: 8, marginBottom: 16 },
	currentTestLabel: { fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4 },
	currentTest: { fontSize: 14, color: "#60a5fa", fontFamily: "monospace" },
	completeContainer: { backgroundColor: "#1a1a1a", padding: 16, borderRadius: 8, marginBottom: 16, alignItems: "center" },
	completeText: { fontSize: 18, color: "#4ade80", fontWeight: "bold" },
	logsContainer: { flex: 1, backgroundColor: "#1a1a1a", borderRadius: 8, overflow: "hidden" },
	logsTitle: { fontSize: 12, color: "#888", textTransform: "uppercase", padding: 12, borderBottomWidth: 1, borderBottomColor: "#333" },
	logsScroll: { flex: 1 },
	logsContent: { padding: 12 },
	logLine: { fontSize: 11, color: "#ddd", fontFamily: "monospace", marginBottom: 4 },
});

