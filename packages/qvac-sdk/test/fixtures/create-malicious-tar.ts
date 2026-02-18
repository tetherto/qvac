/**
 * Generates a malicious .tar.gz file for zip-slip testing.
 *
 * Run: bun run test/fixtures/create-malicious-tar.ts
 */
import { createGzip } from "zlib";
import { createWriteStream, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import tarStream from "tar-stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "malicious-zipslip.tar.gz");

const pack = tarStream.pack();
const gzip = createGzip();

mkdirSync(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath);

// Malicious entries (end in .gguf to pass isModelFile filter)
pack.entry({ name: "../../../escape.gguf", type: "file" }, "MALICIOUS_1");
pack.entry({ name: "../../../../tmp/pwned.gguf", type: "file" }, "MALICIOUS_2");
pack.entry(
  { name: "models/../../../../../../escape-nested.gguf", type: "file" },
  "MALICIOUS_3",
);

// Legitimate entries
pack.entry(
  { name: "legit-model-00001-of-00002.gguf", type: "file" },
  "LEGIT_SHARD_1",
);
pack.entry(
  { name: "legit-model-00002-of-00002.gguf", type: "file" },
  "LEGIT_SHARD_2",
);

pack.finalize();
pack.pipe(gzip).pipe(output);

output.on("close", () => {
  console.log(`Created: ${outputPath}`);
});
