const { spawn } = require('node:child_process');
const path = require('node:path');

const {
  createSafeTrainingTestEnvironment,
} = require('../apps/api/scripts/training-test-environment.cjs');

const rootDir = path.resolve(__dirname, '..');
const environment = createSafeTrainingTestEnvironment({
  ...process.env,
  TRAINING_MODULE_ENABLED: 'true',
  TELEGRAM_TRANSPORT_MODE: 'fake',
  OPENAI_PROVIDER_MODE: 'fake',
});

const gates = [
  ['pnpm', ['--filter', '@platforma/api', 'test']],
  ['pnpm', ['--filter', '@platforma/api', 'test:training:audio:docker']],
  ['pnpm', ['--filter', '@platforma/web', 'test:training:browser']],
];

void run().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Training E2E failed',
  );
  process.exitCode = 1;
});

async function run() {
  for (const [command, args] of gates) {
    await runCommand(command, args);
  }
  console.log(
    'Training stage 10 E2E passed: PostgreSQL/API, MinIO/ffmpeg and browser gates.',
  );
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            signal ? `signal ${signal}` : `code ${code}`
          }`,
        ),
      );
    });
  });
}
