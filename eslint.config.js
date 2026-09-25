const js = require('@eslint/js');
const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/', 'dist/', 'build/'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...typescriptPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      // web-serial.d.ts declares global interfaces (SerialPort, Serial, etc.) that
      // ESLint cannot resolve without full TypeScript project-aware analysis.
      'no-undef': 'off',
      // web-serial.d.ts augments the built-in Navigator interface via declaration
      // merging; ESLint's rule treats this as a redeclaration.
      'no-redeclare': 'off',
    },
  },
];
