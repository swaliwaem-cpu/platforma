import type {
  TrainingAdminAttemptDetail,
  TrainingAdminResultListItem,
  TrainingAdminScoreComponent,
  TrainingReviewRequest,
} from '@platforma/shared';
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClipboardCheckIcon,
  FolderIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  UserRoundIcon,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
} from '../components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field';
import { Input } from '../components/ui/input';
import {
  RadioGroup,
  RadioGroupItem,
} from '../components/ui/radio-group';
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
import {
  TrainingReviewSubmission,
  type TrainingReviewOperation,
  type TrainingReviewSubmissionState,
} from './trainingReviewSubmission.mjs';
import {
  attemptStatusLabels,
  answerStatusLabels,
  factVerdictLabels,
  formatTrainingDuration,
  formatTrainingScore,
  passStatusLabels,
  questionStatusLabels,
  questionTypeLabels,
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
          <p>Список попыток сотрудников и результатов ручной проверки.</p>
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
                <TableHead>Замечания</TableHead>
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
                      Предварительно {formatTrainingScore(item.aiScore)} · по
                      правилам {formatTrainingScore(item.serverScore)}
                      {item.adminScore
                        ? ` · после проверки ${formatTrainingScore(item.adminScore)}`
                        : ''}
                    </small>
                    <small>{passStatusLabels[item.passStatus]}</small>
                  </TableCell>
                  <TableCell>
                    {reviewStatusLabels[item.reviewStatus]}
                  </TableCell>
                  <TableCell>
                    {item.answerErrorsCount} ошибок ·{' '}
                    {item.unsupportedClaimsCount} требуют решения
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

type SelectedReviewView =
  | { kind: 'question'; questionId: string }
  | { kind: 'final' };

type AttemptQuestion = TrainingAdminAttemptDetail['questions'][number];

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
  const [selectedView, setSelectedView] = useState<SelectedReviewView | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyAttempt = useCallback((nextAttempt: TrainingAdminAttemptDetail) => {
    setAttempt(nextAttempt);
    setSelectedView((current) => keepAvailableReviewView(current, nextAttempt));
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await getTrainingAdminAttempt(accessToken, attemptId);
      applyAttempt(response.attempt);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить попытку'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, applyAttempt, attemptId]);

  const refreshAfterReview = useCallback(async () => {
    if (!accessToken) {
      throw new Error('Сессия недоступна');
    }
    const [detail] = await Promise.all([
      getTrainingAdminAttempt(accessToken, attemptId),
      getTrainingRanking(accessToken, {
        page: 1,
        pageSize: 1,
      }),
    ]);
    applyAttempt(detail.attempt);
    setError(null);
  }, [accessToken, applyAttempt, attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedQuestion =
    attempt && selectedView?.kind === 'question'
      ? attempt.questions.find(
          (question) => question.id === selectedView.questionId,
        ) ?? null
      : null;

  const openFinalReview = useCallback(() => {
    setSelectedView({ kind: 'final' });
    window.requestAnimationFrame(() => {
      document.getElementById('training-review-panel')?.focus();
    });
  }, []);

  return (
    <div className="training-results training-results--detail">
      <header className="training-results-header training-results-detail-header">
        <div>
          <button
            className="training-results-back"
            type="button"
            onClick={onBack}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Результаты обучения
          </button>
          <h2>
            {attempt
              ? `${attempt.user.name ?? attempt.user.email} · ${attempt.project.title}`
              : 'Результат попытки'}
          </h2>
          <p>Проверка ответов сотрудника и итогового результата.</p>
        </div>
        <AdminButton disabled={isLoading} onClick={() => void load()}>
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          Обновить
        </AdminButton>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? (
        <div className="training-review-status" role="status">
          {notice}
        </div>
      ) : null}
      {isLoading ? (
        <div className="training-results-loading" role="status" aria-busy>
          <LoaderCircleIcon aria-hidden="true" />
          Загрузка результата…
        </div>
      ) : null}
      {attempt && selectedView ? (
        <>
          <AttemptOverview attempt={attempt} />
          <div className="training-review-workspace">
            <QuestionNavigation
              attempt={attempt}
              selectedView={selectedView}
              onSelect={setSelectedView}
            />
            {selectedQuestion ? (
              <QuestionWorkspace
                key={selectedQuestion.id}
                accessToken={accessToken}
                canReadAudio={hasPermission('training:audio:read')}
                canReview={hasPermission('training:results:review')}
                question={selectedQuestion}
                onError={setError}
                onNotice={setNotice}
                onOpenFinal={openFinalReview}
              />
            ) : null}
            <section
              aria-labelledby="training-question-tab-final"
              className="training-final-workspace"
              hidden={selectedView.kind !== 'final'}
              id="training-review-panel"
              role="tabpanel"
              tabIndex={0}
            >
              {hasPermission('training:results:review') ? (
                <ReviewPanel
                  accessToken={accessToken}
                  attempt={attempt}
                  onRefresh={refreshAfterReview}
                />
              ) : (
                <AdminPanel>
                  <CardHeader>
                    <h3>Итог проверки</h3>
                  </CardHeader>
                  <CardContent>
                    <p className="muted-text">
                      У вас нет права изменять результат этой попытки.
                    </p>
                  </CardContent>
                </AdminPanel>
              )}
              <ReviewHistory attempt={attempt} />
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function AttemptOverview({ attempt }: { attempt: TrainingAdminAttemptDetail }) {
  return (
    <AdminPanel className="training-attempt-overview">
      <CardContent>
        <dl>
          <div>
            <dt>
              <UserRoundIcon aria-hidden="true" />
              Сотрудник
            </dt>
            <dd>{attempt.user.name ?? attempt.user.email}</dd>
          </div>
          <div>
            <dt>
              <FolderIcon aria-hidden="true" />
              Проект
            </dt>
            <dd>{attempt.project.title}</dd>
          </div>
          <div>
            <dt>
              <RotateCcwIcon aria-hidden="true" />
              Попытка
            </dt>
            <dd>№ {attempt.attemptNumber}</dd>
          </div>
          <div>
            <dt>
              <CalendarDaysIcon aria-hidden="true" />
              Дата и время
            </dt>
            <dd>{new Date(attempt.startedAt).toLocaleString('ru-RU')}</dd>
          </div>
          <div className="training-attempt-overview-score">
            <dt>Итоговый балл</dt>
            <dd>{formatTrainingScore(attempt.finalScore)} из 100</dd>
          </div>
          <div>
            <dt>Результат</dt>
            <dd>
              <AdminStatusBadge
                className={`training-status-badge training-status-badge--${attempt.passStatus.toLowerCase()}`}
              >
                {passStatusLabels[attempt.passStatus]}
              </AdminStatusBadge>
            </dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>
              <AdminStatusBadge
                className={`training-status-badge training-status-badge--review-${attempt.reviewStatus.toLowerCase()}`}
              >
                {reviewStatusLabels[attempt.reviewStatus]}
              </AdminStatusBadge>
            </dd>
          </div>
        </dl>
      </CardContent>
    </AdminPanel>
  );
}

function QuestionNavigation({
  attempt,
  selectedView,
  onSelect,
}: {
  attempt: TrainingAdminAttemptDetail;
  selectedView: SelectedReviewView;
  onSelect: (view: SelectedReviewView) => void;
}) {
  const navigationItems: Array<{
    id: string;
    label: string;
    view: SelectedReviewView;
  }> = [
    ...attempt.questions.map((question) => ({
      id: `training-question-tab-${question.id}`,
      label: `Вопрос ${question.sequence}`,
      view: { kind: 'question' as const, questionId: question.id },
    })),
    {
      id: 'training-question-tab-final',
      label: 'Итог проверки',
      view: { kind: 'final' as const },
    },
  ];
  const selectedIndex = Math.max(
    0,
    navigationItems.findIndex((item) => isSameReviewView(item.view, selectedView)),
  );

  function handleNavigationKey(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (index + 1) % navigationItems.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + navigationItems.length) % navigationItems.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = navigationItems.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextItem = navigationItems[nextIndex];
    if (!nextItem) return;
    onSelect(nextItem.view);
    window.requestAnimationFrame(() => {
      document.getElementById(nextItem.id)?.focus();
    });
  }

  return (
    <>
      <AdminPanel className="training-question-navigation">
        <CardHeader>
          <h3>Навигация по вопросам</h3>
          <span>
            {formatRussianCount(attempt.questions.length, [
              'вопрос',
              'вопроса',
              'вопросов',
            ])}
          </span>
        </CardHeader>
        <CardContent
          aria-label="Вопросы попытки"
          aria-orientation="vertical"
          role="tablist"
        >
          {attempt.questions.map((question, index) => {
            const isSelected =
              selectedView.kind === 'question' &&
              selectedView.questionId === question.id;
            const score = getQuestionScore(question);
            return (
              <button
                aria-controls="training-question-workspace"
                aria-selected={isSelected}
                className="training-question-navigation-item"
                id={`training-question-tab-${question.id}`}
                key={question.id}
                role="tab"
                tabIndex={isSelected ? 0 : -1}
                type="button"
                onClick={() =>
                  onSelect({ kind: 'question', questionId: question.id })
                }
                onKeyDown={(event) => handleNavigationKey(event, index)}
              >
                <span className="training-question-number" aria-hidden="true">
                  {question.sequence}
                </span>
                <span className="training-question-navigation-copy">
                  <strong>Вопрос {question.sequence}</strong>
                  <small>{questionTypeLabels[question.type]}</small>
                </span>
                <span className="training-question-navigation-result">
                  <strong>{score}</strong>
                  <small>
                    {questionNeedsAttention(question)
                      ? 'Требуется проверка'
                      : questionStatusLabels[question.status]}
                  </small>
                </span>
              </button>
            );
          })}
          <button
            aria-controls="training-review-panel"
            aria-selected={selectedView.kind === 'final'}
            className="training-question-navigation-item training-question-navigation-final"
            id="training-question-tab-final"
            role="tab"
            tabIndex={selectedView.kind === 'final' ? 0 : -1}
            type="button"
            onClick={() => onSelect({ kind: 'final' })}
            onKeyDown={(event) =>
              handleNavigationKey(event, navigationItems.length - 1)
            }
          >
            <ClipboardCheckIcon aria-hidden="true" />
            <span className="training-question-navigation-copy">
              <strong>Итог проверки</strong>
              <small>{formatTrainingScore(attempt.finalScore)} из 100</small>
            </span>
            <span className="training-question-navigation-result">
              <small>{reviewStatusLabels[attempt.reviewStatus]}</small>
            </span>
          </button>
        </CardContent>
      </AdminPanel>

      <div className="training-question-pager" aria-live="polite">
        <AdminButton
          aria-label="Предыдущий вопрос"
          disabled={selectedIndex === 0}
          tone="secondary"
          onClick={() => {
            const previousItem = navigationItems[selectedIndex - 1];
            if (previousItem) onSelect(previousItem.view);
          }}
        >
          <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
          Назад
        </AdminButton>
        <strong>
          {selectedView.kind === 'final'
            ? 'Итог проверки'
            : `Вопрос ${selectedIndex + 1} из ${attempt.questions.length}`}
        </strong>
        <AdminButton
          aria-label="Следующий вопрос"
          disabled={selectedIndex === navigationItems.length - 1}
          tone="secondary"
          onClick={() => {
            const nextItem = navigationItems[selectedIndex + 1];
            if (nextItem) onSelect(nextItem.view);
          }}
        >
          Далее
          <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
        </AdminButton>
      </div>
    </>
  );
}

function QuestionWorkspace({
  accessToken,
  canReadAudio,
  canReview,
  question,
  onError,
  onNotice,
  onOpenFinal,
}: {
  accessToken: string | null;
  canReadAudio: boolean;
  canReview: boolean;
  question: AttemptQuestion;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
  onOpenFinal: () => void;
}) {
  const answer = question.answer;
  const activeEvaluation = answer?.evaluations.find(
    (evaluation) => evaluation.isActive,
  );
  const activeTranscription = answer?.transcriptions.find(
    (transcription) => transcription.isActive,
  );
  const [isTranscriptExpanded, setIsTranscriptExpanded] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const transcript =
    activeTranscription?.transcript ??
    answer?.combinedTranscript ??
    'Расшифровка пока недоступна.';

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
      onNotice(
        kind === 'transcription'
          ? 'Повторное распознавание поставлено в очередь.'
          : 'Пересчёт оценки поставлен в очередь.',
      );
    } catch (caughtError) {
      onError(readError(caughtError, 'Не удалось запустить обработку'));
    } finally {
      setIsReprocessing(false);
    }
  }

  return (
    <AdminPanel
      aria-labelledby={`training-question-tab-${question.id}`}
      className="training-question-workspace"
      id="training-question-workspace"
      role="tabpanel"
      tabIndex={0}
    >
      <CardHeader>
        <div>
          <h3 id={`training-question-heading-${question.id}`}>
            Вопрос {question.sequence} · {questionTypeLabels[question.type]}
          </h3>
          <p>{question.text}</p>
        </div>
        <AdminStatusBadge
          className={`training-status-badge training-status-badge--question-${question.status.toLowerCase()}`}
        >
          {questionStatusLabels[question.status]}
        </AdminStatusBadge>
      </CardHeader>
      <CardContent>
        {!answer ? (
          <AdminEmptyState
            title="Ответ не получен"
            description="Сотрудник не успел ответить на этот вопрос."
          />
        ) : (
          <div className="training-question-columns">
            <section className="training-answer-pane">
              <header>
                <div>
                  <h4>Ответ сотрудника</h4>
                  <span>{answerStatusLabels[answer.status]}</span>
                </div>
                <span>
                  {formatTrainingDuration(question.answerDurationSeconds)}
                </span>
              </header>
              {canReadAudio && answer.audioAvailable ? (
                <TrainingAudioPlayer
                  accessToken={accessToken}
                  answerId={answer.id}
                  questionSequence={question.sequence}
                />
              ) : null}
              <section className="training-transcript-card">
                <header>
                  <h4>Расшифровка ответа</h4>
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
                      Повторно распознать
                    </AdminButton>
                  ) : null}
                </header>
                <p
                  className="training-transcript-readable"
                  data-expanded={isTranscriptExpanded}
                  id={`training-transcript-${answer.id}`}
                >
                  {transcript}
                </p>
                {transcript.length > 420 ? (
                  <AdminButton
                    aria-controls={`training-transcript-${answer.id}`}
                    aria-expanded={isTranscriptExpanded}
                    tone="text"
                    onClick={() => setIsTranscriptExpanded((current) => !current)}
                  >
                    {isTranscriptExpanded ? 'Свернуть' : 'Показать полностью'}
                  </AdminButton>
                ) : null}
              </section>
              {answer.errorCode ? (
                <AdminAlert tone="error">
                  Ответ не удалось обработать. Повторите обработку или обратитесь
                  к администратору системы.
                </AdminAlert>
              ) : null}
            </section>

            <section className="training-evaluation-pane">
              <header>
                <div>
                  <h4>Разбор ответа</h4>
                  <span>Понятное объяснение выставленных баллов</span>
                </div>
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
                    Пересчитать оценку
                  </AdminButton>
                ) : null}
              </header>
              {activeEvaluation ? (
                <ReadableEvaluation
                  components={activeEvaluation.components}
                  onOpenFinal={onOpenFinal}
                />
              ) : (
                <AdminEmptyState
                  title="Оценка пока недоступна"
                  description="Обработка ответа ещё не завершена."
                />
              )}
            </section>
          </div>
        )}
      </CardContent>
    </AdminPanel>
  );
}

function ReadableEvaluation({
  components,
  onOpenFinal,
}: {
  components: TrainingAdminScoreComponent[];
  onOpenFinal: () => void;
}) {
  const orderedComponents = [...components].sort(
    (left, right) => componentAttentionRank(left) - componentAttentionRank(right),
  );

  return (
    <div className="training-readable-evaluation">
      {orderedComponents.map((component, index) => {
        const evidence = getReadableEvidence(component.evidence);
        const needsDecision = component.factVerdict === 'UNSUPPORTED';
        const isWarning =
          needsDecision || component.factVerdict === 'INCORRECT';
        return (
          <article
            className={
              isWarning
                ? 'training-evaluation-card training-evaluation-card--warning'
                : 'training-evaluation-card'
            }
            key={component.componentKey}
          >
            <header>
              <div>
                <strong>{getReadableComponentTitle(component, index)}</strong>
                <span>
                  {component.factVerdict
                    ? factVerdictLabels[component.factVerdict]
                    : 'Критерий оценки'}
                </span>
              </div>
              <strong>
                {formatTrainingScore(component.awardedPoints)} из{' '}
                {formatTrainingScore(component.maxPoints)}
              </strong>
            </header>
            {evidence.map((item) => (
              <div className="training-evidence-field" key={item.label}>
                <span>{item.label}</span>
                {item.kind === 'quote' ? (
                  <blockquote>{item.value}</blockquote>
                ) : (
                  <p>{item.value}</p>
                )}
              </div>
            ))}
            {needsDecision ? (
              <div className="training-evaluation-decision-link">
                <CircleAlertIcon aria-hidden="true" />
                <span>Нужно решение проверяющего.</span>
                <AdminButton tone="text" onClick={onOpenFinal}>
                  Перейти к итогу
                </AdminButton>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function TrainingAudioPlayer({
  accessToken,
  answerId,
  questionSequence,
}: {
  accessToken: string | null;
  answerId: string;
  questionSequence: number;
}) {
  const managerRef = useRef(new TrainingAudioObjectUrl());
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    generationRef.current += 1;
    managerRef.current.revoke();
    setAudioUrl(null);
    setError(null);
    setIsLoading(false);

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      generationRef.current += 1;
      managerRef.current.revoke();
    };
  }, [answerId]);

  async function loadAudio() {
    if (!accessToken) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    managerRef.current.revoke();
    setAudioUrl(null);
    setIsLoading(true);
    setError(null);
    try {
      const { blob } = await downloadTrainingAnswerAudio(
        accessToken,
        answerId,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        generation !== generationRef.current
      ) {
        return;
      }
      const nextUrl = managerRef.current.replace(blob);
      if (
        controller.signal.aborted ||
        generation !== generationRef.current
      ) {
        managerRef.current.revoke();
        return;
      }
      setAudioUrl(nextUrl);
    } catch (caughtError) {
      if (isAbortError(caughtError)) return;
      setError(readError(caughtError, 'Не удалось загрузить аудио'));
    } finally {
      if (generation === generationRef.current) {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setIsLoading(false);
      }
    }
  }

  return (
    <div className="training-audio-player">
      {audioUrl ? (
        <audio
          aria-label={`Запись ответа на вопрос ${questionSequence}`}
          controls
          preload="metadata"
          src={audioUrl}
        >
          Ваш браузер не поддерживает воспроизведение записи.
        </audio>
      ) : (
        <AdminButton disabled={isLoading} onClick={() => void loadAudio()}>
          <AudioLinesIcon data-icon="inline-start" aria-hidden="true" />
          {isLoading ? 'Загрузка…' : 'Прослушать ответ'}
        </AdminButton>
      )}
      {error ? <span className="form-error">{error}</span> : null}
    </div>
  );
}

function ReviewPanel({
  accessToken,
  attempt,
  onRefresh,
}: {
  accessToken: string | null;
  attempt: TrainingAdminAttemptDetail;
  onRefresh: () => Promise<void>;
}) {
  const unsupported = useMemo(
    () => {
      const components = attempt.questions.flatMap((question) =>
        (question.answer?.evaluations ?? [])
          .filter((evaluation) => evaluation.isActive)
          .flatMap((evaluation) =>
            evaluation.components
              .filter((component) => component.factVerdict === 'UNSUPPORTED')
              .map((component) => ({ component, question })),
          ),
      );
      return [
        ...new Map(
          components.map((item) => [
            item.component.componentKey,
            item,
          ]),
        ).values(),
      ];
    },
    [attempt],
  );
  const submissionRef = useRef(new TrainingReviewSubmission());
  const [decision, setDecision] =
    useState<TrainingReviewRequest['decision'] | null>(null);
  const [adminScore, setAdminScore] = useState(
    attempt.finalScore ?? '',
  );
  const [comment, setComment] = useState('');
  const [unsupportedDecisions, setUnsupportedDecisions] = useState<
    Record<string, 'ACCEPTED' | 'INCORRECT'>
  >({});
  const operationLockRef = useRef(false);
  const [submissionState, setSubmissionState] =
    useState<TrainingReviewSubmissionState>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [validationTarget, setValidationTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const decisionGroupRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const isOperationLocked = [
    'SUBMITTING',
    'COMMITTED',
    'REFRESHING',
    'POST_AMBIGUOUS',
    'REFRESH_FAILED',
  ].includes(submissionState);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || operationLockRef.current) return;
    if (!decision) {
      showValidationError(
        'Выберите итоговое решение по попытке.',
        'decision',
      );
      return;
    }
    const decisions = unsupported.map(({ component }) => ({
      componentKey: component.componentKey,
      decision: unsupportedDecisions[component.componentKey],
    }));
    const unresolvedDecision = decisions.find((item) => !item.decision);
    if (unresolvedDecision) {
      showValidationError(
        'Примите решение по каждому спорному утверждению.',
        `unsupported:${unresolvedDecision.componentKey}`,
      );
      return;
    }
    if (!comment.trim()) {
      showValidationError(
        'Добавьте обязательный комментарий проверяющего.',
        'comment',
      );
      return;
    }
    setValidationTarget(null);
    const request: TrainingReviewRequest = {
      decision,
      ...(decision === 'OVERRIDDEN' ? { adminScore } : {}),
      comment,
      unsupportedClaimsDecisions:
        decisions as TrainingReviewRequest['unsupportedClaimsDecisions'],
    };
    let operation: TrainingReviewOperation<TrainingReviewRequest>;
    try {
      operation = submissionRef.current.begin(request);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось начать сохранение'));
      return;
    }
    await sendReviewOperation(operation);
  }

  function showValidationError(message: string, target: string) {
    setValidationTarget(target);
    setError(message);
    window.requestAnimationFrame(() => {
      if (target === 'decision') {
        decisionGroupRef.current
          ?.querySelector<HTMLElement>('[role="radio"]')
          ?.focus();
        return;
      }
      if (target === 'comment') {
        commentRef.current?.focus();
        return;
      }
      const componentKey = target.replace(/^unsupported:/u, '');
      document
        .getElementById(`training-unsupported-decision-${componentKey}`)
        ?.querySelector<HTMLElement>('[role="radio"]')
        ?.focus();
    });
  }

  async function sendReviewOperation(
    operation: TrainingReviewOperation<TrainingReviewRequest>,
  ) {
    if (!accessToken || operationLockRef.current) return;
    operationLockRef.current = true;
    setSubmissionState('SUBMITTING');
    setError(null);
    setNotice(null);
    setHasConflict(false);
    try {
      await reviewTrainingAttempt(
        accessToken,
        attempt.id,
        operation.payload,
        operation.key,
      );
    } catch (caughtError) {
      operationLockRef.current = false;
      if (isAmbiguousReviewPostError(caughtError)) {
        submissionRef.current.markPostAmbiguous();
        setSubmissionState('POST_AMBIGUOUS');
        setError(
          'Результат сохранения неизвестен. Повторите сохранение без изменения данных.',
        );
        return;
      }
      submissionRef.current.markPostFailed();
      setSubmissionState('POST_FAILED');
      if (
        caughtError instanceof ApiRequestError &&
        caughtError.status === 409
      ) {
        setHasConflict(true);
        setError(
          'Данные попытки изменились. Перечитайте результат перед повторным сохранением.',
        );
        return;
      }
      setError(readError(caughtError, 'Не удалось сохранить решение'));
      return;
    }
    submissionRef.current.markCommitted();
    setSubmissionState('COMMITTED');
    setNotice('Проверка сохранена. Обновляем данные.');
    await refreshCommittedReview();
  }

  async function refreshCommittedReview() {
    submissionRef.current.markRefreshing();
    setSubmissionState('REFRESHING');
    setError(null);
    try {
      await onRefresh();
      submissionRef.current.markCompleted();
      setSubmissionState('COMPLETED');
      setNotice('Решение сохранено, результат и рейтинг обновлены.');
    } catch {
      submissionRef.current.markRefreshFailed();
      setSubmissionState('REFRESH_FAILED');
      setNotice(null);
      setError('Проверка сохранена, но обновить данные не удалось');
    } finally {
      operationLockRef.current = false;
    }
  }

  async function retryAmbiguousPost() {
    if (operationLockRef.current) return;
    const operation =
      submissionRef.current.retryAmbiguous<TrainingReviewRequest>();
    await sendReviewOperation(operation);
  }

  async function retryRefresh() {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    await refreshCommittedReview();
  }

  async function rereadAfterConflict() {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setError(null);
    try {
      await onRefresh();
      submissionRef.current.reset();
      setSubmissionState('IDLE');
      setHasConflict(false);
      setNotice('Данные попытки обновлены. Проверьте решение перед отправкой.');
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось перечитать попытку'));
    } finally {
      operationLockRef.current = false;
    }
  }

  return (
    <AdminPanel
      className="training-review-panel"
      data-review-state={submissionState}
    >
      <CardHeader>
        <div>
          <h3>Итог проверки</h3>
          <p>
            Подтвердите результат системы или скорректируйте итоговый балл.
          </p>
        </div>
        <ShieldAlertIcon aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <form className="training-review-form" onSubmit={submit}>
          <FieldGroup>
          <div className="training-review-current-result">
            <span>Текущий итог</span>
            <strong>{formatTrainingScore(attempt.finalScore)} из 100</strong>
            <span>{passStatusLabels[attempt.passStatus]}</span>
          </div>
          <FieldSet disabled={isOperationLocked}>
            <FieldLegend>Решение проверяющего</FieldLegend>
            <FieldDescription>
              Система ничего не выбрала за вас — решение нужно указать явно.
            </FieldDescription>
            <RadioGroup
              aria-describedby={
                validationTarget === 'decision'
                  ? 'training-review-error'
                  : undefined
              }
              aria-invalid={validationTarget === 'decision'}
              aria-label="Решение проверяющего"
              aria-required="true"
              ref={decisionGroupRef}
              value={decision ?? ''}
              onValueChange={(value) => {
                setDecision(value as TrainingReviewRequest['decision']);
                if (validationTarget === 'decision') {
                  setValidationTarget(null);
                  setError(null);
                }
              }}
            >
              <Field className="training-review-choice" orientation="horizontal">
                <RadioGroupItem id="review-decision-approved" value="APPROVED" />
                <FieldLabel htmlFor="review-decision-approved">
                  Подтвердить системный результат
                </FieldLabel>
              </Field>
              <Field className="training-review-choice" orientation="horizontal">
                <RadioGroupItem id="review-decision-overridden" value="OVERRIDDEN" />
                <FieldLabel htmlFor="review-decision-overridden">
                  Скорректировать итог
                </FieldLabel>
              </Field>
            </RadioGroup>
          </FieldSet>
          {decision === 'OVERRIDDEN' ? (
            <Field>
              <FieldLabel htmlFor="training-review-score">
                Итоговый балл
              </FieldLabel>
              <Input
                id="training-review-score"
                required
                min="0"
                max="100"
                step="0.01"
                type="number"
                disabled={isOperationLocked}
                value={adminScore}
                onChange={(event) => setAdminScore(event.target.value)}
              />
            </Field>
          ) : null}
          {unsupported.length ? (
            <section className="training-unsupported-review">
              <header>
                <div>
                  <h4>Утверждения, требующие решения</h4>
                  <span>
                    {formatRussianCount(unsupported.length, [
                      'утверждение',
                      'утверждения',
                      'утверждений',
                    ])}
                  </span>
                </div>
                <CircleAlertIcon aria-hidden="true" />
              </header>
              {unsupported.map(({ component, question }, index) => {
                const evidence = getReadableEvidence(component.evidence);
                const claim =
                  evidence.find((item) => item.label === 'Утверждение сотрудника')
                    ?.value ?? getReadableComponentTitle(component, index);
                return (
                  <FieldSet
                    className="training-unsupported-claim"
                    disabled={isOperationLocked}
                    key={component.componentKey}
                  >
                    <FieldLegend>{claim}</FieldLegend>
                    <FieldDescription>
                      Вопрос {question.sequence} ·{' '}
                      {questionTypeLabels[question.type]}
                    </FieldDescription>
                    {evidence
                      .filter((item) => item.label !== 'Утверждение сотрудника')
                      .map((item) => (
                        <div className="training-evidence-field" key={item.label}>
                          <span>{item.label}</span>
                          {item.kind === 'quote' ? (
                            <blockquote>{item.value}</blockquote>
                          ) : (
                            <p>{item.value}</p>
                          )}
                        </div>
                      ))}
                    <RadioGroup
                      aria-describedby={
                        validationTarget ===
                        `unsupported:${component.componentKey}`
                          ? 'training-review-error'
                          : undefined
                      }
                      aria-invalid={
                        validationTarget ===
                        `unsupported:${component.componentKey}`
                      }
                      aria-label={`Решение по утверждению: ${claim}`}
                      aria-required="true"
                      id={`training-unsupported-decision-${component.componentKey}`}
                      value={unsupportedDecisions[component.componentKey] ?? ''}
                      onValueChange={(value) => {
                        setUnsupportedDecisions((current) => ({
                          ...current,
                          [component.componentKey]: value as
                            | 'ACCEPTED'
                            | 'INCORRECT',
                        }));
                        if (
                          validationTarget ===
                          `unsupported:${component.componentKey}`
                        ) {
                          setValidationTarget(null);
                          setError(null);
                        }
                      }}
                    >
                      <Field className="training-review-choice" orientation="horizontal">
                        <RadioGroupItem
                          id={`unsupported-${component.componentKey}-accepted`}
                          value="ACCEPTED"
                        />
                        <FieldLabel
                          htmlFor={`unsupported-${component.componentKey}-accepted`}
                        >
                          Допустимый факт
                        </FieldLabel>
                      </Field>
                      <Field className="training-review-choice" orientation="horizontal">
                        <RadioGroupItem
                          id={`unsupported-${component.componentKey}-incorrect`}
                          value="INCORRECT"
                        />
                        <FieldLabel
                          htmlFor={`unsupported-${component.componentKey}-incorrect`}
                        >
                          Ошибка сотрудника
                        </FieldLabel>
                      </Field>
                    </RadioGroup>
                  </FieldSet>
                );
              })}
            </section>
          ) : null}
          <Field>
            <FieldLabel htmlFor="training-review-comment">
              Комментарий (обязательно)
            </FieldLabel>
            <textarea
              aria-describedby={
                validationTarget === 'comment'
                  ? 'training-review-error'
                  : undefined
              }
              aria-invalid={validationTarget === 'comment'}
              ref={commentRef}
              aria-required="true"
              id="training-review-comment"
              maxLength={2000}
              rows={4}
              disabled={isOperationLocked}
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
                if (validationTarget === 'comment') {
                  setValidationTarget(null);
                  setError(null);
                }
              }}
            />
          </Field>
          {notice ? (
            <div className="training-review-status" role="status">
              {notice}
            </div>
          ) : null}
          {error ? <FieldError id="training-review-error">{error}</FieldError> : null}
          <AdminButton
            className="training-review-submit"
            disabled={isOperationLocked}
            type="submit"
          >
            <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" />
            {submissionState === 'SUBMITTING'
              ? 'Сохранение'
              : submissionState === 'REFRESHING'
                ? 'Обновление'
                : 'Сохранить решение'}
          </AdminButton>
          {submissionState === 'POST_AMBIGUOUS' ? (
            <AdminButton
              tone="secondary"
              type="button"
              onClick={() => void retryAmbiguousPost()}
            >
              Повторить сохранение
            </AdminButton>
          ) : null}
          {submissionState === 'REFRESH_FAILED' ? (
            <AdminButton
              tone="secondary"
              type="button"
              onClick={() => void retryRefresh()}
            >
              Повторить обновление
            </AdminButton>
          ) : null}
          {hasConflict ? (
            <AdminButton
              tone="secondary"
              type="button"
              onClick={() => void rereadAfterConflict()}
            >
              Перечитать данные
            </AdminButton>
          ) : null}
          </FieldGroup>
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
  if (!attempt.reviews.length) return null;
  return (
    <AdminPanel className="training-review-history-panel">
      <CardContent>
        <details className="training-review-history-details">
          <summary>Предыдущие решения ({attempt.reviews.length})</summary>
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
        </details>
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

function keepAvailableReviewView(
  current: SelectedReviewView | null,
  attempt: TrainingAdminAttemptDetail,
): SelectedReviewView {
  if (current?.kind === 'final') return current;
  if (
    current?.kind === 'question' &&
    attempt.questions.some((question) => question.id === current.questionId)
  ) {
    return current;
  }
  const defaultQuestion =
    attempt.questions.find(questionNeedsAttention) ?? attempt.questions[0];
  return defaultQuestion
    ? { kind: 'question', questionId: defaultQuestion.id }
    : { kind: 'final' };
}

function isSameReviewView(
  left: SelectedReviewView,
  right: SelectedReviewView,
) {
  return (
    left.kind === right.kind &&
    (left.kind === 'final' ||
      (right.kind === 'question' && left.questionId === right.questionId))
  );
}

function questionNeedsAttention(question: AttemptQuestion) {
  const evaluation = question.answer?.evaluations.find(
    (item) => item.isActive,
  );
  return Boolean(
    evaluation?.requiresReview ||
      evaluation?.components.some(
        (component) => component.factVerdict === 'UNSUPPORTED',
      ),
  );
}

function getQuestionScore(question: AttemptQuestion) {
  const evaluation = question.answer?.evaluations.find(
    (item) => item.isActive,
  );
  if (!evaluation) return '—';
  const maximum = evaluation.components.reduce((total, component) => {
    const value = Number(component.maxPoints);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
  return `${formatTrainingScore(evaluation.serverScore)} / ${formatTrainingScore(maximum)}`;
}

function componentAttentionRank(component: TrainingAdminScoreComponent) {
  if (component.factVerdict === 'UNSUPPORTED') return 0;
  if (component.factVerdict === 'INCORRECT') return 1;
  if (
    component.factVerdict === 'PARTIAL' ||
    component.factVerdict === 'MISSING'
  ) {
    return 2;
  }
  return 3;
}

function getReadableComponentTitle(
  component: TrainingAdminScoreComponent,
  index: number,
) {
  const title = component.title?.trim();
  if (title && !looksLikeTechnicalIdentifier(title)) return title;
  if (component.factVerdict === 'UNSUPPORTED') {
    return 'Утверждение требует решения';
  }
  if (component.factVerdict === 'INCORRECT') return 'Фактическая ошибка';
  return `Критерий ${index + 1}`;
}

function looksLikeTechnicalIdentifier(value: string) {
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/iu.test(value);
}

function getReadableEvidence(value: unknown): Array<{
  kind: 'quote' | 'text';
  label: string;
  value: string;
}> {
  if (typeof value === 'string' && value.trim()) {
    return [
      {
        kind: 'text',
        label: 'Почему так оценено',
        value: value.trim(),
      },
    ];
  }
  if (!isRecord(value)) return [];
  const claim = readEvidenceString(value.claim);
  const text = readEvidenceString(value.text);
  const explanation = readEvidenceString(value.explanation);
  const result: Array<{
    kind: 'quote' | 'text';
    label: string;
    value: string;
  }> = [];
  if (claim) {
    result.push({
      kind: 'quote',
      label: 'Утверждение сотрудника',
      value: claim,
    });
  }
  if (text && text !== claim) {
    result.push({
      kind: 'quote',
      label: 'Фрагмент ответа',
      value: text,
    });
  }
  if (explanation) {
    result.push({
      kind: 'text',
      label: 'Почему так оценено',
      value: explanation,
    });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readEvidenceString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatRussianCount(
  count: number,
  forms: readonly [string, string, string],
) {
  const absolute = Math.abs(count) % 100;
  const lastDigit = absolute % 10;
  const form =
    absolute > 10 && absolute < 20
      ? forms[2]
      : lastDigit === 1
        ? forms[0]
        : lastDigit >= 2 && lastDigit <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}

function isAmbiguousReviewPostError(error: unknown) {
  return (
    !(error instanceof ApiRequestError) ||
    error.status === 0 ||
    error.status >= 500
  );
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
