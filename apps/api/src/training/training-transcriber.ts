import { Injectable } from '@nestjs/common';

export const TRAINING_TRANSCRIBER = Symbol('TRAINING_TRANSCRIBER');

export type TrainingTranscriptionInput = {
  answerId: string;
  fileId: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
};

export interface TrainingTranscriber {
  transcribe(input: TrainingTranscriptionInput): Promise<string>;
}

@Injectable()
export class DeterministicFakeTrainingTranscriber implements TrainingTranscriber {
  async transcribe(_input: TrainingTranscriptionInput) {
    return '[fake:pass]';
  }
}
