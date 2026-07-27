const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const {
  createSafeTrainingTestEnvironment,
} = require('./training-test-environment.cjs');

const apiDir = path.resolve(__dirname, '..');
const tests = readdirSync(path.join(apiDir, 'tests'))
  .filter((name) => name.endsWith('.test.cjs'))
  .sort()
  .map((name) => path.join('tests', name));
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: apiDir,
  env: createSafeTrainingTestEnvironment(process.env),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
