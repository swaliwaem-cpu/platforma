import { TrainingQuestionType } from '@prisma/client';

export const TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;
export const TRAINING_SNAPSHOT_SCHEMA_VERSION = 2;
export const TRAINING_SNAPSHOT_FOLLOW_UP_COUNT = 10;
export const TRAINING_SCORING_VERSION = 'training-v2-scoring-v1';
export const TRAINING_EVALUATION_SCHEMA_VERSION = 'training-v2-evaluation-v1';
export const TRAINING_FACT_ALIAS_LIMIT = 20;
export const TRAINING_FACT_ALIAS_MAX_LENGTH = 80;
export const TRAINING_FACT_STATEMENT_MAX_LENGTH = 1_000;

type TrainingProjectSnapshotSettings = {
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  allowRetakeAfterPass: boolean;
};

export type TrainingProjectSnapshotFact = {
  id: string;
  statement: string;
  aliases: string[];
  required: boolean;
  position: number;
};

export type TrainingProjectSnapshotCriterion = {
  id: string;
  code: string;
  title: string;
  guidance: string;
  maxPoints: number;
  position: number;
};

export type TrainingProjectSnapshotQuestion = {
  sourceQuestionId: string;
  type: TrainingQuestionType;
  text: string;
  position: number;
};

export type TrainingProjectSnapshotV1 = {
  schemaVersion: typeof TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION;
  projectTitle: string;
  settings: TrainingProjectSnapshotSettings;
  questions: TrainingProjectSnapshotQuestion[];
};

export type TrainingProjectSnapshotV2 = {
  schemaVersion: typeof TRAINING_SNAPSHOT_SCHEMA_VERSION;
  projectTitle: string;
  relatedObjectTitle: string | null;
  settings: TrainingProjectSnapshotSettings;
  scoringVersion: typeof TRAINING_SCORING_VERSION;
  evaluationSchemaVersion: typeof TRAINING_EVALUATION_SCHEMA_VERSION;
  criteria: {
    main: TrainingProjectSnapshotCriterion[];
    followUp: TrainingProjectSnapshotCriterion[];
  };
  questions: Array<TrainingProjectSnapshotQuestion & { facts: TrainingProjectSnapshotFact[] }>;
};

export type TrainingProjectSnapshot = TrainingProjectSnapshotV1 | TrainingProjectSnapshotV2;

export function parseTrainingProjectSnapshot(value: unknown): TrainingProjectSnapshot {
  if (!isRecord(value)) throw new Error('Invalid training snapshot');

  if (value.schemaVersion === TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION) {
    return parseLegacySnapshot(value);
  }

  if (value.schemaVersion === TRAINING_SNAPSHOT_SCHEMA_VERSION) {
    return parseStage3Snapshot(value);
  }

  throw new Error('Unsupported training snapshot');
}

export function isTrainingProjectSnapshotV2(
  snapshot: TrainingProjectSnapshot,
): snapshot is TrainingProjectSnapshotV2 {
  return snapshot.schemaVersion === TRAINING_SNAPSHOT_SCHEMA_VERSION;
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

function parseLegacySnapshot(value: Record<string, unknown>): TrainingProjectSnapshotV1 {
  const common = parseCommonSnapshot(value);

  return {
    schemaVersion: TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION,
    ...common,
  };
}

function parseStage3Snapshot(value: Record<string, unknown>): TrainingProjectSnapshotV2 {
  const common = parseCommonSnapshot(value, true);

  if (
    (value.relatedObjectTitle !== null && typeof value.relatedObjectTitle !== 'string') ||
    value.scoringVersion !== TRAINING_SCORING_VERSION ||
    value.evaluationSchemaVersion !== TRAINING_EVALUATION_SCHEMA_VERSION ||
    !isRecord(value.criteria)
  ) {
    throw new Error('Invalid Stage 3 training snapshot');
  }

  const mainCriteria = parseCriteria(value.criteria.main, 55);
  const followUpCriteria = parseCriteria(value.criteria.followUp, 15);
  const criterionIds = [...mainCriteria, ...followUpCriteria].map((criterion) => criterion.id);

  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error('Duplicate training snapshot criterion ID');
  }

  return {
    schemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
    projectTitle: common.projectTitle,
    relatedObjectTitle: value.relatedObjectTitle,
    settings: common.settings,
    scoringVersion: TRAINING_SCORING_VERSION,
    evaluationSchemaVersion: TRAINING_EVALUATION_SCHEMA_VERSION,
    criteria: { main: mainCriteria, followUp: followUpCriteria },
    questions: common.questions as TrainingProjectSnapshotV2['questions'],
  };
}

function parseCommonSnapshot(value: Record<string, unknown>, withFacts = false) {
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
      ...(withFacts ? { facts: parseFacts(question.facts) } : {}),
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

function parseFacts(value: unknown): TrainingProjectSnapshotFact[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Training snapshot question facts are required');
  }

  const facts = value.map((fact) => {
    if (
      !isRecord(fact) ||
      typeof fact.id !== 'string' ||
      typeof fact.statement !== 'string' ||
      !fact.statement.trim() ||
      fact.statement.length > TRAINING_FACT_STATEMENT_MAX_LENGTH ||
      !Array.isArray(fact.aliases) ||
      fact.aliases.length > TRAINING_FACT_ALIAS_LIMIT ||
      fact.aliases.some(
        (alias) =>
          typeof alias !== 'string' ||
          !alias.trim() ||
          alias.length > TRAINING_FACT_ALIAS_MAX_LENGTH,
      ) ||
      typeof fact.required !== 'boolean' ||
      !isInteger(fact.position) ||
      fact.position < 1
    ) {
      throw new Error('Invalid training snapshot fact');
    }

    return {
      id: fact.id,
      statement: fact.statement,
      aliases: fact.aliases as string[],
      required: fact.required,
      position: fact.position,
    };
  });
  if (
    new Set(facts.map((fact) => fact.id)).size !== facts.length ||
    new Set(facts.map((fact) => fact.position)).size !== facts.length ||
    facts.some((fact) => {
      const aliases = fact.aliases.map((alias) =>
        alias.normalize('NFC').trim().toLocaleLowerCase('ru-RU'),
      );
      return new Set(aliases).size !== aliases.length;
    })
  ) {
    throw new Error('Duplicate training snapshot fact data');
  }

  return facts.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

function parseCriteria(value: unknown, expectedTotal: number) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Training snapshot criteria are required');
  }

  const criteria = value.map((criterion) => {
    if (
      !isRecord(criterion) ||
      typeof criterion.id !== 'string' ||
      typeof criterion.code !== 'string' ||
      !criterion.code.trim() ||
      typeof criterion.title !== 'string' ||
      !criterion.title.trim() ||
      typeof criterion.guidance !== 'string' ||
      !isInteger(criterion.maxPoints) ||
      criterion.maxPoints < 1 ||
      !isInteger(criterion.position) ||
      criterion.position < 1
    ) {
      throw new Error('Invalid training snapshot criterion');
    }

    return {
      id: criterion.id,
      code: criterion.code,
      title: criterion.title,
      guidance: criterion.guidance,
      maxPoints: criterion.maxPoints,
      position: criterion.position,
    };
  });
  const normalizedCodes = criteria.map((criterion) => criterion.code.toLocaleLowerCase('en-US'));

  if (
    new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length ||
    new Set(criteria.map((criterion) => criterion.position)).size !== criteria.length ||
    new Set(normalizedCodes).size !== normalizedCodes.length ||
    criteria.reduce((total, criterion) => total + criterion.maxPoints, 0) !== expectedTotal
  ) {
    throw new Error('Invalid training snapshot criteria structure');
  }

  return criteria.sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
