import { FlatCompat } from '@eslint/eslintrc'
import astroEslintParser from 'astro-eslint-parser'

// Instantiate FlatCompat to handle legacy-style configs
const compat = new FlatCompat({
  baseDirectory: process.cwd()
})

export default [
  // 1. Base language options
  {
    files: ['**/*.{js,ts,astro}'],
    ignores: ['node_modules/**', 'dist/**', './demo'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        // Node.js globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        // Custom globals
        Fragment: 'readonly'
      }
    }
  },

  // 2. Bring in your extended configs (from legacy .eslintrc style)
  ...compat.config({
    extends: [
      'plugin:@typescript-eslint/recommended',
      'plugin:import/recommended',
      'plugin:import/typescript'
    ],
    parser: '@typescript-eslint/parser',
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      project: './tsconfig.json'
    }
  }),

  // 3. Astro override: Assign astroEslintParser as an object, then add .astro to extraFileExtensions
  {
    files: ['**/*.astro'],
    languageOptions: {
      parser: astroEslintParser, // <--- important: object reference, not just a string
      parserOptions: {
        extraFileExtensions: ['.astro'], // Tells ESLint to treat .astro as recognized
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    }
  },

  // 4. Custom rules
  // {
  //   rules: {
  //     'prettier/prettier': 'off',
  //     'multiline-ternary': 'off',
  //     'import/no-unresolved': 'off',
  //     'object-curly-newline': ['error', { multiline: true, consistent: true }]
  //   }
  // }
]
