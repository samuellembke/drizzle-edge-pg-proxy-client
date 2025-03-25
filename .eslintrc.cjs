module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off', // Allow any for database client
    '@typescript-eslint/ban-ts-comment': ['warn', {
      'ts-ignore': 'allow-with-description',
      minimumDescriptionLength: 10
    }],
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    'semi': ['error', 'always'],
    'quotes': ['error', 'single', { avoidEscape: true }],
  },
  ignorePatterns: ['dist', 'node_modules', 'examples'],
};