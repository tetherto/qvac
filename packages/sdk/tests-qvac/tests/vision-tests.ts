import type { TestDefinition, Expectation } from "@tetherto/qvac-test-suite";

const createVisionTest = (
  testId: string,
  prompt: string,
  imagePath: string,
  expectation: Expectation,
  opts: { stream?: boolean; estimatedDurationMs?: number } = {},
): TestDefinition => ({
  testId,
  params: {
    history: [
      {
        role: "user",
        content: prompt,
        attachments: [{ path: `shared-test-data/images/${imagePath}` }],
      },
    ],
    ...(opts.stream && { stream: true }),
  },
  expectation,
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: opts.estimatedDurationMs ?? 20000,
  },
});

export const visionBasic = createVisionTest(
  "vision-basic",
  "What animal is in this image?",
  "elephant.jpg",
  { validation: "contains-any", contains: ["elephant"] },
);

export const visionStreaming = createVisionTest(
  "vision-streaming",
  "What do you see in this image?",
  "elephant.jpg",
  { validation: "contains-any", contains: ["elephant"] },
  { stream: true },
);

export const visionStats = createVisionTest(
  "vision-stats",
  "Describe this image briefly.",
  "elephant.jpg",
  { validation: "contains-any", contains: ["elephant"] },
);

export const visionFormatPng = createVisionTest(
  "vision-format-png",
  "Describe this image.",
  "logo.png",
  { validation: "type", expectedType: "string" },
);

export const visionFormatWebp = createVisionTest(
  "vision-format-webp",
  "Describe this image.",
  "photo-webp.webp",
  { validation: "type", expectedType: "string" },
);

export const visionLargeImage = createVisionTest(
  "vision-large-image",
  "Describe this image.",
  "large-4k.jpg",
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 30000 },
);

export const visionSmallImage = createVisionTest(
  "vision-small-image",
  "Describe this image.",
  "small-64.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionObjectDetection = createVisionTest(
  "vision-object-detection",
  "List all the objects you can identify in this image.",
  "room.jpg",
  { validation: "contains-any", contains: ["sofa", "table", "lamp", "window"] },
);

export const visionTextExtraction = createVisionTest(
  "vision-text-extraction",
  "What text do you see in this image?",
  "sign.jpg",
  { validation: "contains-any", contains: ["welcome", "bienvenido", "bienvenue", "willkommen"] },
);

export const visionSceneUnderstanding = createVisionTest(
  "vision-scene-understanding",
  "Describe the scene in this image.",
  "scene.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionMultipleImages: TestDefinition = {
  testId: "vision-multiple-images",
  params: {
    history: [
      {
        role: "user",
        content: "Compare these two images. What is in each one?",
        attachments: [
          { path: "shared-test-data/images/elephant.jpg" },
          { path: "shared-test-data/images/room.jpg" },
        ],
      },
    ],
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 30000,
  },
};

export const visionMultiTurn: TestDefinition = {
  testId: "vision-multi-turn",
  params: {
    history: [
      {
        role: "user",
        content: "What animal is in this image?",
        attachments: [{ path: "shared-test-data/images/elephant.jpg" }],
      },
      {
        role: "assistant",
        content: "The image shows an elephant.",
      },
      {
        role: "user",
        content: "What color is it?",
      },
    ],
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 25000,
  },
};

export const visionErrorMissingImage: TestDefinition = {
  testId: "vision-error-missing-image",
  params: {
    history: [
      {
        role: "user",
        content: "What is in this image?",
        attachments: [{ path: "shared-test-data/images/nonexistent.jpg" }],
      },
    ],
  },
  expectation: { validation: "throws-error", errorContains: "not found" },
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 10000,
  },
};

export const visionErrorUnsupportedFormat: TestDefinition = {
  testId: "vision-error-unsupported-format",
  params: {
    history: [
      {
        role: "user",
        content: "What is in this image?",
        attachments: [{ path: "shared-test-data/images/invalid-format.bmp" }],
      },
    ],
  },
  expectation: { validation: "throws-error", errorContains: "failed to load" },
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 10000,
  },
};

export const visionTests = [
  visionBasic,
  visionStreaming,
  visionStats,
  visionFormatPng,
  visionFormatWebp,
  visionLargeImage,
  visionSmallImage,
  visionObjectDetection,
  visionTextExtraction,
  visionSceneUnderstanding,
  visionMultipleImages,
  visionMultiTurn,
  visionErrorMissingImage,
  visionErrorUnsupportedFormat,
];
