import { build } from 'esbuild';
import { mkdir, cp, copyFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'build/web');
const ui = process.env.FORTUI_PATH || resolve(root, '../fortui');
const ink = process.env.FORTINK_PATH || resolve(root, '../fortink');
await mkdir(out, { recursive: true });
await rm(resolve(out, 'chunks'), { recursive: true, force: true });
await copyFile(resolve(ui, 'web/fortui_surface.js'), resolve(out, 'fortui_surface.js'));
await copyFile(resolve(ink, 'web/model.js'), resolve(root, 'build/model.js'));
await build({ entryPoints: [resolve(root, 'web/shell.js')], bundle: true, format: 'esm',
  outdir: out, entryNames: 'shell', chunkNames: 'chunks/[name]-[hash]', splitting: true,
  sourcemap: true, minify: true,
  alias: { 'fortink/model': resolve(ink, 'web/model.js'), 'fortui/surface': resolve(ui, 'web/fortui_surface.js') },
  target: ['safari18.2', 'chrome120', 'firefox130'] });
for (const file of ['index.html', 'shell.css', 'manifest.webmanifest', 'storage-worker.js']) await copyFile(resolve(root, 'web', file), resolve(out, file));
await copyFile(resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), resolve(out, 'pdf.worker.min.mjs'));
const pdfAssets = ['cmaps', 'standard_fonts', 'wasm'];
for (const directory of pdfAssets) {
  await rm(resolve(out, directory), { recursive: true, force: true });
  await cp(resolve(root, 'node_modules/pdfjs-dist', directory), resolve(out, directory), { recursive: true });
}
const files = (await readdir(out, { withFileTypes: true })).filter(x => x.isFile()
  && x.name !== 'sw.js' && !x.name.endsWith('.map')).map(x => x.name);
for (const file of await readdir(resolve(out, 'chunks'))) if (file.endsWith('.js')) files.push('chunks/' + file);
for (const directory of pdfAssets) for (const file of await readdir(resolve(out, directory))) files.push(directory + '/' + file);
await mkdir(resolve(out, 'licenses'), { recursive: true });
for (const [name, file] of [['pdfjs-dist', 'LICENSE'], ['pdf-lib', 'LICENSE.md'], ['perfect-freehand', 'LICENSE']]) {
  await copyFile(resolve(root, 'node_modules', name, file), resolve(out, 'licenses', name + '.txt'));
}
const { readFile } = await import('node:fs/promises');
const hash = createHash('sha256');
// Cached responses retain headers, including the module content type.
hash.update(await readFile(resolve(root, 'deploy/nginx.conf')));
for (const file of files.sort()) hash.update(await readFile(resolve(out, file)));
const version = hash.digest('hex').slice(0, 16);
await writeFile(resolve(out, 'sw.js'), `const CACHE='fortshell-${version}';
const files=${JSON.stringify(files.map(x => './' + x))};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(files)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const previous=(await caches.keys()).filter(k=>k.startsWith('fortshell-')&&k!==CACHE);
  await Promise.all(previous.slice(0,-1).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method==='GET'&&u.origin===location.origin&&!u.pathname.startsWith('/api/'))e.respondWith((async()=>{
  const c=await caches.open(CACHE), hit=await c.match(e.request);if(hit)return hit;
  if(e.request.mode==='navigate'){const home=await c.match(new URL('./index.html',self.registration.scope));if(home)return home;}
  const previous=await caches.match(e.request);if(previous)return previous;
  const response=await fetch(e.request);if(response.ok)await c.put(e.request,response.clone()).catch(()=>{});return response;
})());});
`);
console.log(out);
