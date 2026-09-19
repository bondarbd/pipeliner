import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const files = [
  ['node_modules/vue/dist/vue.global.prod.js', 'public/vendor/vue.global.prod.js'],
  ['node_modules/@picocss/pico/css/pico.min.css', 'public/vendor/pico.min.css'],
];
fs.mkdirSync(path.join(root, 'public/vendor'), { recursive: true });
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) { console.warn(`vendor: ${from} missing, skipped`); continue; }
  fs.copyFileSync(src, path.join(root, to));
}
