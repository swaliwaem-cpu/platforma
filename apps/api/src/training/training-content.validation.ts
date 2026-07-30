import { UnprocessableEntityException } from '@nestjs/common';

import {
  TRAINING_FOLLOW_UP_MAX_SCORE,
  TRAINING_FOLLOW_UP_POOL_SIZE,
  TRAINING_MAIN_MAX_SCORE,
  TRAINING_MAIN_QUESTION_COUNT,
} from './training.domain';
import { TRAINING_OPENAI_EVALUATION_LIMITS } from './openai/training-openai-evaluation-limits';

const MIN_AVAILABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_AVAILABILITY_WINDOW_MS = 7 * MIN_AVAILABILITY_WINDOW_MS;
const DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS = 4_096;
const CONSERVATIVE_OUTPUT_CHARACTERS_PER_TOKEN = 2;
const SAFE_EVALUATION_OUTPUT_CHARACTERS =
  DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS *
  CONSERVATIVE_OUTPUT_CHARACTERS_PER_TOKEN;
const EVALUATION_SCHEMA_VERSION = 'openai-evaluation-v1';

type PublishableQuestion = {
  id: string;
  type: 'MAIN' | 'FOLLOW_UP';
  text: string;
  position: number;
  isActive: boolean;
  maxScore: number;
};

type PublishableFact = {
  id: string;
  code: string;
  statement: string;
  acceptedAliasesJson: unknown;
  isApproved: boolean;
  questionLinks: Array<{
    questionId: string;
  }>;
};

type PublishableCriterion = {
  id: string;
  questionType: 'MAIN' | 'FOLLOW_UP';
  code: string;
  title: string;
  description?: string | null;
  sortOrder: number;
  maxPoints: number | string | { toString(): string };
  anchorsJson: unknown;
};

type PublishableSource = {
  extractionStatus: string;
};

export type PublishableTrainingVersion = {
  passScore: number;
  attemptLimit: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  finishGraceSeconds: number;
  warningSecondsJson: unknown;
  mainMaxScore: number;
  followUpMaxScore: number;
  project: {
    status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED';
    availableFrom: Date | null;
    deadlineAt: Date | null;
  };
  questions: PublishableQuestion[];
  facts: PublishableFact[];
  criteria: PublishableCriterion[];
  sourceDocuments?: PublishableSource[];
  officialUrlSources?: PublishableSource[];
  pendingFactSuggestionCount?: number;
  activeFactSuggestionRunCount?: number;
  activeFactSuggestionProviderCount?: number;
  activeFactSuggestionJobCount?: number;
};

export type TrainingReadinessIssue = {
  code: string;
  step:
    | 'main'
    | 'sources'
    | 'suggestions'
    | 'questions'
    | 'criteria'
    | 'review';
  entityId?: string;
  message: string;
};

export type TrainingVersionReadiness = {
  readyToPublish: boolean;
  facts: {
    approved: number;
    total: number;
    pendingSuggestions: number;
    ready: boolean;
  };
  questions: {
    active: number;
    required: number;
    mainReady: boolean;
    followUpsReady: boolean;
    positionsReady: boolean;
    ready: boolean;
  };
  criteria: {
    mainPoints: number;
    mainRequired: number;
    followUpPoints: number;
    followUpRequired: number;
    ready: boolean;
  };
  issues: TrainingReadinessIssue[];
};

export function normalizeTrainingUniqueKey(value: string) {
  return value.trim().toLocaleLowerCase('ru-RU');
}

export function collectTrainingPublicationErrors(version: PublishableTrainingVersion) {
  const errors: string[] = [];
  const activeQuestions = version.questions.filter((question) => question.isActive);
  const mainQuestions = activeQuestions.filter((question) => question.type === 'MAIN');
  const followUpQuestions = activeQuestions.filter((question) => question.type === 'FOLLOW_UP');

  if (version.project.status === 'ARCHIVED') {
    errors.push('Archived project cannot be published');
  }

  errors.push(...collectAvailabilityErrors(version.project.availableFrom, version.project.deadlineAt));

  if (!Number.isInteger(version.passScore) || version.passScore < 0 || version.passScore > 100) {
    errors.push('Pass score must be an integer between 0 and 100');
  }
  if (!Number.isInteger(version.attemptLimit) || version.attemptLimit < 1) {
    errors.push('Attempt limit must be a positive integer');
  }
  if (
    !Number.isInteger(version.cooldownMinutes) ||
    version.cooldownMinutes < 60 ||
    version.cooldownMinutes > 1440
  ) {
    errors.push('Cooldown must be between 60 and 1440 minutes');
  }
  if (
    !Number.isInteger(version.totalTimeLimitSeconds) ||
    version.totalTimeLimitSeconds < 300 ||
    version.totalTimeLimitSeconds > 420
  ) {
    errors.push('Attempt timer must be between 300 and 420 seconds');
  }
  if (!Number.isInteger(version.finishGraceSeconds) || version.finishGraceSeconds < 0) {
    errors.push('Finish grace must be a non-negative integer');
  }

  errors.push(
    ...collectWarningErrors(version.warningSecondsJson, version.totalTimeLimitSeconds),
  );

  if (version.mainMaxScore !== TRAINING_MAIN_MAX_SCORE) {
    errors.push(`Main answer maximum must equal ${TRAINING_MAIN_MAX_SCORE}`);
  }
  if (version.followUpMaxScore !== TRAINING_FOLLOW_UP_MAX_SCORE) {
    errors.push(`Follow-up answer maximum must equal ${TRAINING_FOLLOW_UP_MAX_SCORE}`);
  }

  if (mainQuestions.length !== TRAINING_MAIN_QUESTION_COUNT) {
    errors.push(`Published version must contain exactly ${TRAINING_MAIN_QUESTION_COUNT} active main question`);
  }
  if (followUpQuestions.length !== TRAINING_FOLLOW_UP_POOL_SIZE) {
    errors.push(`Published version must contain exactly ${TRAINING_FOLLOW_UP_POOL_SIZE} active follow-up questions`);
  }
  if (mainQuestions.some((question) => question.maxScore !== TRAINING_MAIN_MAX_SCORE)) {
    errors.push(`Every active main question must have maximum score ${TRAINING_MAIN_MAX_SCORE}`);
  }
  if (followUpQuestions.some((question) => question.maxScore !== TRAINING_FOLLOW_UP_MAX_SCORE)) {
    errors.push(`Every active follow-up question must have maximum score ${TRAINING_FOLLOW_UP_MAX_SCORE}`);
  }

  if (hasDuplicates(activeQuestions.map((question) => `${question.type}:${question.position}`))) {
    errors.push('Active question positions must be unique within each question type');
  }
  if (hasDuplicates(activeQuestions.map((question) => normalizeTrainingUniqueKey(question.text)))) {
    errors.push('Active question texts must be unique');
  }
  const followUpPositions = new Set(followUpQuestions.map((question) => question.position));
  if (
    followUpQuestions.length === TRAINING_FOLLOW_UP_POOL_SIZE &&
    Array.from({ length: TRAINING_FOLLOW_UP_POOL_SIZE }, (_, index) => index + 1).some(
      (position) => !followUpPositions.has(position),
    )
  ) {
    errors.push('Active follow-up positions must cover 1 through 10 without gaps');
  }

  if (version.facts.length === 0) {
    errors.push('Published version must contain facts');
  } else if (version.facts.some((fact) => !fact.isApproved)) {
    errors.push('Every fact must be approved before publication');
  }
  if ((version.pendingFactSuggestionCount ?? 0) > 0) {
    errors.push('Pending fact suggestions must be reviewed or dismissed before publication');
  }
  if (getActiveFactSuggestionGenerationCount(version) > 0) {
    errors.push('Fact suggestion generation must finish before publication');
  }
  if (
    [...(version.sourceDocuments ?? []), ...(version.officialUrlSources ?? [])]
      .some((source) =>
        source.extractionStatus === 'PENDING' ||
        source.extractionStatus === 'PROCESSING',
      )
  ) {
    errors.push('Source extraction must finish before publication');
  }
  if (hasDuplicates(version.facts.map((fact) => normalizeTrainingUniqueKey(fact.code)))) {
    errors.push('Fact codes must be unique');
  }

  for (const questionType of ['MAIN', 'FOLLOW_UP'] as const) {
    const criteria = version.criteria.filter((criterion) => criterion.questionType === questionType);
    const expectedMaximum =
      questionType === 'MAIN' ? TRAINING_MAIN_MAX_SCORE : TRAINING_FOLLOW_UP_MAX_SCORE;
    const label = questionType === 'MAIN' ? 'Main' : 'Follow-up';

    if (criteria.length === 0) {
      errors.push(`${label} criteria are required`);
      continue;
    }
    if (criteria.length > TRAINING_OPENAI_EVALUATION_LIMITS.criteria) {
      errors.push(
        `${label} criteria count must not exceed ${TRAINING_OPENAI_EVALUATION_LIMITS.criteria}`,
      );
    }
    if (hasDuplicates(criteria.map((criterion) => normalizeTrainingUniqueKey(criterion.code)))) {
      errors.push(`${label} criterion codes must be unique`);
    }
    if (hasDuplicates(criteria.map((criterion) => String(criterion.sortOrder)))) {
      errors.push(`${label} criterion positions must be unique`);
    }
    if (
      criteria.some(
        (criterion) =>
          !hasValidStructuredAnchors(
            criterion.anchorsJson,
            Number(criterion.maxPoints.toString()),
          ),
      )
    ) {
      errors.push(
        `${label} criteria require valid structured anchors before publication`,
      );
    }
    if (
      criteria.some(
        (criterion) =>
          readStructuredAnchors(criterion.anchorsJson).length >
          TRAINING_OPENAI_EVALUATION_LIMITS.anchorsPerCriterion,
      )
    ) {
      errors.push(
        `${label} criterion anchors count must not exceed ${TRAINING_OPENAI_EVALUATION_LIMITS.anchorsPerCriterion}`,
      );
    }
    if (
      criteria.some(
        (criterion) =>
          !readStructuredAnchors(criterion.anchorsJson).some(
            (anchor) => anchor.points === 0,
          ),
      )
    ) {
      errors.push(`${label} criteria require a zero-point anchor`);
    }
    if (
      criteria.some((criterion) => {
        const maximumPoints = Number(criterion.maxPoints.toString());
        return !readStructuredAnchors(criterion.anchorsJson).some(
          (anchor) => Math.abs(anchor.points - maximumPoints) <= 0.000_001,
        );
      })
    ) {
      errors.push(`${label} criteria require a full-score anchor`);
    }

    const total = criteria.reduce(
      (sum, criterion) => sum + Number(criterion.maxPoints.toString()),
      0,
    );
    if (!Number.isFinite(total) || Math.abs(total - expectedMaximum) > 0.000_001) {
      errors.push(`${label} criteria maximum must equal ${expectedMaximum}`);
    }
  }

  errors.push(
    ...collectEvaluationEnvelopeErrors(
      activeQuestions,
      version.facts,
      version.criteria,
    ),
  );

  return Array.from(new Set(errors));
}

export function getTrainingVersionReadiness(
  version: PublishableTrainingVersion,
): TrainingVersionReadiness {
  const errors = collectTrainingPublicationErrors(version);
  const pendingSuggestions = version.pendingFactSuggestionCount ?? 0;
  const activeSuggestionGeneration =
    getActiveFactSuggestionGenerationCount(version);
  const activeQuestions = version.questions.filter((question) => question.isActive);
  const mainQuestions = activeQuestions.filter((question) => question.type === 'MAIN');
  const followUpQuestions = activeQuestions.filter((question) => question.type === 'FOLLOW_UP');
  const approvedFacts = version.facts.filter((fact) => fact.isApproved).length;
  const mainPoints = sumCriterionPoints(version.criteria, 'MAIN');
  const followUpPoints = sumCriterionPoints(version.criteria, 'FOLLOW_UP');
  const mainQuestionsComplete =
    mainQuestions.length === TRAINING_MAIN_QUESTION_COUNT &&
    mainQuestions.every(
      (question) =>
        question.position === 1 && question.maxScore === TRAINING_MAIN_MAX_SCORE,
    );
  const followUpPositions = new Set(followUpQuestions.map((question) => question.position));
  const followUpQuestionsComplete =
    followUpQuestions.length === TRAINING_FOLLOW_UP_POOL_SIZE &&
    followUpQuestions.every(
      (question) =>
        question.maxScore === TRAINING_FOLLOW_UP_MAX_SCORE &&
        question.position >= 1 &&
        question.position <= TRAINING_FOLLOW_UP_POOL_SIZE,
    ) &&
    followUpPositions.size === TRAINING_FOLLOW_UP_POOL_SIZE;

  return {
    readyToPublish: errors.length === 0,
    facts: {
      approved: approvedFacts,
      total: version.facts.length,
      pendingSuggestions,
      ready:
        version.facts.length > 0 &&
        approvedFacts === version.facts.length &&
        pendingSuggestions === 0 &&
        activeSuggestionGeneration === 0,
    },
    questions: {
      active: activeQuestions.length,
      required: TRAINING_MAIN_QUESTION_COUNT + TRAINING_FOLLOW_UP_POOL_SIZE,
      mainReady: mainQuestionsComplete,
      followUpsReady:
        followUpQuestions.length === TRAINING_FOLLOW_UP_POOL_SIZE &&
        followUpQuestions.every(
          (question) => question.maxScore === TRAINING_FOLLOW_UP_MAX_SCORE,
        ),
      positionsReady:
        followUpQuestions.length === TRAINING_FOLLOW_UP_POOL_SIZE &&
        followUpPositions.size === TRAINING_FOLLOW_UP_POOL_SIZE &&
        Array.from(
          { length: TRAINING_FOLLOW_UP_POOL_SIZE },
          (_, index) => index + 1,
        ).every((position) => followUpPositions.has(position)),
      ready: mainQuestionsComplete && followUpQuestionsComplete,
    },
    criteria: {
      mainPoints,
      mainRequired: TRAINING_MAIN_MAX_SCORE,
      followUpPoints,
      followUpRequired: TRAINING_FOLLOW_UP_MAX_SCORE,
      ready:
        Math.abs(mainPoints - TRAINING_MAIN_MAX_SCORE) <= 0.000_001 &&
        Math.abs(followUpPoints - TRAINING_FOLLOW_UP_MAX_SCORE) <= 0.000_001,
    },
    issues: errors.map(toTrainingReadinessIssue),
  };
}

function hasValidStructuredAnchors(value: unknown, maximumPoints: number) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  return value.every((anchor) => {
    if (
      typeof anchor !== 'object' ||
      anchor === null ||
      Array.isArray(anchor)
    ) {
      return false;
    }
    const record = anchor as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'description,id,points') return false;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const description =
      typeof record.description === 'string'
        ? record.description.trim()
        : '';
    const points = record.points;
    if (
      !id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) ||
      ids.has(id) ||
      !description ||
      typeof points !== 'number' ||
      !Number.isFinite(points) ||
      points < 0 ||
      points > maximumPoints
    ) {
      return false;
    }
    ids.add(id);
    return true;
  });
}

type StructuredAnchor = {
  id: string;
  points: number;
  description: string;
};

function readStructuredAnchors(value: unknown): StructuredAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((anchor) => {
    if (
      typeof anchor !== 'object' ||
      anchor === null ||
      Array.isArray(anchor)
    ) {
      return [];
    }
    const record = anchor as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.points !== 'number' ||
      typeof record.description !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: record.id.trim(),
        points: record.points,
        description: record.description.trim(),
      },
    ];
  });
}

function collectEvaluationEnvelopeErrors(
  questions: PublishableQuestion[],
  facts: PublishableFact[],
  criteria: PublishableCriterion[],
) {
  const errors: string[] = [];
  const approvedFacts = facts.filter((fact) => fact.isApproved);

  for (const question of questions) {
    const linkedFacts = approvedFacts.filter((fact) =>
      fact.questionLinks.some((link) => link.questionId === question.id),
    );
    const questionLabel =
      question.type === 'MAIN'
        ? 'Main question'
        : `Follow-up question ${question.position}`;

    if (linkedFacts.length === 0) {
      errors.push(`${questionLabel} must have at least one linked approved fact`);
      continue;
    }
    if (linkedFacts.length > TRAINING_OPENAI_EVALUATION_LIMITS.facts) {
      errors.push(
        `${questionLabel} linked approved facts count must not exceed ${TRAINING_OPENAI_EVALUATION_LIMITS.facts}`,
      );
    }
    if (hasDuplicateFactVocabulary(linkedFacts)) {
      errors.push(
        `${questionLabel} linked approved facts must not contain duplicate statements or aliases`,
      );
    }

    const questionCriteria = criteria.filter(
      (criterion) => criterion.questionType === question.type,
    );
    if (
      estimateEvaluationPromptCharacters(
        question,
        linkedFacts,
        questionCriteria,
      ) > TRAINING_OPENAI_EVALUATION_LIMITS.promptCharacters
    ) {
      errors.push(
        `${questionLabel} evaluation input exceeds the safe prompt budget`,
      );
    }
    if (
      estimateMinimumEvaluationOutputCharacters(linkedFacts, questionCriteria) >
      SAFE_EVALUATION_OUTPUT_CHARACTERS
    ) {
      errors.push(
        `${questionLabel} evaluation output exceeds the safe output capacity`,
      );
    }
  }

  return errors;
}

function hasDuplicateFactVocabulary(facts: PublishableFact[]) {
  const ownerBySemanticKey = new Map<string, string>();

  for (const fact of facts) {
    const factKeys = new Set(
      [fact.statement, ...readStringArray(fact.acceptedAliasesJson)]
        .map(normalizeFactSemanticKey)
        .filter(Boolean),
    );
    for (const key of factKeys) {
      const ownerId = ownerBySemanticKey.get(key);
      if (ownerId && ownerId !== fact.id) {
        return true;
      }
      ownerBySemanticKey.set(key, fact.id);
    }
  }

  return false;
}

function normalizeFactSemanticKey(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[«»„“”"'`]/gu, '')
    .replace(/[.,!?;:()[\]{}—–-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function estimateEvaluationPromptCharacters(
  question: PublishableQuestion,
  facts: PublishableFact[],
  criteria: PublishableCriterion[],
) {
  return JSON.stringify({
    question: {
      id: question.id,
      type: question.type,
      text: question.text,
      max_score: question.maxScore,
    },
    transcript: 'x'.repeat(
      TRAINING_OPENAI_EVALUATION_LIMITS.transcriptCharacters,
    ),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      code: criterion.code,
      title: criterion.title,
      description: criterion.description ?? null,
      max_points: Number(criterion.maxPoints.toString()),
      anchors: readStructuredAnchors(criterion.anchorsJson).map((anchor) => ({
        id: anchor.id,
        points: anchor.points,
        description: anchor.description,
      })),
    })),
    approved_facts: facts.map((fact) => ({
      id: fact.id,
      code: fact.code,
      statement: fact.statement,
      accepted_aliases: readStringArray(fact.acceptedAliasesJson),
      relevance: null,
      required: false,
    })),
    metrics: [
      {
        id: 'audio_duration_milliseconds',
        value: 420_000,
        unit: 'milliseconds',
      },
      {
        id: 'transcript_word_count',
        value: 1_000,
        unit: 'words',
      },
      {
        id: 'speech_words_per_minute',
        value: 300,
        unit: 'words_per_minute',
      },
    ],
  }).length;
}

function estimateMinimumEvaluationOutputCharacters(
  facts: PublishableFact[],
  criteria: PublishableCriterion[],
) {
  return JSON.stringify({
    schema_version: EVALUATION_SCHEMA_VERSION,
    answer_relevance: 'RELEVANT',
    criteria: criteria.map((criterion) => ({
      criterion_id: criterion.id,
      anchor_id:
        readStructuredAnchors(criterion.anchorsJson).find(
          (anchor) => anchor.points === 0,
        )?.id ?? '0',
      evidence_source: 'NONE',
      evidence: null,
      metric_id: null,
      explanation: 'x',
    })),
    facts: facts.map((fact) => ({
      fact_id: fact.id,
      verdict: 'MISSING',
      claim: null,
      evidence_source: 'NONE',
      evidence: null,
      metric_id: null,
      explanation: 'x',
      confidence: 0,
    })),
    summary: 'x.',
    requires_manual_review: false,
    review_reasons: [],
  }).length;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function assertTrainingVersionPublishable(version: PublishableTrainingVersion) {
  const errors = getTrainingVersionReadiness(version).issues.map(
    (issue) => issue.message,
  );

  if (errors.length > 0) {
    throw new UnprocessableEntityException({
      message: 'Training version cannot be published',
      errors,
    });
  }
}

function toTrainingReadinessIssue(message: string): TrainingReadinessIssue {
  if (message.includes('Source extraction')) {
    return {
      code: 'sources.processing',
      step: 'sources',
      message,
    };
  }
  if (message.includes('suggestion generation')) {
    return {
      code: 'facts.suggestion_generation_active',
      step: 'suggestions',
      message,
    };
  }
  if (message.toLocaleLowerCase('en-US').includes('fact suggestion')) {
    return {
      code: 'facts.pending_suggestions',
      step: 'suggestions',
      message,
    };
  }
  if (message.includes('fact') || message.includes('Fact')) {
    return {
      code: message.includes('approved')
        ? 'facts.unapproved'
        : message.includes('codes')
          ? 'facts.duplicate_codes'
          : 'facts.missing',
      step: 'suggestions',
      message,
    };
  }
  if (message.includes('question') || message.includes('Question')) {
    return {
      code: message.includes('position')
        ? 'questions.positions'
        : message.includes('texts')
          ? 'questions.duplicate_texts'
          : 'questions.shape',
      step: 'questions',
      message,
    };
  }
  if (message.includes('criteria') || message.includes('criterion')) {
    const prefix = message.startsWith('Main')
      ? 'criteria.main'
      : 'criteria.follow_up';
    return {
      code: message.includes('maximum')
        ? `${prefix}.points`
        : message.includes('anchors')
          ? `${prefix}.anchors`
          : `${prefix}.invalid`,
      step: 'criteria',
      message,
    };
  }
  if (
    message.includes('score') ||
    message.includes('Attempt') ||
    message.includes('Cooldown') ||
    message.includes('timer') ||
    message.includes('warnings') ||
    message.includes('grace') ||
    message.includes('maximum')
  ) {
    return {
      code: 'main.attempt_settings',
      step: 'main',
      message,
    };
  }
  if (message.includes('Availability') || message.includes('Archived')) {
    return {
      code: message.includes('Archived')
        ? 'main.project_archived'
        : 'main.availability',
      step: 'main',
      message,
    };
  }
  return {
    code: 'review.publication',
    step: 'review',
    message,
  };
}

function getActiveFactSuggestionGenerationCount(
  version: PublishableTrainingVersion,
) {
  return (
    (version.activeFactSuggestionRunCount ?? 0) +
    (version.activeFactSuggestionProviderCount ?? 0) +
    (version.activeFactSuggestionJobCount ?? 0)
  );
}

function sumCriterionPoints(
  criteria: PublishableCriterion[],
  questionType: PublishableCriterion['questionType'],
) {
  return criteria
    .filter((criterion) => criterion.questionType === questionType)
    .reduce((sum, criterion) => sum + Number(criterion.maxPoints.toString()), 0);
}

export function assertTrainingAvailability(
  availableFrom: Date | null,
  deadlineAt: Date | null,
) {
  const errors = collectAvailabilityErrors(availableFrom, deadlineAt);

  if (errors.length > 0) {
    throw new UnprocessableEntityException({
      message: 'Training project availability is invalid',
      errors,
    });
  }
}

function collectAvailabilityErrors(availableFrom: Date | null, deadlineAt: Date | null) {
  if (availableFrom === null && deadlineAt === null) {
    return [];
  }
  if (availableFrom === null || deadlineAt === null) {
    return ['Availability window requires both availableFrom and deadlineAt'];
  }

  const duration = deadlineAt.getTime() - availableFrom.getTime();
  if (duration < MIN_AVAILABILITY_WINDOW_MS || duration > MAX_AVAILABILITY_WINDOW_MS) {
    return ['Availability window must be between 1 and 7 days'];
  }

  return [];
}

function collectWarningErrors(value: unknown, totalTimeLimitSeconds: number) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (warning) =>
        !Number.isInteger(warning) ||
        Number(warning) <= 0 ||
        Number(warning) >= totalTimeLimitSeconds,
    )
  ) {
    return ['Timer warnings must be positive integers below the attempt timer'];
  }

  const warnings = value.map(Number);
  if (new Set(warnings).size !== warnings.length) {
    return ['Timer warnings must be unique'];
  }
  if (warnings.some((warning, index) => index > 0 && warnings[index - 1]! <= warning)) {
    return ['Timer warnings must be ordered from largest to smallest'];
  }

  return [];
}

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length;
}
