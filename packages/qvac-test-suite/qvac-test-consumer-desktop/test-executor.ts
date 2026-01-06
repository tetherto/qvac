import {
	completion,
	transcribe,
	embed,
	translate,
	textToSpeech,
	loadModel,
	unloadModel,
	ragSaveEmbeddings,
	deleteCache,
	getModelInfo,
	loggingStream,
	LLAMA_3_2_1B_INST_Q4_0,
	GTE_LARGE_FP16,
} from "@tetherto/sdk-dev";
// Dynamic import for SDK_LOG_ID (QVAC-9211) - may not be in types yet
const sdkModule = require("@tetherto/sdk-dev");
const SDK_LOG_ID: string | undefined = sdkModule.SDK_LOG_ID;
import { TestExecutorBase, type SDKFunctions, type PlatformFunctions } from "../shared-test-executor/test-executor-base";
import * as path from "path";
import * as fs from "fs";

export class TestExecutor extends TestExecutorBase {
	constructor() {
		const sdk: SDKFunctions = {
			completion,
			transcribe,
			embed,
			translate,
			textToSpeech,
			loadModel,
			unloadModel,
			ragSaveEmbeddings,
			deleteCache,
			getModelInfo,
			loggingStream,
			SDK_LOG_ID,
			LLAMA_3_2_1B_INST_Q4_0,
			GTE_LARGE_FP16,
			SDK_CLIENT_ERROR_CODES: undefined, // Not available in this SDK version
			SDK_SERVER_ERROR_CODES: undefined, // Not available in this SDK version
		};
		const platform: PlatformFunctions = {
			pathJoin: path.join,
			pathResolve: path.resolve,
			getCwd: () => process.cwd(),
		};
		super(sdk, platform);
	}

	protected async readDocumentFile(filename: string, category: 'documents' | 'code'): Promise<string> {
		// Desktop uses standard fs with path construction
		const filePath = this.platform.pathJoin(__dirname, "..", "shared-test-data", category, filename);
		return fs.readFileSync(filePath, "utf-8");
	}

	protected async getAudioFilePath(filename: string): Promise<string> {
		// Desktop uses direct file path
		return this.platform.pathResolve(this.platform.getCwd(), "../shared-test-data/audio", filename);
	}
}
