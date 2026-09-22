// Build script for the VS Code extension bundle and its webviews.
//
// Three independent bundles are produced:
//   out/extension.js         - extension host bundle (node, commonjs, `vscode` external)
//   media/result/main.js     - query result grid webview (browser, iife)
//   media/connection/main.js - connection form webview (browser, iife)
//
// There is no health dashboard bundle: the health report is emitted as Markdown and rendered into a
// read-only editor, which gives selection, search and copy for free.
//
// `--watch` keeps them all rebuilding on change.

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--release') || process.env.NODE_ENV === 'production';

/**
 * Build steps. Webview bundles deliberately target modern browsers only: they are
 * rendered by Electron's bundled Chromium, so there is no need to down-level.
 *
 * @type {import('esbuild').BuildOptions[]}
 */
const targets = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: !production,
    minify: production,
    // Provided by the VS Code runtime, must never be bundled.
    external: ['vscode'],
  },
  {
    entryPoints: ['media/result/main.ts'],
    outfile: 'media/result/main.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: !production,
    minify: production,
  },
  {
    entryPoints: ['media/connection/main.ts'],
    outfile: 'media/connection/main.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    sourcemap: !production,
    minify: production,
  },
];

if (watch) {
  const contexts = await Promise.all(targets.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[esbuild] watching extension + webviews');
} else {
  await Promise.all(targets.map((options) => esbuild.build(options)));
  console.log(`[esbuild] built ${targets.length} bundles${production ? ' (production)' : ''}`);
}
