#!/usr/bin/env bun
/**
 * Cross-platform script to manage ALLOW_WILDCARD_CONSUMERS in .env file
 * Usage:
 *   bun run scripts/manage-local-env.ts        # Set to true (default)
 *   bun run scripts/manage-local-env.ts unset  # Remove/unset
 */

import * as fs from "fs";
import * as path from "path";

const ENV_FILE = path.join(__dirname, "..", ".env");
const VARIABLE_NAME = "ALLOW_WILDCARD_CONSUMERS";
const VARIABLE_VALUE = "true";

const action = process.argv[2]?.toLowerCase();
const isUnset = action === "unset" || action === "remove" || action === "delete";

function setLocalEnv() {
	let envContent = "";
	let variableExists = false;
	let needsUpdate = false;

	// Read existing .env file if it exists
	if (fs.existsSync(ENV_FILE)) {
		envContent = fs.readFileSync(ENV_FILE, "utf-8");
		const lines = envContent.split(/\r?\n/);
		
		// Check if variable exists and update if needed
		const updatedLines = lines.map((line) => {
			const trimmed = line.trim();
			// Match variable with optional whitespace and = sign
			if (trimmed.startsWith(`${VARIABLE_NAME}=`)) {
				variableExists = true;
				const currentValue = trimmed.split("=")[1]?.trim();
				if (currentValue !== VARIABLE_VALUE) {
					needsUpdate = true;
					return `${VARIABLE_NAME}=${VARIABLE_VALUE}`;
				}
				return line; // Already correct, keep as-is
			}
			return line;
		});
		
		envContent = updatedLines.join("\n");
	}

	// Add variable if it doesn't exist
	if (!variableExists) {
		// Add newline if file exists and doesn't end with one
		if (fs.existsSync(ENV_FILE) && !envContent.endsWith("\n") && envContent.length > 0) {
			envContent += "\n";
		}
		envContent += `${VARIABLE_NAME}=${VARIABLE_VALUE}\n`;
		needsUpdate = true;
	}

	// Write to file if changes were made
	if (needsUpdate || !fs.existsSync(ENV_FILE)) {
		fs.writeFileSync(ENV_FILE, envContent, "utf-8");
		console.log(`✅ Set ${VARIABLE_NAME}=${VARIABLE_VALUE} in ${ENV_FILE}`);
		if (variableExists) {
			console.log(`   (Updated existing value)`);
		} else {
			console.log(`   (Added new variable)`);
		}
	} else {
		console.log(`✅ ${VARIABLE_NAME} is already set to ${VARIABLE_VALUE} in ${ENV_FILE}`);
	}
}

function unsetLocalEnv() {
	if (!fs.existsSync(ENV_FILE)) {
		console.log(`✅ ${ENV_FILE} does not exist. Nothing to unset.`);
		return;
	}

	const envContent = fs.readFileSync(ENV_FILE, "utf-8");
	const lines = envContent.split(/\r?\n/);
	
	// Filter out the variable line
	const filteredLines = lines.filter((line) => {
		const trimmed = line.trim();
		// Remove line if it matches the variable (with or without value)
		return !trimmed.startsWith(`${VARIABLE_NAME}=`);
	});

	const newContent = filteredLines.join("\n").trim();

	// If file becomes empty or only has whitespace, delete it
	if (!newContent || newContent.trim().length === 0) {
		fs.unlinkSync(ENV_FILE);
		console.log(`✅ Removed ${VARIABLE_NAME} and deleted empty .env file`);
	} else {
		// Write back the file without the variable
		fs.writeFileSync(ENV_FILE, newContent + "\n", "utf-8");
		console.log(`✅ Removed ${VARIABLE_NAME} from ${ENV_FILE}`);
	}
}

try {
	if (isUnset) {
		unsetLocalEnv();
	} else {
		setLocalEnv();
	}
} catch (error) {
	console.error(`❌ Error managing local environment: ${error}`);
	process.exit(1);
}

