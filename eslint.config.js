import js from "@eslint/js"
import tseslint from "typescript-eslint"
import pluginVue from "eslint-plugin-vue"
import globals from "globals"

export default tseslint.config(
  {
    // Build output, generated code and vendored files are not linted.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/.claude/**",
      "packages/database/generated/**",
      "apps/root-worker/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `essential` = correctness/reactivity rules only. We deliberately skip the
  // opinionated template-formatting rules (indent, attribute order, line breaks)
  // that a linter shouldn't own — those are left to the editor/formatter.
  ...pluginVue.configs["flat/essential"],

  {
    // Vue SFCs are parsed by vue-eslint-parser with the TS parser for <script>.
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    files: ["**/*.{ts,vue}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, __APP_VERSION__: "readonly" },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The codebase uses a few pragmatic `any`s at tRPC/DOM boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      // Multi-word component names aren't required for this app's local views.
      "vue/multi-word-component-names": "off",
      // Empty catch blocks are a deliberate "swallow and move on" pattern here.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
)
