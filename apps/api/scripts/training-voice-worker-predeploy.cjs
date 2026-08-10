const { Prisma, PrismaClient } = require('@prisma/client');

const CONFIRM_ACTIVE_ARGUMENT = '--confirm-active';

async function inspectActiveClaims(prisma) {
  const [summary] = await prisma.$queryRaw(Prisma.sql`
    SELECT
      COUNT(*)::bigint AS "activeClaims",
      EXTRACT(
        EPOCH FROM CURRENT_TIMESTAMP - MIN(COALESCE(answer."submitted_at", answer."created_at"))
      )::double precision AS "oldestActiveAgeSeconds"
    FROM "training_answers" AS answer
    WHERE answer."processing_status" = 'processing'
      AND answer."processing_locked_by" IS NOT NULL
  `);

  return {
    activeClaims: Number(summary?.activeClaims ?? 0),
    oldestActiveAgeSeconds: summary?.oldestActiveAgeSeconds === null
      ? null
      : Math.max(0, Math.floor(Number(summary?.oldestActiveAgeSeconds ?? 0))),
  };
}

function parseArguments(argumentsList) {
  const unknown = argumentsList.filter((argument) => argument !== CONFIRM_ACTIVE_ARGUMENT);

  if (unknown.length > 0) {
    throw new Error('UNSUPPORTED_ARGUMENT');
  }

  return { confirmActive: argumentsList.includes(CONFIRM_ACTIVE_ARGUMENT) };
}

async function main() {
  const { confirmActive } = parseArguments(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const active = await inspectActiveClaims(prisma);
    const report = {
      event: 'training_voice_worker_predeploy',
      ...active,
      activeDeployConfirmed: active.activeClaims > 0 && confirmActive,
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);

    if (active.activeClaims > 0 && !confirmActive) {
      process.stderr.write(
        'Voice worker deploy blocked: active claims exist. Re-run with --confirm-active only after an explicit operator decision.\n',
      );
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = typeof error?.code === 'string'
      ? error.code.replace(/[^A-Z0-9_]/giu, '_').slice(0, 64)
      : error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message)
        ? error.message
        : 'UNEXPECTED_ERROR';
    process.stderr.write(`Voice worker pre-deploy check failed: ${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = { inspectActiveClaims, parseArguments };
