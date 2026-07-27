const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const { PrismaClient } = require('@prisma/client');

const apiDir = path.resolve(__dirname, '..');
const allowedLocalHosts = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'host.docker.internal',
]);
const productionLikePattern = /(?:^|[._-])(prod|production|live|primary)(?:$|[._-])/iu;
const baseDatabaseUrl = process.env.DATABASE_URL;

if (!baseDatabaseUrl) {
  throw new Error(
    'DATABASE_URL is required to create an isolated training test database',
  );
}

const parsedBaseUrl = parseAndValidateBaseUrl(baseDatabaseUrl);
const temporaryDatabaseName = createTemporaryDatabaseName();
const temporaryDatabaseUrl = new URL(parsedBaseUrl);
temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
temporaryDatabaseUrl.searchParams.delete('schema');

const adminPrisma = new PrismaClient({
  datasources: {
    db: {
      url: parsedBaseUrl.toString(),
    },
  },
});

let currentChild = null;
let cleanupRequired = false;
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
    console.log(
      `Creating isolated PostgreSQL database ${temporaryDatabaseName} on ${parsedBaseUrl.hostname}`,
    );
    cleanupRequired = true;
    await adminPrisma.$executeRawUnsafe(
      `CREATE DATABASE "${temporaryDatabaseName}"`,
    );

    await runChild('pnpm', [
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--schema',
      'prisma/schema.prisma',
    ]);
    await runChild('node', [
      '--test',
      '--test-concurrency=1',
      'tests/training-attempt-db.integration.cjs',
      'tests/training-audio-db.integration.cjs',
      'tests/training-audio-http.integration.cjs',
      'tests/training-telegram-db.integration.cjs',
    ]);
  } catch (error) {
    exitCode = 1;
    console.error(toSafeMessage(error));
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      exitCode = 1;
      console.error(`Training test database cleanup failed: ${toSafeMessage(cleanupError)}`);
    }
  }

  if (!receivedSignal) {
    process.exitCode = exitCode;
  }
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: temporaryDatabaseUrl.toString(),
      },
      stdio: 'inherit',
    });
    currentChild = child;

    child.once('error', (error) => {
      currentChild = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      currentChild = null;
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            signal ? `signal ${signal}` : `code ${code}`
          }`,
        ),
      );
    });
  });
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = (async () => {
    if (!cleanupRequired) {
      await adminPrisma.$disconnect();
      return;
    }

    await adminPrisma.$queryRawUnsafe(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      temporaryDatabaseName,
    );
    await adminPrisma.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${temporaryDatabaseName}"`,
    );
    cleanupRequired = false;
    await adminPrisma.$disconnect();
    console.log(`Dropped isolated PostgreSQL database ${temporaryDatabaseName}`);
  })();

  return cleanupPromise;
}

function parseAndValidateBaseUrl(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }

  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }
  if (!allowedLocalHosts.has(parsed.hostname.toLocaleLowerCase('en-US'))) {
    throw new Error(
      `Refusing training DB tests against non-local PostgreSQL host ${parsed.hostname}`,
    );
  }
  if (parsed.hostname === 'postgres' && !existsSync('/.dockerenv')) {
    throw new Error(
      'Refusing the Docker-only PostgreSQL hostname outside a container',
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const productionLikeParts = [
    parsed.hostname,
    databaseName,
    parsed.username,
  ];
  if (
    productionLikeParts.some((value) => productionLikePattern.test(value)) ||
    ['require', 'verify-ca', 'verify-full'].includes(
      parsed.searchParams.get('sslmode'),
    )
  ) {
    throw new Error('Refusing training DB tests against a production-like URL');
  }
  if (!databaseName) {
    throw new Error('DATABASE_URL must include a base database name');
  }

  return parsed;
}

function createTemporaryDatabaseName() {
  const timestamp = Date.now().toString(36);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return `platforma_training_test_${timestamp}_${suffix}`.slice(0, 63);
}

function toSafeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(baseDatabaseUrl, '[DATABASE_URL]')
    .replaceAll(temporaryDatabaseUrl.toString(), '[TEMP_DATABASE_URL]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 2_000);
}
