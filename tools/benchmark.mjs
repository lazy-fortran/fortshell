import { chromium, webkit } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';

const destination = resolve(process.argv[2] || 'build/benchmarks');
const url = process.env.FORTSHELL_URL || 'http://127.0.0.1:4178';
await mkdir(destination, { recursive: true });
for (const [name, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch({ headless: true, ...(name === 'chromium'
    ? { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => window.fortshell?.ready);
    await page.locator('#compare-toggle').click(); await page.locator('#benchmark').click();
    await page.waitForFunction(() => !document.getElementById('results-download').disabled, {}, { timeout: 120000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#results-download').click()]);
    const report = JSON.parse(await readFile(await download.path(), 'utf8'));
    report.automation = { browser: name, version: browser.version(), cpu: cpus()[0].model,
      system: `${platform()} ${release()}`, page_errors: errors };
    await writeFile(resolve(destination, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(name, await page.locator('#metrics').textContent());
  } finally { await browser.close(); }
}
