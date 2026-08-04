import { FormEvent, Fragment, useEffect, useState } from 'react';
import type { TrainingAdminRankingQuery, TrainingAdminRankingRow } from '@platforma/shared';
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XCircleIcon,
} from 'lucide-react';

import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadTrainingAdminRankingCsv, getTrainingAdminRanking } from './trainingApi';
import { formatTrainingDate, formatTrainingDuration } from './trainingView';

const initialQuery: TrainingAdminRankingQuery = {
  page: 1,
  limit: 20,
  search: '',
  project: '',
  accessMode: '',
  currentlyAssigned: '',
  currentlyEligible: '',
};

export function TrainingAdminRankingPage({ navigate }: { navigate: (pathname: string) => void }) {
  const { accessToken } = useAuth();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<TrainingAdminRankingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    void getTrainingAdminRanking(accessToken, query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setItems(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setItems([]);
          setTotal(0);
          setTotalPages(0);
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить рейтинг');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, query, reloadKey]);

  const update = <Key extends keyof TrainingAdminRankingQuery>(
    key: Key,
    value: TrainingAdminRankingQuery[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setExpandedUserId(null);
    setQuery({ ...draft, page: 1 });
  };

  const resetFilters = () => {
    setDraft(initialQuery);
    setQuery(initialQuery);
    setShowAdvancedFilters(false);
    setExpandedUserId(null);
  };

  const setPage = (page: number) => {
    const next = { ...query, page };
    setDraft(next);
    setQuery(next);
    setExpandedUserId(null);
  };

  const exportCsv = async () => {
    if (!accessToken || isExporting) return;
    setIsExporting(true);
    setError(null);
    try {
      await downloadTrainingAdminRankingCsv(accessToken, { ...query, page: 1 });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Не удалось выгрузить CSV');
    } finally {
      setIsExporting(false);
    }
  };

  const firstVisibleItem = total ? (query.page - 1) * query.limit + 1 : 0;
  const lastVisibleItem = Math.min(query.page * query.limit, total);

  return <div className="training-page training-admin-page training-ranking-page">
    <header className="training-page-header">
      <div>
        <p className="eyebrow">Админка · Обучение</p>
        <h2>Рейтинг сотрудников</h2>
        <p className="muted-text">Сравнение результатов с подробностями по выбранному сотруднику.</p>
      </div>
      <div className="training-project-actions training-ranking-header-actions">
        <AdminButton type="button" tone="secondary" onClick={() => navigate('/admin/training')}>
          <ArrowLeftIcon aria-hidden="true" />
          К проектам
        </AdminButton>
        <AdminButton type="button" tone="primary" disabled={isExporting} onClick={() => void exportCsv()}>
          <DownloadIcon aria-hidden="true" />
          {isExporting ? 'Подготовка…' : 'Скачать CSV'}
        </AdminButton>
      </div>
    </header>

    <AdminPanel className="training-results-filter-panel training-ranking-filter-panel">
      <form onSubmit={applyFilters}>
        <div className="training-ranking-filter-header">
          <div>
            <h3>Найти сотрудника</h3>
            <p>Основные фильтры видны сразу, дополнительные открываются отдельно.</p>
          </div>
          <div className="training-ranking-filter-actions">
            <AdminButton type="button" tone="secondary" onClick={resetFilters}>
              <RotateCcwIcon aria-hidden="true" />
              Сбросить
            </AdminButton>
            <AdminButton
              type="button"
              tone="secondary"
              aria-expanded={showAdvancedFilters}
              aria-controls="training-ranking-advanced-filters"
              onClick={() => setShowAdvancedFilters((value) => !value)}
            >
              <SlidersHorizontalIcon aria-hidden="true" />
              {showAdvancedFilters ? 'Скрыть фильтры' : 'Ещё фильтры'}
            </AdminButton>
            <AdminButton type="submit" tone="primary">
              <SearchIcon aria-hidden="true" />
              Показать
            </AdminButton>
          </div>
        </div>

        <FieldGroup className="training-ranking-filters training-ranking-filters--main">
          <Field>
            <FieldLabel htmlFor="training-ranking-search">Сотрудник</FieldLabel>
            <Input
              id="training-ranking-search"
              placeholder="Имя или электронная почта"
              value={draft.search}
              onChange={(event) => update('search', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="training-ranking-project">Проект</FieldLabel>
            <Input
              id="training-ranking-project"
              placeholder="Название или идентификатор"
              value={draft.project}
              onChange={(event) => update('project', event.target.value)}
            />
          </Field>
          <SelectField
            id="training-ranking-eligible"
            label="Доступ"
            value={draft.currentlyEligible}
            onChange={(value) => update('currentlyEligible', value as TrainingAdminRankingQuery['currentlyEligible'])}
            options={[["", "Все сотрудники"], ["true", "Есть доступ"], ["false", "Нет доступа"]]}
          />
        </FieldGroup>

        {showAdvancedFilters ? <FieldGroup id="training-ranking-advanced-filters" className="training-ranking-filters training-ranking-filters--advanced">
          <SelectField
            id="training-ranking-access"
            label="Модель доступа"
            value={draft.accessMode}
            onChange={(value) => update('accessMode', value as TrainingAdminRankingQuery['accessMode'])}
            options={[["", "Все"], ["ASSIGNED_USERS", "По назначениям"], ["ALL_PARTICIPANTS", "Все участники"]]}
          />
          <SelectField
            id="training-ranking-assigned"
            label="Сейчас назначен"
            value={draft.currentlyAssigned}
            onChange={(value) => update('currentlyAssigned', value as TrainingAdminRankingQuery['currentlyAssigned'])}
            options={[["", "Все"], ["true", "Да"], ["false", "Нет"]]}
          />
        </FieldGroup> : null}
      </form>
    </AdminPanel>

    {error ? <AdminAlert tone="error">
      <span>{error}</span>
      <AdminButton type="button" tone="secondary" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton>
    </AdminAlert> : null}

    {isLoading ? <Skeleton className="training-list-skeleton" aria-label="Загрузка рейтинга" /> : items.length ? <AdminPanel className="training-results-table-panel training-ranking-table-panel">
      <div className="training-ranking-panel-header">
        <div>
          <h3>Сотрудники</h3>
          <p>Нажмите «Детали», чтобы раскрыть аналитику под строкой.</p>
        </div>
        <AdminStatusBadge>{total} {pluralizeEmployee(total)}</AdminStatusBadge>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Место</TableHead>
            <TableHead>Сотрудник</TableHead>
            <TableHead>Доступ</TableHead>
            <TableHead>Результат</TableHead>
            <TableHead>Средний балл</TableHead>
            <TableHead>Текущий охват</TableHead>
            <TableHead>Попытки / время</TableHead>
            <TableHead><span className="sr-only">Действия</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, index) => <RankingRow
            key={item.user.id}
            item={item}
            position={(query.page - 1) * query.limit + index + 1}
            isExpanded={expandedUserId === item.user.id}
            onToggle={() => setExpandedUserId((current) => current === item.user.id ? null : item.user.id)}
          />)}
        </TableBody>
      </Table>

      <footer className="training-ranking-panel-footer">
        <span>Показано {firstVisibleItem}–{lastVisibleItem} из {total}</span>
        <div className="training-results-pagination">
          <AdminButton type="button" tone="secondary" disabled={query.page <= 1 || isLoading} onClick={() => setPage(query.page - 1)}>
            Назад
          </AdminButton>
          <span>Страница {query.page} из {Math.max(1, totalPages)}</span>
          <AdminButton type="button" tone="secondary" disabled={query.page >= totalPages || isLoading} onClick={() => setPage(query.page + 1)}>
            Далее
          </AdminButton>
        </div>
      </footer>
    </AdminPanel> : <AdminEmptyState title="Рейтинг пуст" description="Измените фильтры или дождитесь подтверждённых результатов." />}
  </div>;
}

function RankingRow({
  item,
  position,
  isExpanded,
  onToggle,
}: {
  item: TrainingAdminRankingRow;
  position: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const detailsId = `training-ranking-details-${item.user.id}`;
  const coverageLabel = item.currentCoveragePercent === null ? '—' : `${item.currentCoveragePercent}%`;
  const coverageValue = Math.min(100, Math.max(0, Number(item.currentCoveragePercent ?? 0)));
  const coverageWidth = `${coverageValue}%`;
  const hasAccess = item.currentEligibleProjectsCount > 0;

  return <Fragment>
    <TableRow className="training-ranking-row" data-state={isExpanded ? 'selected' : undefined}>
      <TableCell><span className="training-ranking-position">{position}</span></TableCell>
      <TableCell>
        <div className="training-ranking-person">
          <strong>{item.user.name ?? item.user.email}</strong>
          <small>{item.user.email}</small>
        </div>
      </TableCell>
      <TableCell>
        <AdminStatusBadge className={hasAccess ? 'training-ranking-access training-ranking-access--yes' : 'training-ranking-access training-ranking-access--no'}>
          {hasAccess ? <CheckCircle2Icon aria-hidden="true" /> : <XCircleIcon aria-hidden="true" />}
          {hasAccess ? 'Есть доступ' : 'Нет доступа'}
        </AdminStatusBadge>
      </TableCell>
      <TableCell><strong>{item.passedProjectsCount} / {item.completedProjectsCount}</strong></TableCell>
      <TableCell><strong>{item.averageBestScore ?? '—'}</strong></TableCell>
      <TableCell>
        <div className="training-ranking-coverage">
          <strong>{coverageLabel}</strong>
          <div className="training-ranking-progress" role="progressbar" aria-label={`Текущий охват: ${coverageLabel}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverageValue}>
            <span style={{ width: coverageWidth }} />
          </div>
          <small>{item.currentEligibleProjectsCount} {pluralizeProject(item.currentEligibleProjectsCount)}</small>
        </div>
      </TableCell>
      <TableCell>
        <div className="training-ranking-attempts">
          <strong>{item.attemptsUsed}</strong>
          <small>Всего {formatTrainingDuration(item.totalDurationSeconds)}</small>
        </div>
      </TableCell>
      <TableCell>
        <AdminButton
          type="button"
          tone="secondary"
          className="training-ranking-detail-toggle"
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          {isExpanded ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
          Детали
        </AdminButton>
      </TableCell>
    </TableRow>

    {isExpanded ? <TableRow className="training-ranking-expanded-row">
      <TableCell colSpan={8}>
        <div id={detailsId} className="training-ranking-expanded-content">
          <div className="training-ranking-expanded-grid">
            <section>
              <span className="training-ranking-detail-label">Прогресс</span>
              <strong>{item.currentCompletedEligibleProjectsCount} из {item.currentEligibleProjectsCount} завершено</strong>
              <p>Пройдено: {item.currentPassedEligibleProjectsCount}.</p>
              <p>Для всех: {item.currentAccess.allParticipantsProjectsCount} · по назначениям: {item.currentAccess.assignedProjectsCount} · активных назначений: {item.currentAccess.activeAssignmentsCount}.</p>
            </section>
            <section>
              <span className="training-ranking-detail-label">Качество</span>
              <strong>{item.summary.text}</strong>
              <p>Ошибок в фактах: {item.summary.factualErrorsCount} · неподтверждённых утверждений: {item.summary.unsupportedClaimsCount}.</p>
              {item.summary.strongestCriterion ? <p>Сильная сторона: {item.summary.strongestCriterion.title}.</p> : null}
            </section>
            <section>
              <span className="training-ranking-detail-label">Последняя активность</span>
              <strong>{formatTrainingDate(item.lastCompletedAt)}</strong>
              <p>Среднее время: {item.averageDurationSeconds ? formatTrainingDuration(Number(item.averageDurationSeconds)) : '—'}.</p>
              <p>Лучший результат: {item.passedProjectsCount} из {item.completedProjectsCount}.</p>
            </section>
          </div>

          <details className="training-ranking-project-results">
            <summary>Результаты по проектам</summary>
            {item.bestResults.length ? <ul>{item.bestResults.map((result) => <li key={result.projectId}>
              <div>
                <strong>{result.projectTitle}</strong>
                <small>{result.isPassed ? 'пройдено' : 'не пройдено'} · {result.currentlyEligible ? 'доступен сейчас' : 'история'} · {result.accessMode === 'ALL_PARTICIPANTS' ? 'все участники' : assignmentLabel(result.assignmentStatus)}</small>
              </div>
              <strong>{result.finalScore}/100</strong>
            </li>)}</ul> : <p>Завершённых проектов пока нет.</p>}
          </details>
        </div>
      </TableCell>
    </TableRow> : null}
  </Fragment>;
}

function assignmentLabel(status: TrainingAdminRankingRow['bestResults'][number]['assignmentStatus']) {
  if (status === 'ASSIGNED') return 'назначен';
  if (status === 'REVOKED') return 'назначение отозвано';
  return 'не назначался';
}

function pluralizeEmployee(count: number) {
  const value = Math.abs(count) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return 'сотрудников';
  if (last === 1) return 'сотрудник';
  if (last > 1 && last < 5) return 'сотрудника';
  return 'сотрудников';
}

function pluralizeProject(count: number) {
  const value = Math.abs(count) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return 'проектов';
  if (last === 1) return 'проект';
  if (last > 1 && last < 5) return 'проекта';
  return 'проектов';
}

function SelectField({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <select id={id} className="training-select" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(([optionValue, optionLabel]) => <option key={optionValue || 'all'} value={optionValue}>{optionLabel}</option>)}
    </select>
  </Field>;
}
