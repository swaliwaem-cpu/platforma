const {
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
} = require('@prisma/client');

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
const PROJECT_ID = '20000000-0000-4000-8000-000000000001';
const VERSION_ID = '30000000-0000-4000-8000-000000000001';
const MAIN_QUESTION_ID = '40000000-0000-4000-8000-000000000001';
const MAIN_FACT_ID = '50000000-0000-4000-8000-000000000001';

class FakeTrainingAttemptPrisma {
  constructor(options = {}) {
    this.now = options.now ?? new Date('2026-07-25T10:00:00.000Z');
    this.sequence = 0;
    this.transactionTail = Promise.resolve();
    this.attempts = new Map();
    this.attemptQuestions = new Map();
    this.answers = new Map();
    this.segments = new Map();
    this.evaluations = new Map();
    this.scoreComponents = [];
    this.jobs = new Map();
    this.reviews = [];
    this.auditLogs = [];
    this.rawQueries = [];
    this.transactionOptions = [];

    const mainFact = {
      id: MAIN_FACT_ID,
      projectVersionId: VERSION_ID,
      code: 'main.fact',
      topicCode: 'main',
      statement: 'Утверждённый факт',
      isApproved: true,
    };
    this.questions = [
      {
        id: MAIN_QUESTION_ID,
        projectVersionId: VERSION_ID,
        type: TrainingQuestionType.MAIN,
        text: 'Главный вопрос',
        position: 1,
        isActive: true,
        maxScore: 55,
        factLinks: [{ fact: mainFact }],
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `40000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
        projectVersionId: VERSION_ID,
        type: TrainingQuestionType.FOLLOW_UP,
        text: `Дополнительный вопрос ${index + 1}`,
        position: index + 1,
        isActive: true,
        maxScore: 15,
        factLinks: [],
      })),
    ];
    this.criteria = [
      {
        id: '60000000-0000-4000-8000-000000000001',
        projectVersionId: VERSION_ID,
        questionType: TrainingQuestionType.MAIN,
        code: 'main-total',
        title: 'Главный ответ',
        maxPoints: 55,
        sortOrder: 1,
      },
      {
        id: '60000000-0000-4000-8000-000000000002',
        projectVersionId: VERSION_ID,
        questionType: TrainingQuestionType.FOLLOW_UP,
        code: 'follow-total',
        title: 'Дополнительный ответ',
        maxPoints: 15,
        sortOrder: 1,
      },
    ];
    this.version = {
      id: VERSION_ID,
      projectId: PROJECT_ID,
      versionNumber: 1,
      status: TrainingVersionStatus.PUBLISHED,
      passScore: options.passScore ?? 75,
      attemptLimit: options.attemptLimit ?? 3,
      cooldownMinutes: options.cooldownMinutes ?? 60,
      totalTimeLimitSeconds: options.totalTimeLimitSeconds ?? 420,
      finishGraceSeconds: options.finishGraceSeconds ?? 90,
      warningSecondsJson: options.warningSeconds ?? [60, 20],
      allowRetakeAfterPass: options.allowRetakeAfterPass ?? false,
      mainMaxScore: 55,
      followUpMaxScore: 15,
      promptVersion: 'fake-prompt-v1',
      schemaVersion: 'fake-schema-v1',
      questions: this.questions,
    };
    this.project = {
      id: PROJECT_ID,
      title: 'Тестовый проект',
      slug: 'test-project',
      status: options.projectStatus ?? TrainingProjectStatus.OPEN,
      availableFrom: options.availableFrom ?? null,
      deadlineAt: options.deadlineAt ?? null,
      activeVersionId: VERSION_ID,
      activeVersion: this.version,
    };

    this.$queryRaw = async (query) => {
      this.rawQueries.push(query);
      return [{ locked: true }];
    };
    this.$transaction = async (operation, options) => {
      if (options) this.transactionOptions.push(options);
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      let release;
      const previous = this.transactionTail;
      this.transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation(this);
      } finally {
        release();
      }
    };

    this.trainingProject = {
      findUnique: async ({ where }) =>
        where.id === this.project.id ? this.project : null,
    };
    this.trainingAttempt = {
      findMany: async ({ where = {}, include }) =>
        [...this.attempts.values()]
          .filter((attempt) => matchesAttemptWhere(attempt, where))
          .sort((left, right) => right.attemptNumber - left.attemptNumber)
          .map((attempt) => (include ? this.buildAttempt(attempt) : attempt)),
      create: async ({ data }) => {
        const id = this.nextId('attempt');
        const record = {
          id,
          ...data,
          aiScore: null,
          serverScore: null,
          adminScore: null,
          finalScore: null,
          passStatus: TrainingPassStatus.PENDING,
          reviewStatus: TrainingReviewStatus.NOT_REQUIRED,
          summary: null,
          totalDurationSeconds: null,
          completedAt: null,
          createdAt: data.startedAt,
          updatedAt: data.startedAt,
        };
        this.attempts.set(id, record);
        return { id };
      },
      findUnique: async ({ where }) => {
        const attempt = this.attempts.get(where.id);
        return attempt ? this.buildAttempt(attempt) : null;
      },
      findFirst: async ({ where, orderBy }) => {
        const matches = [...this.attempts.values()].filter((attempt) =>
          matchesAttemptWhere(attempt, where),
        );
        if (orderBy?.[0]?.finalScore === 'desc') {
          matches.sort(
            (left, right) => Number(right.finalScore) - Number(left.finalScore),
          );
        }
        const attempt = matches[0];
        return attempt ? this.buildAttempt(attempt) : null;
      },
      update: async ({ where, data }) => {
        const attempt = required(this.attempts.get(where.id), 'attempt');
        Object.assign(attempt, materializeData(data, attempt), { updatedAt: this.now });
        return this.buildAttempt(attempt);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const attempt of this.attempts.values()) {
          if (!matchesAttemptWhere(attempt, where)) continue;
          Object.assign(attempt, materializeData(data, attempt), { updatedAt: this.now });
          count += 1;
        }
        return { count };
      },
    };
    this.trainingAttemptQuestion = {
      createMany: async ({ data }) => {
        for (const item of data) {
          const id = this.nextId('attempt-question');
          this.attemptQuestions.set(id, {
            id,
            ...item,
            firstSegmentAt: item.firstSegmentAt ?? null,
            finishedAt: item.finishedAt ?? null,
            responseTimeSeconds: null,
            answerDurationSeconds: null,
            createdAt: this.now,
            updatedAt: this.now,
          });
        }
        return { count: data.length };
      },
      update: async ({ where, data }) => {
        const question = required(
          this.attemptQuestions.get(where.id),
          'attempt question',
        );
        Object.assign(question, materializeData(data, question), { updatedAt: this.now });
        return this.buildAttemptQuestion(question);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const question of this.attemptQuestions.values()) {
          if (matchesAttemptQuestionWhere(question, where)) {
            Object.assign(question, materializeData(data, question), {
              updatedAt: this.now,
            });
            count += 1;
          }
        }
        return { count };
      },
    };
    this.trainingAnswer = {
      create: async ({ data }) => {
        const id = this.nextId('answer');
        const record = {
          id,
          ...data,
          combinedTranscript: null,
          normalizedLanguage: null,
          acousticMetricsJson: null,
          transcriptionProvider: null,
          transcriptionModel: null,
          transcriptionRequestId: null,
          processingStartedAt: null,
          processingFinishedAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: this.now,
          updatedAt: this.now,
        };
        this.answers.set(id, record);
        return this.buildAnswer(record);
      },
      findUnique: async ({ where }) => {
        const answer = this.answers.get(where.id);
        return answer ? this.buildAnswerContext(answer) : null;
      },
      update: async ({ where, data }) => {
        const answer = required(this.answers.get(where.id), 'answer');
        Object.assign(answer, materializeData(data, answer), { updatedAt: this.now });
        return this.buildAnswer(answer);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const answer of this.answers.values()) {
          if (
            (!where.id || answer.id === where.id) &&
            (!where.status || answer.status === where.status)
          ) {
            Object.assign(answer, materializeData(data, answer), {
              updatedAt: this.now,
            });
            count += 1;
          }
        }
        return { count };
      },
    };
    this.trainingVoiceSegment = {
      findUnique: async ({ where }) => {
        const segment = [...this.segments.values()].find(
          (item) => item.telegramUpdateId === where.telegramUpdateId,
        );
        if (!segment) return null;
        const answer = required(this.answers.get(segment.answerId), 'answer');
        const attemptQuestion = required(
          this.attemptQuestions.get(answer.attemptQuestionId),
          'attempt question',
        );
        return {
          ...segment,
          answer: {
            ...this.buildAnswer(answer),
            attemptQuestion: {
              id: attemptQuestion.id,
              attemptId: attemptQuestion.attemptId,
            },
          },
        };
      },
      create: async ({ data }) => {
        if (
          [...this.segments.values()].some(
            (segment) => segment.telegramUpdateId === data.telegramUpdateId,
          )
        ) {
          throw new Error('duplicate fake update');
        }
        const id = this.nextId('segment');
        const record = {
          id,
          ...data,
          originalStorageBucket: null,
          originalStorageKey: null,
          sizeBytes: null,
          createdAt: data.receivedAt,
          updatedAt: data.receivedAt,
        };
        this.segments.set(id, record);
        return record;
      },
    };
    this.trainingEvaluationCriterion = {
      findMany: async ({ where }) =>
        this.criteria
          .filter(
            (criterion) =>
              criterion.projectVersionId === where.projectVersionId &&
              criterion.questionType === where.questionType,
          )
          .sort((left, right) => left.sortOrder - right.sortOrder),
    };
    this.trainingAnswerEvaluation = {
      findFirst: async ({ where }) => {
        const evaluation = [...this.evaluations.values()].find(
          (item) =>
            item.answerId === where.answerId &&
            item.evaluationNumber === where.evaluationNumber,
        );
        return evaluation ? this.buildEvaluation(evaluation) : null;
      },
      create: async ({ data }) => {
        const id = this.nextId('evaluation');
        const nestedComponents = data.scoreComponents?.create ?? [];
        const record = {
          id,
          ...data,
          scoreComponents: undefined,
          createdAt: this.now,
          updatedAt: this.now,
        };
        this.evaluations.set(id, record);
        for (const component of nestedComponents) {
          this.scoreComponents.push({
            id: this.nextId('score-component'),
            evaluationId: id,
            ...component,
          });
        }
        return this.buildEvaluation(record);
      },
    };
    this.trainingJob = {
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && this.jobs.has(item.idempotencyKey)) continue;
          this.jobs.set(item.idempotencyKey, {
            id: this.nextId('job'),
            ...item,
            attempts: item.attempts ?? 0,
            maxAttempts: item.maxAttempts ?? 3,
            lockOwner: item.lockOwner ?? null,
            lockedAt: item.lockedAt ?? null,
            heartbeatAt: item.heartbeatAt ?? null,
            lastErrorCode: item.lastErrorCode ?? null,
            lastErrorMessage: item.lastErrorMessage ?? null,
            errorDetailsJson: item.errorDetailsJson ?? null,
            finishedAt: null,
            createdAt: this.now,
            updatedAt: this.now,
          });
          count += 1;
        }
        return { count };
      },
      findFirst: async ({ where = {}, orderBy }) => {
        const matches = [...this.jobs.values()].filter((job) =>
          matchesJobWhere(job, where),
        );
        if (orderBy) {
          matches.sort(
            (left, right) =>
              left.runAt.getTime() - right.runAt.getTime() ||
              left.createdAt.getTime() - right.createdAt.getTime(),
          );
        }
        return matches[0] ?? null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const job of this.jobs.values()) {
          if (!matchesJobWhere(job, where)) continue;
          Object.assign(job, materializeData(data, job), { updatedAt: this.now });
          count += 1;
        }
        return { count };
      },
    };
    this.trainingResultReview = {
      create: async ({ data }) => {
        const record = {
          id: this.nextId('review'),
          ...data,
          createdAt: data.reviewedAt ?? this.now,
        };
        this.reviews.push(record);
        return record;
      },
    };
    this.auditLog = {
      create: async ({ data }) => {
        const record = { id: this.nextId('audit'), ...data };
        this.auditLogs.push(record);
        return record;
      },
    };
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(4, '0')}`;
  }

  buildAttempt(attempt) {
    return {
      ...attempt,
      user: {
        id: attempt.userId,
        email: 'user@example.test',
        name: 'User',
      },
      project: this.project,
      projectVersion: this.version,
      attemptQuestions: [...this.attemptQuestions.values()]
        .filter((question) => question.attemptId === attempt.id)
        .sort((left, right) => left.sequence - right.sequence)
        .map((question) => this.buildAttemptQuestion(question)),
      reviews: this.reviews
        .filter((review) => review.attemptId === attempt.id)
        .sort((left, right) => right.reviewNumber - left.reviewNumber),
    };
  }

  buildAttemptQuestion(question) {
    const answer = [...this.answers.values()].find(
      (item) => item.attemptQuestionId === question.id,
    );
    return {
      ...question,
      question: required(
        this.questions.find((item) => item.id === question.questionId),
        'question',
      ),
      answer: answer ? this.buildAnswer(answer) : null,
    };
  }

  buildAnswer(answer) {
    return {
      ...answer,
      voiceSegments: [...this.segments.values()]
        .filter((segment) => segment.answerId === answer.id)
        .sort((left, right) => left.segmentIndex - right.segmentIndex),
      evaluations: [...this.evaluations.values()]
        .filter((evaluation) => evaluation.answerId === answer.id)
        .sort(
          (left, right) => left.evaluationNumber - right.evaluationNumber,
        )
        .map((evaluation) => this.buildEvaluation(evaluation)),
    };
  }

  buildEvaluation(evaluation) {
    return {
      ...evaluation,
      scoreComponents: this.scoreComponents.filter(
        (component) => component.evaluationId === evaluation.id,
      ),
    };
  }

  buildAnswerContext(answer) {
    const attemptQuestion = required(
      this.attemptQuestions.get(answer.attemptQuestionId),
      'attempt question',
    );
    const attempt = required(
      this.attempts.get(attemptQuestion.attemptId),
      'attempt',
    );
    const question = required(
      this.questions.find((item) => item.id === attemptQuestion.questionId),
      'question',
    );

    return {
      ...this.buildAnswer(answer),
      attemptQuestion: {
        ...attemptQuestion,
        question,
        attempt: {
          ...attempt,
          projectVersion: this.version,
        },
      },
    };
  }
}

class MutableTrainingClock {
  constructor(now = new Date('2026-07-25T10:00:00.000Z')) {
    this.current = now;
  }

  now() {
    return new Date(this.current);
  }

  set(value) {
    this.current = new Date(value);
  }

  advanceSeconds(seconds) {
    this.current = new Date(this.current.getTime() + seconds * 1_000);
  }
}

class DeterministicQuestionSelector {
  constructor(offset = 0) {
    this.offset = offset;
  }

  select(candidates, count) {
    return Array.from({ length: count }, (_, index) => {
      const randomIndex = (this.offset + index) % candidates.length;
      return {
        candidate: candidates[randomIndex],
        randomIndex,
      };
    });
  }
}

function matchesAttemptWhere(attempt, where) {
  if (where.id && attempt.id !== where.id) return false;
  if (where.userId && attempt.userId !== where.userId) return false;
  if (where.projectId && attempt.projectId !== where.projectId) return false;
  if (where.isConsumed !== undefined && attempt.isConsumed !== where.isConsumed) {
    return false;
  }
  if (where.finalScore?.not === null && attempt.finalScore === null) return false;
  if (
    where.reviewStatus?.not &&
    attempt.reviewStatus === where.reviewStatus.not
  ) {
    return false;
  }
  if (where.status?.in && !where.status.in.includes(attempt.status)) return false;
  if (typeof where.status === 'string' && attempt.status !== where.status) {
    return false;
  }
  return true;
}

function matchesAttemptQuestionWhere(question, where) {
  if (where.attemptId && question.attemptId !== where.attemptId) return false;
  if (where.sequence?.gt !== undefined && question.sequence <= where.sequence.gt) {
    return false;
  }
  if (where.status?.in && !where.status.in.includes(question.status)) return false;
  return true;
}

function matchesJobWhere(job, where) {
  if (where.id) {
    if (typeof where.id === 'string' && job.id !== where.id) return false;
    if (where.id.not && job.id === where.id.not) return false;
  }
  if (where.idempotencyKey) {
    if (typeof where.idempotencyKey === 'string') {
      if (job.idempotencyKey !== where.idempotencyKey) return false;
    } else {
      if (
        where.idempotencyKey.startsWith &&
        !job.idempotencyKey.startsWith(where.idempotencyKey.startsWith)
      ) {
        return false;
      }
    }
  }
  if (where.kind?.in && !where.kind.in.includes(job.kind)) return false;
  if (typeof where.kind === 'string' && job.kind !== where.kind) return false;
  if (where.status?.in && !where.status.in.includes(job.status)) return false;
  if (typeof where.status === 'string' && job.status !== where.status) {
    return false;
  }
  if (where.attempts !== undefined && job.attempts !== where.attempts) {
    return false;
  }
  if (where.runAt?.lte && job.runAt > where.runAt.lte) return false;
  if (where.heartbeatAt === null && job.heartbeatAt !== null) return false;
  if (
    where.heartbeatAt?.lte &&
    (job.heartbeatAt === null || job.heartbeatAt > where.heartbeatAt.lte)
  ) {
    return false;
  }
  if (
    where.lockOwner !== undefined &&
    job.lockOwner !== where.lockOwner
  ) {
    return false;
  }
  if (where.OR && !where.OR.some((condition) => matchesJobWhere(job, condition))) {
    return false;
  }
  return true;
}

function materializeData(data, current = {}) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'increment')
    ) {
      result[key] = (current[key] ?? 0) + value.increment;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function required(value, label) {
  if (!value) throw new Error(`Missing fake ${label}`);
  return value;
}

module.exports = {
  ADMIN_ID,
  FakeTrainingAttemptPrisma,
  MAIN_FACT_ID,
  MAIN_QUESTION_ID,
  MutableTrainingClock,
  DeterministicQuestionSelector,
  PROJECT_ID,
  USER_ID,
  VERSION_ID,
};
