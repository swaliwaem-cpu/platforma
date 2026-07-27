export type TrainingAudioErrorCode =
  | 'TELEGRAM_RATE_LIMITED'
  | 'TELEGRAM_SERVER_ERROR'
  | 'TELEGRAM_NETWORK_ERROR'
  | 'TELEGRAM_TIMEOUT'
  | 'TELEGRAM_PERMANENT_CLIENT_ERROR'
  | 'TELEGRAM_INVALID_RESPONSE'
  | 'TELEGRAM_INVALID_FILE_PATH'
  | 'AUDIO_CONTENT_TYPE_INVALID'
  | 'AUDIO_CONTENT_LENGTH_INVALID'
  | 'AUDIO_SIZE_LIMIT_EXCEEDED'
  | 'AUDIO_BYTE_COUNT_MISMATCH'
  | 'AUDIO_CONTAINER_INVALID'
  | 'AUDIO_STORAGE_FAILED'
  | 'ANSWER_NOT_READY'
  | 'FFMPEG_NOT_AVAILABLE'
  | 'FFMPEG_TIMEOUT'
  | 'FFMPEG_FAILED'
  | 'FFPROBE_TIMEOUT'
  | 'FFPROBE_FAILED'
  | 'AUDIO_METADATA_INVALID'
  | 'AUDIO_TEMP_IO_FAILED'
  | 'TRANSCRIPTION_RETRYABLE_FAILURE'
  | 'TRANSCRIPTION_PERMANENT_FAILURE'
  | 'TRANSCRIPTION_TIMEOUT';

export class TrainingAudioError extends Error {
  constructor(
    readonly code: TrainingAudioErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`Training audio processing failed with ${code}`);
    this.name = 'TrainingAudioError';
  }
}
