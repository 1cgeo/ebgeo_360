// Config avulsa para varrer a UI de calibracao, que o eslint.config.js do repo
// ignora por estar em public/. Serve para pegar referencia orfa (no-undef), que
// e o unico erro que passa por node --check e pelo carregamento do modulo, e so
// aparece quando a linha roda no navegador.
import globals from 'globals';

export default [
  {
    files: ['public/calibration/js/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, maplibregl: 'readonly', THREE: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
