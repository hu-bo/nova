import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/api/generated/**',
      'src/routeTree.gen.ts',
      'openapi.json',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', '*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          // 边界模块（导出组件的文件）只能导出组件，否则 React Fast Refresh 会拒绝更新
          // 并整页重载。非组件值（hook、常量、上下文）请放在独立的 *.ts 模块里。
          allowExportNames: ['Route'],
        },
      ],
    },
  },
);
