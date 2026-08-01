import { BadRequestException } from '@nestjs/common';

import type {
  StartTrainingAttemptInput,
  SubmitTrainingAnswerInput,
} from './training-attempt-state.service';
import type {
  CreateTrainingProjectInput,
  UpdateTrainingProjectDraftInput,
} from './training-project.service';
import { TRAINING_SNAPSHOT_FOLLOW_UP_COUNT } from './training-snapshot';

const TRAINING_DEFAULT_TIME_LIMIT_MINUTES = 7;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseCreateTrainingProjectInput(body: Record<string, unknown>): CreateTrainingProjectInput {
  return {
    title: parseRequiredText(body.title, 'title', 240),
    description: parseOptionalText(body.description, 'description'),
    realEstateObjectId: parseOptionalUuid(body.realEstateObjectId, 'realEstateObjectId'),
    sortOrder: parseInteger(body.sortOrder, 'sortOrder', 0, { minimum: 0 }),
    attemptLimit: parseInteger(body.attemptLimit, 'attemptLimit', 3, { minimum: 1 }),
    timeLimitSeconds: parseTrainingTimeLimitMinutes(body.timeLimitMinutes),
    passScore: parseInteger(body.passScore, 'passScore', 75, { minimum: 0, maximum: 100 }),
    allowRetakeAfterPass: parseRequiredBoolean(
      body.allowRetakeAfterPass,
      'allowRetakeAfterPass',
    ),
  };
}

export function parseUpdateTrainingProjectDraftInput(
  body: Record<string, unknown>,
): UpdateTrainingProjectDraftInput {
  const base = parseCreateTrainingProjectInput(body);

  if (
    !Array.isArray(body.followUpQuestions) ||
    body.followUpQuestions.length !== TRAINING_SNAPSHOT_FOLLOW_UP_COUNT
  ) {
    throw new BadRequestException(
      `followUpQuestions must contain exactly ${TRAINING_SNAPSHOT_FOLLOW_UP_COUNT} questions`,
    );
  }

  return {
    ...base,
    mainQuestion: parseRequiredText(body.mainQuestion, 'mainQuestion'),
    followUpQuestions: body.followUpQuestions.map((question, index) =>
      parseRequiredText(question, `followUpQuestions[${index}]`),
    ),
  };
}

export function parseTrainingAvailabilityInput(body: Record<string, unknown>) {
  return {
    isOpen: parseRequiredBoolean(body.isOpen, 'isOpen'),
  };
}

export function parseStartTrainingAttemptInput(
  body: Record<string, unknown>,
  idempotencyKey: string | undefined,
): StartTrainingAttemptInput {
  if (body.confirmed !== true) {
    throw new BadRequestException('Attempt start must be explicitly confirmed');
  }

  return {
    confirmed: true,
    idempotencyKey: parseUuid(idempotencyKey, 'Idempotency-Key'),
  };
}

export function parseSubmitTrainingAnswerInput(body: Record<string, unknown>): SubmitTrainingAnswerInput {
  return {
    attemptQuestionId: parseUuid(body.attemptQuestionId, 'attemptQuestionId'),
    text: parseRequiredText(body.text, 'text'),
  };
}

export function parseTrainingTimeLimitMinutes(
  value: unknown,
  fallbackMinutes = TRAINING_DEFAULT_TIME_LIMIT_MINUTES,
) {
  const minutes = parseInteger(value, 'timeLimitMinutes', fallbackMinutes, { minimum: 1 });

  return minutes * 60;
}

export function parseUuid(value: unknown, fieldName: string) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new BadRequestException(`${fieldName} must be a UUID`);
  }

  return value;
}

function parseRequiredText(value: unknown, fieldName: string, maximumLength?: number) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${fieldName} is required`);
  }

  const text = value.trim();

  if (maximumLength && text.length > maximumLength) {
    throw new BadRequestException(`${fieldName} is too long`);
  }

  return text;
}

function parseOptionalText(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be text`);
  }

  return value.trim() || null;
}

function parseOptionalUuid(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return parseUuid(value, fieldName);
}

function parseInteger(
  value: unknown,
  fieldName: string,
  fallback: number,
  bounds: { minimum?: number; maximum?: number },
) {
  const parsed = value === undefined ? fallback : Number(value);

  if (!Number.isInteger(parsed)) {
    throw new BadRequestException(`${fieldName} must be an integer`);
  }

  if (bounds.minimum !== undefined && parsed < bounds.minimum) {
    throw new BadRequestException(`${fieldName} must be at least ${bounds.minimum}`);
  }

  if (bounds.maximum !== undefined && parsed > bounds.maximum) {
    throw new BadRequestException(`${fieldName} must be at most ${bounds.maximum}`);
  }

  return parsed;
}

function parseRequiredBoolean(value: unknown, fieldName: string) {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${fieldName} must be a boolean`);
  }

  return value;
}
