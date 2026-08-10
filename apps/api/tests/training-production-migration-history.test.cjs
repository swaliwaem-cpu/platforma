const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '../../..');
const migrationsRoot = resolve(repositoryRoot, 'apps/api/prisma/migrations');
const schemaPath = resolve(repositoryRoot, 'apps/api/prisma/schema.prisma');

const productionHistory = new Map([
  ['20260725210000_add_training_module', '8eb2d46c76541fca80cf7b25067f5de02eb8402c836080b719dae39a7eb939fc'],
  ['20260726150000_add_training_telegram_update_job', 'dbf01a7a17336039e78f713a5b92e1d685501fbaba353a0dcff515cc657bee17'],
  ['20260726180000_fix_training_telegram_review_findings', '6c77b5b8c8d23a7c82711043fa8bc954858efe0d478daa3ce788e5a109849afc'],
  ['20260727120000_add_training_audio_pipeline', 'e021056e9aa39b20a400f1d11ba6f793821674aaeb0380a57995237bf8ca849c'],
  ['20260727200000_fix_training_audio_review_findings', '4f002773a7162002cdcfda4a7634a543ecfa1a12757040335bf13011f665bf11'],
  ['20260727220000_add_training_openai_provider_runs', 'c29d9490be010a50003bad806fbb5c82f20c11cdd9e24f67b711ae48ee31f433'],
  ['20260727230000_fix_training_openai_review_findings', 'c756db8a4eff4ac9e7cd0214cc93d047d226aa24f87f26e2ad379a5cdd1bf707'],
  ['20260728090000_training_stage10_hardening', 'cff14bf4306ca8f30db9c0b9c88193d82fa72873a321676323d392b4bd0fba7c'],
  ['20260728130000_fix_training_stage10_final_review_findings', '5d122104db2656b5d9ca1b9f7c61001b029427cb6f8d22bd713ac8a753baf5f0'],
  ['20260729120000_training_content_creation_workflow', 'ce4447184979d70c21ba64390f88332e4e1011bb1965490db3e0bea17d72afe5'],
  ['20260729160000_add_training_linked_sources_assignments', 'fe0aabb6a8e5a59e834e54437291526e346f351b997d94bea3fef8e22241eb8d'],
  ['20260731120000_replace_training_v1_with_v2', '9bca3808143325fa5c335ba7acd841fdec7f0e817ce8cfdb261e5a5f9bc00787'],
  ['20260804114000_set_training_time_limit_to_20_minutes', 'a0b85826e82384a001d669d18015bc0087a592bb439e17e904fa2de089856e1b'],
  ['20260805120000_add_training_project_knowledge', '9634314270cb758b7e9d660c6b3903be2cd9e57122ba9218e74702abf156c995'],
  ['20260807140000_add_training_question_generation_artifacts', '25a62ef87d82ac52976b6a1f80a2855b530bedb03c43a0fd5eea28fb18ccc96c'],
]);

function migrationChecksum(migrationName) {
  const migration = readFileSync(resolve(migrationsRoot, migrationName, 'migration.sql'));
  return createHash('sha256').update(migration).digest('hex');
}

test('production Training migration history remains byte-exact', () => {
  for (const [migrationName, expectedChecksum] of productionHistory) {
    assert.equal(migrationChecksum(migrationName), expectedChecksum, migrationName);
  }
});

test('production transition remains ordered before V2 and Patch 3', () => {
  const migrations = readdirSync(migrationsRoot).sort();
  const replacementIndex = migrations.indexOf('20260731120000_replace_training_v1_with_v2');
  const stage1Index = migrations.indexOf('20260801120000_add_training_v2_stage_1');
  const timeLimitIndex = migrations.indexOf('20260804114000_set_training_time_limit_to_20_minutes');
  const knowledgeIndex = migrations.indexOf('20260805120000_add_training_project_knowledge');

  assert.ok(replacementIndex >= 0 && replacementIndex < stage1Index);
  assert.ok(timeLimitIndex > stage1Index && timeLimitIndex < knowledgeIndex);
});

test('Prisma project default matches the applied 20-minute migration', () => {
  const schema = readFileSync(schemaPath, 'utf8');
  assert.match(
    schema,
    /timeLimitSeconds\s+Int\s+@default\(1200\)\s+@map\("time_limit_seconds"\)/u,
  );
});
