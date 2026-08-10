export const OPENAI_TRANSCRIPTION_HARD_MAX_BYTES = 25 * 1024 * 1024;

const DEFAULT_MAX_DURATION_SECONDS = 30 * 60;
const DEFAULT_MAX_SEGMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_INPUT_BYTES = 60 * 1024 * 1024;
const DEFAULT_PROVIDER_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const DEFAULT_FFMPEG_CONCURRENCY = 1;
const DEFAULT_OPUS_BITRATE_BPS = 32_000;
const DEFAULT_CHUNK_OVERLAP_SECONDS = 2;

type TrainingEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type TrainingAudioLimits = {
  maxDurationSeconds: number;
  maxSegmentBytes: number;
  maxTotalInputBytes: number;
  providerUploadMaxBytes: number;
  ffmpegTimeoutMs: number;
  maxBufferedBytes: number;
  ffmpegConcurrency: number;
  opusBitrateBps: number;
  chunkOverlapSeconds: number;
};

export class TrainingAudioLimitsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrainingAudioLimitsError';
  }
}

export function getTrainingAudioLimits(
  environment: TrainingEnvironment = process.env,
): TrainingAudioLimits {
  const limits = {
    maxDurationSeconds: readInteger(
      environment,
      'TRAINING_AUDIO_MAX_DURATION_SECONDS',
      DEFAULT_MAX_DURATION_SECONDS,
      60,
      DEFAULT_MAX_DURATION_SECONDS,
    ),
    maxSegmentBytes: readInteger(
      environment,
      'TRAINING_AUDIO_MAX_SEGMENT_BYTES',
      DEFAULT_MAX_SEGMENT_BYTES,
      64 * 1024,
      DEFAULT_MAX_SEGMENT_BYTES,
    ),
    maxTotalInputBytes: readInteger(
      environment,
      'TRAINING_AUDIO_MAX_TOTAL_INPUT_BYTES',
      DEFAULT_MAX_TOTAL_INPUT_BYTES,
      64 * 1024,
      128 * 1024 * 1024,
    ),
    providerUploadMaxBytes: readInteger(
      environment,
      'TRAINING_AUDIO_PROVIDER_UPLOAD_MAX_BYTES',
      DEFAULT_PROVIDER_UPLOAD_MAX_BYTES,
      256 * 1024,
      OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
    ),
    ffmpegTimeoutMs: readInteger(
      environment,
      'TRAINING_FFMPEG_TIMEOUT_MS',
      DEFAULT_FFMPEG_TIMEOUT_MS,
      1_000,
      600_000,
    ),
    maxBufferedBytes: readInteger(
      environment,
      'TRAINING_AUDIO_MAX_BUFFERED_BYTES',
      DEFAULT_MAX_BUFFERED_BYTES,
      64 * 1024,
      256 * 1024 * 1024,
    ),
    ffmpegConcurrency: readInteger(
      environment,
      'TRAINING_FFMPEG_CONCURRENCY',
      DEFAULT_FFMPEG_CONCURRENCY,
      1,
      8,
    ),
    opusBitrateBps: readInteger(
      environment,
      'TRAINING_AUDIO_OPUS_BITRATE_BPS',
      DEFAULT_OPUS_BITRATE_BPS,
      16_000,
      64_000,
    ),
    chunkOverlapSeconds: readInteger(
      environment,
      'TRAINING_AUDIO_CHUNK_OVERLAP_SECONDS',
      DEFAULT_CHUNK_OVERLAP_SECONDS,
      0,
      10,
    ),
  } satisfies TrainingAudioLimits;

  if (limits.maxTotalInputBytes < limits.maxSegmentBytes) {
    throw new TrainingAudioLimitsError('TRAINING_AUDIO_MAX_TOTAL_INPUT_BYTES_INVALID');
  }
  if (limits.maxBufferedBytes < limits.maxSegmentBytes) {
    throw new TrainingAudioLimitsError('TRAINING_AUDIO_MAX_BUFFERED_BYTES_INVALID');
  }

  const encodedUpperBound =
    Math.ceil((limits.maxDurationSeconds * limits.opusBitrateBps) / 8) + 1024 * 1024;
  if (encodedUpperBound > OPENAI_TRANSCRIPTION_HARD_MAX_BYTES) {
    throw new TrainingAudioLimitsError('TRAINING_AUDIO_CODEC_LIMITS_INCONSISTENT');
  }

  return limits;
}

function readInteger(
  environment: TrainingEnvironment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const configured = environment[key];
  if (configured === undefined || configured.trim() === '') return fallback;
  const value = Number(configured);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TrainingAudioLimitsError(`${key}_INVALID`);
  }

  return value;
}
