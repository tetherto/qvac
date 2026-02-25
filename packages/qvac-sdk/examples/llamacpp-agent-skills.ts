import { exec } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  type ToolInput,
  QWEN3_4B_INST_Q4_K_M,
} from "@/index";

const execAsync = promisify(exec);

const runTerminalCommandSchema = z.object({
  command: z.string().describe("Shell command to execute"),
});

const writeTextFileSchema = z.object({
  path: z
    .string()
    .describe("File path relative to home directory (or starting with ~/)"),
  content: z.string().describe("Text content to write"),
  append: z.boolean().optional().describe("Append instead of overwrite"),
});

const ALLOWED_COMMANDS = new Set([
  "curl",
  "gemini",
  "memo",
  "python",
  "python3",
  "pandoc",
  "pdftoppm",
  "soffice",
  "libreoffice",
  "node",
  "npm",
  "npx",
  "which",
  "mkdir",
  "cat",
  "tee",
  "cp",
  "mv",
  "pwd",
  "ls",
  "echo",
  "date",
  "whoami",
]);

const HOME_DIR = os.homedir();

function resolvePathFromHome(inputPath: string): string {
  if (inputPath === "~") {
    return HOME_DIR;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(HOME_DIR, inputPath.slice(2));
  }
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  return path.resolve(HOME_DIR, inputPath);
}

function isInsideHome(targetPath: string): boolean {
  if (targetPath === HOME_DIR) return true;
  return targetPath.startsWith(`${HOME_DIR}${path.sep}`);
}

const terminalTools: ToolInput[] = [
  {
    name: "run_terminal_command",
    description:
      "Run a terminal command from the home directory (~) and return stdout/stderr. Use this instead of pretending to execute commands.",
    parameters: runTerminalCommandSchema,
    handler: async (rawArgs) => {
      const parsed = runTerminalCommandSchema.parse(rawArgs);
      const command = parsed.command.trim();
      if (command.length === 0) {
        return { ok: false, error: "Command cannot be empty" };
      }

      const firstToken = command.split(/\s+/)[0] ?? "";
      if (!ALLOWED_COMMANDS.has(firstToken)) {
        return {
          ok: false,
          error: `Command "${firstToken}" is not allowed in this example`,
          allowedCommands: Array.from(ALLOWED_COMMANDS),
        };
      }

      const resolvedCwd = HOME_DIR;

      const normalizeCommand = (input: string) => {
        // wttr.in is more reliable with explicit https in some environments.
        return input.replace(
          /(^|["'\s])(wttr\.in\/)/g,
          (_, prefix: string) => `${prefix}https://wttr.in/`,
        );
      };

      const withRetryFlags = (input: string) => {
        if (!input.startsWith("curl ")) return input;
        if (/\s-L(\s|$)/.test(input) || /\s--location(\s|$)/.test(input)) {
          return input;
        }
        return input.replace(/^curl(\s|$)/, "curl -L --retry 2 --retry-delay 1$1");
      };

      const explainCommandFailure = (code: string | number | undefined) => {
        const normalized = String(code ?? "");
        if (normalized === "52") {
          return "curl exit code 52 usually means empty reply from server (transient endpoint/proxy/network issue). Retrying with https and -L often fixes it.";
        }
        if (normalized === "6") {
          return "curl exit code 6 means host resolution failed (DNS).";
        }
        if (normalized === "7") {
          return "curl exit code 7 means connection failed.";
        }
        if (normalized === "28") {
          return "curl exit code 28 means operation timed out.";
        }
        return undefined;
      };

      const normalizedCommand = normalizeCommand(command);

      try {
        const { stdout, stderr } = await execAsync(normalizedCommand, {
          cwd: resolvedCwd,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
        return {
          ok: true,
          command: normalizedCommand,
          cwd: resolvedCwd,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        };
      } catch (error) {
        const err = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        const code = err.code ?? "UNKNOWN";
        const hint = explainCommandFailure(code);

        if (firstToken === "curl" && String(code) === "52") {
          const retryCommand = withRetryFlags(normalizedCommand);
          try {
            const { stdout, stderr } = await execAsync(retryCommand, {
              cwd: resolvedCwd,
              timeout: 20000,
              maxBuffer: 1024 * 1024,
            });
            return {
              ok: true,
              command: retryCommand,
              cwd: resolvedCwd,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              retried: true,
              retryReason: hint,
            };
          } catch (retryError) {
            const retryErr = retryError as Error & {
              code?: number | string;
              stdout?: string;
              stderr?: string;
            };
            return {
              ok: false,
              command: retryCommand,
              cwd: resolvedCwd,
              code: retryErr.code ?? code,
              stdout: (retryErr.stdout ?? "").trim(),
              stderr: (retryErr.stderr ?? retryErr.message ?? "").trim(),
              retried: true,
              hint,
            };
          }
        }

        return {
          ok: false,
          command: normalizedCommand,
          cwd: resolvedCwd,
          code,
          stdout: (err.stdout ?? "").trim(),
          stderr: (err.stderr ?? err.message ?? "").trim(),
          hint,
        };
      }
    },
  },
  {
    name: "write_text_file",
    description:
      "Write UTF-8 text to a file (create parent directories as needed).",
    parameters: writeTextFileSchema,
    handler: async (rawArgs) => {
      const parsed = writeTextFileSchema.parse(rawArgs);
      const targetPath = resolvePathFromHome(parsed.path);

      // Keep writes scoped to the home directory for safety.
      if (!isInsideHome(targetPath)) {
        return {
          ok: false,
          error: "Target path must stay inside the home directory",
          homeDirectory: HOME_DIR,
          requestedPath: parsed.path,
        };
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      if (parsed.append) {
        await appendFile(targetPath, parsed.content, "utf-8");
      } else {
        await writeFile(targetPath, parsed.content, "utf-8");
      }

      return {
        ok: true,
        path: targetPath,
        bytesWritten: Buffer.byteLength(parsed.content, "utf-8"),
        append: Boolean(parsed.append),
      };
    },
  },
];

let modelId: string | undefined;

try {
  modelId = await loadModel({
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelType: "llamacpp-completion",
    modelConfig: {
      ctx_size: 32768,
      tools: true,
    },
    onProgress: (progress) =>
      console.log(`Loading model: ${progress.percentage.toFixed(1)}%`),
  });

  const history: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }> = [
    {
      role: "system",
      content:
        "You are a concise software engineering assistant. To execute terminal commands, ALWAYS use run_terminal_command. To create text files, use write_text_file. Do not claim commands ran unless tool output is available. Terminal commands run from the home directory (~).",
    },
  ];

  const turns = [
    {
      label: "weather London",
      prompt:
        "Use /weather and run a real command to get current weather in London. Use run_terminal_command with curl and report actual output.",
    },
    {
      label: "weather Tokyo",
      prompt:
        "Use /weather and run a real command to get current weather in Tokyo. Use run_terminal_command with curl and report actual output.",
    },
    {
      label: "docx-create-markdown",
      prompt:
        "Use /docx to create a short two-section report in Markdown at ~/tmp/docx-demo.md using write_text_file.",
    },
    {
      label: "docx-markdown-to-docx",
      prompt:
        "Use /docx to convert ~/tmp/docx-demo.md into ~/tmp/docx-demo.docx using a real terminal command and report the actual output.",
    },
    {
      label: "docx-docx-to-pdf",
      prompt:
        "Use /docx to convert ~/tmp/docx-demo.docx into ~/tmp/docx-demo.pdf using a real terminal command and report the actual output.",
    },
  ];

  for (const [index, turn] of turns.entries()) {
    console.log(`\n--- Turn ${index + 1}: ${turn.label} ---\n`);
    history.push({ role: "user", content: turn.prompt });

    const firstPass = completion({
      modelId,
      history,
      stream: true,
      tools: terminalTools,
    });

    for await (const token of firstPass.tokenStream) {
      process.stdout.write(token);
    }

    const firstPassText = await firstPass.text;
    const toolCalls = await firstPass.toolCalls;

    if (toolCalls.length === 0) {
      history.push({
        role: "assistant",
        content: firstPassText.trim(),
      });
      console.log("\n\nStats:", await firstPass.stats);
      continue;
    }

    history.push({ role: "assistant", content: firstPassText.trim() });

    for (const call of toolCalls) {
      if (!call.invoke) {
        history.push({
          role: "tool",
          content: JSON.stringify({
            toolCallId: call.id,
            error: `No handler registered for tool: ${call.name}`,
          }),
        });
        continue;
      }

      const toolResult = await call.invoke();
      history.push({
        role: "tool",
        content: JSON.stringify(
          {
            toolCallId: call.id,
            toolName: call.name,
            result: toolResult,
          },
          null,
          2,
        ),
      });
    }

    console.log("\n\n--- Tool Results Added; Final Answer ---\n");
    const secondPass = completion({
      modelId,
      history,
      stream: true,
      tools: terminalTools,
    });

    let assistantReply = "";
    for await (const token of secondPass.tokenStream) {
      process.stdout.write(token);
      assistantReply += token;
    }

    history.push({ role: "assistant", content: assistantReply.trim() });
    console.log("\n\nStats:", await secondPass.stats);
  }
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
} finally {
  if (modelId) {
    await unloadModel({ modelId, clearStorage: false });
  }
}
