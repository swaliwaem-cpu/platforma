const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../..');
const composeFile = path.join(
  repositoryRoot,
  'docker-compose.training-audio-test.yml',
);
const projectName = `platforma-training-audio-${randomUUID()
  .replaceAll('-', '')
  .slice(0, 12)}`;

let currentChild = null;
let cleanupPromise = null;
let receivedSignal = null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    receivedSignal = signal;
    if (currentChild && !currentChild.killed) {
      currentChild.kill(signal);
    }
    void cleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  });
}

void main();

async function main() {
  let exitCode = 0;
  try {
    await runDockerCompose([
      'up',
      '--build',
      '--abort-on-container-exit',
      '--exit-code-from',
      'audio-tests',
    ]);
  } catch (error) {
    exitCode = 1;
    console.error(toSafeMessage(error));
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      exitCode = 1;
      console.error(
        `Training audio Docker cleanup failed: ${toSafeMessage(
          cleanupError,
        )}`,
      );
    }
  }
  if (!receivedSignal) process.exitCode = exitCode;
}

function runDockerCompose(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '--project-name',
        projectName,
        '--file',
        composeFile,
        ...args,
      ],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
      },
    );
    currentChild = child;
    child.once('error', (error) => {
      currentChild = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      currentChild = null;
      if (code === 0 || options.ignoreFailure) {
        resolve();
        return;
      }
      reject(
        new Error(
          `docker compose ${args.join(' ')} exited with ${
            signal ? `signal ${signal}` : `code ${code}`
          }`,
        ),
      );
    });
  });
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = runDockerCompose(
    ['down', '--volumes', '--remove-orphans', '--timeout', '5'],
    { ignoreFailure: true },
  );
  return cleanupPromise;
}

function toSafeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 2_000);
}

