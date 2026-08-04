import { BadRequestException } from '@nestjs/common';

import type {
  StartTrainingAttemptInput,
  SubmitTrainingAnswerInput,
} from './training-attempt-state.service';
import type {
  CreateTrainingProjectInput,
  TrainingCriterionDraftInput,
  TrainingFactDraftInput,
  UpdateTrainingProjectDraftInput,
} from './training-project.service';
import type { ReviewTrainingAttemptInput } from './training-review.service';
import {
  TRAINING_FACT_ALIAS_LIMIT,
  TRAINING_FACT_ALIAS_MAX_LENGTH,
  TRAINING_FACT_ALIAS_MAX_WORDS,
  TRAINING_FACT_STATEMENT_MAX_LENGTH,
  TRAINING_SNAPSHOT_FOLLOW_UP_COUNT,
} from './training-snapshot';
import {
  TrainingAnswerSource,
  TrainingAttemptStatus,
  TrainingProjectAccessMode,
  TrainingQuestionType,
  TrainingReviewStatus,
} from '@prisma/client';
import type {
  TrainingAdminResultSort,
  TrainingAssignmentStatus,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import type { TrainingAdminResultsQueryInput } from './training-results.service';
import type { TrainingAdminRankingQueryInput } from './training-ranking.service';

const TRAINING_DEFAULT_TIME_LIMIT_MINUTES = 7;
const TRAINING_ASSIGNMENT_BULK_LIMIT = 500;
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
    accessMode: parseTrainingProjectAccessMode(
      body.accessMode,
      TrainingProjectAccessMode.ASSIGNED_USERS,
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
    facts: parseTrainingFacts(body.facts),
    criteria: parseTrainingCriteria(body.criteria),
  };
}

export function parseTrainingAvailabilityInput(body: Record<string, unknown>) {
  return {
    isOpen: parseRequiredBoolean(body.isOpen, 'isOpen'),
  };
}

export function parseTrainingProjectAccessModeInput(body: Record<string, unknown>) {
  return {
    accessMode: parseTrainingProjectAccessMode(body.accessMode),
  };
}

export function parseTrainingAssignmentUsersQuery(
  query: Record<string, string | undefined>,
) {
  const assigned = query.assigned ?? 'all';

  if (assigned !== 'all' && assigned !== 'yes' && assigned !== 'no') {
    throw new BadRequestException('assigned must be all, yes or no');
  }
  if (query.status !== undefined && query.status !== 'active') {
    throw new BadRequestException('status must be active');
  }

  return {
    page: parseInteger(query.page, 'page', 1, { minimum: 1 }),
    limit: parseInteger(query.limit, 'limit', 20, { minimum: 1, maximum: 100 }),
    search: parseOptionalBoundedText(query.search, 'search', 240),
    assigned,
  } as const;
}

export function parseTrainingAdminResultsQuery(
  query: Record<string, string | undefined>,
): TrainingAdminResultsQueryInput {
  const scoreMin = parseOptionalInteger(query.scoreMin, 'scoreMin', 0, 100);
  const scoreMax = parseOptionalInteger(query.scoreMax, 'scoreMax', 0, 100);
  const durationMin = parseOptionalInteger(query.durationMin, 'durationMin', 0, 2_147_483_647);
  const durationMax = parseOptionalInteger(query.durationMax, 'durationMax', 0, 2_147_483_647);
  const startedFrom = parseOptionalDate(query.startedFrom, 'startedFrom');
  const startedTo = parseOptionalDate(query.startedTo, 'startedTo');

  if (scoreMin !== null && scoreMax !== null && scoreMin > scoreMax) {
    throw new BadRequestException('scoreMin must not exceed scoreMax');
  }
  if (durationMin !== null && durationMax !== null && durationMin > durationMax) {
    throw new BadRequestException('durationMin must not exceed durationMax');
  }
  if (startedFrom && startedTo && startedFrom.getTime() > startedTo.getTime()) {
    throw new BadRequestException('startedFrom must not exceed startedTo');
  }

  return {
    page: parseInteger(query.page, 'page', 1, { minimum: 1 }),
    limit: parseInteger(query.limit, 'limit', 20, { minimum: 1, maximum: 100 }),
    search: parseOptionalBoundedText(query.search, 'search', 240) || null,
    userId: parseOptionalUuid(query.userId, 'userId'),
    projectId: parseOptionalUuid(query.projectId, 'projectId'),
    accessMode: parseOptionalEnum(
      query.accessMode,
      'accessMode',
      Object.values(TrainingProjectAccessMode),
    ),
    assignmentStatus: parseOptionalEnum(
      query.assignmentStatus,
      'assignmentStatus',
      ['ASSIGNED', 'REVOKED', 'NEVER_ASSIGNED'] satisfies TrainingAssignmentStatus[],
    ),
    startedFrom,
    startedTo,
    attemptStatus: parseOptionalEnum(
      query.attemptStatus,
      'attemptStatus',
      Object.values(TrainingAttemptStatus),
    ),
    reviewStatus: parseOptionalEnum(
      query.reviewStatus,
      'reviewStatus',
      Object.values(TrainingReviewStatus),
    ),
    passed: parseOptionalBoolean(query.passed, 'passed'),
    scoreMin,
    scoreMax,
    durationMin,
    durationMax,
    source: parseOptionalEnum(
      query.source,
      'source',
      Object.values(TrainingAnswerSource),
    ),
    sort: parseOptionalEnum(
      query.sort,
      'sort',
      [
        'STARTED_DESC',
        'STARTED_ASC',
        'COMPLETED_DESC',
        'COMPLETED_ASC',
        'SCORE_DESC',
        'SCORE_ASC',
        'DURATION_DESC',
        'DURATION_ASC',
      ] satisfies TrainingAdminResultSort[],
    ) ?? 'STARTED_DESC',
  };
}

export function parseTrainingAdminRankingQuery(
  query: Record<string, string | undefined>,
): TrainingAdminRankingQueryInput {
  return {
    page: parseInteger(query.page, 'page', 1, { minimum: 1 }),
    limit: parseInteger(query.limit, 'limit', 20, { minimum: 1, maximum: 100 }),
    search: parseOptionalBoundedText(query.search, 'search', 240) || null,
    project: parseOptionalBoundedText(query.project, 'project', 240) || null,
    accessMode: parseOptionalEnum(
      query.accessMode,
      'accessMode',
      Object.values(TrainingProjectAccessMode),
    ),
    currentlyAssigned: parseOptionalBoolean(query.currentlyAssigned, 'currentlyAssigned'),
    currentlyEligible: parseOptionalBoolean(query.currentlyEligible, 'currentlyEligible'),
  };
}

export function parseBulkTrainingProjectAssignmentsInput(body: Record<string, unknown>) {
  if (body.action !== 'ASSIGN' && body.action !== 'REVOKE') {
    throw new BadRequestException('action must be ASSIGN or REVOKE');
  }
  if (
    !Array.isArray(body.userIds) ||
    body.userIds.length === 0 ||
    body.userIds.length > TRAINING_ASSIGNMENT_BULK_LIMIT
  ) {
    throw new BadRequestException(
      `userIds must contain between 1 and ${TRAINING_ASSIGNMENT_BULK_LIMIT} items`,
    );
  }

  return {
    action: body.action,
    userIds: [...new Set(body.userIds.map((userId, index) =>
      parseUuid(userId, `userIds[${index}]`),
    ))],
  } as const;
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

export function parseReviewTrainingAttemptInput(
  body: Record<string, unknown>,
): ReviewTrainingAttemptInput {
  const comment = parseOptionalBoundedText(body.comment, 'comment', 2_000) || null;

  if (body.decision === 'APPROVE') {
    if (body.finalScore !== undefined && body.finalScore !== null) {
      throw new BadRequestException('finalScore is only allowed for OVERRIDE');
    }

    return { decision: 'APPROVE', finalScore: null, comment };
  }

  if (body.decision === 'OVERRIDE') {
    if (!comment) throw new BadRequestException('comment is required for OVERRIDE');
    return {
      decision: 'OVERRIDE',
      finalScore: parseInteger(body.finalScore, 'finalScore', -1, {
        minimum: 0,
        maximum: 100,
      }),
      comment,
    };
  }

  throw new BadRequestException('decision must be APPROVE or OVERRIDE');
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

function parseOptionalInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === null || value === '') return null;
  return parseInteger(value, fieldName, minimum, { minimum, maximum });
}

function parseOptionalBoolean(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException(`${fieldName} must be true or false`);
}

function parseOptionalDate(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) {
    throw new BadRequestException(`${fieldName} must be an ISO date`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadRequestException(`${fieldName} must be an ISO date`);
  }
  return parsed;
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowed: readonly T[],
): T | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(`${fieldName} is invalid`);
  }
  return value as T;
}

function parseRequiredBoolean(value: unknown, fieldName: string) {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${fieldName} must be a boolean`);
  }

  return value;
}

function parseTrainingProjectAccessMode(
  value: unknown,
  fallback?: TrainingProjectAccessMode,
) {
  const parsed = value === undefined ? fallback : value;

  if (
    parsed !== TrainingProjectAccessMode.ALL_PARTICIPANTS &&
    parsed !== TrainingProjectAccessMode.ASSIGNED_USERS
  ) {
    throw new BadRequestException('accessMode must be ALL_PARTICIPANTS or ASSIGNED_USERS');
  }

  return parsed;
}

function parseTrainingFacts(value: unknown): TrainingFactDraftInput[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('facts must be an array');
  }

  const facts = value.map((item, index) => {
    const record = parseRecord(item, `facts[${index}]`);
    const aliases = parseAliases(record.aliases, `facts[${index}].aliases`);

    return {
      id: parseOptionalUuid(record.id, `facts[${index}].id`),
      questionType: parseQuestionType(record.questionType, `facts[${index}].questionType`),
      questionPosition: parseQuestionPosition(
        record.questionType,
        record.questionPosition,
        `facts[${index}].questionPosition`,
      ),
      statement: parseRequiredText(
        record.statement,
        `facts[${index}].statement`,
        TRAINING_FACT_STATEMENT_MAX_LENGTH,
      ).normalize('NFC'),
      aliases,
      isRequired: parseRequiredBoolean(record.isRequired, `facts[${index}].isRequired`),
      position: parseInteger(record.position, `facts[${index}].position`, index + 1, {
        minimum: 1,
      }),
    };
  });

  assertUniqueDraftData(
    facts,
    (fact) => fact.id,
    'fact IDs',
    true,
  );
  assertUniqueDraftData(
    facts,
    (fact) => `${fact.questionType}:${fact.questionPosition}:${fact.position}`,
    'fact positions',
  );

  return facts;
}

function parseTrainingCriteria(value: unknown): TrainingCriterionDraftInput[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('criteria must be an array');
  }

  const criteria = value.map((item, index) => {
    const record = parseRecord(item, `criteria[${index}]`);

    return {
      id: parseOptionalUuid(record.id, `criteria[${index}].id`),
      questionType: parseQuestionType(
        record.questionType,
        `criteria[${index}].questionType`,
      ),
      code: parseCriterionCode(record.code, `criteria[${index}].code`),
      title: parseRequiredText(record.title, `criteria[${index}].title`, 240),
      guidance: parseOptionalBoundedText(
        record.guidance,
        `criteria[${index}].guidance`,
        2_000,
      ),
      maxPoints: parseInteger(
        record.maxPoints,
        `criteria[${index}].maxPoints`,
        1,
        { minimum: 1, maximum: 55 },
      ),
      position: parseInteger(record.position, `criteria[${index}].position`, index + 1, {
        minimum: 1,
      }),
    };
  });

  assertUniqueDraftData(criteria, (criterion) => criterion.id, 'criterion IDs', true);
  assertUniqueDraftData(
    criteria,
    (criterion) => `${criterion.questionType}:${criterion.code}`,
    'criterion codes',
  );
  assertUniqueDraftData(
    criteria,
    (criterion) => `${criterion.questionType}:${criterion.position}`,
    'criterion positions',
  );

  return criteria;
}

function parseAliases(value: unknown, fieldName: string) {
  if (!Array.isArray(value) || value.length > TRAINING_FACT_ALIAS_LIMIT) {
    throw new BadRequestException(
      `${fieldName} must contain at most ${TRAINING_FACT_ALIAS_LIMIT} aliases`,
    );
  }

  const aliases = value.map((alias, index) => {
    const parsed = parseRequiredText(
      alias,
      `${fieldName}[${index}]`,
      TRAINING_FACT_ALIAS_MAX_LENGTH,
    ).normalize('NFC');

    if (
      /\r|\n/u.test(parsed) ||
      parsed.split(/\s+/u).length > TRAINING_FACT_ALIAS_MAX_WORDS
    ) {
      throw new BadRequestException(`${fieldName}[${index}] must be a short term`);
    }

    return parsed;
  });
  const normalized = aliases.map((alias) => alias.toLocaleLowerCase('ru-RU'));

  if (new Set(normalized).size !== normalized.length) {
    throw new BadRequestException(`${fieldName} contains duplicates`);
  }

  return aliases;
}

function parseRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function parseQuestionType(value: unknown, fieldName: string) {
  if (value !== TrainingQuestionType.MAIN && value !== TrainingQuestionType.FOLLOW_UP) {
    throw new BadRequestException(`${fieldName} must be MAIN or FOLLOW_UP`);
  }

  return value;
}

function parseQuestionPosition(type: unknown, value: unknown, fieldName: string) {
  const parsed = parseInteger(value, fieldName, 1, {
    minimum: 1,
    maximum: type === TrainingQuestionType.MAIN ? 1 : TRAINING_SNAPSHOT_FOLLOW_UP_COUNT,
  });

  if (type === TrainingQuestionType.MAIN && parsed !== 1) {
    throw new BadRequestException(`${fieldName} must be 1 for MAIN`);
  }

  return parsed;
}

function parseCriterionCode(value: unknown, fieldName: string) {
  const code = parseRequiredText(value, fieldName, 64).toLocaleLowerCase('en-US');

  if (!/^[a-z][a-z0-9_]*$/u.test(code)) {
    throw new BadRequestException(`${fieldName} must use lowercase snake_case`);
  }

  return code;
}

function parseOptionalBoundedText(value: unknown, fieldName: string, maximumLength: number) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestException(`${fieldName} must be text`);

  const text = value.trim();

  if (text.length > maximumLength) {
    throw new BadRequestException(`${fieldName} is too long`);
  }

  return text;
}

function assertUniqueDraftData<T>(
  items: T[],
  getKey: (item: T) => string | null,
  fieldName: string,
  ignoreNull = false,
) {
  const keys = items.map(getKey).filter((key): key is string => !ignoreNull || key !== null);

  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException(`${fieldName} must be unique`);
  }
}
