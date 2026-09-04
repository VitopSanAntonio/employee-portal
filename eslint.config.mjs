// Flat config. Covers the shared browser modules, the service worker, the
// Cloudflare Worker, and the test suites — none of which had any static
// checking before: CI validated HTML and ran browser tests, but nothing ever
// looked at the JavaScript.
const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', localStorage: 'readonly',
  fetch: 'readonly', console: 'readonly', navigator: 'readonly',
  crypto: 'readonly', FileReader: 'readonly', DataTransfer: 'readonly',
  URL: 'readonly', Image: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', DOMException: 'readonly',
  AbortController: 'readonly',
  // form-utils.js publishes this on window; the page scripts that consume it
  // see it as a bare global.
  PortalForm: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly', matchMedia: 'readonly',
};

const COMMON_RULES = {
  'no-unused-vars': ['error', { args: 'none' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
};

export default [
  {
    ignores: ['node_modules/**', 'test-results/**'],
  },
  {
    // Browser-side shared modules, loaded via plain <script> tags.
    files: ['lang.js', 'form-utils.js', 'photo-upload.js', 'time-off-request.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: COMMON_RULES,
  },
  {
    // Service worker: its own global scope.
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly', caches: 'readonly', fetch: 'readonly',
        console: 'readonly', Response: 'readonly', Request: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
    rules: COMMON_RULES,
  },
  {
    // Cloudflare Worker + Node test suites: ES modules.
    // The test files include page.evaluate() callbacks, whose bodies are
    // serialised and run inside the browser — hence the DOM globals here.
    files: ['worker/**/*.js', 'tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly', fetch: 'readonly', crypto: 'readonly',
        Request: 'readonly', Response: 'readonly', URL: 'readonly',
        AbortController: 'readonly', TextDecoder: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        globalThis: 'readonly', process: 'readonly', Buffer: 'readonly',
        document: 'readonly', navigator: 'readonly', localStorage: 'readonly',
        caches: 'readonly', performance: 'readonly', window: 'readonly',
        DOMException: 'readonly',
      },
    },
    rules: COMMON_RULES,
  },
];
