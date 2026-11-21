import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// Ink against the Fortran server: saved there, seen by a second device, and
// sent after the network returns. Needs `fo build` and `npm run build:web`.
const binary = resolve('build/fo/bin/fortshell'), web = resolve(process.env.FORTSHELL_WEB || 'build/web');

function freePort() {
  return new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args); let out = '';
    child.stdout.on('data', d => { out += d; }); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`fortshell ${args[0]} exited ${code}`)));
  });
}
async function draw(page, from = 0.2) {
  await page.waitForFunction(() => window.fortshell?.ready && !window.fortshell.busy);
  const box = await page.locator('#active').boundingBox();
  await page.mouse.move(box.x + box.width * from, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (from + 0.4), box.y + box.height * 0.4, { steps: 30 });
  await page.mouse.up();
}
const strokes = page => page.evaluate(() => window.fortshell.module._fs_count());
const status = page => page.locator('#save-status');

let data, server, origin, token;
test.beforeAll(async () => {
  await access(binary);
  data = await mkdtemp(join(tmpdir(), 'fortshell-server-'));
  token = await run(['init', '--data', data]);
  const port = await freePort();
  server = spawn(binary, ['serve', '--data', data, '--web', web, '--listen', `127.0.0.1:${port}`, '--processes', '4'],
    { detached: true, stdio: 'ignore' });
  origin = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});
test.afterAll(async () => {
  if (server) process.kill(-server.pid, 'SIGTERM');
  if (data) await rm(data, { recursive: true, force: true });
});

test('ink is saved on the server, reaches a second device and survives going offline', async ({ browser }) => {
  // The session cookie is Secure. WebKit on Linux keeps no Secure cookie over
  // plain HTTP, while the deployment is HTTPS only.
  test.skip(browser.browserType().name() === 'webkit', 'Secure cookie over plain HTTP');
  const tablet = await browser.newContext({ serviceWorkers: 'allow' }), page = await tablet.newPage();
  await page.goto(`${origin}/#login=${token}`);
  await page.waitForFunction(() => window.fortshell?.ready);
  expect(new URL(page.url()).hash).toBe('');
  await draw(page);
  await page.evaluate(() => window.fortshell.flush());
  await expect(status(page)).toHaveText('Saved', { timeout: 10000 });

  const desk = await browser.newContext({ serviceWorkers: 'allow' }), other = await desk.newPage();
  await other.goto(`${origin}/#login=${token}`);
  await other.waitForFunction(() => window.fortshell?.ready);
  await expect.poll(() => strokes(other)).toBe(await strokes(page));

  // Ink written offline waits in the outbox and arrives once the network returns.
  await tablet.setOffline(true);
  await draw(page, 0.3);
  await page.evaluate(() => window.fortshell.flush());
  await expect(status(page)).toContainText('waiting for the server', { timeout: 10000 });
  await tablet.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(status(page)).toHaveText('Saved', { timeout: 20000 });
  await expect.poll(() => strokes(other), { timeout: 10000 }).toBe(await strokes(page));

  // A browser without a session saves locally and says so.
  const stranger = await browser.newContext(), third = await stranger.newPage();
  await third.goto(origin);
  await third.waitForFunction(() => window.fortshell?.ready);
  await expect(status(third)).toContainText('Sign in', { timeout: 10000 });
  await Promise.all([tablet.close(), desk.close(), stranger.close()]);
});
