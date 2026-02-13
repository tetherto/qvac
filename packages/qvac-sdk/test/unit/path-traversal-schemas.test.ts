// @ts-ignore brittle has no type declarations
import test from "brittle";
import { audioInputSchema } from "@/schemas/transcription";
import { imageInputSchema } from "@/schemas/ocr";
import { attachmentSchema } from "@/schemas/completion-stream";
import {
  ragIngestParamsSchema,
  ragSearchParamsSchema,
  ragDeleteWorkspaceParamsSchema,
  ragCloseWorkspaceParamsSchema,
} from "@/schemas/rag";

// ============== Attack vectors ==============

const TRAVERSAL_VECTORS = [
  "../../../etc/passwd",
  "..\\..\\..\\Windows\\System32",
  "foo/../../../bar",
  "foo%00/../bar",
  "%2e%2e%2f%2e%2e%2f",
  "..\\../mixed",
] as const;

// ============== Category B schemas (absolute user paths) ==============
// These MUST continue to accept all paths — the user intentionally points
// the SDK at files on their filesystem. These are regression guards:
// if someone adds blanket .. rejection to these schemas, these tests break.

test("audioInputSchema filePath accepts user paths (no-regression)", (t) => {
  const paths = [
    "/Users/me/audio.wav",
    "/opt/media/file.mp3",
    "C:\\Users\\me\\audio.wav",
    "./audio.wav",
    "../recordings/file.mp3",
    "relative/path/audio.wav",
  ];
  for (const p of paths) {
    const result = audioInputSchema.safeParse({ type: "filePath", value: p });
    t.ok(result.success, `must accept user path: ${p}`);
  }
});

test("imageInputSchema filePath accepts user paths (no-regression)", (t) => {
  const paths = [
    "/Users/me/image.png",
    "/opt/media/photo.jpg",
    "./image.png",
    "../photos/pic.jpg",
  ];
  for (const p of paths) {
    const result = imageInputSchema.safeParse({ type: "filePath", value: p });
    t.ok(result.success, `must accept user path: ${p}`);
  }
});

test("attachmentSchema accepts user paths (no-regression)", (t) => {
  const paths = [
    "/Users/me/doc.pdf",
    "/tmp/attachment.txt",
    "./doc.pdf",
    "../documents/report.pdf",
  ];
  for (const p of paths) {
    const result = attachmentSchema.safeParse({ path: p });
    t.ok(result.success, `must accept user path: ${p}`);
  }
});

// ============== Category A schemas (path components) ==============
// These strings are joined to a base directory server-side. Traversal
// strings here escape the base dir. The schemas MUST reject them.
//
// These tests assert the DESIRED (fixed) behavior and will FAIL on
// the current (vulnerable) code. They pass once the fix lands.

test("RAG ingest: workspace must reject traversal strings", (t) => {
  for (const vec of TRAVERSAL_VECTORS) {
    const result = ragIngestParamsSchema.safeParse({
      modelId: "test-model",
      workspace: vec,
      documents: ["test"],
    });
    t.absent(result.success, `must reject workspace "${vec}"`);
  }
});

test("RAG deleteWorkspace: must reject traversal strings", (t) => {
  for (const vec of TRAVERSAL_VECTORS) {
    const result = ragDeleteWorkspaceParamsSchema.safeParse({
      workspace: vec,
    });
    t.absent(result.success, `must reject workspace "${vec}"`);
  }
});

test("RAG closeWorkspace: must reject traversal strings", (t) => {
  for (const vec of TRAVERSAL_VECTORS) {
    const result = ragCloseWorkspaceParamsSchema.safeParse({
      workspace: vec,
    });
    t.absent(result.success, `must reject workspace "${vec}"`);
  }
});

test("RAG search: workspace must reject traversal strings", (t) => {
  for (const vec of TRAVERSAL_VECTORS) {
    const result = ragSearchParamsSchema.safeParse({
      modelId: "test-model",
      query: "test",
      workspace: vec,
    });
    t.absent(result.success, `must reject workspace "${vec}"`);
  }
});
