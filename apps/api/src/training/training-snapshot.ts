import { TrainingQuestionType } from '@prisma/client';

export const TRAINING_SNAPSHOT_SCHEMA_VERSION = 1;
export const TRAINING_SNAPSHOT_FOLLOW_UP_COUNT = 10;

export type TrainingProjectSnapshotQuestion = {
  sourceQuestionId: string;
  type: TrainingQuestionType;
  text: string;
  position: number;
};

export type TrainingProjectSnapshot = {
  schemaVersion: typeof TRAINING_SNAPSHOT_SCHEMA_VERSION;
  projectTitle: string;
  settings: {
    attemptLimit: number;
    timeLimitSeconds: number;
    passScore: number;
    allowRetakeAfterPass: boolean;
  };
  questions: TrainingProjectSnapshotQuestion[];
};

export function parseTrainingProjectSnapshot(value: unknown): TrainingProjectSnapshot {
  if (!isRecord(value) || value.schemaVersion !== TRAINING_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Unsupported training snapshot');
  }

  const settings = value.settings;
  const questions = value.questions;

  if (
    typeof value.projectTitle !== 'string' ||
    !isRecord(settings) ||
    !isInteger(settings.attemptLimit) ||
    !isInteger(settings.timeLimitSeconds) ||
    !isInteger(settings.passScore) ||
    typeof settings.allowRetakeAfterPass !== 'boolean' ||
    !Array.isArray(questions)
  ) {
    throw new Error('Invalid training snapshot');
  }

  const parsedQuestions = questions.map((question) => {
    if (
      !isRecord(question) ||
      typeof question.sourceQuestionId !== 'string' ||
      (question.type !== TrainingQuestionType.MAIN &&
        question.type !== TrainingQuestionType.FOLLOW_UP) ||
      typeof question.text !== 'string' ||
      !isInteger(question.position)
    ) {
      throw new Error('Invalid training snapshot question');
    }

    return {
      sourceQuestionId: question.sourceQuestionId,
      type: question.type,
      text: question.text,
      position: question.position,
    };
  });

  if (
    !hasTrainingSnapshotQuestionStructure(parsedQuestions) ||
    new Set(parsedQuestions.map((question) => question.sourceQuestionId)).size !==
      parsedQuestions.length
  ) {
    throw new Error('Invalid training snapshot question structure');
  }

  return {
    schemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
    projectTitle: value.projectTitle,
    settings: {
      attemptLimit: settings.attemptLimit,
      timeLimitSeconds: settings.timeLimitSeconds,
      passScore: settings.passScore,
      allowRetakeAfterPass: settings.allowRetakeAfterPass,
    },
    questions: parsedQuestions,
  };
}

export function hasTrainingSnapshotQuestionStructure(
  questions: readonly Pick<TrainingProjectSnapshotQuestion, 'type' | 'position'>[],
) {
  const mainQuestions = questions.filter(
    (question) => question.type === TrainingQuestionType.MAIN,
  );
  const followUpQuestions = questions.filter(
    (question) => question.type === TrainingQuestionType.FOLLOW_UP,
  );
  const followUpPositions = new Set(
    followUpQuestions.map((question) => question.position),
  );

  return (
    mainQuestions.length === 1 &&
    mainQuestions[0]?.position === 1 &&
    followUpQuestions.length === TRAINING_SNAPSHOT_FOLLOW_UP_COUNT &&
    followUpPositions.size === TRAINING_SNAPSHOT_FOLLOW_UP_COUNT &&
    [...followUpPositions].every(
      (position) => position >= 1 && position <= TRAINING_SNAPSHOT_FOLLOW_UP_COUNT,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
