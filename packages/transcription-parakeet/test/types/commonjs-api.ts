import TranscriptionParakeet = require("../../index");
import DefaultTranscriptionParakeet, {
  type ParakeetConfig,
  type TranscriptionParakeetArgs,
} from "../../index";

const config: ParakeetConfig = { maxThreads: 4 };
const namespaceConfig: TranscriptionParakeet.ParakeetConfig = config;
const args: TranscriptionParakeetArgs = {
  config: { parakeetConfig: namespaceConfig },
};

const requireConstructor: typeof TranscriptionParakeet =
  TranscriptionParakeet;
const defaultConstructor: typeof TranscriptionParakeet =
  DefaultTranscriptionParakeet;
const backendId: TranscriptionParakeet.BackendId =
  TranscriptionParakeet.BackendId.CPU;

void [args, requireConstructor, defaultConstructor, backendId];
