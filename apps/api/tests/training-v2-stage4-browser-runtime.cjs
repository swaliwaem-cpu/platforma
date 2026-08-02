require('reflect-metadata');

const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

const {
  extractSemanticHtml,
  installTrainingBrowserGuards,
} = require('../dist/training/training-url-extractor.js');

async function main() {
  const executablePath = process.env.TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH;
  assert.ok(executablePath, 'TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH is required');

  const browser = await chromium.launch({ headless: true, executablePath });
  let context;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      permissions: [],
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const initialUrl = new URL('https://fixture.test/page');
    const requests = [];
    const failed = [];
    context.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
    context.on('requestfailed', (request) => failed.push(`${request.method()} ${request.url()}`));
    await installTrainingBrowserGuards(
      context,
      page,
      initialUrl,
      async () => ['93.184.216.34'],
    );
    await page.setContent(`
      <main><h1>JS fixture</h1><p id="content">before render</p></main>
      <iframe name="unsafe-target"></iframe>
      <form id="unsafe-form" action="https://fixture.test/page" method="post" target="unsafe-target">
        <input name="unsafe" value="1">
      </form>
      <script>
        document.querySelector('#content').textContent = 'Rendered stable training content';
        window.open('https://fixture.test/page', '_blank');
        document.querySelector('#unsafe-form').submit();
        fetch('https://analytics.test/collect').catch(() => undefined);
      </script>
    `);
    await page.waitForTimeout(300);

    const html = await page.content();
    const segments = extractSemanticHtml(html);
    assert.match(segments.map((segment) => segment.text).join('\n'), /Rendered stable training content/u);
    assert.ok(requests.includes('POST https://fixture.test/page'));
    assert.ok(requests.includes('GET https://analytics.test/collect'));
    assert.ok(failed.includes('POST https://fixture.test/page'));
    assert.ok(failed.includes('GET https://analytics.test/collect'));
    assert.equal(context.pages().length, 1, 'popup must be closed');
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close();
  }
  assert.equal(browser.isConnected(), false, 'browser process must be closed');
  process.stdout.write('STAGE4_BROWSER_RUNTIME_OK\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
