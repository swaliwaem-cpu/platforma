const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const rootDir = resolve(__dirname, '../../..');
const packagePath = resolve(rootDir, 'package.json');
const feedImportPackagePath = resolve(rootDir, 'tools/feed-import/package.json');
const fixtureDir = resolve(rootDir, 'tools/feed-import/tests/fixtures');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('feed import workspace package exposes first-stage scripts and XML parser dependency', () => {
  assert.equal(existsSync(feedImportPackagePath), true);

  const rootPackage = readJson(packagePath);
  const feedImportPackage = readJson(feedImportPackagePath);

  assert.equal(rootPackage.scripts['feed-import:preview'], 'pnpm --filter @platforma/feed-import run preview');
  assert.equal(rootPackage.scripts['feed-import:run'], 'pnpm --filter @platforma/feed-import run run');
  assert.equal(feedImportPackage.name, '@platforma/feed-import');
  assert.equal(feedImportPackage.private, true);
  assert.equal(feedImportPackage.scripts.build, 'pnpm --filter @platforma/api prisma:generate && tsc -p tsconfig.json');
  assert.equal(feedImportPackage.scripts.analyze, 'pnpm build && node dist/index.js analyze');
  assert.equal(feedImportPackage.scripts.preview, 'pnpm build && node dist/index.js preview');
  assert.equal(feedImportPackage.scripts.run, 'pnpm build && node dist/index.js run');
  assert.equal(feedImportPackage.scripts.test, 'pnpm build && node --test tests/*.test.cjs');
  assert.equal(feedImportPackage.dependencies['@prisma/client'], '6.19.3');
  assert.equal(feedImportPackage.dependencies['fast-xml-parser'], '^5.3.2');
  assert.equal(feedImportPackage.dependencies.sharp, '^0.34.5');
});

test('feed import package keeps source feed fixtures close to parser tests', () => {
  const yandexFixture = resolve(fixtureDir, 'yandex.xml');
  const cianFixture = resolve(fixtureDir, 'MNF_Cian_5827_.xml');
  const tektaFixture = resolve(fixtureDir, 'tekta.xml');

  assert.equal(existsSync(yandexFixture), true);
  assert.equal(existsSync(cianFixture), true);
  assert.equal(existsSync(tektaFixture), true);
  assert.match(readFileSync(yandexFixture, 'utf8'), /<realty-feed\b/);
  assert.match(readFileSync(cianFixture, 'utf8'), /<feed>/);
  assert.match(readFileSync(tektaFixture, 'utf8'), /<projects>\s*<project>/);
});
