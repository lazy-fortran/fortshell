import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';

const destination = resolve(process.argv[2] || 'build/benchmarks/live');
const url = process.env.FORTSHELL_URL || 'http://127.0.0.1:4178';
await mkdir(destination, { recursive: true });
for (const [name, type] of Object.entries({ chromium, webkit })) {
  const browser = await type.launch({ headless: true, ...(name === 'chromium'
    ? { args: ['--enable-unsafe-webgpu', '--use-angle=metal'] } : {}) });
  const measurements = [];
  try {
    for (const renderer of ['canvas', 'webgl', 'webgpu']) {
      // Reverse paired order to expose warm-up and order effects.
      for (const scheduling of ['frame', 'immediate', 'immediate', 'frame']) {
        const engines = scheduling === 'frame' ? ['wasm', 'js'] : ['js', 'wasm'];
        for (const engine of engines) {
          const context = await browser.newContext({ serviceWorkers: 'block' });
          try {
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(url); await page.waitForFunction(() => window.fortshell?.ready);
            await page.locator('#compare-toggle').click();
            await page.locator('#engine').selectOption(engine);
            await page.locator('#scheduling').selectOption(scheduling);
            await page.locator('#renderer').selectOption(renderer);
            await page.waitForFunction(() => !window.fortshell.busy);
            if (await page.locator('#error').isVisible()) {
              const reason = await page.locator('#error').textContent();
              if (!/unavailable|No WebGPU adapter/.test(reason)) throw new Error(reason);
              measurements.push({ renderer, engine, scheduling, status: 'unavailable', reason });
              console.log(`${name} ${renderer}: ${reason}`);
              break;
            }
            await page.locator('#latency-toggle').click();
            const box = await page.locator('#active').boundingBox();
            await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.3);
            await page.mouse.down();
            for (let segment = 0; segment < 4; segment++) {
              await page.mouse.move(box.x + box.width * (segment % 2 ? 0.1 : 0.9),
                box.y + box.height * (0.35 + segment * 0.1), { steps: 24 });
            }
            await page.mouse.up();
            await page.locator('#latency-toggle').click();
            const report = await page.evaluate(() => window.fortshell.latencyReport());
            if (errors.length) throw new Error(errors.join('\n'));
            if (!report.retained_batches) throw new Error('No live input measured');
            measurements.push({ renderer, engine, scheduling, status: 'measured', report });
            const result = report.pipelines[0];
            const duration = value => value === 0 ? `<${report.timer_quantum_ms ?? '?'}ms` : `${value.toFixed(3)}ms`;
            console.log(`${name} ${result.pipeline}: callback-to-submit p95 ${duration(result.callback_to_submit_ms.p95_ms)}, input ${duration(result.input_ms.p95_ms)}, wait ${duration(result.wait_to_draw_ms.p95_ms)}, draw ${duration(result.draw_submit_ms.p95_ms)}`);
          } finally { await context.close(); }
        }
      }
    }
    await writeFile(resolve(destination, `${name}.json`), JSON.stringify({
      browser: name, version: browser.version(), cpu: cpus()[0].model,
      system: `${platform()} ${release()}`, source: 'Automated mouse input through the application pointer surface. No physical pen or display measurement.',
      measurements,
    }, null, 2) + '\n');
  } finally { await browser.close(); }
}
