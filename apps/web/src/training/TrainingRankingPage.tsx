import type {
  TrainingRankingItem,
  TrainingRankingResponse,
} from '@platforma/shared';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  TrophyIcon,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  AdminAlert,
  AdminButton,
  AdminEmptyState,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import {
  downloadTrainingRankingCsv,
  getTrainingRanking,
} from './trainingResultsApi';
import {
  formatTrainingDuration,
  formatTrainingScore,
  passStatusLabels,
} from './trainingViewModel.mjs';
import './trainingResults.css';

type TrainingRankingPageProps = {
  navigate: (path: string) => void;
  onBack: () => void;
};

export function TrainingRankingPage({
  navigate,
  onBack,
}: TrainingRankingPageProps) {
  const { accessToken } = useAuth();
  const [response, setResponse] = useState<TrainingRankingResponse | null>(
    null,
  );
  const [userFilter, setUserFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [appliedUser, setAppliedUser] = useState('');
  const [appliedProject, setAppliedProject] = useState('');
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      setResponse(
        await getTrainingRanking(accessToken, {
          page,
          pageSize: 25,
          user: appliedUser || undefined,
          projectId: appliedProject || undefined,
        }),
      );
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить рейтинг'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, appliedProject, appliedUser, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedUser(userFilter.trim());
    setAppliedProject(projectFilter);
  }

  async function exportCsv() {
    if (!accessToken) return;
    setIsExporting(true);
    setError(null);
    try {
      const { blob, filename } = await downloadTrainingRankingCsv(
        accessToken,
        {
          user: appliedUser || undefined,
          projectId: appliedProject || undefined,
        },
      );
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename ?? 'training-ranking.csv';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось выгрузить CSV'));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="training-results training-results--ranking">
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
          <p className="eyebrow">Обучение · аналитика</p>
          <h2>Рейтинг сотрудников</h2>
          <p>
            Лучший подтверждённый результат по проекту; ожидание проверки и
            технические возвраты исключены.
          </p>
        </div>
        <div className="training-results-actions">
          <AdminButton
            disabled={isExporting}
            tone="secondary"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon data-icon="inline-start" aria-hidden="true" />
            {isExporting ? 'Выгрузка' : 'CSV'}
          </AdminButton>
          <AdminButton disabled={isLoading} onClick={() => void load()}>
            <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
            Обновить
          </AdminButton>
        </div>
      </header>

      <AdminPanel>
        <form className="training-ranking-filter" onSubmit={submit}>
          <label>
            <span>Сотрудник</span>
            <Input
              placeholder="Имя или email"
              value={userFilter}
              onChange={(event) => setUserFilter(event.target.value)}
            />
          </label>
          <label>
            <span>Проект</span>
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">Все проекты</option>
              {response?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <AdminButton type="submit">
            <SearchIcon data-icon="inline-start" aria-hidden="true" />
            Применить
          </AdminButton>
        </form>
      </AdminPanel>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {isLoading ? (
        <div className="training-results-loading" role="status">
          <LoaderCircleIcon aria-hidden="true" />
          Расчёт рейтинга
        </div>
      ) : null}
      {!isLoading && !response?.items.length ? (
        <AdminEmptyState
          title="Данных для рейтинга пока нет"
          description="Сотрудники появятся после завершённых попыток; до этого нулевые значения не подставляются."
        />
      ) : null}
      {response?.items.length ? (
        <AdminPanel className="training-results-table-panel">
          <Table className="training-ranking-table">
            <TableHeader>
              <TableRow>
                <TableHead>Место</TableHead>
                <TableHead>Сотрудник</TableHead>
                <TableHead>Пройдено</TableHead>
                <TableHead>Завершено</TableHead>
                <TableHead>Средний лучший</TableHead>
                <TableHead>Попытки</TableHead>
                <TableHead>Время</TableHead>
                <TableHead>Расшифровка</TableHead>
                <TableHead>Последняя</TableHead>
                <TableHead aria-label="Разбор" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.items.map((item) => (
                <RankingRow
                  key={item.user.id}
                  item={item}
                  navigate={navigate}
                />
              ))}
            </TableBody>
          </Table>
        </AdminPanel>
      ) : null}
      {response ? (
        <div className="training-pagination">
          <span>Всего сотрудников: {response.pagination.total}</span>
          <div>
            <AdminButton
              disabled={page <= 1}
              tone="secondary"
              onClick={() => setPage((current) => current - 1)}
            >
              Назад
            </AdminButton>
            <span>
              {page} / {Math.max(response.pagination.totalPages, 1)}
            </span>
            <AdminButton
              disabled={page >= response.pagination.totalPages}
              tone="secondary"
              onClick={() => setPage((current) => current + 1)}
            >
              Далее
            </AdminButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RankingRow({
  item,
  navigate,
}: {
  item: TrainingRankingItem;
  navigate: (path: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell>
          <span className="training-ranking-position">
            {item.position <= 3 ? (
              <TrophyIcon aria-hidden="true" />
            ) : null}
            {item.position}
          </span>
        </TableCell>
        <TableCell>
          <strong>{item.user.name ?? 'Без имени'}</strong>
          <small>{item.user.email}</small>
        </TableCell>
        <TableCell>{item.passedProjectsCount}</TableCell>
        <TableCell>{item.completedProjectsCount}</TableCell>
        <TableCell>
          <strong>{formatTrainingScore(item.averageBestScore)}</strong>
        </TableCell>
        <TableCell>{item.attemptsUsed}</TableCell>
        <TableCell>
          <span>
            Среднее {formatTrainingDuration(item.averageDurationSeconds)}
          </span>
          <small>
            Суммарно {formatTrainingDuration(item.totalDurationSeconds)}
          </small>
        </TableCell>
        <TableCell>
          <span className="training-ranking-narrative-brief">
            {item.narrative}
          </span>
        </TableCell>
        <TableCell>
          {item.lastCompletedAt
            ? new Date(item.lastCompletedAt).toLocaleDateString('ru-RU')
            : '—'}
        </TableCell>
        <TableCell>
          <AdminButton
            aria-expanded={isExpanded}
            tone="text"
            onClick={() => setIsExpanded((current) => !current)}
          >
            <ChevronDownIcon data-icon="inline-start" aria-hidden="true" />
            Разбор
          </AdminButton>
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow className="training-ranking-expanded-row">
          <TableCell colSpan={10}>
            <p className="training-ranking-narrative">{item.narrative}</p>
            <div className="training-ranking-projects">
              {item.projects.length ? (
                item.projects.map((project) => (
                  <article key={project.projectId}>
                    <header>
                      <strong>{project.projectTitle}</strong>
                      <div>
                        <AdminStatusBadge>
                          {passStatusLabels[project.passStatus]}
                        </AdminStatusBadge>
                        <strong>
                          {formatTrainingScore(project.finalScore)}
                        </strong>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>Дата</dt>
                        <dd>
                          {new Date(project.completedAt).toLocaleString(
                            'ru-RU',
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Использовано попыток</dt>
                        <dd>{project.attemptsUsed}</dd>
                      </div>
                      <div>
                        <dt>Динамика</dt>
                        <dd>
                          {project.scoreChangeFromFirst === null
                            ? 'Недостаточно попыток'
                            : formatSignedScore(
                                project.scoreChangeFromFirst,
                              )}
                        </dd>
                      </div>
                      {project.components.map((component) => (
                        <div key={component.key}>
                          <dt>{component.title}</dt>
                          <dd>
                            {formatTrainingScore(component.awardedPoints)} /{' '}
                            {formatTrainingScore(component.maxPoints)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {project.summary ? <p>{project.summary}</p> : null}
                    {project.errors.length ? (
                      <p>Ошибки: {project.errors.join(', ')}</p>
                    ) : null}
                    {project.unsupportedClaims.length ? (
                      <p>
                        Сверх материала:{' '}
                        {project.unsupportedClaims.join(', ')}
                      </p>
                    ) : null}
                    <AdminButton
                      tone="text"
                      onClick={() =>
                        navigate(
                          `/admin/training/results/${project.attemptId}`,
                        )
                      }
                    >
                      Открыть попытку № {project.attemptNumber}
                    </AdminButton>
                  </article>
                ))
              ) : (
                <p className="muted-text">
                  Нет завершённых подтверждённых проектов.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatSignedScore(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return `${parsed > 0 ? '+' : ''}${formatTrainingScore(parsed)}`;
}
