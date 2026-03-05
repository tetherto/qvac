// ESLint flat config (ESM) with strict TypeScript rules and no `any`
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default [
  // Ignore generated output and lockfiles
  {
    ignores: [
      "dist/**",
      "bun.lock",
      "eslint.config.*",
      "scripts/**/*.mjs",
      "tests-qvac/**",
      "test/**",
    ],
  },

  // Type-aware recommended rules (only for TS files)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),

  // Project-specific rules
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          // Use the project's tsconfig to resolve paths and extensions
          project: "./tsconfig.json",
          alwaysTryTypes: true,
        },
        node: {
          extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
        },
      },
      "import/extensions": [".js", ".jsx", ".ts", ".tsx", ".mjs"],
    },
    languageOptions: {
      parserOptions: {
        // Auto-detect tsconfig(s) and use the project service for good perf
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Ignore Node.js subpath imports which the resolver can't handle
      "import/no-unresolved": ["error", { ignore: ["^#"] }],

      // Absolutely no `any`
      "@typescript-eslint/no-explicit-any": "error",

      // Tighten unsafe flows
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Prefer type-only imports for clarity
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Discourage ts-comments unless properly documented
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],

      // Ensure files end with a newline
      "eol-last": ["error", "always"],
    },
  },
];
