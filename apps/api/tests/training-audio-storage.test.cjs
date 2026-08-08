require('reflect-metadata');

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { BadRequestException } = require('@nestjs/common');

const { parseS3ListObjectsV2 } = require('../dist/files/s3-storage.service.js');
const {
  parseCreateTrainingAudioDeletionManifestInput,
  parseExecuteTrainingAudioDeletionManifestInput,
  parseTrainingAudioStorageQuery,
} = require('../dist/training/training.validation.js');

test('ListObjectsV2 parser preserves object identity and pagination token', () => {
  const parsed = parseS3ListObjectsV2(`<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <Contents>
        <Key>training-v2/answers/a&amp;b/segments/one.ogg</Key>
        <LastModified>2026-08-08T12:34:56.000Z</LastModified>
        <ETag>&quot;abc123&quot;</ETag>
        <Size>42</Size>
      </Contents>
      <NextContinuationToken>next&amp;token</NextContinuationToken>
    </ListBucketResult>`);

  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.nextContinuationToken, 'next&token');
  assert.deepEqual(parsed.objects, [{
    key: 'training-v2/answers/a&b/segments/one.ogg',
    size: 42,
    etag: 'abc123',
    lastModified: new Date('2026-08-08T12:34:56.000Z'),
  }]);
});

test('audio storage query validates paging, filters, inclusive end date and state', () => {
  const query = parseTrainingAudioStorageQuery({
    page: '2',
    limit: '25',
    project: '  Удалённый проект  ',
    user: '  Бывший сотрудник  ',
    createdFrom: '2026-08-01',
    createdTo: '2026-08-08',
    state: 'UNLINKED',
  });

  assert.equal(query.page, 2);
  assert.equal(query.limit, 25);
  assert.equal(query.project, 'Удалённый проект');
  assert.equal(query.user, 'Бывший сотрудник');
  assert.equal(query.createdFrom.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(query.createdToExclusive.toISOString(), '2026-08-09T00:00:00.000Z');
  assert.equal(query.state, 'UNLINKED');
  assert.throws(
    () => parseTrainingAudioStorageQuery({ createdFrom: '2026-08-09', createdTo: '2026-08-08' }),
    BadRequestException,
  );
  assert.throws(
    () => parseTrainingAudioStorageQuery({ state: 'AUTO_DELETE' }),
    BadRequestException,
  );
});

test('manual deletion input requires a reason, unique bounded selection and explicit execute confirmation', () => {
  assert.deepEqual(
    parseCreateTrainingAudioDeletionManifestInput({
      selectionIds: ['entry:11111111-1111-1111-1111-111111111111'],
      reason: '  Удалено оператором после проверки  ',
    }),
    {
      selectionIds: ['entry:11111111-1111-1111-1111-111111111111'],
      reason: 'Удалено оператором после проверки',
    },
  );
  assert.throws(
    () => parseCreateTrainingAudioDeletionManifestInput({ selectionIds: ['same', 'same'], reason: 'x' }),
    BadRequestException,
  );
  assert.throws(
    () => parseExecuteTrainingAudioDeletionManifestInput({ confirmed: false }),
    BadRequestException,
  );
  assert.deepEqual(parseExecuteTrainingAudioDeletionManifestInput({ confirmed: true }), { confirmed: true });
});

test('audio catalog migration is additive and does not schedule automatic deletion', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../prisma/migrations/20260808210000_add_training_audio_storage_catalog/migration.sql',
  ), 'utf8');

  assert.match(migration, /CREATE TABLE "training_audio_storage_entries"/u);
  assert.match(migration, /"project_title_snapshot"/u);
  assert.match(migration, /"user_name_snapshot"/u);
  assert.match(migration, /"user_email_snapshot"/u);
  assert.match(migration, /CREATE TABLE "training_audio_deletion_manifests"/u);
  assert.doesNotMatch(migration, /DELETE\s+FROM|DROP\s+TABLE|TRUNCATE/iu);
});
