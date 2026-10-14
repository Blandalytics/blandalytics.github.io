// ESLint for the Model Drilldown page: browser ES modules, no build step
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    // ShareImage: /shared/share-image.js, loaded by a classic script tag before the modules
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ShareImage: 'readonly' },
    },
  },
];
