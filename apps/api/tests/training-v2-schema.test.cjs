const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '../../..');
const schema = readFileSync(resolve(repositoryRoot, 'apps/api/prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260801120000_add_training_v2_stage_1/migration.sql',
  ),
  'utf8',
);
const seed = readFileSync(resolve(repositoryRoot, 'apps/api/src/prisma/seed.ts'), 'utf8');

test('Training V2 Stage 1 adds exactly five Training models', () => {
  const modelNames = [...schema.matchAll(/^model (Training\w+) \{/gmu)].map((match) => match[1]);

  assert.deepEqual(modelNames, [
    'TrainingProject',
    'TrainingQuestion',
    'TrainingAttempt',
    'TrainingAttemptQuestion',
    'TrainingAnswer',
  ]);
});

test('Training schema stores project settings, snapshot and immutable answers', () => {
  assert.match(
    schema,
    /model TrainingProject \{[\s\S]*status\s+TrainingProjectStatus[\s\S]*isOpen\s+Boolean[\s\S]*attemptLimit\s+Int[\s\S]*timeLimitSeconds\s+Int[\s\S]*passScore\s+Int[\s\S]*allowRetakeAfterPass\s+Boolean/,
  );
  assert.match(
    schema,
    /model TrainingAttempt \{[\s\S]*startIdempotencyKey\s+String[\s\S]*projectSnapshotJson\s+Json[\s\S]*fakeEvaluationVersion\s+String[\s\S]*@@unique\(\[userId, projectId, attemptNumber\]\)[\s\S]*@@unique\(\[userId, projectId, startIdempotencyKey\]\)/,
  );
  assert.match(
    schema,
    /model TrainingAttemptQuestion \{[\s\S]*sequence\s+Int[\s\S]*questionTextSnapshot\s+String[\s\S]*maxScore\s+Int[\s\S]*@@unique\(\[attemptId, sequence\]\)[\s\S]*@@unique\(\[attemptId, sourceQuestionId\]\)/,
  );
  assert.match(
    schema,
    /model TrainingAnswer \{[\s\S]*attemptQuestionId\s+String\s+@unique[\s\S]*score\s+Int[\s\S]*fakeOutcome\s+TrainingFakeOutcome[\s\S]*safeBreakdownJson\s+Json/,
  );
});

test('Training migration enforces history and concurrency invariants', () => {
  for (const table of [
    'training_projects',
    'training_questions',
    'training_attempts',
    'training_attempt_questions',
    'training_answers',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }

  assert.match(
    migration,
    /CREATE UNIQUE INDEX "training_attempts_one_in_progress_per_user_project_idx"[\s\S]*WHERE "status" = 'in_progress'/,
  );
  assert.match(migration, /training_projects_open_status_check/);
  assert.match(migration, /training_attempts_state_check/);
  assert.match(migration, /training_attempt_questions_sequence_check/);
  assert.match(
    migration,
    /training_attempts_project_id_fkey[\s\S]*ON DELETE RESTRICT/,
  );
  assert.match(
    migration,
    /training_attempt_questions_source_question_id_fkey[\s\S]*ON DELETE SET NULL/,
  );
});

test('Training permissions are seeded idempotently with the fixed role mapping', () => {
  assert.match(seed, /\['training:participate', 'Participate in training projects'\]/);
  assert.match(seed, /\['training:projects:manage', 'Manage training projects'\]/);
  assert.match(seed, /\['training:results:read', 'Read training attempt results'\]/);
  assert.match(seed, /admin: permissions\.map\(\(\[key\]\) => key\)/);
  assert.match(seed, /user:[\s\S]*'training:participate'/);

  const editorBlock = seed.match(/editor:\s*\[([\s\S]*?)\],\n\s*user:/u)?.[1] ?? '';
  assert.doesNotMatch(editorBlock, /training:/);
});
