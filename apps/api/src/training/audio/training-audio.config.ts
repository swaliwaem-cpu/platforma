import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { Injectable } from '@nestjs/common';

const MEBIBYTE = 1024 * 1024;

@Injectable()
export class TrainingAudioConfig {
  readonly maxSegmentBytes: number;
  readonly maxAnswerBytes: number;
  readonly maxSegments: number;
  readonly maxAnswerDurationSeconds: number;
  readonly downloadTimeoutMs: number;
  readonly ffmpegTimeoutMs: number;
  readonly workerPollMs: number;
  readonly workerConcurrency: number;
  readonly workerLeaseMs: number;
  readonly workerHeartbeatMs: number;
  readonly workerDrainTimeoutMs: number;
  readonly tempDir: string;
  readonly retentionDays: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.maxSegmentBytes = readBoundedInteger(
      'TRAINING_AUDIO_MAX_BYTES',
      env.TRAINING_AUDIO_MAX_BYTES,
      20 * MEBIBYTE,
      64 * 1024,
      20 * MEBIBYTE,
    );
    this.maxAnswerBytes = readBoundedInteger(
      'TRAINING_AUDIO_MAX_ANSWER_BYTES',
      env.TRAINING_AUDIO_MAX_ANSWER_BYTES,
      80 * MEBIBYTE,
      this.maxSegmentBytes,
      256 * MEBIBYTE,
    );
    this.maxSegments = readBoundedInteger(
      'TRAINING_AUDIO_MAX_SEGMENTS',
      env.TRAINING_AUDIO_MAX_SEGMENTS,
      32,
      1,
      100,
    );
    this.maxAnswerDurationSeconds = readBoundedInteger(
      'TRAINING_AUDIO_MAX_DURATION_SECONDS',
      env.TRAINING_AUDIO_MAX_DURATION_SECONDS,
      600,
      60,
      1_800,
    );
    this.downloadTimeoutMs = readBoundedInteger(
      'TRAINING_AUDIO_DOWNLOAD_TIMEOUT_MS',
      env.TRAINING_AUDIO_DOWNLOAD_TIMEOUT_MS,
      30_000,
      1_000,
      120_000,
    );
    this.ffmpegTimeoutMs = readBoundedInteger(
      'TRAINING_FFMPEG_TIMEOUT_MS',
      env.TRAINING_FFMPEG_TIMEOUT_MS,
      90_000,
      1_000,
      300_000,
    );
    this.workerPollMs = readBoundedInteger(
      'TRAINING_AUDIO_WORKER_POLL_MS',
      env.TRAINING_AUDIO_WORKER_POLL_MS,
      500,
      50,
      60_000,
    );
    this.workerConcurrency = readBoundedInteger(
      'TRAINING_AUDIO_WORKER_CONCURRENCY',
      env.TRAINING_AUDIO_WORKER_CONCURRENCY,
      2,
      1,
      16,
    );
    this.workerLeaseMs = readBoundedInteger(
      'TRAINING_AUDIO_WORKER_LEASE_MS',
      env.TRAINING_AUDIO_WORKER_LEASE_MS,
      120_000,
      1_000,
      600_000,
    );
    this.workerHeartbeatMs = readBoundedInteger(
      'TRAINING_AUDIO_WORKER_HEARTBEAT_MS',
      env.TRAINING_AUDIO_WORKER_HEARTBEAT_MS,
      5_000,
      100,
      60_000,
    );
    this.workerDrainTimeoutMs = readBoundedInteger(
      'TRAINING_AUDIO_WORKER_DRAIN_TIMEOUT_MS',
      env.TRAINING_AUDIO_WORKER_DRAIN_TIMEOUT_MS,
      30_000,
      100,
      180_000,
    );
    if (this.workerHeartbeatMs >= this.workerLeaseMs) {
      throw new Error(
        'TRAINING_AUDIO_WORKER_HEARTBEAT_MS must be less than TRAINING_AUDIO_WORKER_LEASE_MS',
      );
    }

    this.tempDir =
      env.TRAINING_AUDIO_TEMP_DIR?.trim() ||
      join(tmpdir(), 'platforma-training-audio');
    if (!isAbsolute(this.tempDir)) {
      throw new Error('TRAINING_AUDIO_TEMP_DIR must be an absolute path');
    }

    this.retentionDays = readBoundedInteger(
      'TRAINING_AUDIO_RETENTION_DAYS',
      env.TRAINING_AUDIO_RETENTION_DAYS,
      0,
      0,
      0,
    );
  }
}

function readBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
