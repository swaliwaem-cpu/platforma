import type {
  TrainingAdminAnswerDetail,
  TrainingAdminAttemptDetail,
  TrainingAdminResultListItem,
  TrainingReviewRequest,
} from '@platforma/shared';
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  CheckCircle2Icon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  AdminAlert,
  AdminButton,
  AdminEmptyState,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { ApiRequestError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import {
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { TrainingAudioObjectUrl } from './trainingAudioUrl.mjs';
import {
  downloadTrainingAnswerAudio,
  getTrainingAdminAttempt,
  getTrainingAdminResults,
  getTrainingRanking,
  reprocessTrainingAnswer,
  reviewTrainingAttempt,
} from './trainingResultsApi';
import { TrainingReviewSubmission } from './trainingReviewSubmission.mjs';
import {
  attemptStatusLabels,
  formatTrainingDuration,
  formatTrainingScore,
  passStatusLabels,
  reviewStatusLabels,
} from './trainingViewModel.mjs';
import './trainingResults.css';

type TrainingAdminResultsPageProps = {
  pathname: string;
  navigate: (path: string) => void;
  onBack: () => void;
};

type ResultFilters = {
  user: string;
  projectId: string;
  status: string;
  reviewStatus: string;
  passStatus: string;
  dateFrom: string;
  dateTo: string;
  minScore: string;
  maxScore: string;
  sort: string;
};

const emptyFilters: ResultFilters = {
  user: '',
  projectId: '',
  status: '',
  reviewStatus: '',
  passStatus: '',
  dateFrom: '',
  dateTo: '',
  minScore: '',
  maxScore: '',
  sort: 'newest',
};

export function TrainingAdminResultsPage({
  pathname,
  navigate,
  onBack,
}: TrainingAdminResultsPageProps) {
  const detailMatch = pathname.match(
    /^\/admin\/training\/results\/([0-9a-f-]+)\/?$/iu,
  );
  if (detailMatch?.[1]) {
    return (
      <TrainingAdminAttemptPage
        attemptId={detailMatch[1]}
        onBack={() => navigate('/admin/training/results')}
      />
    );
  }
  return (
    <TrainingAdminResultList
      navigate={navigate}
      onBack={onBack}
    />
  );
}

function TrainingAdminResultList({
  navigate,
  onBack,
}: {
  navigate: (path: string) => void;
  onBack: () => void;
}) {
  const { accessToken } = useAuth();
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [items, setItems] = useState<TrainingAdminResultListItem[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>(
    [],
  );
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const [results, ranking] = await Promise.all([
        getTrainingAdminResults(accessToken, {
          page,
          pageSize: 25,
          ...compactFilters(appliedFilters),
        }),
        getTrainingRanking(accessToken, { page: 1, pageSize: 1 }),
      ]);
      setItems(results.items);
      setPagination(results.pagination);
      setProjects(ranking.projects);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить результаты'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, appliedFilters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  }

  return (
    <div className="training-results training-results--admin">
      <header className="training-results-header">
        <div>
          <button
            className="training-results-back"
            type="button"
            onClick={onBack}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Админка
          </button>
          <p className="eyebrow">Обучение · контроль</p>
          <h2>Результаты и проверки</h2>
          <p>
            Быстрый список попыток без тяжёлых transcript и audio-данных.
          </p>
        </div>
        <div className="training-results-actions">
          <AdminButton
            tone="secondary"
            onClick={() => navigate('/admin/training/ranking')}
          >
            Рейтинг
          </AdminButton>
          <AdminButton disabled={isLoading} onClick={() => void load()}>
            <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
            Обновить
          </AdminButton>
        </div>
      </header>

      <AdminPanel>
        <form className="training-results-filter-grid" onSubmit={submitFilters}>
          <label>
            <span>Сотрудник</span>
            <Input
              placeholder="Имя или email"
              value={filters.user}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  user: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Проект</span>
            <select
              value={filters.projectId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  projectId: event.target.value,
                }))
              }
            >
              <option value="">Все</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Статус попытки</span>
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              <option value="">Все</option>
              {Object.entries(attemptStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Проверка</span>
            <select
              value={filters.reviewStatus}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  reviewStatus: event.target.value,
                }))
              }
            >
              <option value="">Все</option>
              {Object.entries(reviewStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Результат</span>
            <select
              value={filters.passStatus}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  passStatus: event.target.value,
                }))
              }
            >
              <option value="">Все</option>
              {Object.entries(passStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>С даты</span>
            <Input
              type="date"
              value={filters.dateFrom}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  dateFrom: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>По дату</span>
            <Input
              type="date"
              value={filters.dateTo}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  dateTo: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Баллы от</span>
            <Input
              min="0"
              max="100"
              type="number"
              value={filters.minScore}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  minScore: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Баллы до</span>
            <Input
              min="0"
              max="100"
              type="number"
              value={filters.maxScore}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  maxScore: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Сортировка</span>
            <select
              value={filters.sort}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  sort: event.target.value,
                }))
              }
            >
              <option value="newest">Сначала новые</option>
              <option value="oldest">Сначала старые</option>
              <option value="score_desc">Баллы по убыванию</option>
              <option value="score_asc">Баллы по возрастанию</option>
            </select>
          </label>
          <div className="training-filter-actions">
            <AdminButton type="submit">
              <SearchIcon data-icon="inline-start" aria-hidden="true" />
              Применить
            </AdminButton>
            <AdminButton
              tone="text"
              type="button"
              onClick={() => {
                setFilters(emptyFilters);
                setAppliedFilters(emptyFilters);
                setPage(1);
              }}
            >
              Сбросить
            </AdminButton>
          </div>
        </form>
      </AdminPanel>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {isLoading ? (
        <div className="training-results-loading" role="status">
          <LoaderCircleIcon aria-hidden="true" />
          Загрузка результатов
        </div>
      ) : null}
      {!isLoading && !items.length ? (
        <AdminEmptyState
          title="Результаты не найдены"
          description="Измените фильтры или дождитесь завершения попыток."
        />
      ) : null}
      {items.length ? (
        <AdminPanel className="training-results-table-panel">
          <Table className="training-results-table">
            <TableHeader>
              <TableRow>
                <TableHead>Сотрудник</TableHead>
                <TableHead>Проект</TableHead>
                <TableHead>Попытка</TableHead>
                <TableHead>Состояние</TableHead>
                <TableHead>Баллы</TableHead>
                <TableHead>Проверка</TableHead>
                <TableHead>Ошибки</TableHead>
                <TableHead>Дата</TableHead>
                <TableHead aria-label="Действия" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <strong>{item.user.name ?? 'Без имени'}</strong>
                    <small>{item.user.email}</small>
                  </TableCell>
                  <TableCell>
                    {item.project.title}
                    <small>Версия {item.projectVersion.versionNumber}</small>
                  </TableCell>
                  <TableCell>
                    № {item.attemptNumber}
                    <small>
                      Ответов: {item.answersCompleted} · использовано:{' '}
                      {item.attemptsUsed}
                    </small>
                  </TableCell>
                  <TableCell>
                    <AdminStatusBadge>
                      {attemptStatusLabels[item.status]}
                    </AdminStatusBadge>
                    {item.summary ? <small>{item.summary}</small> : null}
                  </TableCell>
                  <TableCell>
                    <strong>
                      Итог {formatTrainingScore(item.finalScore)}
                    </strong>
                    <small>
                      AI {formatTrainingScore(item.aiScore)} · сервер{' '}
                      {formatTrainingScore(item.serverScore)}
                      {item.adminScore
                        ? ` · admin ${formatTrainingScore(item.adminScore)}`
                        : ''}
                    </small>
                    <small>{passStatusLabels[item.passStatus]}</small>
                  </TableCell>
                  <TableCell>
                    {reviewStatusLabels[item.reviewStatus]}
                  </TableCell>
                  <TableCell>
                    {item.answerErrorsCount +
                      item.unsupportedClaimsCount}
                  </TableCell>
                  <TableCell>
                    {new Date(item.startedAt).toLocaleDateString('ru-RU')}
                    <small>
                      {formatTrainingDuration(item.totalDurationSeconds)}
                    </small>
                  </TableCell>
                  <TableCell>
                    <AdminButton
                      tone="text"
                      onClick={() =>
                        navigate(`/admin/training/results/${item.id}`)
                      }
                    >
                      Открыть
                    </AdminButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminPanel>
      ) : null}
      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        onPage={setPage}
      />
    </div>
  );
}

function TrainingAdminAttemptPage({
  attemptId,
  onBack,
}: {
  attemptId: string;
  onBack: () => void;
}) {
  const { accessToken, hasPermission } = useAuth();
  const [attempt, setAttempt] = useState<TrainingAdminAttemptDetail | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await getTrainingAdminAttempt(accessToken, attemptId);
      setAttempt(response.attempt);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить попытку'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="training-results training-results--detail">
      <header className="training-results-header">
        <div>
          <button
            className="training-results-back"
            type="button"
            onClick={onBack}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Результаты
          </button>
          <p className="eyebrow">Полный разбор</p>
          <h2>
            {attempt
              ? `${attempt.user.name ?? attempt.user.email} · ${attempt.project.title}`
              : 'Результат попытки'}
          </h2>
          {attempt ? (
            <p>
              Попытка {attempt.attemptNumber} ·{' '}
              {new Date(attempt.startedAt).toLocaleString('ru-RU')}
            </p>
          ) : null}
        </div>
        <AdminButton disabled={isLoading} onClick={() => void load()}>
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          Обновить
        </AdminButton>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {isLoading ? (
        <div className="training-results-loading" role="status">
          <LoaderCircleIcon aria-hidden="true" />
          Загрузка полного разбора
        </div>
      ) : null}
      {attempt ? (
        <>
          <AttemptScoreSummary attempt={attempt} />
          <Timeline attempt={attempt} />
          <div className="training-admin-question-list">
            {attempt.questions.map((question) => (
              <AdminQuestionCard
                key={question.id}
                answer={question.answer}
                question={question}
                canReadAudio={hasPermission('training:audio:read')}
                canReview={hasPermission('training:results:review')}
                accessToken={accessToken}
                onNotice={setNotice}
                onError={setError}
              />
            ))}
          </div>
          {hasPermission('training:results:review') ? (
            <ReviewPanel
              accessToken={accessToken}
              attempt={attempt}
              onReviewed={async () => {
                await load();
                if (accessToken) {
                  await getTrainingRanking(accessToken, {
                    page: 1,
                    pageSize: 1,
                  });
                }
                setNotice('Решение сохранено, результат и рейтинг обновлены.');
              }}
            />
          ) : null}
          <ReviewHistory attempt={attempt} />
          <ProcessingHistory attempt={attempt} />
        </>
      ) : null}
    </div>
  );
}

function AttemptScoreSummary({
  attempt,
}: {
  attempt: TrainingAdminAttemptDetail;
}) {
  return (
    <AdminPanel>
      <CardHeader>
        <CardTitle>Итог попытки</CardTitle>
        <AdminStatusBadge>
          {reviewStatusLabels[attempt.reviewStatus]}
        </AdminStatusBadge>
      </CardHeader>
      <CardContent>
        <dl className="training-detail-summary training-detail-summary--admin">
          <div>
            <dt>AI</dt>
            <dd>{formatTrainingScore(attempt.aiScore)}</dd>
          </div>
          <div>
            <dt>Server</dt>
            <dd>{formatTrainingScore(attempt.serverScore)}</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>{formatTrainingScore(attempt.adminScore)}</dd>
          </div>
          <div className="training-detail-summary-final">
            <dt>Final</dt>
            <dd>{formatTrainingScore(attempt.finalScore)}</dd>
          </div>
          <div>
            <dt>Результат</dt>
            <dd>{passStatusLabels[attempt.passStatus]}</dd>
          </div>
          <div>
            <dt>Время</dt>
            <dd>{formatTrainingDuration(attempt.totalDurationSeconds)}</dd>
          </div>
        </dl>
        {attempt.summary ? (
          <p className="training-attempt-summary">{attempt.summary}</p>
        ) : null}
      </CardContent>
    </AdminPanel>
  );
}

function Timeline({ attempt }: { attempt: TrainingAdminAttemptDetail }) {
  return (
    <AdminPanel>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="training-timeline">
          {attempt.timeline.map((event, index) => (
            <li key={`${event.at}:${event.kind}:${index}`}>
              <span aria-hidden="true" />
              <div>
                <strong>{event.label}</strong>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleString('ru-RU')}
                </time>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </AdminPanel>
  );
}

function AdminQuestionCard({
  answer,
  question,
  canReadAudio,
  canReview,
  accessToken,
  onNotice,
  onError,
}: {
  answer: TrainingAdminAnswerDetail | null;
  question: TrainingAdminAttemptDetail['questions'][number];
  canReadAudio: boolean;
  canReview: boolean;
  accessToken: string | null;
  onNotice: (value: string | null) => void;
  onError: (value: string | null) => void;
}) {
  const activeEvaluation = answer?.evaluations.find(
    (evaluation) => evaluation.isActive,
  );
  const activeTranscription = answer?.transcriptions.find(
    (transcription) => transcription.isActive,
  );
  const [isReprocessing, setIsReprocessing] = useState(false);

  async function reprocess(kind: 'transcription' | 'evaluation') {
    if (!accessToken || !answer) return;
    setIsReprocessing(true);
    onError(null);
    onNotice(null);
    try {
      await reprocessTrainingAnswer(
        accessToken,
        answer.id,
        kind,
        'Повторная обработка из интерфейса проверки',
      );
      onNotice('Повторная обработка поставлена в очередь.');
    } catch (caughtError) {
      onError(readError(caughtError, 'Не удалось запустить обработку'));
    } finally {
      setIsReprocessing(false);
    }
  }

  return (
    <AdminPanel className="training-admin-question">
      <CardHeader>
        <div>
          <p className="eyebrow">
            Вопрос {question.sequence} · {question.type}
          </p>
          <CardTitle>{question.text}</CardTitle>
        </div>
        <AdminStatusBadge>{question.status}</AdminStatusBadge>
      </CardHeader>
      <CardContent>
        {!answer ? (
          <AdminEmptyState title="Ответ не создан" />
        ) : (
          <>
            <div className="training-answer-meta">
              <span>Статус: {answer.status}</span>
              <span>
                Голос: {formatTrainingDuration(
                  answer.audioDurationMilliseconds === null
                    ? null
                    : Math.round(answer.audioDurationMilliseconds / 1_000),
                )}
              </span>
              <span>Сегментов: {answer.segments.length}</span>
              <span>
                Audio: {answer.audioMimeType ?? 'MIME —'} ·{' '}
                {answer.audioSizeBytes
                  ? `${answer.audioSizeBytes} bytes`
                  : 'размер —'}
              </span>
              <span>
                Transcription:{' '}
                {answer.transcriptionProvider ?? 'provider —'} /{' '}
                {answer.transcriptionModel ?? 'model —'} / request{' '}
                {answer.transcriptionRequestId ?? '—'}
              </span>
            </div>
            {canReadAudio && answer.audioAvailable ? (
              <TrainingAudioPlayer
                accessToken={accessToken}
                answerId={answer.id}
              />
            ) : null}
            <section className="training-answer-section">
              <div className="training-answer-section-heading">
                <h4>Transcript</h4>
                {canReview ? (
                  <AdminButton
                    disabled={isReprocessing}
                    tone="text"
                    onClick={() => void reprocess('transcription')}
                  >
                    <RotateCcwIcon
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    Перезапустить
                  </AdminButton>
                ) : null}
              </div>
              <p className="training-transcript">
                {activeTranscription?.transcript ??
                  answer.combinedTranscript ??
                  'Transcript отсутствует.'}
              </p>
            </section>
            <section className="training-answer-section">
              <div className="training-answer-section-heading">
                <h4>Оценка и доказательства</h4>
                {canReview ? (
                  <AdminButton
                    disabled={isReprocessing}
                    tone="text"
                    onClick={() => void reprocess('evaluation')}
                  >
                    <RotateCcwIcon
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    Перезапустить
                  </AdminButton>
                ) : null}
              </div>
              {activeEvaluation ? (
                <div className="training-component-list">
                  {activeEvaluation.components.map((component) => (
                    <article
                      key={component.componentKey}
                      className={
                        component.factVerdict === 'UNSUPPORTED' ||
                        component.factVerdict === 'INCORRECT'
                          ? 'training-component training-component--warning'
                          : 'training-component'
                      }
                    >
                      <div>
                        <strong>
                          {component.title ?? component.componentKey}
                        </strong>
                        <span>
                          {component.criterionCode ??
                            component.factCode ??
                            'Компонент'}
                        </span>
                      </div>
                      <strong>
                        {formatTrainingScore(component.awardedPoints)} /{' '}
                        {formatTrainingScore(component.maxPoints)}
                      </strong>
                      <span>{component.factVerdict ?? 'CRITERION'}</span>
                      {component.evidence ? (
                        <pre>{formatEvidence(component.evidence)}</pre>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted-text">Активная оценка отсутствует.</p>
              )}
            </section>
            <details className="training-provider-details">
              <summary>
                Сегменты и акустика ({answer.segments.length})
              </summary>
              <div className="training-segment-list">
                {answer.segments.map((segment) => (
                  <article key={segment.id}>
                    <strong>Сегмент {segment.segmentIndex + 1}</strong>
                    <span>{segment.mimeType ?? 'MIME не указан'}</span>
                    <span>
                      {segment.sizeBytes
                        ? `${segment.sizeBytes} bytes`
                        : 'Размер не указан'}
                    </span>
                    <span>
                      {formatTrainingDuration(
                        segment.durationMilliseconds === null
                          ? null
                          : Math.round(
                              segment.durationMilliseconds / 1_000,
                            ),
                      )}
                    </span>
                    <time dateTime={segment.receivedAt}>
                      {new Date(segment.receivedAt).toLocaleString('ru-RU')}
                    </time>
                  </article>
                ))}
              </div>
              {answer.acousticMetrics ? (
                <pre className="training-safe-json">
                  {formatEvidence(answer.acousticMetrics)}
                </pre>
              ) : (
                <p className="muted-text">Акустические метрики отсутствуют.</p>
              )}
            </details>
            <details className="training-provider-details">
              <summary>
                История evaluation ({answer.evaluations.length})
              </summary>
              <div className="training-evaluation-history">
                {answer.evaluations.map((evaluation) => (
                  <article key={evaluation.id}>
                    <strong>
                      Evaluation {evaluation.evaluationNumber}
                      {evaluation.isActive ? ' · active' : ''}
                    </strong>
                    <span>
                      AI {formatTrainingScore(evaluation.aiSuggestedScore)} ·
                      server {formatTrainingScore(evaluation.serverScore)}
                    </span>
                    <span>
                      prompt {evaluation.promptVersion} · schema{' '}
                      {evaluation.schemaVersion} · rubric{' '}
                      {evaluation.rubricVersion}
                    </span>
                    {evaluation.summary ? <p>{evaluation.summary}</p> : null}
                  </article>
                ))}
              </div>
            </details>
            <details className="training-provider-details">
              <summary>
                Provider runs и метрики ({answer.providerRuns.length})
              </summary>
              <div className="training-provider-run-list">
                {answer.providerRuns.map((run) => (
                  <article key={run.id}>
                    <strong>
                      {run.kind} · {run.status}
                    </strong>
                    <span>
                      model: {run.actualModelId ?? run.requestedModelId}
                    </span>
                    <span>request: {run.requestId ?? '—'}</span>
                    <span>latency: {run.latencyMs ?? '—'} ms</span>
                    <span>
                      prompt/schema/rubric: {run.promptVersion ?? '—'} /{' '}
                      {run.schemaVersion ?? '—'} /{' '}
                      {run.rubricVersion ?? '—'}
                    </span>
                    {run.errorCode ? (
                      <span>
                        {run.errorCode} · {run.errorClass ?? 'error'}
                      </span>
                    ) : null}
                    {run.usage ? (
                      <pre className="training-safe-json">
                        {formatEvidence(run.usage)}
                      </pre>
                    ) : null}
                  </article>
                ))}
              </div>
            </details>
            {answer.errorCode ? (
              <AdminAlert tone="error">
                {answer.errorCode}: {answer.errorMessage ?? 'Ошибка ответа'}
              </AdminAlert>
            ) : null}
          </>
        )}
      </CardContent>
    </AdminPanel>
  );
}

function TrainingAudioPlayer({
  accessToken,
  answerId,
}: {
  accessToken: string | null;
  answerId: string;
}) {
  const managerRef = useRef(new TrainingAudioObjectUrl());
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      managerRef.current.revoke();
    },
    [],
  );

  async function loadAudio() {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const { blob } = await downloadTrainingAnswerAudio(
        accessToken,
        answerId,
      );
      setAudioUrl(managerRef.current.replace(blob));
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить аудио'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="training-audio-player">
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl}>
          Ваш браузер не поддерживает audio.
        </audio>
      ) : (
        <AdminButton disabled={isLoading} onClick={() => void loadAudio()}>
          <AudioLinesIcon data-icon="inline-start" aria-hidden="true" />
          {isLoading ? 'Загрузка' : 'Загрузить защищённое аудио'}
        </AdminButton>
      )}
      {error ? <span className="form-error">{error}</span> : null}
    </div>
  );
}

function ReviewPanel({
  accessToken,
  attempt,
  onReviewed,
}: {
  accessToken: string | null;
  attempt: TrainingAdminAttemptDetail;
  onReviewed: () => Promise<void>;
}) {
  const unsupported = useMemo(
    () => {
      const components = attempt.questions.flatMap(
        (question) =>
          question.answer?.evaluations
            .filter((evaluation) => evaluation.isActive)
            .flatMap((evaluation) =>
              evaluation.components.filter(
                (component) => component.factVerdict === 'UNSUPPORTED',
              ),
            ) ?? [],
      );
      return [
        ...new Map(
          components.map((component) => [
            component.componentKey,
            component,
          ]),
        ).values(),
      ];
    },
    [attempt],
  );
  const submissionRef = useRef(new TrainingReviewSubmission());
  const [decision, setDecision] =
    useState<TrainingReviewRequest['decision']>('APPROVED');
  const [adminScore, setAdminScore] = useState(
    attempt.finalScore ?? '',
  );
  const [comment, setComment] = useState('');
  const [unsupportedDecisions, setUnsupportedDecisions] = useState<
    Record<string, 'ACCEPTED' | 'INCORRECT'>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    const decisions = unsupported.map((component) => ({
      componentKey: component.componentKey,
      decision: unsupportedDecisions[component.componentKey],
    }));
    if (decisions.some((item) => !item.decision)) {
      setError('Примите решение по каждому unsupported claim.');
      return;
    }
    const request: TrainingReviewRequest = {
      decision,
      ...(decision === 'OVERRIDDEN' ? { adminScore } : {}),
      comment,
      unsupportedClaimsDecisions:
        decisions as TrainingReviewRequest['unsupportedClaimsDecisions'],
    };
    const idempotencyKey = submissionRef.current.keyFor(request);
    setIsSubmitting(true);
    setError(null);
    try {
      await reviewTrainingAttempt(
        accessToken,
        attempt.id,
        request,
        idempotencyKey,
      );
      submissionRef.current.complete();
      await onReviewed();
    } catch (caughtError) {
      setError(
        caughtError instanceof ApiRequestError && caughtError.status === 409
          ? 'Конфликт повторного запроса: обновите попытку и повторите решение.'
          : readError(caughtError, 'Не удалось сохранить решение'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AdminPanel className="training-review-panel">
      <CardHeader>
        <div>
          <p className="eyebrow">Ручная проверка</p>
          <CardTitle>Решение администратора</CardTitle>
        </div>
        <ShieldAlertIcon aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <form className="training-review-form" onSubmit={submit}>
          <fieldset>
            <legend>Решение</legend>
            <label>
              <input
                checked={decision === 'APPROVED'}
                name="review-decision"
                type="radio"
                value="APPROVED"
                onChange={() => setDecision('APPROVED')}
              />
              Подтвердить системный результат
            </label>
            <label>
              <input
                checked={decision === 'OVERRIDDEN'}
                name="review-decision"
                type="radio"
                value="OVERRIDDEN"
                onChange={() => setDecision('OVERRIDDEN')}
              />
              Скорректировать итог
            </label>
          </fieldset>
          {decision === 'OVERRIDDEN' ? (
            <label>
              <span>Итоговый балл</span>
              <Input
                required
                min="0"
                max="100"
                step="0.01"
                type="number"
                value={adminScore}
                onChange={(event) => setAdminScore(event.target.value)}
              />
            </label>
          ) : null}
          {unsupported.length ? (
            <fieldset className="training-unsupported-review">
              <legend>Unsupported claims</legend>
              {unsupported.map((component) => (
                <div key={component.componentKey}>
                  <strong>
                    {component.title ?? component.componentKey}
                  </strong>
                  <label>
                    <input
                      checked={
                        unsupportedDecisions[component.componentKey] ===
                        'ACCEPTED'
                      }
                      name={`unsupported-${component.componentKey}`}
                      type="radio"
                      onChange={() =>
                        setUnsupportedDecisions((current) => ({
                          ...current,
                          [component.componentKey]: 'ACCEPTED',
                        }))
                      }
                    />
                    Допустимый факт
                  </label>
                  <label>
                    <input
                      checked={
                        unsupportedDecisions[component.componentKey] ===
                        'INCORRECT'
                      }
                      name={`unsupported-${component.componentKey}`}
                      type="radio"
                      onChange={() =>
                        setUnsupportedDecisions((current) => ({
                          ...current,
                          [component.componentKey]: 'INCORRECT',
                        }))
                      }
                    />
                    Ошибка сотрудника
                  </label>
                </div>
              ))}
            </fieldset>
          ) : null}
          <label>
            <span>Комментарий</span>
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
          <AdminButton
            disabled={isSubmitting || !comment.trim()}
            type="submit"
          >
            <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" />
            {isSubmitting ? 'Сохранение' : 'Сохранить решение'}
          </AdminButton>
        </form>
      </CardContent>
    </AdminPanel>
  );
}

function ReviewHistory({
  attempt,
}: {
  attempt: TrainingAdminAttemptDetail;
}) {
  return (
    <AdminPanel>
      <CardHeader>
        <CardTitle>История проверок</CardTitle>
      </CardHeader>
      <CardContent>
        {attempt.reviews.length ? (
          <div className="training-review-history">
            {attempt.reviews.map((review) => (
              <article key={review.id}>
                <header>
                  <strong>
                    № {review.reviewNumber} ·{' '}
                    {reviewStatusLabels[review.decision]}
                  </strong>
                  <time dateTime={review.reviewedAt}>
                    {new Date(review.reviewedAt).toLocaleString('ru-RU')}
                  </time>
                </header>
                <p>{review.comment}</p>
                <span>
                  {review.reviewer.name ?? review.reviewer.email} · итог{' '}
                  {formatTrainingScore(review.finalScore)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted-text">Ручных проверок пока нет.</p>
        )}
      </CardContent>
    </AdminPanel>
  );
}

function ProcessingHistory({
  attempt,
}: {
  attempt: TrainingAdminAttemptDetail;
}) {
  return (
    <AdminPanel>
      <CardHeader>
        <CardTitle>История обработки</CardTitle>
      </CardHeader>
      <CardContent>
        {attempt.jobs.length ? (
          <div className="training-job-list">
            {attempt.jobs.map((job) => (
              <article key={job.id}>
                <strong>{job.kind}</strong>
                <span>{job.status}</span>
                <span>Попыток worker: {job.attempts}</span>
                {job.lastErrorCode ? (
                  <span>
                    {job.lastErrorCode}: {job.lastErrorMessage}
                  </span>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="muted-text">Связанные job-записи не найдены.</p>
        )}
      </CardContent>
    </AdminPanel>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="training-pagination">
      <span>Всего: {total}</span>
      <div>
        <AdminButton
          disabled={page <= 1}
          tone="secondary"
          onClick={() => onPage(page - 1)}
        >
          Назад
        </AdminButton>
        <span>
          {page} / {Math.max(totalPages, 1)}
        </span>
        <AdminButton
          disabled={page >= totalPages}
          tone="secondary"
          onClick={() => onPage(page + 1)}
        >
          Далее
        </AdminButton>
      </div>
    </div>
  );
}

function compactFilters(filters: ResultFilters) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== ''),
  );
}

function formatEvidence(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
