require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const { NotFoundException } = require('@nestjs/common');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  TrainingAudioAccessService,
} = require('../dist/training/audio/training-audio-access.service.js');
const {
  TrainingAudioConfig,
} = require('../dist/training/audio/training-audio.config.js');
const {
  TrainingAudioController,
} = require('../dist/training/audio/training-audio.controller.js');
const {
  S3StorageService,
} = require('../dist/files/s3-storage.service.js');
const {
  TrainingAudioError,
} = require('../dist/training/audio/training-audio.error.js');
const {
  NodeTrainingAudioProcessRunner,
} = require('../dist/training/audio/training-audio-process.runner.js');
const {
  TrainingFfmpegService,
} = require('../dist/training/audio/training-ffmpeg.service.js');
const {
  FakeTrainingTelegramAudioProvider,
  FetchTrainingTelegramAudioProvider,
} = require('../dist/training/audio/training-telegram-audio.provider.js');
const {
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  TrainingModule,
} = require('../dist/training/training.module.js');

const rootDir = resolve(__dirname, '../../..');
const workerSource = readFileSync(
  resolve(
    rootDir,
    'apps/api/src/training/audio/training-audio-worker.service.ts',
  ),
  'utf8',
);
const processRunnerSource = readFileSync(
  resolve(
    rootDir,
    'apps/api/src/training/audio/training-audio-process.runner.ts',
  ),
  'utf8',
);
const composeSource = readFileSync(
  resolve(rootDir, 'docker-compose.yml'),
  'utf8',
);
const dockerfileSource = readFileSync(
  resolve(rootDir, 'apps/api/Dockerfile'),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(resolve(rootDir, 'apps/api/package.json'), 'utf8'),
);
const schemaSource = readFileSync(
  resolve(rootDir, 'apps/api/prisma/schema.prisma'),
  'utf8',
);
const audioMigrationSource = readFileSync(
  resolve(
    rootDir,
    'apps/api/prisma/migrations/20260727120000_add_training_audio_pipeline/migration.sql',
  ),
  'utf8',
);
const reviewMigrationSource = readFileSync(
  resolve(
    rootDir,
    'apps/api/prisma/migrations/20260727200000_fix_training_audio_review_findings/migration.sql',
  ),
  'utf8',
);

function config(overrides = {}) {
  return {
    maxSegmentBytes: 1024,
    maxAnswerBytes: 4096,
    maxSegments: 32,
    maxAnswerDurationSeconds: 600,
    downloadTimeoutMs: 50,
    ffmpegTimeoutMs: 1000,
    transcriptionTimeoutMs: 50,
    workerPollMs: 50,
    workerConcurrency: 2,
    workerLeaseMs: 1000,
    workerHeartbeatMs: 100,
    workerDrainTimeoutMs: 500,
    tempDir: join(tmpdir(), 'platforma-training-audio-test'),
    retentionDays: 0,
    ...overrides,
  };
}

function oggOpusFixture(size = 64) {
  const body = Buffer.alloc(size);
  body.write('OggS', 0, 'ascii');
  body.write('OpusHead', 24, 'ascii');
  return body;
}

function telegramJson(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

async function captureAudioError(operation) {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof TrainingAudioError);
    return error;
  }
  assert.fail('Expected TrainingAudioError');
}

test('audio config enforces bounded worker values, absolute temp and indefinite retention', () => {
  const current = new TrainingAudioConfig({
    TRAINING_AUDIO_TEMP_DIR: '/tmp/platforma-audio-fixture',
    TRAINING_AUDIO_RETENTION_DAYS: '0',
  });

  assert.equal(current.maxSegmentBytes, 20 * 1024 * 1024);
  assert.equal(current.workerConcurrency, 2);
  assert.equal(current.retentionDays, 0);
  assert.throws(
    () =>
      new TrainingAudioConfig({
        TRAINING_AUDIO_TEMP_DIR: 'relative/path',
      }),
    /must be an absolute path/,
  );
  assert.throws(
    () =>
      new TrainingAudioConfig({
        TRAINING_AUDIO_RETENTION_DAYS: '30',
      }),
    /must be an integer from 0 to 0/,
  );
  assert.throws(
    () =>
      new TrainingAudioConfig({
        TRAINING_AUDIO_WORKER_LEASE_MS: '1000',
        TRAINING_AUDIO_WORKER_HEARTBEAT_MS: '1000',
      }),
    /must be less than/,
  );
});

test('production storage requires a distinct explicitly configured audio bucket', async () => {
  await withTemporaryEnvironment(
    {
      NODE_ENV: 'production',
      MINIO_BUCKET: 'general-bucket',
      TRAINING_AUDIO_BUCKET: undefined,
    },
    async () => {
      await assert.rejects(
        () => new S3StorageService().onModuleInit(),
        /TRAINING_AUDIO_BUCKET is required/,
      );
    },
  );
  await withTemporaryEnvironment(
    {
      NODE_ENV: 'production',
      MINIO_BUCKET: 'same-bucket',
      TRAINING_AUDIO_BUCKET: 'same-bucket',
    },
    async () => {
      await assert.rejects(
        () => new S3StorageService().onModuleInit(),
        /must differ from MINIO_BUCKET/,
      );
    },
  );
});

test('training audio bucket privacy probe accepts private storage and rejects public read, list or ambiguous access', async (t) => {
  for (const fixture of [
    { name: 'private', anonymous: 'denied', succeeds: true },
    {
      name: 'public object read',
      anonymous: { GET: 'public' },
      succeeds: false,
    },
    {
      name: 'public bucket list',
      anonymous: { LIST: 'public' },
      succeeds: false,
    },
    {
      name: 'ambiguous read',
      anonymous: { GET: 'network' },
      succeeds: false,
    },
  ]) {
    await t.test(fixture.name, async () => {
      await withTemporaryEnvironment(
        {
          NODE_ENV: 'production',
          S3_ENDPOINT: 'https://minio.test',
          S3_PUBLIC_ENDPOINT: 'https://public-minio.test',
          MINIO_BUCKET: 'general-bucket',
          TRAINING_DOCUMENT_BUCKET: 'document-bucket',
          TRAINING_AUDIO_BUCKET: 'audio-private-bucket',
        },
        async () => {
          const originalFetch = global.fetch;
          global.fetch = createS3PrivacyFetch(fixture.anonymous);
          try {
            const operation = () =>
              new S3StorageService().onModuleInit();
            if (fixture.succeeds) {
              await operation();
            } else {
              await assert.rejects(
                operation,
                /TRAINING_AUDIO_BUCKET/,
              );
            }
          } finally {
            global.fetch = originalFetch;
          }
        },
      );
    });
  }
});

test('training audio bucket anonymous PUT is a mandatory fail-closed gate with signed cleanup', async (t) => {
  for (const fixture of [
    {
      name: 'private PUT is denied',
      anonymous: { PUT: 'denied' },
      succeeds: true,
    },
    {
      name: 'public PUT is rejected and removed',
      anonymous: { PUT: 'public' },
      succeeds: false,
    },
    {
      name: 'ambiguous PUT is rejected in production',
      anonymous: { PUT: 'network' },
      succeeds: false,
    },
  ]) {
    await t.test(fixture.name, async () => {
      await withProductionStorageEnvironment(async () => {
        const originalFetch = global.fetch;
        const storageFetch = createS3PrivacyFetch(fixture.anonymous);
        global.fetch = storageFetch;
        try {
          const operation = () => new S3StorageService().onModuleInit();
          if (fixture.succeeds) {
            await operation();
          } else {
            await assert.rejects(operation, /TRAINING_AUDIO_BUCKET/);
          }
          assert.deepEqual(storageFetch.getStoredProbeKeys(), []);
          const anonymousPut = storageFetch.calls.find(
            (call) => !call.signed && call.operation === 'PUT',
          );
          assert.ok(anonymousPut);
          assert.equal(anonymousPut.headers.has('authorization'), false);
          assert.equal(anonymousPut.headers.has('x-amz-date'), false);
          assert.equal(
            anonymousPut.headers.has('x-amz-content-sha256'),
            false,
          );
        } finally {
          global.fetch = originalFetch;
        }
      });
    });
  }
});

test('training audio bucket cleans the exact anonymous PUT sentinel after a client timeout', async () => {
  await withProductionStorageEnvironment(async () => {
    const originalFetch = global.fetch;
    const storageFetch = createS3PrivacyFetch({
      PUT: 'stored-timeout',
    });
    global.fetch = storageFetch;
    try {
      await assert.rejects(
        () => new S3StorageService().onModuleInit(),
        /anonymous object PUT was inconclusive/,
      );
      const anonymousPut = storageFetch.calls.find(
        (call) => !call.signed && call.operation === 'PUT',
      );
      assert.ok(anonymousPut);
      const signedCleanup = storageFetch.calls.find(
        (call) =>
          call.signed &&
          call.operation === 'DELETE' &&
          call.pathname === anonymousPut.pathname,
      );
      assert.ok(signedCleanup);
      assert.match(
        signedCleanup.pathname,
        /^\/audio-private-bucket\/training-audio\/privacy-probe\//,
      );
      assert.deepEqual(storageFetch.getStoredProbeKeys(), []);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('training audio bucket accepts missing sentinel cleanup without changing the anonymous PUT verdict', async (t) => {
  for (const fixture of [
    {
      name: 'denied PUT with signed DELETE 404 remains private',
      anonymous: { PUT: 'denied' },
      missingDeleteResponse: '404',
      succeeds: true,
      cleanupStatus: 404,
      cleanupCode: null,
    },
    {
      name: 'public PUT response with signed DELETE NoSuchKey remains unsafe',
      anonymous: { PUT: 'public' },
      missingDeleteResponse: 'NoSuchKey',
      succeeds: false,
      cleanupStatus: 400,
      cleanupCode: 'NoSuchKey',
    },
  ]) {
    await t.test(fixture.name, async () => {
      await withProductionStorageEnvironment(async () => {
        const originalFetch = global.fetch;
        const storageFetch = createS3PrivacyFetch(
          fixture.anonymous,
          null,
          null,
          {
            storeAnonymousPut: false,
            missingDeleteResponse: fixture.missingDeleteResponse,
          },
        );
        global.fetch = storageFetch;
        try {
          const operation = () => new S3StorageService().onModuleInit();
          if (fixture.succeeds) {
            await operation();
          } else {
            await assert.rejects(
              operation,
              /permits anonymous object PUT/,
            );
          }
          const anonymousPut = storageFetch.calls.find(
            (call) => !call.signed && call.operation === 'PUT',
          );
          assert.ok(anonymousPut);
          assert.deepEqual(
            storageFetch
              .getSignedPrivacyDeleteResults()
              .find((result) => result.pathname === anonymousPut.pathname),
            {
              pathname: anonymousPut.pathname,
              status: fixture.cleanupStatus,
              code: fixture.cleanupCode,
            },
          );
          assert.deepEqual(storageFetch.getStoredProbeKeys(), []);
        } finally {
          global.fetch = originalFetch;
        }
      });
    });
  }
});

test('training audio bucket anonymous PUT cleanup errors are logged and fail startup', async () => {
  await withProductionStorageEnvironment(async () => {
    const originalFetch = global.fetch;
    global.fetch = createS3PrivacyFetch(
      { PUT: 'public' },
      null,
      null,
      { failSignedDeleteNumber: 2 },
    );
    try {
      await assert.rejects(
        () => new S3StorageService().onModuleInit(),
        /privacy sentinel cleanup failed/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('training audio bucket policy rejects public read and write capabilities including wildcard actions', async (t) => {
  const fixtures = [
    {
      name: 'nested Principal.AWS read',
      principal: {
        AWS: ['arn:aws:iam::123456789012:root', '*'],
      },
      action: 's3:GetObject',
    },
    {
      name: 'Principal star PutObject',
      principal: '*',
      action: 's3:PutObject',
    },
    {
      name: 'Principal.AWS star all actions',
      principal: { AWS: '*' },
      action: 's3:*',
    },
    {
      name: 'Action array containing PutObject',
      principal: '*',
      action: ['s3:GetBucketLocation', 's3:PutObject'],
    },
    {
      name: 'wildcard write action',
      principal: '*',
      action: 's3:Put*',
    },
    {
      name: 'wildcard covering object writes',
      principal: '*',
      action: 's3:*Object',
    },
    {
      name: 'conditional public write fails closed',
      principal: '*',
      action: 's3:PutObject',
      condition: {
        IpAddress: {
          'aws:SourceIp': '10.0.0.0/8',
        },
      },
    },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await withProductionStorageEnvironment(async () => {
        const originalFetch = global.fetch;
        global.fetch = createS3PrivacyFetch('denied', {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: fixture.principal,
              Action: fixture.action,
              ...(fixture.condition
                ? { Condition: fixture.condition }
                : {}),
            },
          ],
        });
        try {
          await assert.rejects(
            () => new S3StorageService().onModuleInit(),
            /TRAINING_AUDIO_BUCKET policy allows public access/,
          );
        } finally {
          global.fetch = originalFetch;
        }
      });
    });
  }
});

test('training audio bucket ACL rejects every public or authenticated grant capability', async (t) => {
  for (const fixture of [
    { group: 'AllUsers', permission: 'READ' },
    { group: 'AllUsers', permission: 'WRITE' },
    { group: 'AllUsers', permission: 'FULL_CONTROL' },
    { group: 'AuthenticatedUsers', permission: 'WRITE_ACP' },
  ]) {
    await t.test(
      `${fixture.group} ${fixture.permission}`,
      async () => {
        await withProductionStorageEnvironment(async () => {
          const originalFetch = global.fetch;
          global.fetch = createS3PrivacyFetch(
            'denied',
            null,
            createPublicAcl(fixture.group, fixture.permission),
          );
          try {
            await assert.rejects(
              () => new S3StorageService().onModuleInit(),
              /TRAINING_AUDIO_BUCKET ACL allows public access/,
            );
          } finally {
            global.fetch = originalFetch;
          }
        });
      },
    );
  }
});

test('audio migration links private File rows to segments and merged answers with integrity constraints', () => {
  assert.match(
    schemaSource,
    /model TrainingAnswer \{[\s\S]*mergedAudioFileId\s+String\?\s+@unique[\s\S]*mergedAudioDurationMilliseconds\s+Int\?[\s\S]*audioPreparedAt\s+DateTime\?[\s\S]*mergedAudioFile\s+File\?/,
  );
  assert.match(
    schemaSource,
    /model TrainingVoiceSegment \{[\s\S]*originalFileId\s+String\?\s+@unique[\s\S]*checksum\s+String\?[\s\S]*durationMilliseconds\s+Int\?[\s\S]*downloadedAt\s+DateTime\?[\s\S]*originalFile\s+File\?/,
  );
  assert.match(
    audioMigrationSource,
    /FOREIGN KEY \("merged_audio_file_id"\)[\s\S]*ON DELETE RESTRICT/,
  );
  assert.match(
    audioMigrationSource,
    /FOREIGN KEY \("original_file_id"\)[\s\S]*ON DELETE RESTRICT/,
  );
  assert.match(
    audioMigrationSource,
    /training_voice_segments_checksum_sha256/,
  );
  for (const constraint of [
    'training_attempt_questions_attempt_id_fkey',
    'training_answers_attempt_question_id_fkey',
    'training_voice_segments_answer_id_fkey',
    'training_answer_evaluations_answer_id_fkey',
    'training_score_components_evaluation_id_fkey',
    'training_result_reviews_attempt_id_fkey',
  ]) {
    assert.match(
      reviewMigrationSource,
      new RegExp(
        `${constraint}[\\s\\S]*?ON DELETE RESTRICT`,
      ),
    );
  }
  assert.match(
    schemaSource,
    /model TrainingAudioUploadIntent \{[\s\S]*expectedChecksum[\s\S]*recoveryKey[\s\S]*cleanupGeneration/,
  );
  assert.match(
    reviewMigrationSource,
    /CREATE TABLE "training_audio_upload_intents"/,
  );
});

test('Telegram voice provider downloads valid Ogg Opus and checks every byte count', async () => {
  const body = oggOpusFixture();
  const calls = [];
  const provider = new FetchTrainingTelegramAudioProvider(
    '123456:secret-token',
    config(),
    async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return telegramJson({
          ok: true,
          result: {
            file_path: 'voice/internal-file.oga',
            file_size: body.length,
          },
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'audio/ogg; charset=binary',
          'content-length': String(body.length),
        },
      });
    },
  );

  const result = await provider.downloadVoice({
    fileId: 'telegram-file-id',
    declaredSizeBytes: BigInt(body.length),
    declaredDurationSeconds: 3,
  });

  assert.deepEqual(result, { body, mimeType: 'audio/ogg' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(new URL(calls[0].url).origin, 'https://api.telegram.org');
  assert.equal(new URL(calls[1].url).origin, 'https://api.telegram.org');
  assert.match(calls[1].url, /\/file\/bot/);
});

test('Telegram getFile classifies 429, 5xx, permanent 4xx and invalid JSON', async (t) => {
  const cases = [
    {
      name: '429 honors retry_after',
      response: telegramJson(
        {
          ok: false,
          error_code: 429,
          parameters: { retry_after: 7 },
        },
        { status: 429 },
      ),
      code: 'TELEGRAM_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 7000,
    },
    {
      name: '5xx is retryable before JSON parsing',
      response: new Response('gateway failure', { status: 503 }),
      code: 'TELEGRAM_SERVER_ERROR',
      retryable: true,
    },
    {
      name: '4xx is permanent',
      response: telegramJson(
        { ok: false, error_code: 400 },
        { status: 400 },
      ),
      code: 'TELEGRAM_PERMANENT_CLIENT_ERROR',
      retryable: false,
    },
    {
      name: 'invalid success JSON is retryable',
      response: new Response('{broken', { status: 200 }),
      code: 'TELEGRAM_INVALID_RESPONSE',
      retryable: true,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const provider = new FetchTrainingTelegramAudioProvider(
        '123456:token-must-not-leak',
        config(),
        async () => fixture.response,
      );
      const error = await captureAudioError(() =>
        provider.downloadVoice({
          fileId: 'file',
          declaredSizeBytes: null,
          declaredDurationSeconds: 1,
        }),
      );
      assert.equal(error.code, fixture.code);
      assert.equal(error.retryable, fixture.retryable);
      if (fixture.retryAfterMs) {
        assert.equal(error.retryAfterMs, fixture.retryAfterMs);
      }
      assert.equal(error.message.includes('token-must-not-leak'), false);
    });
  }
});

test('Telegram download timeout aborts the request without exposing the bot token', async () => {
  const provider = new FetchTrainingTelegramAudioProvider(
    '123456:timeout-secret',
    config({ downloadTimeoutMs: 10 }),
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('request aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  );

  const error = await captureAudioError(() =>
    provider.downloadVoice({
      fileId: 'file',
      declaredSizeBytes: null,
      declaredDurationSeconds: 1,
    }),
  );

  assert.equal(error.code, 'TELEGRAM_TIMEOUT');
  assert.equal(error.retryable, true);
  assert.equal(error.message.includes('timeout-secret'), false);
});

test('Telegram download rejects oversize, Content-Length mismatch, MIME and container spoofing', async (t) => {
  const fixtures = [
    {
      name: 'declared oversize',
      getFileSize: 2048,
      body: oggOpusFixture(),
      headers: {
        'content-type': 'audio/ogg',
        'content-length': '64',
      },
      code: 'AUDIO_SIZE_LIMIT_EXCEEDED',
    },
    {
      name: 'content length mismatch',
      getFileSize: 64,
      body: oggOpusFixture(),
      headers: {
        'content-type': 'audio/ogg',
        'content-length': '63',
      },
      code: 'AUDIO_BYTE_COUNT_MISMATCH',
    },
    {
      name: 'invalid MIME',
      getFileSize: 64,
      body: oggOpusFixture(),
      headers: {
        'content-type': 'text/plain',
        'content-length': '64',
      },
      code: 'AUDIO_CONTENT_TYPE_INVALID',
    },
    {
      name: 'spoofed Ogg body',
      getFileSize: 64,
      body: Buffer.alloc(64),
      headers: {
        'content-type': 'audio/ogg',
        'content-length': '64',
      },
      code: 'AUDIO_CONTAINER_INVALID',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let call = 0;
      const provider = new FetchTrainingTelegramAudioProvider(
        '123456:secret',
        config(),
        async () => {
          call += 1;
          return call === 1
            ? telegramJson({
                ok: true,
                result: {
                  file_path: 'voice/file.oga',
                  file_size: fixture.getFileSize,
                },
              })
            : new Response(fixture.body, {
                status: 200,
                headers: fixture.headers,
              });
        },
      );
      const error = await captureAudioError(() =>
        provider.downloadVoice({
          fileId: 'file',
          declaredSizeBytes:
            fixture.name === 'declared oversize' ? 2048n : 64n,
          declaredDurationSeconds: 1,
        }),
      );
      assert.equal(error.code, fixture.code);
    });
  }
});

test('Telegram getFile rejects traversal paths before file download', async () => {
  let calls = 0;
  const provider = new FetchTrainingTelegramAudioProvider(
    '123456:secret',
    config(),
    async () => {
      calls += 1;
      return telegramJson({
        ok: true,
        result: { file_path: '../private/token', file_size: 64 },
      });
    },
  );
  const error = await captureAudioError(() =>
    provider.downloadVoice({
      fileId: 'file',
      declaredSizeBytes: 64n,
      declaredDurationSeconds: 1,
    }),
  );

  assert.equal(error.code, 'TELEGRAM_INVALID_FILE_PATH');
  assert.equal(calls, 1);
});

test('Telegram file_path validation rejects URL, authority, traversal, encoding, backslash and malformed inputs', async (t) => {
  const invalidPaths = [
    'https://evil.example/file.oga',
    '//evil.example/file.oga',
    '../private/file.oga',
    'voice/%2e%2e/private.oga',
    'voice\\private.oga',
    'https://user:password@evil.example:8443/file.oga',
    'voice//file.oga',
    'voice/\u0000file.oga',
  ];
  for (const filePath of invalidPaths) {
    await t.test(JSON.stringify(filePath), async () => {
      let calls = 0;
      const provider = new FetchTrainingTelegramAudioProvider(
        '123456:path-secret',
        config(),
        async () => {
          calls += 1;
          return telegramJson({
            ok: true,
            result: {
              file_path: filePath,
              file_size: 64,
            },
          });
        },
      );
      const error = await captureAudioError(() =>
        provider.downloadVoice({
          fileId: 'file',
          declaredSizeBytes: 64n,
          declaredDurationSeconds: 1,
        }),
      );
      assert.equal(error.code, 'TELEGRAM_INVALID_FILE_PATH');
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes('path-secret'), false);
      assert.equal(calls, 1);
    });
  }
});

test('Telegram redirects to external and loopback hosts are security errors and are never followed', async (t) => {
  for (const target of [
    'https://evil.example/audio.oga',
    'http://localhost/audio.oga',
    'http://127.0.0.1/audio.oga',
  ]) {
    await t.test(target, async () => {
      const calls = [];
      const provider = new FetchTrainingTelegramAudioProvider(
        '123456:redirect-secret',
        config(),
        async (url, options) => {
          calls.push({
            url: String(url),
            redirect: options.redirect,
          });
          if (calls.length === 1) {
            return telegramJson({
              ok: true,
              result: {
                file_path: 'voice/file.oga',
                file_size: 64,
              },
            });
          }
          return new Response(null, {
            status: 302,
            headers: { location: target },
          });
        },
      );
      const error = await captureAudioError(() =>
        provider.downloadVoice({
          fileId: 'file',
          declaredSizeBytes: 64n,
          declaredDurationSeconds: 1,
        }),
      );
      assert.equal(error.code, 'TELEGRAM_REDIRECT_BLOCKED');
      assert.equal(error.retryable, false);
      assert.equal(calls.length, 2);
      assert.equal(calls.every((call) => call.redirect === 'manual'), true);
      assert.equal(
        calls.every(
          (call) =>
            new URL(call.url).origin === 'https://api.telegram.org',
        ),
        true,
      );
    });
  }
});

test('Telegram response.url cannot change the fixed API origin', async () => {
  let calls = 0;
  const provider = new FetchTrainingTelegramAudioProvider(
    '123456:response-url-secret',
    config(),
    async () => {
      calls += 1;
      const response = telegramJson({
        ok: true,
        result: {
          file_path: 'voice/file.oga',
          file_size: 64,
        },
      });
      Object.defineProperty(response, 'url', {
        value: 'http://127.0.0.1/getFile',
      });
      return response;
    },
  );
  const error = await captureAudioError(() =>
    provider.downloadVoice({
      fileId: 'file',
      declaredSizeBytes: 64n,
      declaredDurationSeconds: 1,
    }),
  );
  assert.equal(error.code, 'TELEGRAM_REDIRECT_BLOCKED');
  assert.equal(calls, 1);
});

test('fake Telegram audio and transcription providers are deterministic and network-free', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be used');
  };
  try {
    const audio = await new FakeTrainingTelegramAudioProvider().downloadVoice({
      fileId: 'fake-file',
      declaredSizeBytes: null,
      declaredDurationSeconds: 1,
    });
    const transcription =
      await new DeterministicFakeTrainingTranscriptionProvider().transcribe({
        answerId: 'answer',
        audio: {
          fileId: 'merged-file',
          mimeType: 'audio/wav',
          sizeBytes: audio.body.length,
          checksum: createHash('sha256').update(audio.body).digest('hex'),
          durationMilliseconds: 250,
        },
        segments: [
          {
            id: 'second',
            segmentIndex: 2,
            fakeTranscript: 'вторая часть',
          },
          {
            id: 'first',
            segmentIndex: 1,
            fakeTranscript: 'первая часть',
          },
        ],
      });

    assert.equal(audio.mimeType, 'audio/wav');
    assert.equal(transcription.transcript, 'первая часть\nвторая часть');
    assert.equal(transcription.wordCount, 4);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fake transcription exposes retryable, permanent and timeout fixtures', async () => {
  const provider = new DeterministicFakeTrainingTranscriptionProvider();
  const base = {
    answerId: 'answer',
    segments: [],
  };
  const retryable = await captureAudioError(() =>
    provider.transcribe({
      ...base,
      segments: [
        {
          id: 'one',
          segmentIndex: 1,
          fakeTranscript: '[[fake-transcription:retryable]]',
        },
      ],
    }),
  );
  const permanent = await captureAudioError(() =>
    provider.transcribe({
      ...base,
      segments: [
        {
          id: 'one',
          segmentIndex: 1,
          fakeTranscript: '[[fake-transcription:permanent]]',
        },
      ],
    }),
  );
  const timeoutResult = await Promise.race([
    provider
      .transcribe({
        ...base,
        segments: [
          {
            id: 'one',
            segmentIndex: 1,
            fakeTranscript: '[[fake-transcription:timeout]]',
          },
        ],
      })
      .then(() => 'resolved'),
    new Promise((resolvePromise) =>
      setTimeout(() => resolvePromise('pending'), 10),
    ),
  ]);

  assert.equal(retryable.retryable, true);
  assert.equal(permanent.retryable, false);
  assert.equal(timeoutResult, 'pending');
});

test('ffmpeg pipeline sorts persisted positions, emits objective metrics and cleans temp files', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'platforma-ffmpeg-test-'));
  const bodies = new Map([
    ['segment-1', Buffer.from('first-audio')],
    ['segment-2', Buffer.from('second-audio')],
  ]);
  const manifests = [];
  const processCalls = [];
  const files = {
    readStoredFile: async (file) => bodies.get(file.id),
  };
  const processRunner = {
    run: async (input) => {
      processCalls.push(input);
      const target = input.args.at(-1);
      if (input.command === 'ffprobe') {
        const sourceName = input.args.at(-1);
        const duration =
          sourceName === 'answer-normalized.wav'
            ? 3
            : sourceName === 'segment-0001-source.wav'
              ? 1
              : 2;
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_name: 'pcm_s16le',
                channels: 1,
                sample_rate: '16000',
              },
            ],
            format: { duration: String(duration) },
          }),
          stderr: '',
        };
      }
      if (input.args.includes('concat.txt')) {
        manifests.push(
          await readFile(join(input.cwd, 'concat.txt'), 'utf8'),
        );
      }
      if (target !== '-') {
        await writeFile(join(input.cwd, target), Buffer.alloc(96, 1));
      }
      return {
        stdout: '',
        stderr: input.args.includes('silencedetect=noise=-35dB:d=0.8')
          ? '[silencedetect] silence_start: 1\n[silencedetect] silence_end: 2 | silence_duration: 1'
          : '',
      };
    },
  };
  const service = new TrainingFfmpegService(
    config({ tempDir: tempBase }),
    files,
    processRunner,
  );
  let outputPath;
  try {
    const prepared = await service.withPreparedAudio(
      [
        ffmpegSegment('segment-2', 2, bodies.get('segment-2'), 2500),
        ffmpegSegment('segment-1', 1, bodies.get('segment-1'), 0),
      ],
      async (current) => {
        outputPath = current.path;
        assert.equal(existsSync(current.path), true);
        return current;
      },
    );

    assert.deepEqual(
      prepared.segments.map((segment) => segment.id),
      ['segment-1', 'segment-2'],
    );
    assert.equal(prepared.durationMilliseconds, 3000);
    assert.equal(prepared.metrics.segmentCount, 2);
    assert.equal(prepared.metrics.totalOriginalBytes, 23);
    assert.deepEqual(prepared.metrics.segmentDurationsSeconds, [1, 2]);
    assert.deepEqual(prepared.metrics.technicalIntervalsSeconds, [1.5]);
    assert.equal(prepared.metrics.silence.pauseCount, 1);
    assert.equal(prepared.metrics.silence.silenceRatio, 0.333);
    assert.equal(manifests.length, 1);
    assert.equal(
      manifests[0],
      "file 'segment-0001.wav'\nfile 'segment-0002.wav'\n",
    );
    assert.equal(processCalls.every((call) => Array.isArray(call.args)), true);
    const wavConversion = processCalls.find(
      (call) =>
        call.command === 'ffmpeg' &&
        call.args.includes('segment-0001-source.wav'),
    );
    assert.equal(wavConversion.args.at(-1), 'segment-0001.wav');
    assert.notEqual(
      wavConversion.args[wavConversion.args.indexOf('-i') + 1],
      wavConversion.args.at(-1),
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test('ffmpeg timeout and non-zero fixtures propagate typed errors and clean temp files', async (t) => {
  for (const code of ['FFMPEG_TIMEOUT', 'FFMPEG_FAILED']) {
    await t.test(code, async () => {
      const tempBase = await mkdtemp(
        join(tmpdir(), 'platforma-ffmpeg-failure-'),
      );
      const body = Buffer.from('audio');
      const service = new TrainingFfmpegService(
        config({ tempDir: tempBase }),
        {
          readStoredFile: async () => body,
        },
        {
          run: async (input) => {
            if (input.command === 'ffprobe') {
              return {
                stdout: JSON.stringify({
                  streams: [
                    {
                      codec_name: 'pcm_s16le',
                      channels: 1,
                      sample_rate: '16000',
                    },
                  ],
                  format: { duration: '1' },
                }),
                stderr: '',
              };
            }
            throw new TrainingAudioError(code, code === 'FFMPEG_TIMEOUT');
          },
        },
      );
      try {
        const error = await captureAudioError(() =>
          service.withPreparedAudio(
            [ffmpegSegment('segment-1', 1, body, 0)],
            async () => undefined,
          ),
        );
        assert.equal(error.code, code);
        assert.deepEqual(
          (await require('node:fs/promises').readdir(tempBase)).filter(
            (entry) => entry.startsWith('answer-'),
          ),
          [],
        );
      } finally {
        await rm(tempBase, { recursive: true, force: true });
      }
    });
  }
});

test('temp scavenger removes only stale generated directories and never follows symlinks', async () => {
  const tempBase = await mkdtemp(
    join(tmpdir(), 'platforma-audio-scavenger-'),
  );
  const external = await mkdtemp(
    join(tmpdir(), 'platforma-audio-external-'),
  );
  const stale = join(tempBase, 'answer-stale');
  const fresh = join(tempBase, 'answer-fresh');
  const link = join(tempBase, 'answer-link');
  try {
    await mkdir(stale);
    await mkdir(fresh);
    await writeFile(join(external, 'keep'), 'keep');
    await symlink(external, link, 'dir');
    const old = new Date(Date.now() - 2 * 60_000);
    await utimes(stale, old, old);
    const service = new TrainingFfmpegService(
      config({ tempDir: tempBase }),
      { readStoredFile: async () => Buffer.alloc(0) },
      { run: async () => ({ stdout: '', stderr: '' }) },
    );
    await service.scavengeTempDirectories(60_000);
    const entries = await readdir(tempBase);
    assert.equal(entries.includes('answer-stale'), false);
    assert.equal(entries.includes('answer-fresh'), true);
    assert.equal(entries.includes('answer-link'), true);
    assert.equal(
      (await readdir(external)).includes('keep'),
      true,
    );
  } finally {
    await rm(tempBase, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('process runner timeout terminates the full POSIX process group', {
  skip: process.platform === 'win32',
}, async () => {
  const tempBase = await mkdtemp(
    join(tmpdir(), 'platforma-process-tree-test-'),
  );
  const pidFile = join(tempBase, 'processes.txt');
  const childScript =
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parentScript = [
    "trap '' TERM",
    '"$2" -e "$3" >/dev/null 2>&1 &',
    'child_pid=$!',
    'printf "%s,%s" "$$" "$child_pid" > "$1"',
    'wait',
  ].join('\n');
  let parentPid;
  let childPid;
  try {
    const runner = new NodeTrainingAudioProcessRunner();
    const error = await captureAudioError(() =>
      runner.run({
        command: '/bin/sh',
        args: [
          '-c',
          parentScript,
          'platforma-process-tree-parent',
          pidFile,
          process.execPath,
          childScript,
        ],
        cwd: tempBase,
        timeoutMs: 1_000,
      }),
    );
    assert.equal(error.code, 'FFPROBE_TIMEOUT');
    [parentPid, childPid] = (await readFile(pidFile, 'utf8'))
      .split(',')
      .map(Number);
    assert.equal(Number.isSafeInteger(parentPid), true);
    assert.equal(Number.isSafeInteger(childPid), true);
    assert.equal(processExists(parentPid), false);
    assert.equal(processExists(childPid), false);
    assert.equal(processGroupExists(parentPid), false);
  } finally {
    if (parentPid && processGroupExists(parentPid)) {
      process.kill(-parentPid, 'SIGKILL');
    }
    if (childPid && processExists(childPid)) {
      process.kill(childPid, 'SIGKILL');
    }
    await rm(tempBase, { recursive: true, force: true });
  }
});

test('audio process and worker source preserve no-shell CAS lifecycle and deterministic keys', () => {
  assert.match(processRunnerSource, /spawn\(input\.command,\s*input\.args,/);
  assert.match(processRunnerSource, /shell:\s*false/);
  assert.doesNotMatch(processRunnerSource, /\bexec\s*\(/);
  assert.match(workerSource, /status:\s*TrainingJobStatus\.RUNNING/);
  assert.match(workerSource, /lockOwner:\s*this\.workerId/);
  assert.match(workerSource, /heartbeatAt/);
  assert.match(workerSource, /recoverStaleJobs/);
  assert.match(
    workerSource,
    /attempt:\$\{attemptId\}:answer:\$\{answerId\}:transcribe/,
  );
  assert.match(
    workerSource,
    /training-audio\/answers\/\$\{answerId\}\/segments\/\$\{segmentId\}/,
  );
});

test('protected audio endpoint requires permission, ownership or administrative scope and audits reads', async () => {
  const fileBody = Buffer.from('private audio');
  const file = {
    id: 'file-id',
    bucket: 'private-audio',
    key: 'training-audio/answers/answer/normalized.wav',
    url: null,
    mimeType: 'audio/wav',
    sizeBytes: BigInt(fileBody.length),
    checksum: createHash('sha256').update(fileBody).digest('hex'),
  };
  const auditRows = [];
  const answer = {
    id: 'answer-id',
    mergedAudioFile: file,
    attemptQuestion: {
      attempt: {
        id: 'attempt-id',
        userId: 'owner-id',
      },
    },
  };
  const service = new TrainingAudioAccessService(
    {
      trainingAnswer: {
        findUnique: async () => answer,
      },
      auditLog: {
        create: async ({ data }) => {
          auditRows.push(data);
          return data;
        },
      },
    },
    {
      readStoredFile: async (storedFile) => {
        assert.equal(storedFile.key, file.key);
        return fileBody;
      },
    },
  );

  const owner = await service.getAnswerAudio(
    'answer-id',
    {
      id: 'owner-id',
      permissions: ['training:audio:read'],
    },
    {},
  );
  const admin = await service.getAnswerAudio(
    'answer-id',
    {
      id: 'admin-id',
      permissions: [
        'training:audio:read',
        'training:results:read',
      ],
    },
    {},
  );

  assert.equal(owner.buffer, fileBody);
  assert.equal(admin.buffer, fileBody);
  assert.deepEqual(
    auditRows.map((row) => row.metadata.scope),
    ['ownership', 'administrative'],
  );
  await assert.rejects(
    () =>
      service.getAnswerAudio(
        'answer-id',
        {
          id: 'other-id',
          permissions: ['training:audio:read'],
        },
        {},
      ),
    NotFoundException,
  );
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingAudioController.prototype.getAnswerAudio,
    ),
    ['training:audio:read'],
  );
  const controllers = Reflect.getMetadata('controllers', TrainingModule);
  assert.ok(controllers.includes(TrainingAudioController));
});

test('audio controller streams bytes with private headers and never serializes storage metadata', async () => {
  const body = Buffer.from('wav bytes');
  const headers = new Map();
  let sent;
  const controller = new TrainingAudioController({
    getAnswerAudio: async () => ({
      buffer: body,
      mimeType: 'audio/wav',
      sizeBytes: body.length,
    }),
  });
  await controller.getAnswerAudio(
    'answer-id',
    { id: 'admin-id', permissions: ['training:audio:read'] },
    {},
    {
      setHeader: (name, value) => headers.set(name, value),
      send: (value) => {
        sent = value;
      },
    },
  );

  assert.equal(sent, body);
  assert.equal(headers.get('Content-Length'), body.length);
  assert.equal(headers.get('Cache-Control'), 'private, no-store');
  assert.equal(JSON.stringify(sent).includes('training-audio/'), false);
});

test('Docker and Compose run one PostgreSQL-backed audio worker with ffmpeg and bounded shutdown', () => {
  assert.match(dockerfileSource, /apk add --no-cache ffmpeg/);
  assert.equal(
    packageJson.scripts['start:training-worker'],
    'node --env-file-if-exists=.env dist/training/training-worker.main.js',
  );
  assert.match(composeSource, /^\s{2}training-worker:\s*$/mu);
  assert.match(
    composeSource,
    /command:\s*\["node", "apps\/api\/dist\/training\/training-worker\.main\.js"\]/,
  );
  assert.match(composeSource, /^\s*stop_grace_period:\s*45s\s*$/mu);
  assert.match(composeSource, /TRAINING_AUDIO_BUCKET:/);
  assert.doesNotMatch(
    JSON.stringify(packageJson.dependencies),
    /bullmq|redis/u,
  );
});

function ffmpegSegment(id, segmentIndex, body, receivedAtMilliseconds) {
  return {
    id,
    answerId: 'answer-id',
    segmentIndex,
    receivedAt: new Date(receivedAtMilliseconds),
    file: {
      id,
      bucket: 'private-audio',
      key: `training-audio/${id}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: BigInt(body.length),
      checksum: createHash('sha256').update(body).digest('hex'),
    },
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function withTemporaryEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withProductionStorageEnvironment(operation) {
  return withTemporaryEnvironment(
    {
      NODE_ENV: 'production',
      S3_ENDPOINT: 'https://minio.test',
      S3_PUBLIC_ENDPOINT: 'https://public-minio.test',
      MINIO_BUCKET: 'general-bucket',
      TRAINING_DOCUMENT_BUCKET: 'document-bucket',
      TRAINING_AUDIO_BUCKET: 'audio-private-bucket',
    },
    operation,
  );
}

function createS3PrivacyFetch(
  anonymousMode,
  bucketPolicy = null,
  bucketAcl = null,
  options = {},
) {
  const storedObjects = new Map();
  const calls = [];
  const signedPrivacyDeleteResults = [];
  let signedPrivacyDeletes = 0;
  const storageFetch = async (urlValue, init = {}) => {
    const url = new URL(String(urlValue));
    const headers = new Headers(init.headers);
    const signed = headers.has('authorization');
    const method = init.method ?? 'GET';
    const operation =
      method === 'GET' && url.searchParams.has('list-type')
        ? 'LIST'
        : method;
    calls.push({ signed, operation, headers, pathname: url.pathname });
    if (!signed) {
      const mode =
        typeof anonymousMode === 'string'
          ? anonymousMode
          : (anonymousMode[operation] ?? 'denied');
      if (mode === 'stored-timeout' && method === 'PUT') {
        storedObjects.set(
          url.pathname,
          Buffer.from(init.body ?? ''),
        );
        throw new DOMException(
          'anonymous probe timed out',
          'TimeoutError',
        );
      }
      if (mode === 'network') {
        throw new TypeError('anonymous probe unavailable');
      }
      if (
        mode === 'public' &&
        method === 'PUT' &&
        options.storeAnonymousPut !== false
      ) {
        storedObjects.set(
          url.pathname,
          Buffer.from(init.body ?? ''),
        );
      }
      if (mode === 'public' && method === 'DELETE') {
        storedObjects.delete(url.pathname);
      }
      return new Response(
        mode === 'public' ? 'public' : 'denied',
        {
          status:
            mode !== 'public'
              ? 403
              : method === 'DELETE'
                ? 204
                : 200,
        },
      );
    }
    if (method === 'GET' && url.searchParams.has('policy')) {
      return bucketPolicy
        ? Response.json(bucketPolicy)
        : new Response(null, { status: 404 });
    }
    if (method === 'GET' && url.searchParams.has('acl')) {
      return bucketAcl
        ? new Response(bucketAcl, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (
      method === 'PUT' &&
      url.pathname.includes('/training-audio/privacy-probe/')
    ) {
      storedObjects.set(url.pathname, {
        body: Buffer.from(init.body ?? ''),
        checksum: headers.get('x-amz-meta-sha256'),
        contentType: headers.get('content-type'),
      });
      return new Response(null, { status: 200 });
    }
    if (
      method === 'HEAD' &&
      url.pathname.includes('/training-audio/privacy-probe/')
    ) {
      const stored = storedObjects.get(url.pathname);
      if (!stored) return new Response(null, { status: 404 });
      const body = Buffer.isBuffer(stored) ? stored : stored.body;
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(body.length),
          'content-type':
            stored.contentType ?? 'application/octet-stream',
          'x-amz-meta-sha256': stored.checksum ?? '',
        },
      });
    }
    if (
      method === 'DELETE' &&
      url.pathname.includes('/training-audio/privacy-probe/')
    ) {
      signedPrivacyDeletes += 1;
      if (
        options.failSignedDeleteNumber === signedPrivacyDeletes
      ) {
        signedPrivacyDeleteResults.push({
          pathname: url.pathname,
          status: 500,
          code: null,
        });
        return new Response('delete failed', { status: 500 });
      }
      const existed = storedObjects.delete(url.pathname);
      if (!existed && options.missingDeleteResponse === '404') {
        signedPrivacyDeleteResults.push({
          pathname: url.pathname,
          status: 404,
          code: null,
        });
        return new Response(null, { status: 404 });
      }
      if (!existed && options.missingDeleteResponse === 'NoSuchKey') {
        signedPrivacyDeleteResults.push({
          pathname: url.pathname,
          status: 400,
          code: 'NoSuchKey',
        });
        return new Response(
          '<Error><Code>NoSuchKey</Code></Error>',
          { status: 400 },
        );
      }
      signedPrivacyDeleteResults.push({
        pathname: url.pathname,
        status: 204,
        code: null,
      });
      return new Response(null, { status: 204 });
    }
    return new Response(null, {
      status: method === 'DELETE' ? 204 : 200,
    });
  };
  storageFetch.calls = calls;
  storageFetch.getStoredProbeKeys = () =>
    [...storedObjects.keys()].filter((key) =>
      key.includes('/training-audio/privacy-probe/'),
    );
  storageFetch.getSignedPrivacyDeleteResults = () =>
    signedPrivacyDeleteResults;
  return storageFetch;
}

function createPublicAcl(group, permission) {
  return [
    '<AccessControlPolicy>',
    '<AccessControlList>',
    '<Grant>',
    '<Grantee>',
    `<URI>http://acs.amazonaws.com/groups/global/${group}</URI>`,
    '</Grantee>',
    `<Permission>${permission}</Permission>`,
    '</Grant>',
    '</AccessControlList>',
    '</AccessControlPolicy>',
  ].join('');
}
