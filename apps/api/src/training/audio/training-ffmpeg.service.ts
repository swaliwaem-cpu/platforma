import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { File } from '@prisma/client';

import { FilesService } from '../../files/files.service';
import { TrainingAudioConfig } from './training-audio.config';
import { TrainingAudioError } from './training-audio.error';
import {
  TRAINING_AUDIO_PROCESS_RUNNER,
  type TrainingAudioProcessRunner,
} from './training-audio-process.runner';

const SILENCE_THRESHOLD_DB = -35;
const LONG_PAUSE_MINIMUM_SECONDS = 0.8;
const TEMP_SCAVENGE_INTERVAL_MS = 5 * 60_000;
const TEMP_DIRECTORY_MAX_AGE_MS = 60 * 60_000;
const TEMP_SCAVENGE_MAX_ENTRIES = 200;

export type TrainingFfmpegSegmentInput = {
  id: string;
  answerId: string;
  segmentIndex: number;
  receivedAt: Date;
  file: Pick<
    File,
    'id' | 'bucket' | 'key' | 'mimeType' | 'sizeBytes' | 'checksum'
  >;
};

export type TrainingPreparedSegment = {
  id: string;
  segmentIndex: number;
  durationMilliseconds: number;
  codec: string;
  channels: number;
  sampleRate: number;
};

export type TrainingPreparedAudio = {
  path: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
  checksum: string;
  durationMilliseconds: number;
  segments: TrainingPreparedSegment[];
  metrics: {
    version: 1;
    segmentCount: number;
    totalOriginalBytes: number;
    totalDurationSeconds: number;
    segmentDurationsSeconds: number[];
    technicalIntervalsSeconds: number[];
    silence: {
      thresholdDb: number;
      minimumPauseSeconds: number;
      pauseCount: number;
      totalPauseSeconds: number;
      maximumPauseSeconds: number;
      speechDurationSeconds: number;
      silenceRatio: number;
    };
  };
};

@Injectable()
export class TrainingFfmpegService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingFfmpegService.name);
  private readonly activeDirectories = new Set<string>();
  private scavengerInterval: NodeJS.Timeout | null = null;
  private scavengerRunning = false;

  constructor(
    private readonly config: TrainingAudioConfig,
    private readonly files: FilesService,
    @Inject(TRAINING_AUDIO_PROCESS_RUNNER)
    private readonly processRunner: TrainingAudioProcessRunner,
  ) {}

  async onModuleInit() {
    await this.ensureTempRoot();
    await this.scavengeTempDirectories();
    this.scavengerInterval = setInterval(() => {
      void this.scavengeTempDirectories();
    }, TEMP_SCAVENGE_INTERVAL_MS);
    this.scavengerInterval.unref();
  }

  onModuleDestroy() {
    if (this.scavengerInterval) {
      clearInterval(this.scavengerInterval);
      this.scavengerInterval = null;
    }
  }

  async withPreparedAudio<T>(
    inputs: TrainingFfmpegSegmentInput[],
    operation: (prepared: TrainingPreparedAudio) => Promise<T>,
  ) {
    const segments = validateSegments(inputs, this.config);
    await this.ensureTempRoot();
    const directory = await mkdtemp(
      join(this.config.tempDir, 'answer-'),
    ).catch(() => {
      throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
    });
    this.activeDirectories.add(directory);

    try {
      const normalizedPaths: string[] = [];
      const preparedSegments: TrainingPreparedSegment[] = [];
      for (const segment of segments) {
        const extension =
          segment.file.mimeType === 'audio/wav' ? '.wav' : '.ogg';
        const sourceName = `segment-${String(segment.segmentIndex).padStart(
          4,
          '0',
        )}${extension}`;
        const sourcePath = join(directory, sourceName);
        const normalizedName = `segment-${String(
          segment.segmentIndex,
        ).padStart(4, '0')}.wav`;
        const normalizedPath = join(directory, normalizedName);
        const body = await this.files.readStoredFile(segment.file);
        if (
          body.length === 0 ||
          body.length > this.config.maxSegmentBytes ||
          (segment.file.sizeBytes !== null &&
            BigInt(body.length) !== segment.file.sizeBytes)
        ) {
          throw new TrainingAudioError('AUDIO_BYTE_COUNT_MISMATCH', false);
        }
        const checksum = createHash('sha256').update(body).digest('hex');
        if (segment.file.checksum && checksum !== segment.file.checksum) {
          throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
        }
        await writeFile(sourcePath, body, { mode: 0o600 }).catch(() => {
          throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
        });

        const metadata = await this.probeAudio(
          directory,
          sourceName,
          segment.file.mimeType,
        );
        await this.runFfmpeg(directory, [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-filter_threads',
          '1',
          '-i',
          sourceName,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          '-y',
          normalizedName,
        ]);
        normalizedPaths.push(normalizedPath);
        preparedSegments.push({
          id: segment.id,
          segmentIndex: segment.segmentIndex,
          durationMilliseconds: Math.round(metadata.durationSeconds * 1_000),
          codec: metadata.codec,
          channels: metadata.channels,
          sampleRate: metadata.sampleRate,
        });
      }

      const manifestName = 'concat.txt';
      const manifest = normalizedPaths
        .map((path) => `file '${basename(path)}'`)
        .join('\n');
      await writeFile(join(directory, manifestName), `${manifest}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      }).catch(() => {
        throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
      });

      const outputName = 'answer-normalized.wav';
      const outputPath = join(directory, outputName);
      await this.runFfmpeg(directory, [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        manifestName,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        '-y',
        outputName,
      ]);

      const mergedMetadata = await this.probeAudio(
        directory,
        outputName,
        'audio/wav',
      );
      if (
        mergedMetadata.durationSeconds <= 0 ||
        mergedMetadata.durationSeconds >
          this.config.maxAnswerDurationSeconds
      ) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      const outputStat = await stat(outputPath).catch(() => {
        throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
      });
      if (
        outputStat.size <= 0 ||
        outputStat.size > this.config.maxAnswerBytes
      ) {
        throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
      }
      const outputBuffer = await readFile(outputPath).catch(() => {
        throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
      });
      const silence = await this.detectSilence(
        directory,
        outputName,
        mergedMetadata.durationSeconds,
      );
      const durationMilliseconds = Math.round(
        mergedMetadata.durationSeconds * 1_000,
      );
      const technicalIntervalsSeconds = calculateTechnicalIntervals(
        segments,
        preparedSegments,
      );
      const prepared: TrainingPreparedAudio = {
        path: outputPath,
        mimeType: 'audio/wav',
        sizeBytes: outputStat.size,
        checksum: createHash('sha256').update(outputBuffer).digest('hex'),
        durationMilliseconds,
        segments: preparedSegments,
        metrics: {
          version: 1,
          segmentCount: preparedSegments.length,
          totalOriginalBytes: segments.reduce(
            (total, segment) =>
              total + Number(segment.file.sizeBytes ?? 0n),
            0,
          ),
          totalDurationSeconds: roundMetric(
            mergedMetadata.durationSeconds,
          ),
          segmentDurationsSeconds: preparedSegments.map((segment) =>
            roundMetric(segment.durationMilliseconds / 1_000),
          ),
          technicalIntervalsSeconds,
          silence,
        },
      };
      return await operation(prepared);
    } finally {
      await this.cleanupTempDirectory(directory, 'pipeline-finally');
      this.activeDirectories.delete(directory);
    }
  }

  async scavengeTempDirectories(olderThanMs = TEMP_DIRECTORY_MAX_AGE_MS) {
    if (this.scavengerRunning) return;
    this.scavengerRunning = true;
    try {
      await this.ensureTempRoot();
      const entries = await readdir(this.config.tempDir, {
        withFileTypes: true,
      });
      const now = Date.now();
      for (const entry of entries.slice(0, TEMP_SCAVENGE_MAX_ENTRIES)) {
        if (
          !entry.name.startsWith('answer-') ||
          !entry.isDirectory() ||
          entry.isSymbolicLink()
        ) {
          continue;
        }
        const candidate = resolve(this.config.tempDir, entry.name);
        if (
          dirname(candidate) !== resolve(this.config.tempDir) ||
          this.activeDirectories.has(candidate)
        ) {
          continue;
        }
        try {
          const metadata = await lstat(candidate);
          if (
            metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            now - metadata.mtimeMs < olderThanMs
          ) {
            continue;
          }
          await rm(candidate, { recursive: true, force: true });
        } catch (error) {
          this.logCleanupError(
            'temp-scavenger-entry-failed',
            entry.name,
            error,
          );
        }
      }
    } catch (error) {
      this.logCleanupError(
        'temp-scavenger-scan-failed',
        null,
        error,
      );
    } finally {
      this.scavengerRunning = false;
    }
  }

  private async ensureTempRoot() {
    await mkdir(this.config.tempDir, {
      recursive: true,
      mode: 0o700,
    }).catch(() => {
      throw new TrainingAudioError('AUDIO_TEMP_IO_FAILED', true);
    });
  }

  private async cleanupTempDirectory(
    directory: string,
    context: string,
  ) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      this.logCleanupError(context, basename(directory), error);
    }
  }

  private logCleanupError(
    event: string,
    directory: string | null,
    error: unknown,
  ) {
    this.logger.warn(
      JSON.stringify({
        event,
        directory,
        errorCode: readFilesystemErrorCode(error),
      }),
    );
  }

  private async probeAudio(
    cwd: string,
    inputName: string,
    mimeType: string | null,
  ) {
    const result = await this.processRunner.run({
      command: 'ffprobe',
      cwd,
      timeoutMs: this.config.ffmpegTimeoutMs,
      args: [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name,channels,sample_rate:format=duration',
        '-of',
        'json',
        inputName,
      ],
    });
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    const metadata = readProbeMetadata(payload);
    if (
      (mimeType === 'audio/ogg' && metadata.codec !== 'opus') ||
      (mimeType === 'audio/wav' &&
        !metadata.codec.startsWith('pcm_'))
    ) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    return metadata;
  }

  private async runFfmpeg(cwd: string, args: string[]) {
    await this.processRunner.run({
      command: 'ffmpeg',
      args,
      cwd,
      timeoutMs: this.config.ffmpegTimeoutMs,
    });
  }

  private async detectSilence(
    cwd: string,
    inputName: string,
    durationSeconds: number,
  ) {
    const result = await this.processRunner.run({
      command: 'ffmpeg',
      cwd,
      timeoutMs: this.config.ffmpegTimeoutMs,
      args: [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'info',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-i',
        inputName,
        '-af',
        `silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${LONG_PAUSE_MINIMUM_SECONDS}`,
        '-f',
        'null',
        '-',
      ],
    });
    const pauses = parseSilenceIntervals(result.stderr, durationSeconds);
    const totalPauseSeconds = pauses.reduce(
      (total, pause) => total + pause.duration,
      0,
    );
    const maximumPauseSeconds = pauses.reduce(
      (maximum, pause) => Math.max(maximum, pause.duration),
      0,
    );
    return {
      thresholdDb: SILENCE_THRESHOLD_DB,
      minimumPauseSeconds: LONG_PAUSE_MINIMUM_SECONDS,
      pauseCount: pauses.length,
      totalPauseSeconds: roundMetric(totalPauseSeconds),
      maximumPauseSeconds: roundMetric(maximumPauseSeconds),
      speechDurationSeconds: roundMetric(
        Math.max(0, durationSeconds - totalPauseSeconds),
      ),
      silenceRatio: roundMetric(
        durationSeconds > 0 ? totalPauseSeconds / durationSeconds : 0,
      ),
    };
  }
}

function validateSegments(
  inputs: TrainingFfmpegSegmentInput[],
  config: TrainingAudioConfig,
) {
  if (inputs.length === 0 || inputs.length > config.maxSegments) {
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }
  const sorted = [...inputs].sort(
    (left, right) => left.segmentIndex - right.segmentIndex,
  );
  const answerId = sorted[0]!.answerId;
  let totalBytes = 0;
  for (const [index, segment] of sorted.entries()) {
    if (
      segment.answerId !== answerId ||
      segment.segmentIndex !== index + 1 ||
      !segment.file.bucket ||
      !segment.file.key ||
      !segment.file.mimeType ||
      segment.file.sizeBytes === null ||
      segment.file.sizeBytes <= 0n
    ) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    totalBytes += Number(segment.file.sizeBytes);
  }
  if (totalBytes > config.maxAnswerBytes) {
    throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
  }
  return sorted;
}

function readProbeMetadata(value: unknown) {
  const payload = asRecord(value);
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const stream = asRecord(streams[0]);
  const format = asRecord(payload?.format);
  const codec = stream?.codec_name;
  const channels = Number(stream?.channels);
  const sampleRate = Number(stream?.sample_rate);
  const durationSeconds = Number(format?.duration);
  if (
    typeof codec !== 'string' ||
    !codec ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1_000 ||
    sampleRate > 384_000 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }
  return { codec, channels, sampleRate, durationSeconds };
}

function parseSilenceIntervals(stderr: string, durationSeconds: number) {
  const pauses: Array<{ start: number; end: number; duration: number }> = [];
  let currentStart: number | null = null;
  for (const line of stderr.split(/\r?\n/u)) {
    const startMatch = /silence_start:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }
    const endMatch =
      /silence_end:\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*silence_duration:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(
        line,
      );
    if (!endMatch) continue;
    const end = Number(endMatch[1]);
    const reportedDuration = Number(endMatch[2]);
    const start =
      currentStart === null ? Math.max(0, end - reportedDuration) : currentStart;
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start &&
      end <= durationSeconds + 0.1
    ) {
      pauses.push({
        start,
        end,
        duration: Math.max(0, end - start),
      });
    }
    currentStart = null;
  }
  if (currentStart !== null && currentStart < durationSeconds) {
    pauses.push({
      start: currentStart,
      end: durationSeconds,
      duration: durationSeconds - currentStart,
    });
  }
  return pauses;
}

function calculateTechnicalIntervals(
  inputs: TrainingFfmpegSegmentInput[],
  prepared: TrainingPreparedSegment[],
) {
  const durations = new Map(
    prepared.map((segment) => [
      segment.id,
      segment.durationMilliseconds,
    ]),
  );
  const intervals: number[] = [];
  for (let index = 1; index < inputs.length; index += 1) {
    const previous = inputs[index - 1]!;
    const current = inputs[index]!;
    const previousDuration = durations.get(previous.id) ?? 0;
    const previousEnd = previous.receivedAt.getTime() + previousDuration;
    intervals.push(
      roundMetric(
        Math.max(0, current.receivedAt.getTime() - previousEnd) / 1_000,
      ),
    );
  }
  return intervals;
}

function roundMetric(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFilesystemErrorCode(error: unknown) {
  return error instanceof Error && 'code' in error
    ? String(error.code).slice(0, 64)
    : 'UNKNOWN';
}
