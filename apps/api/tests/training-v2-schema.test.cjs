const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '../../..');
const schema = readFileSync(resolve(repositoryRoot, 'apps/api/prisma/schema.prisma'), 'utf8');
const stage1Migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260801120000_add_training_v2_stage_1/migration.sql',
  ),
  'utf8',
);
const stage2Migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260801190000_add_training_v2_stage_2/migration.sql',
  ),
  'utf8',
);
const seed = readFileSync(resolve(repositoryRoot, 'apps/api/src/prisma/seed.ts'), 'utf8');

test('Training V2 Stage 2 has exactly eight Training models', () => {
  const modelNames = [...schema.matchAll(/^model (Training\w+) \{/gmu)].map((match) => match[1]);

  assert.deepEqual(modelNames, [
    'TrainingProject',
    'TrainingQuestion',
    'TrainingAttempt',
    'TrainingAttemptQuestion',
    'TrainingAnswer',
    'TrainingTelegramAccount',
    'TrainingTelegramLinkToken',
    'TrainingAnswerSegment',
  ]);
});

test('Training schema preserves Stage 1 and adds only Stage 2 transport state', () => {
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
    /model TrainingAnswer \{[\s\S]*attemptQuestionId\s+String\s+@unique[\s\S]*source\s+TrainingAnswerSource[\s\S]*processingStatus\s+TrainingAnswerProcessingStatus[\s\S]*text\s+String\?[\s\S]*score\s+Int\?[\s\S]*mergedAudioFileId\s+String\?[\s\S]*processingAttempts\s+Int/,
  );
  assert.match(
    schema,
    /model TrainingTelegramAccount \{[\s\S]*userId\s+String[\s\S]*telegramUserId\s+BigInt[\s\S]*chatId\s+BigInt[\s\S]*revokedAt\s+DateTime\?/,
  );
  assert.match(
    schema,
    /model TrainingTelegramLinkToken \{[\s\S]*userId\s+String[\s\S]*projectId\s+String[\s\S]*tokenHash\s+String\s+@unique[\s\S]*expiresAt\s+DateTime[\s\S]*usedAt\s+DateTime\?/,
  );
  assert.match(
    schema,
    /model TrainingAnswerSegment \{[\s\S]*answerId\s+String[\s\S]*position\s+Int[\s\S]*telegramMessageId\s+BigInt[\s\S]*telegramFileUniqueId\s+String[\s\S]*storedFileId\s+String\?[\s\S]*@@unique\(\[answerId, telegramMessageId\]\)/,
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
    assert.match(stage1Migration, new RegExp(`CREATE TABLE "${table}"`));
  }

  assert.match(
    stage1Migration,
    /CREATE UNIQUE INDEX "training_attempts_one_in_progress_per_user_project_idx"[\s\S]*WHERE "status" = 'in_progress'/,
  );
  assert.match(stage1Migration, /training_projects_open_status_check/);
  assert.match(stage1Migration, /training_attempts_state_check/);
  assert.match(stage1Migration, /training_attempt_questions_sequence_check/);
  assert.match(
    stage1Migration,
    /training_attempts_project_id_fkey[\s\S]*ON DELETE RESTRICT/,
  );
  assert.match(
    stage1Migration,
    /training_attempt_questions_source_question_id_fkey[\s\S]*ON DELETE SET NULL/,
  );
});

test('Stage 2 migration is additive and enforces Telegram/audio invariants', () => {
  for (const table of [
    'training_telegram_accounts',
    'training_telegram_link_tokens',
    'training_answer_segments',
  ]) {
    assert.match(stage2Migration, new RegExp(`CREATE TABLE "${table}"`));
  }

  assert.match(stage2Migration, /ALTER COLUMN "text" DROP NOT NULL/);
  assert.match(stage2Migration, /training_answers_payload_state_check/);
  assert.match(stage2Migration, /training_telegram_accounts_active_user_idx[\s\S]*WHERE "revoked_at" IS NULL/);
  assert.match(stage2Migration, /training_telegram_accounts_active_telegram_user_idx[\s\S]*WHERE "revoked_at" IS NULL/);
  assert.match(stage2Migration, /training_answer_segments_answer_id_telegram_message_id_key/);
  assert.match(stage2Migration, /training_answer_segments_answer_id_telegram_file_unique_id_key/);
  assert.match(stage2Migration, /training_answers_merged_audio_file_id_fkey[\s\S]*ON DELETE RESTRICT/);
  assert.doesNotMatch(stage2Migration, /DROP TABLE|DROP TYPE|DELETE FROM|TRUNCATE/);
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
