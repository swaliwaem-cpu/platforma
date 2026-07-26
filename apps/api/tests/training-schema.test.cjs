const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260725210000_add_training_module/migration.sql',
);
const telegramMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260726150000_add_training_telegram_update_job/migration.sql',
);

const schema = fs.readFileSync(schemaPath, 'utf8');
const migration = fs.readFileSync(migrationPath, 'utf8');
const telegramMigration = fs.readFileSync(telegramMigrationPath, 'utf8');

test('training schema defines the approved state enums', () => {
  for (const enumName of [
    'TrainingProjectStatus',
    'TrainingVersionStatus',
    'TrainingQuestionType',
    'TrainingAttemptStatus',
    'TrainingAttemptQuestionStatus',
    'TrainingAnswerStatus',
    'TrainingFactVerdict',
    'TrainingReviewStatus',
    'TrainingPassStatus',
    'TrainingJobStatus',
    'TrainingJobKind',
    'TrainingSourceExtractionStatus',
    'TrainingSourceDocumentType',
    'TrainingProcessedUpdateStatus',
  ]) {
    assert.match(schema, new RegExp(`enum ${enumName} \\{`));
  }

  assert.match(
    schema,
    /enum TrainingAttemptStatus \{[\s\S]*STARTED[\s\S]*AWAITING_MAIN[\s\S]*PROCESSING_MAIN[\s\S]*AWAITING_FOLLOW_UP[\s\S]*PROCESSING_FOLLOW_UP[\s\S]*FINALIZING[\s\S]*COMPLETED[\s\S]*REQUIRES_REVIEW[\s\S]*EXPIRED[\s\S]*TECHNICAL_FAILURE/,
  );
  assert.match(
    schema,
    /enum TrainingJobKind \{[\s\S]*PROCESS_TELEGRAM_UPDATE[\s\S]*TELEGRAM_DOWNLOAD_SEGMENT[\s\S]*ASSEMBLE_ANSWER_AUDIO[\s\S]*TRANSCRIBE_ANSWER[\s\S]*ANALYZE_ACOUSTICS[\s\S]*EVALUATE_ANSWER[\s\S]*FINALIZE_ATTEMPT[\s\S]*SEND_TELEGRAM_MESSAGE[\s\S]*SEND_TIMER_WARNING[\s\S]*EXPIRE_ATTEMPT[\s\S]*EXTRACT_SOURCE_DOCUMENT/,
  );
  assert.match(
    telegramMigration,
    /ALTER TYPE "training_job_kind" ADD VALUE 'process_telegram_update'/,
  );
});

test('training projects reuse User and optionally link RealEstateObject', () => {
  assert.match(
    schema,
    /model TrainingProject \{[\s\S]*realEstateObjectId\s+String\?[\s\S]*activeVersionId\s+String\?[\s\S]*realEstateObject\s+RealEstateObject\?[\s\S]*activeVersion\s+TrainingProjectVersion\?[\s\S]*versions\s+TrainingProjectVersion\[\]/,
  );
  assert.match(
    schema,
    /realEstateObject\s+RealEstateObject\?\s+@relation\(fields: \[realEstateObjectId\], references: \[id\], onDelete: SetNull\)/,
  );
  assert.match(schema, /trainingProjects\s+TrainingProject\[\]/);
  assert.match(schema, /trainingAttempts\s+TrainingAttempt\[\]/);
  assert.match(schema, /trainingTelegramAccount\s+TrainingTelegramAccount\?/);
  assert.doesNotMatch(schema, /model (TrainingEmployee|Employee) \{/);
});

test('training content is versioned and records the 1 plus 10 publication shape', () => {
  for (const modelName of [
    'TrainingProjectVersion',
    'TrainingQuestion',
    'TrainingFact',
    'TrainingQuestionFactLink',
    'TrainingEvaluationCriterion',
    'TrainingSourceDocument',
  ]) {
    assert.match(schema, new RegExp(`model ${modelName} \\{`));
  }

  assert.match(schema, /@@unique\(\[projectId, versionNumber\]\)/);
  assert.match(schema, /@@unique\(\[projectVersionId, type, position\]\)/);
  assert.match(schema, /@@unique\(\[projectVersionId, code\]\)/);
  assert.match(schema, /@@id\(\[questionId, factId\]\)/);
  assert.match(schema, /mainMaxScore\s+Int\s+@default\(55\)/);
  assert.match(schema, /followUpMaxScore\s+Int\s+@default\(15\)/);
  assert.match(
    migration,
    /training_questions_one_active_main_per_version_key[\s\S]*WHERE "type" = 'main' AND "is_active" = true/,
  );
  assert.match(
    migration,
    /training_questions_position_check[\s\S]*"type" = 'main' AND "position" = 1[\s\S]*"type" = 'follow_up' AND "position" BETWEEN 1 AND 10/,
  );
});

test('attempts are pinned to versions and support four questions with multi-segment voice', () => {
  for (const modelName of [
    'TrainingAttempt',
    'TrainingAttemptQuestion',
    'TrainingAnswer',
    'TrainingVoiceSegment',
    'TrainingAnswerEvaluation',
    'TrainingScoreComponent',
    'TrainingResultReview',
  ]) {
    assert.match(schema, new RegExp(`model ${modelName} \\{`));
  }

  assert.match(
    schema,
    /model TrainingAttempt \{[\s\S]*projectVersionId\s+String[\s\S]*settingsSnapshotJson\s+Json[\s\S]*aiScore\s+Decimal\?[\s\S]*serverScore\s+Decimal\?[\s\S]*adminScore\s+Decimal\?[\s\S]*finalScore\s+Decimal\?[\s\S]*reviewStatus\s+TrainingReviewStatus/,
  );
  assert.match(schema, /@@unique\(\[userId, projectId, attemptNumber\]\)/);
  assert.match(schema, /@@unique\(\[attemptId, sequence\]\)/);
  assert.match(schema, /@@unique\(\[attemptId, questionId\]\)/);
  assert.match(schema, /attemptQuestionId\s+String\s+@unique/);
  assert.match(schema, /@@unique\(\[answerId, segmentIndex\]\)/);
  assert.match(schema, /telegramUpdateId\s+BigInt\s+@unique/);
  assert.match(
    migration,
    /training_attempts_one_active_per_user_project_key[\s\S]*WHERE "status" IN \([\s\S]*'finalizing'[\s\S]*\)/,
  );
  assert.match(
    migration,
    /training_attempt_questions_sequence_check" CHECK \("sequence" BETWEEN 1 AND 4\)/,
  );
});

test('private voice storage, Telegram idempotency and PostgreSQL jobs are persisted', () => {
  assert.match(
    schema,
    /model TrainingVoiceSegment \{[\s\S]*originalStorageBucket\s+String\?[\s\S]*originalStorageKey\s+String\?[\s\S]*sizeBytes\s+BigInt\?[\s\S]*durationSeconds\s+Int\?/,
  );
  assert.doesNotMatch(
    schema.match(/model TrainingVoiceSegment \{[\s\S]*?@@map\("training_voice_segments"\)[\s\S]*?\}/)?.[0] ??
      '',
    /\burl\b/i,
  );
  assert.match(
    schema,
    /model TrainingProcessedUpdate \{[\s\S]*updateId\s+BigInt\s+@unique[\s\S]*status\s+TrainingProcessedUpdateStatus[\s\S]*processedAt\s+DateTime\?/,
  );
  assert.match(
    schema,
    /model TrainingJob \{[\s\S]*kind\s+TrainingJobKind[\s\S]*status\s+TrainingJobStatus[\s\S]*payloadJson\s+Json[\s\S]*idempotencyKey\s+String\s+@unique[\s\S]*runAt\s+DateTime[\s\S]*attempts\s+Int[\s\S]*maxAttempts\s+Int[\s\S]*lockOwner\s+String\?[\s\S]*heartbeatAt\s+DateTime\?/,
  );
  assert.match(
    migration,
    /CREATE INDEX "training_jobs_claim_idx"[\s\S]*WHERE "status" = 'pending'/,
  );
});

test('training migration is additive and enforces database integrity', () => {
  const expectedTables = [
    'training_projects',
    'training_project_versions',
    'training_questions',
    'training_facts',
    'training_question_fact_links',
    'training_evaluation_criteria',
    'training_source_documents',
    'training_telegram_accounts',
    'training_link_tokens',
    'training_attempts',
    'training_attempt_questions',
    'training_answers',
    'training_voice_segments',
    'training_answer_evaluations',
    'training_score_components',
    'training_result_reviews',
    'training_processed_updates',
    'training_jobs',
  ];

  for (const tableName of expectedTables) {
    assert.match(migration, new RegExp(`CREATE TABLE "${tableName}"`));
  }

  assert.doesNotMatch(migration, /\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|INSERT INTO)\b/);
  assert.doesNotMatch(
    migration,
    /ALTER TABLE "(catalog_quick_links|feed_media_assets|feed_source_mappings|feed_sources|feed_units|file_variants)"/,
  );
  assert.match(
    migration,
    /training_validate_attempt_version[\s\S]*Training attempt must be pinned to a published version[\s\S]*training_attempts_validate_version/,
  );
  assert.match(
    migration,
    /training_validate_question_fact_version[\s\S]*Training question and fact must belong to the same version[\s\S]*training_question_fact_links_validate_version/,
  );
  assert.match(
    migration,
    /training_project_versions_prevent_published_mutation[\s\S]*training_questions_prevent_published_mutation[\s\S]*training_question_fact_links_prevent_published_mutation/,
  );
});
