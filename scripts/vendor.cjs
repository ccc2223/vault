const fs = require('node:fs');
const { buildSync } = require('esbuild');
fs.mkdirSync('vendor', { recursive: true });
for (const [source, target] of [
  ['node_modules/marked/marked.min.js', 'vendor/marked.min.js'],
  ['node_modules/marked/LICENSE.md', 'vendor/marked-LICENSE.md'],
  ['node_modules/dompurify/dist/purify.min.js', 'vendor/purify.min.js'],
  ['node_modules/dompurify/LICENSE', 'vendor/dompurify-LICENSE'],
  ['node_modules/@codemirror/view/LICENSE', 'vendor/codemirror-LICENSE']
]) fs.copyFileSync(source, target);
// CodeMirror ships as ES modules; bundle the pieces the editor uses into one classic script.
buildSync({
  entryPoints: ['scripts/codemirror.mjs'], outfile: 'vendor/codemirror.min.js',
  bundle: true, minify: true, format: 'iife', globalName: 'CM', target: 'es2020', legalComments: 'none',
  banner: { js: '/* CodeMirror 6 and Lezer (MIT, Marijn Haverbeke and others): see codemirror-LICENSE */' }
});
