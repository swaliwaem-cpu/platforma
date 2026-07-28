const { spawnSync } = require('node:child_process');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const apiDir = path.join(rootDir, 'apps/api');
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (process.cwd() !== rootDir) {
  throw new Error('Training staging commands must run from the repository root');
}
if (process.env.DEPLOYMENT_ENV?.trim().toLowerCase() !== 'staging') {
  throw new Error(
    'Training staging commands require DEPLOYMENT_ENV=staging from .env.staging',
  );
}

require('../apps/api/dist/training/training-deployment-preflight.js');

if (command === 'preflight' && commandArgs.length === 0) {
  console.log('Training staging deployment preflight passed');
  process.exit(0);
}

if (command !== 'prisma' || !isAllowedPrismaCommand(commandArgs)) {
  throw new Error(
    'Allowed commands: preflight, prisma validate, prisma migrate status, prisma migrate deploy',
  );
}

const prismaCli = require.resolve('prisma/build/index.js', {
  paths: [apiDir],
});
const child = spawnSync(
  process.execPath,
  [
    prismaCli,
    ...commandArgs,
    '--schema',
    path.join(apiDir, 'prisma/schema.prisma'),
  ],
  {
    cwd: apiDir,
    env: process.env,
    stdio: 'inherit',
  },
);
if (child.error) throw child.error;
process.exit(child.status ?? 1);

function isAllowedPrismaCommand(args) {
  return (
    (args.length === 1 && args[0] === 'validate') ||
    (args.length === 2 &&
      args[0] === 'migrate' &&
      (args[1] === 'status' || args[1] === 'deploy'))
  );
}
