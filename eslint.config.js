// Path: eslint.config.js

import js from '@eslint/js';
import globals from 'globals';

/**
 * ESLint Flat Configuration for EBGeo Street View Service
 * @see https://eslint.org/docs/latest/use/configure/configuration-files-new
 */
export default [
    // Base recommended rules
    js.configs.recommended,

    // Global configuration
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2021,
            }
        },

        rules: {
            // ===== ERROR PREVENTION =====
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }],
            'no-undef': 'error',
            'no-redeclare': 'error',
            'no-duplicate-case': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-extra-boolean-cast': 'error',
            'no-irregular-whitespace': 'error',
            'no-loss-of-precision': 'error',
            'no-misleading-character-class': 'error',
            'no-prototype-builtins': 'warn',
            'no-template-curly-in-string': 'warn',
            'no-unreachable': 'error',
            'no-unsafe-finally': 'error',
            'no-unsafe-optional-chaining': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',

            // ===== BEST PRACTICES =====
            'eqeqeq': ['error', 'always', { null: 'ignore' }],
            'no-caller': 'error',
            'no-eval': 'error',
            'no-extend-native': 'error',
            'no-implied-eval': 'error',
            'no-iterator': 'error',
            'no-labels': 'error',
            'no-lone-blocks': 'error',
            'no-multi-str': 'error',
            'no-new-func': 'error',
            'no-new-wrappers': 'error',
            'no-octal-escape': 'error',
            'no-proto': 'error',
            'no-return-assign': ['error', 'except-parens'],
            'no-self-compare': 'error',
            'no-sequences': 'error',
            'no-throw-literal': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-useless-call': 'error',
            'no-useless-concat': 'error',
            'no-useless-escape': 'warn',
            'no-useless-return': 'warn',
            'no-void': 'error',
            'no-with': 'error',
            'prefer-promise-reject-errors': 'warn',
            'radix': 'error',

            // ===== ES6+ =====
            'no-var': 'error',
            'prefer-const': ['warn', { destructuring: 'all' }],
            'prefer-rest-params': 'error',
            'prefer-spread': 'error',
            'no-useless-computed-key': 'warn',
            'no-useless-constructor': 'warn',
            'no-useless-rename': 'warn',
            'no-duplicate-imports': 'error',
            'symbol-description': 'warn',

            // ===== CODE STYLE (minimal, non-controversial) =====
            'no-multiple-empty-lines': ['warn', { max: 2, maxEOF: 1 }],
            'no-trailing-spaces': 'warn',
            'eol-last': ['warn', 'always'],
            'no-tabs': 'error',
            'curly': ['error', 'multi-line', 'consistent'],
            'brace-style': ['warn', '1tbs', { allowSingleLine: true }],

            // ===== CONSOLE (allowed — server-side logging) =====
            'no-console': 'off',

            // ===== COMMENTS =====
            'spaced-comment': ['warn', 'always', {
                line: { markers: ['/'] },
                block: { balanced: true }
            }]
        }
    },

    // Config files
    {
        files: ['*.config.js'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    },

    // Ignore patterns
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'public/**',
            '*.min.js',
        ]
    }
];
