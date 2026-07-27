require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const {
  mkdtemp,
  readFile,
  rm,
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
  TrainingAudioError,
} = require('../dist/training/audio/training-audio.error.js');
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
});

test('Telegram voice provider downloads valid Ogg Opus and checks every byte count', async () => {
  const body = oggOpusFixture();
  const calls = [];
  const provider = new FetchTrainingTelegramAudioProvider(
    '123456:secret-token',
    config(),
    'https://telegram.invalid',
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
        'https://telegram.invalid',
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
    'https://telegram.invalid',
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
        'https://telegram.invalid',
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
    'https://telegram.invalid',
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
            : sourceName === 'segment-0001.wav'
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
