const fs = require('node:fs');
fs.mkdirSync('vendor', { recursive: true });
for (const [source, target] of [
  ['node_modules/marked/marked.min.js', 'vendor/marked.min.js'],
  ['node_modules/marked/LICENSE.md', 'vendor/marked-LICENSE.md'],
  ['node_modules/dompurify/dist/purify.min.js', 'vendor/purify.min.js'],
  ['node_modules/dompurify/LICENSE', 'vendor/dompurify-LICENSE']
]) fs.copyFileSync(source, target);
