require('reflect-metadata');

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  TRAINING_MODULE_ENABLED_ENV,
  TrainingConfigService,
  parseTrainingModuleEnabled,
} = require('../dist/training/training.config.js');
const { TrainingController } = require('../dist/training/training.controller.js');
const {
  TRAINING_ADMIN_PERMISSION_KEYS,
  TRAINING_PERMISSION_DEFINITIONS,
  TRAINING_PILOT_PERMISSION_KEYS,
} = require('../dist/training/training.permissions.js');

const rootDir = resolve(__dirname, '../../..');
const appModuleSource = readFileSync(resolve(rootDir, 'apps/api/src/app.module.ts'), 'utf8');
const seedSource = readFileSync(resolve(rootDir, 'apps/api/src/prisma/seed.ts'), 'utf8');
const sharedIndexSource = readFileSync(resolve(rootDir, 'packages/shared/src/index.ts'), 'utf8');
const sharedTrainingSource = readFileSync(resolve(rootDir, 'packages/shared/src/training.ts'), 'utf8');

const expectedTrainingPermissionKeys = [
  'training:take',
  'training:own-results:read',
  'training:projects:read',
  'training:projects:manage',
  'training:results:read',
  'training:results:review',
  'training:attempts:reset',
  'training:audio:read',
  'training:ranking:read',
  'training:telegram:manage',
  'training:operations:read',
  'training:operations:manage',
  'training:data:delete',
];

test('training feature flag parsing is strict and disabled by default', () => {
  assert.equal(parseTrainingModuleEnabled(undefined), false);
  assert.equal(parseTrainingModuleEnabled(''), false);
  assert.equal(parseTrainingModuleEnabled(' true '), true);
  assert.equal(parseTrainingModuleEnabled('FALSE'), false);
  assert.throws(
    () => parseTrainingModuleEnabled('1'),
    /TRAINING_MODULE_ENABLED must be "true" or "false"/,
  );
});

test('TrainingConfigService exposes the validated feature flag state', () => {
  const previousValue = process.env[TRAINING_MODULE_ENABLED_ENV];

  try {
    process.env[TRAINING_MODULE_ENABLED_ENV] = 'true';
    const config = new TrainingConfigService();
    assert.deepEqual(config.getConfig(), {
      enabled: true,
      status: 'enabled',
    });

    process.env[TRAINING_MODULE_ENABLED_ENV] = 'false';
    assert.deepEqual(config.getConfig(), {
      enabled: false,
      status: 'disabled',
    });
  } finally {
    if (previousValue === undefined) {
      delete process.env[TRAINING_MODULE_ENABLED_ENV];
    } else {
      process.env[TRAINING_MODULE_ENABLED_ENV] = previousValue;
    }
  }
});

test('TrainingController exposes only a permission-protected config shell', () => {
  const response = { enabled: true, status: 'enabled' };
  const controller = new TrainingController({
    getConfig: () => response,
  });

  assert.deepEqual(controller.getConfig(), response);
  assert.deepEqual(
    Reflect.getMetadata(PERMISSIONS_KEY, TrainingController.prototype.getConfig),
    ['training:take'],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingController.prototype.getAdminConfig,
    ),
    ['training:projects:manage'],
  );
  assert.deepEqual(controller.getAdminConfig(), response);

  const controllerSource = readFileSync(
    resolve(rootDir, 'apps/api/src/training/training.controller.ts'),
    'utf8',
  );
  assert.match(controllerSource, /@Controller\('training'\)/);
  assert.match(controllerSource, /@UseGuards\(JwtAuthGuard, PermissionsGuard\)/);
  assert.match(controllerSource, /@Get\('config'\)/);
  assert.match(controllerSource, /@Get\('admin\/config'\)/);
  assert.doesNotMatch(controllerSource, /@(Post|Patch|Put|Delete)\(/);
});

test('training permission contracts match the approved role matrix', () => {
  assert.deepEqual(
    TRAINING_PERMISSION_DEFINITIONS.map(([key]) => key),
    expectedTrainingPermissionKeys,
  );
  assert.deepEqual(TRAINING_PILOT_PERMISSION_KEYS, [
    'training:take',
    'training:own-results:read',
  ]);
  assert.deepEqual(
    TRAINING_ADMIN_PERMISSION_KEYS,
    expectedTrainingPermissionKeys.filter(
      (key) =>
        ![
          'training:take',
          'training:own-results:read',
          'training:data:delete',
        ].includes(key),
    ),
  );
  assert.equal(TRAINING_ADMIN_PERMISSION_KEYS.includes('training:take'), false);
  assert.equal(
    TRAINING_ADMIN_PERMISSION_KEYS.includes('training:own-results:read'),
    false,
  );
  assert.equal(TRAINING_ADMIN_PERMISSION_KEYS.includes('training:data:delete'), false);

  assert.match(seedSource, /\.\.\.TRAINING_PERMISSION_DEFINITIONS/);
  assert.match(
    seedSource,
    /training_admin:\s*\['admin:access', \.\.\.TRAINING_ADMIN_PERMISSION_KEYS\]/,
  );
  assert.match(seedSource, /user:\s*BASE_USER_PERMISSION_KEYS/);
  assert.match(
    seedSource,
    /training_pilot:\s*\[[\s\S]*\.\.\.BASE_USER_PERMISSION_KEYS,[\s\S]*\.\.\.TRAINING_PILOT_PERMISSION_KEYS/,
  );
  assert.match(seedSource, /rolePermission\.deleteMany/);
  assert.match(seedSource, /rolePermission\.createMany/);

  const editorPermissions =
    seedSource.match(/editor:\s*\[([\s\S]*?)\],\s*user:/)?.[1] ?? '';
  assert.doesNotMatch(editorPermissions, /training:/);
});

test('TrainingModule and shared config contracts are wired into the monorepo', () => {
  assert.match(appModuleSource, /import \{ TrainingModule \} from '\.\/training\/training\.module';/);
  assert.match(appModuleSource, /imports:\s*\[[\s\S]*TrainingModule/);
  assert.match(sharedIndexSource, /export \* from '\.\/training\.js';/);
  assert.match(sharedTrainingSource, /export type TrainingModuleStatus = 'enabled' \| 'disabled';/);
  assert.match(
    sharedTrainingSource,
    /export type TrainingModuleConfigResponse = \{[\s\S]*enabled: boolean;[\s\S]*status: TrainingModuleStatus;/,
  );
});
