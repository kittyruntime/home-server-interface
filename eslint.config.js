import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'

export default tseslint.config(
  {
    // Build output, generated code and vendored files are not linted.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/.claude/**',
      'packages/database/generated/**',
      'packages/database/src/generated/**',
      'website/.astro/**',
      'apps/root-worker/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `essential` = correctness/reactivity rules only; the few formatting rules
  // the project enforces are listed below under "Code style".
  ...pluginVue.configs['flat/essential'],

  {
    // Vue SFCs are parsed by vue-eslint-parser with the TS parser for <script>.
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, __APP_VERSION__: 'readonly' },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with an underscore.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The codebase uses a few pragmatic `any`s at tRPC/DOM boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      // Multi-word component names aren't required for this app's local views.
      'vue/multi-word-component-names': 'off',
      // Empty catch blocks are a deliberate "swallow and move on" pattern here.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Code style (see website/src/content/docs/development/code-style.md).
    // These rules only settle what the codebase already does in most places
    // and are all autofixable: `pnpm lint:fix` formats a file. Line length,
    // attribute wrapping and column alignment are left to the author.
    files: ['**/*.{ts,vue,mjs,js}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1, flatTernaryExpressions: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/block-spacing': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/comma-spacing': 'error',
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/type-annotation-spacing': 'error',
      '@stylistic/quote-props': ['error', 'consistent-as-needed'],
    },
  },

  {
    // Templates: two-space indentation, wrapped attributes one step in.
    files: ['**/*.vue'],
    rules: {
      'vue/html-indent': ['error', 2, { alignAttributesVertically: false }],
      'vue/html-quotes': ['error', 'double'],
      'vue/html-self-closing': ['error', { html: { void: 'never', normal: 'always', component: 'always' } }],
      'vue/html-closing-bracket-spacing': 'error',
      'vue/mustache-interpolation-spacing': 'error',
      'vue/no-multi-spaces': 'error',
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      'vue/padding-line-between-blocks': 'error',
      'vue/component-name-in-template-casing': ['error', 'PascalCase', { registeredComponentsOnly: true }],
    },
  },

  {
    // Backend logs must go through utils/log (one JSON format, see #42).
    files: ['apps/backend/src/**/*.ts'],
    ignores: ['apps/backend/src/tests/**'],
    rules: { 'no-console': 'error' },
  },

  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
