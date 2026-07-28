const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const {
  createSafeTrainingTestEnvironment,
} = require('../apps/api/scripts/training-test-environment.cjs');

const rootDir = path.resolve(__dirname, '..');
const composeFile = path.join(
  rootDir,
  'docker-compose.training-full-chain.yml',
);
const projectName = `platforma-training-e2e-${randomUUID()
  .replaceAll('-', '')
  .slice(0, 12)}`;
let currentChild = null;
let cleanupPromise = null;
let activeEnvironment = process.env;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (currentChild && !currentChild.killed) currentChild.kill(signal);
    void cleanup(activeEnvironment).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  });
}

void run().catch((error) => {
  console.error(toSafeMessage(error));
  process.exitCode = 1;
});

async function run() {
  const [postgresPort, minioPort, apiPort, webPort] =
    await Promise.all([
      findFreePort(),
      findFreePort(),
      findFreePort(),
      findFreePort(),
    ]);
  const environment = createSafeTrainingTestEnvironment({
    ...process.env,
    NODE_ENV: 'test',
    DEPLOYMENT_ENV: 'development',
    TRAINING_MODULE_ENABLED: 'true',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    TELEGRAM_BOT_USERNAME: 'platforma_training_e2e_bot',
    OPENAI_PROVIDER_MODE: 'fake',
    DATABASE_URL:
      `postgresql://training_full_chain:training_full_chain_password@127.0.0.1:${postgresPort}/training_full_chain?schema=public`,
    S3_ENDPOINT: `http://127.0.0.1:${minioPort}`,
    S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${minioPort}`,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'training_full_chain',
    S3_SECRET_ACCESS_KEY: 'training_full_chain_password',
    MINIO_BUCKET: 'training-full-chain-general',
    TRAINING_DOCUMENT_BUCKET: 'training-full-chain-documents',
    TRAINING_AUDIO_BUCKET: 'training-full-chain-audio',
    TRAINING_AUDIO_WORKER_POLL_MS: '50',
    TRAINING_AUDIO_WORKER_CONCURRENCY: '1',
    TRAINING_AUDIO_WORKER_LEASE_MS: '30000',
    TRAINING_AUDIO_WORKER_HEARTBEAT_MS: '1000',
    TRAINING_AUDIO_WORKER_DRAIN_TIMEOUT_MS: '5000',
    JWT_ACCESS_SECRET: 'training-full-chain-access-secret',
    JWT_REFRESH_SECRET: 'training-full-chain-refresh-secret',
    PORT: String(apiPort),
    WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
    VITE_API_URL: `http://127.0.0.1:${apiPort}`,
    TRAINING_E2E_POSTGRES_PORT: String(postgresPort),
    TRAINING_E2E_MINIO_PORT: String(minioPort),
    TRAINING_E2E_API_PORT: String(apiPort),
    TRAINING_E2E_WEB_PORT: String(webPort),
    TRAINING_E2E_ADMIN_EMAIL: 'training-e2e-admin@example.test',
    TRAINING_E2E_ADMIN_PASSWORD: 'TrainingE2E!1',
  });
  activeEnvironment = environment;

  try {
    await runCompose(environment, ['build', 'training-worker']);
    await runCompose(environment, [
      'up',
      '-d',
      '--wait',
      'postgres',
      'minio',
    ]);
    await runCommand(
      'pnpm',
      ['--filter', '@platforma/api', 'build'],
      environment,
    );
    await runCommand(
      'pnpm',
      ['--filter', '@platforma/web', 'build'],
      environment,
    );
    await runCommand(
      'pnpm',
      ['--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'deploy'],
      environment,
    );
    await runCommand(
      process.execPath,
      ['apps/api/dist/prisma/seed.js'],
      {
        ...environment,
        ADMIN_EMAIL: environment.TRAINING_E2E_ADMIN_EMAIL,
        ADMIN_NAME: 'Training E2E Admin',
        ADMIN_PASSWORD: environment.TRAINING_E2E_ADMIN_PASSWORD,
      },
    );
    await runCompose(environment, ['up', '-d', 'training-worker']);
    await runCommand(
      process.execPath,
      ['apps/api/tests/training-full-chain.e2e.cjs'],
      environment,
    );
    console.log(
      'Training full-chain E2E passed: one PostgreSQL/Telegram/MinIO/ffmpeg/fake-provider/review/UI/CSV chain.',
    );
  } finally {
    await cleanup(environment);
  }
}

function runCompose(environment, args, ignoreFailure = false) {
  return runCommand(
    'docker',
    [
      'compose',
      '--project-name',
      projectName,
      '--file',
      composeFile,
      ...args,
    ],
    environment,
    ignoreFailure,
  );
}

function runCommand(
  command,
  args,
  environment,
  ignoreFailure = false,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: environment,
      stdio: 'inherit',
    });
    currentChild = child;
    child.once('error', (error) => {
      currentChild = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      currentChild = null;
      if (code === 0 || ignoreFailure) {
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

function cleanup(environment = process.env) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = runCompose(
    environment,
    ['down', '--volumes', '--remove-orphans', '--timeout', '5'],
    true,
  );
  return cleanupPromise;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local E2E port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function toSafeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 2_000);
}
