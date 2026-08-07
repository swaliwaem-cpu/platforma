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
const stage3Migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260802090000_add_training_v2_stage_3/migration.sql',
  ),
  'utf8',
);
const stage3EnumMigration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260802083000_add_training_v2_stage_3_enum_values/migration.sql',
  ),
  'utf8',
);
const stage4Migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260802150000_add_training_v2_stage_4_materials/migration.sql',
  ),
  'utf8',
);
const knowledgeMigration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260805120000_add_training_project_knowledge/migration.sql',
  ),
  'utf8',
);
const sharedArtifactMigration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260807140000_add_training_question_generation_artifacts/migration.sql',
  ),
  'utf8',
);
const rootEnvironmentExample = readFileSync(resolve(repositoryRoot, '.env.example'), 'utf8');
const apiEnvironmentExample = readFileSync(
  resolve(repositoryRoot, 'apps/api/.env.example'),
  'utf8',
);
const compose = readFileSync(resolve(repositoryRoot, 'docker-compose.yml'), 'utf8');
const seed = readFileSync(resolve(repositoryRoot, 'apps/api/src/prisma/seed.ts'), 'utf8');

test('Training V2 preserves Stage 4 models and adds the accepted assignment layer', () => {
  const modelNames = [...schema.matchAll(/^model (Training\w+) \{/gmu)].map((match) => match[1]);

  assert.deepEqual(modelNames, [
    'TrainingProject',
    'TrainingProjectKnowledgeVersion',
    'TrainingQuestionGenerationArtifact',
    'TrainingProjectAssignment',
    'TrainingQuestion',
    'TrainingFact',
    'TrainingMaterial',
    'TrainingMaterialRevision',
    'TrainingCriterion',
    'TrainingAttempt',
    'TrainingAttemptQuestion',
    'TrainingAnswer',
    'TrainingTelegramAccount',
    'TrainingTelegramLinkToken',
    'TrainingAnswerSegment',
  ]);
});

test('shared question artifact migration is additive, indexed and project-independent', () => {
  assert.match(
    sharedArtifactMigration,
    /CREATE TABLE "training_question_generation_artifacts"/u,
  );
  assert.match(
    sharedArtifactMigration,
    /UNIQUE INDEX[\s\S]*"real_estate_object_id", "generation_key_hash"/u,
  );
  assert.match(
    sharedArtifactMigration,
    /real_estate_object_id_fkey[\s\S]*ON DELETE CASCADE/u,
  );
  assert.match(
    sharedArtifactMigration,
    /generation_artifact_id_fkey[\s\S]*ON DELETE SET NULL/u,
  );
  assert.match(
    sharedArtifactMigration,
    /generation_artifact_id_idx/u,
  );
  assert.doesNotMatch(
    sharedArtifactMigration,
    /DROP\s|DELETE\s+FROM|TRUNCATE|ALTER\s+COLUMN/iu,
  );
  assert.doesNotMatch(
    sharedArtifactMigration,
    /training_question_generation_artifacts[\s\S]*"project_id"/u,
  );
});

test('cross-project generation reuse flag is documented off by default', () => {
  for (const contract of [rootEnvironmentExample, apiEnvironmentExample, compose]) {
    assert.match(
      contract,
      /TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED(?::|=)[^\n]*false/u,
    );
  }
});

test('project knowledge migration is additive and enforces hash/version claims', () => {
  assert.match(knowledgeMigration, /CREATE TABLE "training_project_knowledge_versions"/u);
  assert.match(knowledgeMigration, /UNIQUE INDEX[\s\S]*"project_id", "source_hash"/u);
  assert.match(knowledgeMigration, /"status" IN \('GENERATING', 'READY', 'FAILED'\)/u);
  assert.match(knowledgeMigration, /"compiled_knowledge_json" IS NOT NULL/u);
  assert.doesNotMatch(knowledgeMigration, /DROP TABLE|DROP TYPE|DELETE FROM|TRUNCATE/iu);
});

test('Stage 4 migration is additive and enforces revision and source invariants', () => {
  assert.match(stage4Migration, /CREATE TABLE "training_materials"/);
  assert.match(stage4Migration, /CREATE TABLE "training_material_revisions"/);
  assert.match(stage4Migration, /training_material_revision_ready_immutable_trigger/);
  assert.match(stage4Migration, /training_fact_material_same_project_trigger/);
  assert.match(stage4Migration, /FOREIGN KEY \("file_id"\)[\s\S]*ON DELETE RESTRICT/);
  assert.match(stage4Migration, /UPDATE "training_projects"[\s\S]*"content_schema_version" = 3/);
  assert.doesNotMatch(stage4Migration, /DROP TABLE|DROP TYPE|DELETE FROM|TRUNCATE/);
});

test('Stage 3 migration adds facts, criteria and checkpoint/review state only', () => {
  assert.match(stage3Migration, /CREATE TABLE "training_facts"/);
  assert.match(stage3Migration, /CREATE TABLE "training_criteria"/);
  assert.match(stage3Migration, /ADD COLUMN "transcription_status"/);
  assert.match(stage3Migration, /ADD COLUMN "review_status"/);
  assert.match(stage3Migration, /counts_toward_attempt_limit/);
  assert.match(stage3EnumMigration, /technical_failed/);
  assert.match(stage3EnumMigration, /technical_failure/);
  assert.doesNotMatch(stage3Migration, /provider_run|evaluation_run|transcription_run|review_history|training_jobs|outbox|document|embedding|ranking/iu);
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
  assert.match(seed, /\['training:results:review', 'Review training attempt results'\]/);
  assert.match(seed, /admin: permissions\.map\(\(\[key\]\) => key\)/);
  assert.match(seed, /user:[\s\S]*'training:participate'/);

  const editorBlock = seed.match(/editor:\s*\[([\s\S]*?)\],\n\s*user:/u)?.[1] ?? '';
  assert.doesNotMatch(editorBlock, /training:/);
});
