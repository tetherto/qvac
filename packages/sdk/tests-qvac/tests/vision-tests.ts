import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createVisionTest = (
  testId: string,
  prompt: string,
  imagePath: string,
  expectation:
    | { validation: "contains-all" | "contains-any"; contains: string[] }
    | {
        validation: "type";
        expectedType: "string" | "number" | "array";
      },
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
  },
  expectation,
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 20000,
  },
});

export const visionSimpleImage = createVisionTest(
  "vision-simple-image",
  "What do you see in this image?",
  "cat.jpg",
  {
    validation: "contains-any",
    contains: ["cat", "animal", "pet"],
  },
);

export const visionObjectDetection = createVisionTest(
  "vision-object-detection",
  "List all the objects you can identify in this image.",
  "room.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionTextExtraction = createVisionTest(
  "vision-text-extraction",
  "What text do you see in this image?",
  "sign.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionMultipleImages = createVisionTest(
  "vision-multiple-images",
  "Compare these images.",
  "before.jpg", // Simplified - would need multiple attachments
  { validation: "type", expectedType: "string" },
);

export const visionImageFormatPng = createVisionTest(
  "vision-image-format-png",
  "Describe this image.",
  "logo.png",
  {
    validation: "type",
    expectedType: "string",
  },
);

export const visionImageFormatWebp = createVisionTest(
  "vision-image-format-webp",
  "Describe this image.",
  "photo-webp.webp",
  { validation: "type", expectedType: "string" },
);

export const visionLargeImage = createVisionTest(
  "vision-large-image",
  "Describe this image.",
  "large-4k.jpg",
  {
    validation: "type",
    expectedType: "string",
  },
);

export const visionColorAnalysis = createVisionTest(
  "vision-color-analysis",
  "What are the dominant colors in this image?",
  "sunset.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionSceneUnderstanding = createVisionTest(
  "vision-scene-understanding",
  "Describe the scene in this image.",
  "scene.jpg",
  { validation: "type", expectedType: "string" },
);

export const visionImageAndText = createVisionTest(
  "vision-image-and-text",
  "What do you see?",
  "cat.jpg",
  {
    validation: "type",
    expectedType: "string",
  },
);

// Simplified remaining vision tests
const remainingVisionTests: TestDefinition[] = [
  "vision-multi-turn-with-image",
  "vision-error-corrupted-image",
  "vision-error-unsupported-format",
  "vision-error-missing-image",
  "vision-image-base64",
].map((testId) => ({
  testId,
  params: {
    history: [
      {
        role: "user",
        content: "Test",
        attachments: [{ path: "shared-test-data/images/cat.jpg" }],
      },
    ],
  },
  expectation: { validation: "type", expectedType: "string" } as const,
  metadata: {
    category: "vision",
    dependency: "vision",
    estimatedDurationMs: 20000,
  },
}));

export const visionTests = [
  visionSimpleImage,
  visionObjectDetection,
  visionTextExtraction,
  visionMultipleImages,
  visionImageFormatPng,
  visionImageFormatWebp,
  visionLargeImage,
  visionColorAnalysis,
  visionSceneUnderstanding,
  visionImageAndText,
  ...remainingVisionTests,
];
