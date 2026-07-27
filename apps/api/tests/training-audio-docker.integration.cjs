require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  mkdtemp,
  readFile,
  readdir,
  rm,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  PrismaClient,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingAudioUploadState,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  FilesService,
} = require('../dist/files/files.service.js');
const {
  S3StorageService,
} = require('../dist/files/s3-storage.service.js');
const {
  TrainingAudioConfig,
} = require('../dist/training/audio/training-audio.config.js');
const {
  NodeTrainingAudioProcessRunner,
} = require('../dist/training/audio/training-audio-process.runner.js');
const {
  TrainingAudioWorkerService,
} = require('../dist/training/audio/training-audio-worker.service.js');
const {
  TrainingFfmpegService,
} = require('../dist/training/audio/training-ffmpeg.service.js');

const prisma = new PrismaClient();
const storage = new S3StorageService();
const files = new FilesService(prisma, storage);
const config = new TrainingAudioConfig();
const processRunner = new NodeTrainingAudioProcessRunner();
const crashBody = Buffer.from(
  'OggS\0platforma-training-audio-crash-fixture',
  'utf8',
);

void main();

async function main() {
  let exitCode = 0;
  try {
    console.log('Training audio Docker integration started');
    await prisma.$connect();
    await storage.onModuleInit();
    await verifyStorageContract();
    console.log('MinIO put/head/get/delete passed');
    await verifyPrivateAndPublicBucketPolicy();
    console.log('MinIO private/public privacy probes passed');
    await verifyRealFfmpegPipeline();
    console.log('Real OGG/Opus to WAV ffmpeg smoke passed');
    await verifyRealProcessTimeouts();
    console.log('Real ffmpeg and process-group timeouts passed');
    await verifyCrashRecovery(false);
    console.log('Crash-after-upload active recovery passed');
    await verifyCrashRecovery(true);
    console.log('Crash-after-upload terminal cleanup passed');
    await assertAudioBucketEmpty();
    console.log(
      'Training audio Docker integration passed: MinIO, crash recovery, cleanup, ffmpeg and process groups',
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  process.exitCode = exitCode;
}

async function verifyStorageContract() {
  const bucket = storage.getTrainingAudioBucket();
  const key = `training-audio/docker-contract/${randomUUID()}.wav`;
  const body = Buffer.from('real-minio-put-head-get-delete');
  const checksum = sha256(body);
  await files.putPrivateTrainingAudioObject({
    bucket,
    key,
    body,
    mimeType: 'audio/wav',
    checksum,
  });
  assert.deepEqual(
    await storage.headObject(key, bucket),
    {
      exists: true,
      contentLength: body.length,
      contentType: 'audio/wav',
      sha256: checksum,
    },
  );
  assert.deepEqual(
    await storage.getObject(key, bucket),
    body,
  );
  await files.deletePrivateTrainingAudioObject(bucket, key);
  assert.equal(
    (
      await storage.headObject(
        key,
        bucket,
      )
    ).exists,
    false,
  );
}

async function verifyPrivateAndPublicBucketPolicy() {
  await storage.verifyTrainingAudioBucketPrivacy();
  const bucket = storage.getTrainingAudioBucket();
  const publicKey = `training-audio/public-probe/${randomUUID()}`;
  const body = Buffer.from('must-never-be-public');
  await storage.putObject({
    bucket,
    key: publicKey,
    body,
    contentType: 'application/octet-stream',
    metadata: { sha256: sha256(body) },
  });
  const policy = Buffer.from(
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    }),
  );
  const policyQuery = new URLSearchParams({ policy: '' });
  const putPolicy = await storage.signedFetch({
    method: 'PUT',
    bucket,
    query: policyQuery,
    body: policy,
    contentType: 'application/json',
    contentLength: policy.length,
  });
  assert.equal(putPolicy.ok, true, await putPolicy.text());
  try {
    const anonymous = await fetch(
      storage.buildObjectUrl(bucket, publicKey),
      { redirect: 'error' },
    );
    assert.equal(anonymous.status, 200);
    assert.deepEqual(
      Buffer.from(await anonymous.arrayBuffer()),
      body,
    );
    await assert.rejects(
      () => storage.verifyTrainingAudioBucketPrivacy(),
      /TRAINING_AUDIO_BUCKET permits anonymous object GET/,
    );
  } finally {
    const deletePolicy = await storage.signedFetch({
      method: 'DELETE',
      bucket,
      query: policyQuery,
    });
    assert.equal(
      deletePolicy.ok || deletePolicy.status === 404,
      true,
    );
    await storage.deleteObject(publicKey, bucket);
  }
  await storage.verifyTrainingAudioBucketPrivacy();

  const listPolicy = Buffer.from(
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:ListBucket',
          Resource: [`arn:aws:s3:::${bucket}`],
        },
      ],
    }),
  );
  const putListPolicy = await storage.signedFetch({
    method: 'PUT',
    bucket,
    query: policyQuery,
    body: listPolicy,
    contentType: 'application/json',
    contentLength: listPolicy.length,
  });
  assert.equal(
    putListPolicy.ok,
    true,
    await putListPolicy.text(),
  );
  try {
    const anonymousList = await fetch(
      storage.buildObjectUrl(
        bucket,
        undefined,
        new URLSearchParams({
          'list-type': '2',
          'max-keys': '1',
        }),
      ),
      { redirect: 'error' },
    );
    assert.equal(anonymousList.status, 200);
    await assert.rejects(
      () => storage.verifyTrainingAudioBucketPrivacy(),
      /TRAINING_AUDIO_BUCKET permits anonymous bucket LIST/,
    );
  } finally {
    const deletePolicy = await storage.signedFetch({
      method: 'DELETE',
      bucket,
      query: policyQuery,
    });
    assert.equal(
      deletePolicy.ok || deletePolicy.status === 404,
      true,
    );
  }
  await storage.verifyTrainingAudioBucketPrivacy();

  const anonymousWriteKey =
    `training-audio/public-write-probe/${randomUUID()}`;
  const anonymousWriteBody = Buffer.from(
    'anonymous-write-must-be-rejected',
  );
  const writePolicy = Buffer.from(
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:PutObject',
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    }),
  );
  const putWritePolicy = await storage.signedFetch({
    method: 'PUT',
    bucket,
    query: policyQuery,
    body: writePolicy,
    contentType: 'application/json',
    contentLength: writePolicy.length,
  });
  assert.equal(
    putWritePolicy.ok,
    true,
    await putWritePolicy.text(),
  );
  try {
    const anonymousPut = await fetch(
      storage.buildObjectUrl(bucket, anonymousWriteKey),
      {
        method: 'PUT',
        body: anonymousWriteBody,
        redirect: 'error',
      },
    );
    assert.equal(anonymousPut.ok, true);
    assert.deepEqual(
      await storage.getObject(anonymousWriteKey, bucket),
      anonymousWriteBody,
    );
    await assert.rejects(
      () => storage.verifyTrainingAudioBucketPrivacy(),
      /TRAINING_AUDIO_BUCKET permits anonymous object PUT/,
    );
  } finally {
    const deletePolicy = await storage.signedFetch({
      method: 'DELETE',
      bucket,
      query: policyQuery,
    });
    assert.equal(
      deletePolicy.ok || deletePolicy.status === 404,
      true,
    );
    await storage.deleteObject(anonymousWriteKey, bucket);
    assert.equal(
      (await storage.headObject(anonymousWriteKey, bucket)).exists,
      false,
    );
  }
  await storage.verifyTrainingAudioBucketPrivacy();
}

async function verifyRealFfmpegPipeline() {
  const generationDirectory = await mkdtemp(
    path.join(tmpdir(), 'training-audio-fixtures-'),
  );
  const ffmpeg = new TrainingFfmpegService(
    config,
    files,
    processRunner,
  );
  const answerId = randomUUID();
  const storedKeys = [];
  try {
    const inputs = [];
    for (const [index, frequency] of [440, 660].entries()) {
      const fileName = `synthetic-${index + 1}.ogg`;
      await processRunner.run({
        command: 'ffmpeg',
        cwd: generationDirectory,
        timeoutMs: 10_000,
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${frequency}:sample_rate=48000`,
          '-t',
          '0.35',
          '-ac',
          '1',
          '-c:a',
          'libopus',
          '-b:a',
          '24k',
          '-f',
          'ogg',
          '-y',
          fileName,
        ],
      });
      const body = await readFile(
        path.join(generationDirectory, fileName),
      );
      const key = `training-audio/docker-ffmpeg/${answerId}/${fileName}`;
      const checksum = sha256(body);
      storedKeys.push(key);
      await files.putPrivateTrainingAudioObject({
        bucket: storage.getTrainingAudioBucket(),
        key,
        body,
        mimeType: 'audio/ogg',
        checksum,
      });
      inputs.push({
        id: randomUUID(),
        answerId,
        segmentIndex: index + 1,
        receivedAt: new Date(Date.now() + index),
        file: {
          id: randomUUID(),
          bucket: storage.getTrainingAudioBucket(),
          key,
          mimeType: 'audio/ogg',
          sizeBytes: BigInt(body.length),
          checksum,
        },
      });
    }

    await ffmpeg.withPreparedAudio(inputs, async (prepared) => {
      assert.equal(prepared.segments.length, 2);
      assert.equal(prepared.metrics.segmentCount, 2);
      assert.equal(prepared.mimeType, 'audio/wav');
      assert.equal(prepared.sizeBytes > 0, true);
      const probe = await processRunner.run({
        command: 'ffprobe',
        cwd: path.dirname(prepared.path),
        timeoutMs: 5_000,
        args: [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_name,channels,sample_rate:format=duration',
          '-of',
          'json',
          path.basename(prepared.path),
        ],
      });
      const metadata = JSON.parse(probe.stdout);
      const stream = metadata.streams[0];
      const duration = Number(metadata.format.duration);
      assert.equal(stream.codec_name, 'pcm_s16le');
      assert.equal(Number(stream.sample_rate), 16_000);
      assert.equal(stream.channels, 1);
      assert.equal(Math.abs(duration - 0.7) <= 0.15, true);
      assert.equal(
        prepared.checksum,
        sha256(await readFile(prepared.path)),
      );
    });
    const remainingTempEntries = await readdir(config.tempDir);
    assert.equal(
      remainingTempEntries.some((entry) =>
        entry.startsWith('answer-'),
      ),
      false,
    );
  } finally {
    ffmpeg.onModuleDestroy();
    for (const key of storedKeys) {
      await files.deletePrivateTrainingAudioObject(
        storage.getTrainingAudioBucket(),
        key,
      );
    }
    await rm(generationDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function verifyRealProcessTimeouts() {
  await assert.rejects(
    () =>
      processRunner.run({
        command: 'ffmpeg',
        cwd: tmpdir(),
        timeoutMs: 100,
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=16000:cl=mono',
          '-t',
          '60',
          '-f',
          'null',
          '-',
        ],
      }),
    (error) => error?.code === 'FFMPEG_TIMEOUT',
  );

  if (process.platform === 'win32') return;
  const fixtureDirectory = await mkdtemp(
    path.join(tmpdir(), 'training-audio-process-tree-'),
  );
  const statePath = path.join(fixtureDirectory, 'pids.json');
  const script = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e',",
    JSON.stringify(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ),
    "],{stdio:'ignore'});",
    `writeFileSync(${JSON.stringify(
      statePath,
    )},JSON.stringify({parent:process.pid,child:child.pid}));`,
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join('');
  let pids = null;
  try {
    await assert.rejects(() =>
      processRunner.run({
        command: process.execPath,
        cwd: fixtureDirectory,
        timeoutMs: 200,
        args: ['-e', script],
      }),
    );
    pids = JSON.parse(await readFile(statePath, 'utf8'));
    assertProcessMissing(pids.parent);
    assertProcessMissing(pids.child);
    assertProcessGroupMissing(pids.parent);
  } finally {
    if (pids) {
      try {
        process.kill(-pids.parent, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await rm(fixtureDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function verifyCrashRecovery(terminal) {
  const fixture = await createCrashFixture(
    terminal ? 'terminal' : 'active',
  );
  const crashed = await runCrashWorker();
  assert.equal(crashed.code, null);
  assert.equal(crashed.signal, 'SIGKILL');

  const pending = await prisma.trainingAudioUploadIntent.findUnique({
    where: { segmentId: fixture.segmentId },
  });
  assert.ok(pending);
  assert.equal(pending.state, TrainingAudioUploadState.PENDING);
  assert.equal(pending.committedFileId, null);
  const object = await storage.headObject(
    pending.objectKey,
    pending.bucket,
  );
  assert.deepEqual(object, {
    exists: true,
    contentLength: crashBody.length,
    contentType: 'audio/ogg',
    sha256: sha256(crashBody),
  });
  assert.equal(
    await prisma.file.count({
      where: {
        bucket: pending.bucket,
        key: pending.objectKey,
      },
    }),
    0,
  );

  const rotatedBucket =
    `training-audio-rotated-${randomUUID().slice(0, 12)}`;
  const {
    storage: restartedStorage,
    files: restartedFiles,
  } = await createStorageForAudioBucket(rotatedBucket);
  assert.equal(
    restartedStorage.getTrainingAudioBucket(),
    rotatedBucket,
  );
  const rotatedObject = Buffer.from(
    'same key in current bucket B must remain untouched',
  );
  await restartedStorage.putObject({
    bucket: rotatedBucket,
    key: pending.objectKey,
    body: rotatedObject,
    contentType: 'audio/wav',
    metadata: { sha256: sha256(rotatedObject) },
  });

  if (terminal) {
    await prisma.trainingAttempt.update({
      where: { id: fixture.attemptId },
      data: {
        status: TrainingAttemptStatus.TECHNICAL_FAILURE,
      },
    });
  }
  const staleAt = new Date(Date.now() - 5_000);
  await prisma.trainingJob.update({
    where: { id: fixture.jobId },
    data: {
      lockedAt: staleAt,
      heartbeatAt: staleAt,
    },
  });
  const provider = {
    calls: 0,
    async downloadVoice() {
      this.calls += 1;
      return { body: crashBody, mimeType: 'audio/ogg' };
    },
  };
  const ffmpeg = {
    async withPreparedAudio() {
      throw new Error('ffmpeg must not run in download recovery');
    },
  };
  const worker = new TrainingAudioWorkerService(
    prisma,
    config,
    restartedFiles,
    ffmpeg,
    provider,
  );
  await worker.drainNow();
  await worker.drainNow();

  const recoveredIntent =
    await prisma.trainingAudioUploadIntent.findUnique({
      where: { id: pending.id },
    });
  const segment = await prisma.trainingVoiceSegment.findUnique({
    where: { id: fixture.segmentId },
  });
  if (terminal) {
    assert.equal(
      recoveredIntent.state,
      TrainingAudioUploadState.CLEANED,
    );
    assert.equal(segment.originalFileId, null);
    assert.equal(
      (
        await restartedStorage.headObject(
          pending.objectKey,
          pending.bucket,
        )
      ).exists,
      false,
    );
    const cleanup = await prisma.trainingJob.findFirst({
      where: {
        kind: TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT,
        payloadJson: {
          path: ['intentId'],
          equals: pending.id,
        },
      },
    });
    assert.equal(cleanup.status, TrainingJobStatus.SUCCEEDED);
  } else {
    assert.equal(
      recoveredIntent.state,
      TrainingAudioUploadState.COMMITTED,
    );
    assert.ok(segment.originalFileId);
    assert.equal(
      await prisma.file.count({
        where: {
          bucket: pending.bucket,
          key: pending.objectKey,
        },
      }),
      1,
    );
    const persistedFile = await prisma.file.findFirst({
      where: {
        bucket: pending.bucket,
        key: pending.objectKey,
      },
    });
    assert.equal(persistedFile.bucket, pending.bucket);
    await worker.drainNow();
    assert.equal(
      await prisma.file.count({
        where: {
          bucket: pending.bucket,
          key: pending.objectKey,
        },
      }),
      1,
    );
    await restartedFiles.deletePrivateTrainingAudioObject(
      pending.bucket,
      pending.objectKey,
    );
  }
  assert.deepEqual(
    await restartedStorage.getObject(
      pending.objectKey,
      rotatedBucket,
    ),
    rotatedObject,
  );
  await restartedStorage.deleteObject(
    pending.objectKey,
    rotatedBucket,
  );
  assert.equal(
    (
      await restartedStorage.headObject(
        pending.objectKey,
        rotatedBucket,
      )
    ).exists,
    false,
  );
}

async function createStorageForAudioBucket(bucket) {
  const previousBucket = process.env.TRAINING_AUDIO_BUCKET;
  process.env.TRAINING_AUDIO_BUCKET = bucket;
  try {
    const restartedStorage = new S3StorageService();
    await restartedStorage.onModuleInit();
    return {
      storage: restartedStorage,
      files: new FilesService(prisma, restartedStorage),
    };
  } finally {
    if (previousBucket === undefined) {
      delete process.env.TRAINING_AUDIO_BUCKET;
    } else {
      process.env.TRAINING_AUDIO_BUCKET = previousBucket;
    }
  }
}

async function createCrashFixture(label) {
  const unique = `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const role = await prisma.role.create({
    data: { name: `training-audio-docker-${unique}` },
  });
  const user = await prisma.user.create({
    data: {
      email: `training-audio-docker-${unique}@example.test`,
      passwordHash: 'not-used',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-audio-docker-${unique}`,
      title: 'Training audio crash recovery',
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
    },
  });
  const question = await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'Crash recovery',
      position: 1,
      maxScore: 55,
    },
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedById: user.id,
      publishedAt: new Date(),
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: {
      status: TrainingProjectStatus.OPEN,
      activeVersionId: version.id,
    },
  });
  const attempt = await prisma.trainingAttempt.create({
    data: {
      userId: user.id,
      projectId: project.id,
      projectVersionId: version.id,
      attemptNumber: 1,
      status: TrainingAttemptStatus.PROCESSING_MAIN,
      expiresAt: new Date(Date.now() + 60_000),
      graceExpiresAt: new Date(Date.now() + 120_000),
      settingsSnapshotJson: {},
    },
  });
  const attemptQuestion =
    await prisma.trainingAttemptQuestion.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        sequence: 1,
        status: TrainingAttemptQuestionStatus.PROCESSING,
      },
    });
  const answer = await prisma.trainingAnswer.create({
    data: {
      attemptQuestionId: attemptQuestion.id,
      status: TrainingAnswerStatus.DOWNLOADING,
    },
  });
  const segment = await prisma.trainingVoiceSegment.create({
    data: {
      answerId: answer.id,
      segmentIndex: 1,
      telegramUpdateId: BigInt(
        Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
      ),
      telegramMessageId: BigInt(
        Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
      ),
      telegramChatId: BigInt(
        Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
      ),
      telegramFileId: `docker-crash-${unique}`,
      fileUniqueId: `docker-crash-${unique}`,
      durationSeconds: 1,
    },
  });
  const job = await prisma.trainingJob.create({
    data: {
      kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
      status: TrainingJobStatus.PENDING,
      payloadJson: {
        attemptId: attempt.id,
        answerId: answer.id,
        segmentId: segment.id,
      },
      idempotencyKey: `training-audio-docker-crash:${segment.id}`,
      runAt: new Date(),
      maxAttempts: 5,
    },
  });
  return {
    attemptId: attempt.id,
    segmentId: segment.id,
    jobId: job.id,
  };
}

function runCrashWorker() {
  return new Promise((resolve, reject) => {
    const fixturePath = path.resolve(
      __dirname,
      'fixtures/training-audio-crash-worker.cjs',
    );
    const child = spawn(process.execPath, [fixturePath], {
      env: {
        ...process.env,
        TRAINING_AUDIO_CRASH_BODY: crashBody.toString('base64'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function assertAudioBucketEmpty() {
  const response = await storage.signedFetch({
    method: 'GET',
    bucket: storage.getTrainingAudioBucket(),
    query: new URLSearchParams({
      'list-type': '2',
      'max-keys': '1000',
    }),
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  assert.equal(/<Key>/u.test(body), false, body);
}

function assertProcessMissing(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === 'ESRCH',
  );
}

function assertProcessGroupMissing(pid) {
  assert.throws(
    () => process.kill(-pid, 0),
    (error) => error?.code === 'ESRCH',
  );
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}
