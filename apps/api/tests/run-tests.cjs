const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const testsDirectory = resolve(__dirname);
const testFiles = readdirSync(testsDirectory)
  .filter((name) => name.endsWith('.test.cjs'))
  .sort()
  .map((name) => resolve(testsDirectory, name));
const environment = { ...process.env };

environment.NODE_ENV = 'test';
environment.TRAINING_AI_MODE = 'fake';
environment.TELEGRAM_TRANSPORT_MODE = 'fake';
delete environment.OPENAI_API_KEY;

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: resolve(__dirname, '..'),
  env: environment,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
