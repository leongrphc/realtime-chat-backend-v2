import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['.next/**', 'dist/**', 'out/**', '.wrangler/**', 'node_modules/**', 'next-env.d.ts'] },
  js.configs.recommended, ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['src/app/**/*.tsx'], plugins: { 'react-hooks': hooks }, rules: hooks.configs.recommended.rules }
);
