import {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  TrainingEvaluationProvider,
  TrainingTranscriptionProvider,
} from '../training-attempt.providers';
import { TrainingOpenAiConfig } from './training-openai.config';
import { OpenAiTrainingEvaluationProvider } from './training-openai-evaluation.provider';
import { OpenAiTrainingTranscriptionProvider } from './training-openai-transcription.provider';

export function createTrainingTranscriptionProvider(
  config: TrainingOpenAiConfig,
  fakeProvider: DeterministicFakeTrainingTranscriptionProvider,
  realProvider: OpenAiTrainingTranscriptionProvider,
): TrainingTranscriptionProvider {
  return config.providerMode === 'real' ? realProvider : fakeProvider;
}

export function createTrainingEvaluationProvider(
  config: TrainingOpenAiConfig,
  fakeProvider: DeterministicFakeTrainingEvaluationProvider,
  realProvider: OpenAiTrainingEvaluationProvider,
): TrainingEvaluationProvider {
  return config.providerMode === 'real' ? realProvider : fakeProvider;
}
