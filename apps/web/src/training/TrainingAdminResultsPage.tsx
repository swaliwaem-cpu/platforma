import { FormEvent, useEffect, useState } from 'react';
import type { TrainingAdminResultSummary, TrainingAdminResultsQuery } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getTrainingAdminResults } from './trainingApi';
import {
  formatTrainingDate,
  formatTrainingDuration,
  getTrainingStatusClass,
  trainingAnswerSourceLabels,
  trainingAssignmentStatusLabels,
  trainingAttemptStatusLabels,
  trainingReviewStatusLabels,
} from './trainingView';

const initialQuery: TrainingAdminResultsQuery = {
  page: 1,
  limit: 20,
  search: '',
  userId: '',
  projectId: '',
  accessMode: '',
  assignmentStatus: '',
  startedFrom: '',
  startedTo: '',
  attemptStatus: '',
  reviewStatus: '',
  passed: '',
  scoreMin: '',
  scoreMax: '',
  durationMin: '',
  durationMax: '',
  source: '',
  sort: 'STARTED_DESC',
};

type TrainingAdminResultsPageProps = { navigate: (pathname: string) => void };

export function TrainingAdminResultsPage({ navigate }: TrainingAdminResultsPageProps) {
  const { accessToken } = useAuth();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<TrainingAdminResultSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAdminResults(accessToken, query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setItems(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить результаты');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, query, reloadKey]);

  const update = <Key extends keyof TrainingAdminResultsQuery>(key: Key, value: TrainingAdminResultsQuery[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setQuery({ ...draft, page: 1 });
  };
  const resetFilters = () => {
    setDraft(initialQuery);
    setQuery(initialQuery);
  };
  const setPage = (page: number) => {
    const next = { ...query, page };
    setDraft(next);
    setQuery(next);
  };

  return (
    <div className="training-page training-admin-page">
      <header className="training-page-header">
        <div><p className="eyebrow">Админка · Обучение</p><h2>Результаты сотрудников</h2><p className="muted-text">Серверные фильтры, постраничный вывод и детальная проверка каждой попытки.</p></div>
        <AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>К проектам</AdminButton>
      </header>

      <AdminPanel className="training-results-filter-panel">
        <form onSubmit={applyFilters}>
          <FieldGroup className="training-results-filters">
            <Field><FieldLabel htmlFor="training-result-search">Сотрудник</FieldLabel><Input id="training-result-search" placeholder="Имя или электронная почта" value={draft.search} onChange={(event) => update('search', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-project">Идентификатор проекта</FieldLabel><Input id="training-result-project" value={draft.projectId} onChange={(event) => update('projectId', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-user">Идентификатор сотрудника</FieldLabel><Input id="training-result-user" value={draft.userId} onChange={(event) => update('userId', event.target.value)} /></Field>
            <SelectField id="training-result-status" label="Статус" value={draft.attemptStatus} onChange={(value) => update('attemptStatus', value as TrainingAdminResultsQuery['attemptStatus'])} options={[['', 'Все'], ['IN_PROGRESS', 'В процессе'], ['COMPLETED', 'Завершена'], ['REQUIRES_REVIEW', 'Требует проверки'], ['TIMED_OUT', 'Время истекло'], ['TECHNICAL_FAILED', 'Техническая ошибка']]} />
            <SelectField id="training-result-review" label="Проверка" value={draft.reviewStatus} onChange={(value) => update('reviewStatus', value as TrainingAdminResultsQuery['reviewStatus'])} options={[['', 'Все'], ['NOT_REQUIRED', 'Не требуется'], ['PENDING', 'Ожидает'], ['RESOLVED', 'Завершена']]} />
            <SelectField id="training-result-passed" label="Итог" value={draft.passed} onChange={(value) => update('passed', value as TrainingAdminResultsQuery['passed'])} options={[['', 'Все'], ['true', 'Пройдено'], ['false', 'Не пройдено']]} />
            <SelectField id="training-result-access" label="Модель доступа" value={draft.accessMode} onChange={(value) => update('accessMode', value as TrainingAdminResultsQuery['accessMode'])} options={[['', 'Все'], ['ASSIGNED_USERS', 'По назначениям'], ['ALL_PARTICIPANTS', 'Все участники']]} />
            <SelectField id="training-result-assignment" label="Назначение" value={draft.assignmentStatus} onChange={(value) => update('assignmentStatus', value as TrainingAdminResultsQuery['assignmentStatus'])} options={[['', 'Все'], ['ASSIGNED', 'Назначен'], ['REVOKED', 'Отозван'], ['NEVER_ASSIGNED', 'Не назначался']]} />
            <SelectField id="training-result-source" label="Источник" value={draft.source} onChange={(value) => update('source', value as TrainingAdminResultsQuery['source'])} options={[['', 'Все'], ['TEXT', 'Текст'], ['TELEGRAM', 'Телеграм']]} />
            <Field><FieldLabel htmlFor="training-result-from">Старт от</FieldLabel><Input id="training-result-from" type="datetime-local" value={draft.startedFrom} onChange={(event) => update('startedFrom', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-to">Старт до</FieldLabel><Input id="training-result-to" type="datetime-local" value={draft.startedTo} onChange={(event) => update('startedTo', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-score-min">Балл от</FieldLabel><Input id="training-result-score-min" inputMode="numeric" value={draft.scoreMin} onChange={(event) => update('scoreMin', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-score-max">Балл до</FieldLabel><Input id="training-result-score-max" inputMode="numeric" value={draft.scoreMax} onChange={(event) => update('scoreMax', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-duration-min">Секунд от</FieldLabel><Input id="training-result-duration-min" inputMode="numeric" value={draft.durationMin} onChange={(event) => update('durationMin', event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="training-result-duration-max">Секунд до</FieldLabel><Input id="training-result-duration-max" inputMode="numeric" value={draft.durationMax} onChange={(event) => update('durationMax', event.target.value)} /></Field>
            <SelectField id="training-result-sort" label="Сортировка" value={draft.sort} onChange={(value) => update('sort', value as TrainingAdminResultsQuery['sort'])} options={[['STARTED_DESC', 'Новые сначала'], ['STARTED_ASC', 'Старые сначала'], ['COMPLETED_DESC', 'Недавно завершённые'], ['SCORE_DESC', 'Высокий балл'], ['SCORE_ASC', 'Низкий балл'], ['DURATION_DESC', 'Долгие сначала'], ['DURATION_ASC', 'Быстрые сначала']]} />
          </FieldGroup>
          <div className="training-results-filter-actions"><AdminButton type="submit" tone="primary">Применить</AdminButton><AdminButton type="button" tone="text" onClick={resetFilters}>Сбросить</AdminButton></div>
        </form>
      </AdminPanel>

      {error ? <AdminAlert tone="error"><span>{error}</span><AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton></AdminAlert> : null}
      <div className="training-section-heading"><h3>Найденные попытки</h3><span className="training-section-count">{total}</span></div>
      {isLoading ? <Skeleton className="training-list-skeleton" /> : items.length ? (
        <AdminPanel className="training-results-table-panel">
          <Table>
            <TableHeader><TableRow><TableHead>Сотрудник / проект</TableHead><TableHead>Статус</TableHead><TableHead>Результат</TableHead><TableHead>Длительность</TableHead><TableHead>Текущий доступ</TableHead><TableHead>Старт</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{items.map((item) => <ResultRow key={item.id} item={item} open={() => navigate(`/admin/training/attempts/${item.id}`)} />)}</TableBody>
          </Table>
        </AdminPanel>
      ) : <AdminEmptyState title="Результаты не найдены" description="Измените фильтры или дождитесь новых попыток." />}
      <div className="training-results-pagination"><AdminButton type="button" tone="text" disabled={query.page <= 1 || isLoading} onClick={() => setPage(query.page - 1)}>Назад</AdminButton><span>Страница {query.page} из {Math.max(1, totalPages)}</span><AdminButton type="button" tone="text" disabled={query.page >= totalPages || isLoading} onClick={() => setPage(query.page + 1)}>Далее</AdminButton></div>
    </div>
  );
}

function ResultRow({ item, open }: { item: TrainingAdminResultSummary; open: () => void }) {
  return <TableRow><TableCell><strong>{item.user.name ?? item.user.email}</strong><small className="training-table-secondary">{item.user.email} · {item.project.title} · №{item.attemptNumber}</small></TableCell><TableCell><AdminStatusBadge className={getTrainingStatusClass(item.status)}>{trainingAttemptStatusLabels[item.status]}</AdminStatusBadge><small className="training-table-secondary">{trainingReviewStatusLabels[item.reviewStatus]}</small></TableCell><TableCell>{item.finalScore ?? '—'} / 100<small className="training-table-secondary">{item.isPassed === null ? 'Итог не подтверждён' : item.isPassed ? 'Пройдено' : 'Не пройдено'}</small></TableCell><TableCell>{formatTrainingDuration(item.durationSeconds)}<small className="training-table-secondary">{item.answerCount} ответов · {item.answerSources.map((source) => trainingAnswerSourceLabels[source]).join(', ') || '—'}</small></TableCell><TableCell>{item.currentAccess.hasCurrentAccess ? 'Есть' : 'Нет'}<small className="training-table-secondary">{trainingAssignmentStatusLabels[item.currentAccess.assignmentStatus]}</small></TableCell><TableCell>{formatTrainingDate(item.startedAt)}</TableCell><TableCell><AdminButton type="button" tone="text" onClick={open}>Открыть</AdminButton></TableCell></TableRow>;
}

function SelectField({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><select id={id} className="training-select" value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue || 'all'} value={optionValue}>{optionLabel}</option>)}</select></Field>;
}
