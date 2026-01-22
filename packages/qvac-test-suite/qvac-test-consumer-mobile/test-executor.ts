import {
	completion,
	transcribe,
	embed,
	translate,
	textToSpeech,
	ocr,
	loadModel,
	unloadModel,
	ragIngest,
	deleteCache,
	getModelInfo,
	loggingStream,
	LLAMA_3_2_1B_INST_Q4_0,
	GTE_LARGE_FP16,
	OCR_CRAFT_LATIN_RECOGNIZER_1,
} from "@tetherto/sdk-dev";
// Dynamic import for SDK_LOG_ID (QVAC-9211) - may not be in types yet
const sdkModule = require("@tetherto/sdk-dev");
const SDK_LOG_ID: string | undefined = sdkModule.SDK_LOG_ID;
import { TestExecutorBase, type SDKFunctions, type PlatformFunctions } from "../shared-test-executor/test-executor-base";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { audio, documents, code, images } from "../shared-test-data/assets";

export class TestExecutor extends TestExecutorBase {
	constructor() {
		const sdk: SDKFunctions = {
			completion,
			transcribe,
			embed,
			translate,
			textToSpeech,
			ocr,
			loadModel,
			unloadModel,
			ragIngest,
			deleteCache,
			getModelInfo,
			loggingStream,
			SDK_LOG_ID,
			LLAMA_3_2_1B_INST_Q4_0,
			GTE_LARGE_FP16,
			OCR_CRAFT_LATIN_RECOGNIZER_1	,
			SDK_CLIENT_ERROR_CODES: undefined, // Not available in this SDK version
			SDK_SERVER_ERROR_CODES: undefined, // Not available in this SDK version
		};
		const platform: PlatformFunctions = {
			pathJoin: (...paths: string[]) => require("path").join(...paths),
			pathResolve: (...paths: string[]) => require("path").resolve(...paths),
			getCwd: () => require("process").cwd(),
		};
		super(sdk, platform);
	}

	protected async readDocumentFile(filename: string, category: 'documents' | 'code'): Promise<string> {
		const assetMap = category === 'documents' ? documents : code;
		const assetModule = assetMap[filename as keyof typeof assetMap];
		if (!assetModule) {
			throw new Error(`${category} file not found: ${filename}`);
		}

		const asset = Asset.fromModule(assetModule);
		await asset.downloadAsync();

		if (!asset.localUri) {
			throw new Error(`Failed to load ${category} file: ${filename}`);
		}

		// Use modern FileSystem API: new File(uri).text()
		const file = new File(asset.localUri);
		return await file.text();
	}

	protected async getAudioFilePath(filename: string): Promise<string> {
		const audioModule = audio[filename as keyof typeof audio];
		if (!audioModule) {
			throw new Error(`Audio file not found: ${filename}`);
		}

		const audioAsset = Asset.fromModule(audioModule);
		await audioAsset.downloadAsync();

		let audioPath = audioAsset.localUri || audioAsset.uri;
		if (audioPath.startsWith("file://")) {
			audioPath = audioPath.substring(7);
		}
		audioPath = decodeURIComponent(audioPath);

		return audioPath;
	}

	protected async getImageFilePath(filename: string): Promise<string> {
		const imageModule = images[filename as keyof typeof images];
		if (!imageModule) {
			throw new Error(`Image file not found: ${filename}`);
		}

		const imageAsset = Asset.fromModule(imageModule);
		await imageAsset.downloadAsync();

		let imagePath = imageAsset.localUri || imageAsset.uri;
		if (imagePath.startsWith("file://")) {
			imagePath = imagePath.substring(7);
		}
		imagePath = decodeURIComponent(imagePath);

		return imagePath;
	}
}
