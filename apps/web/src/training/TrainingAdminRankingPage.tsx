import { FormEvent, useEffect, useState } from 'react';
import type { TrainingAdminRankingQuery, TrainingAdminRankingRow } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadTrainingAdminRankingCsv, getTrainingAdminRanking } from './trainingApi';
import { formatTrainingDate, formatTrainingDuration } from './trainingView';

const initialQuery: TrainingAdminRankingQuery = {
  page: 1, limit: 20, search: '', project: '', accessMode: '',
  currentlyAssigned: '', currentlyEligible: '',
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
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false); });
    return () => controller.abort();
  }, [accessToken, query, reloadKey]);

  const update = <Key extends keyof TrainingAdminRankingQuery>(key: Key, value: TrainingAdminRankingQuery[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const applyFilters = (event: FormEvent) => { event.preventDefault(); setQuery({ ...draft, page: 1 }); };
  const resetFilters = () => { setDraft(initialQuery); setQuery(initialQuery); };
  const setPage = (page: number) => { const next = { ...query, page }; setDraft(next); setQuery(next); };
  const exportCsv = async () => {
    if (!accessToken || isExporting) return;
    setIsExporting(true); setError(null);
    try { await downloadTrainingAdminRankingCsv(accessToken, { ...query, page: 1 }); }
    catch (exportError) { setError(exportError instanceof Error ? exportError.message : 'Не удалось выгрузить CSV'); }
    finally { setIsExporting(false); }
  };

  return <div className="training-page training-admin-page">
    <header className="training-page-header"><div><p className="eyebrow">Админка · Обучение</p><h2>Рейтинг сотрудников</h2><p className="muted-text">Исторические лучшие результаты и текущий охват доступных проектов.</p></div><div className="training-project-actions"><AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>К проектам</AdminButton><AdminButton type="button" tone="primary" disabled={isExporting} onClick={() => void exportCsv()}>{isExporting ? 'Подготовка…' : 'Скачать CSV'}</AdminButton></div></header>
    <AdminPanel className="training-results-filter-panel"><form onSubmit={applyFilters}><FieldGroup className="training-ranking-filters"><Field><FieldLabel htmlFor="training-ranking-search">Сотрудник</FieldLabel><Input id="training-ranking-search" placeholder="Имя или электронная почта" value={draft.search} onChange={(event) => update('search', event.target.value)} /></Field><Field><FieldLabel htmlFor="training-ranking-project">Проект</FieldLabel><Input id="training-ranking-project" placeholder="Название или идентификатор" value={draft.project} onChange={(event) => update('project', event.target.value)} /></Field><SelectField id="training-ranking-access" label="Модель доступа" value={draft.accessMode} onChange={(value) => update('accessMode', value as TrainingAdminRankingQuery['accessMode'])} options={[["", "Все"], ["ASSIGNED_USERS", "По назначениям"], ["ALL_PARTICIPANTS", "Все участники"]]} /><SelectField id="training-ranking-assigned" label="Сейчас назначен" value={draft.currentlyAssigned} onChange={(value) => update('currentlyAssigned', value as TrainingAdminRankingQuery['currentlyAssigned'])} options={[["", "Все"], ["true", "Да"], ["false", "Нет"]]} /><SelectField id="training-ranking-eligible" label="Сейчас доступно" value={draft.currentlyEligible} onChange={(value) => update('currentlyEligible', value as TrainingAdminRankingQuery['currentlyEligible'])} options={[["", "Все"], ["true", "Да"], ["false", "Нет"]]} /></FieldGroup><div className="training-results-filter-actions"><AdminButton type="submit" tone="primary">Применить</AdminButton><AdminButton type="button" tone="text" onClick={resetFilters}>Сбросить</AdminButton></div></form></AdminPanel>
    {error ? <AdminAlert tone="error"><span>{error}</span><AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>Повторить</AdminButton></AdminAlert> : null}
    <div className="training-section-heading"><h3>Сотрудники</h3><span className="training-section-count">{total}</span></div>
    {isLoading ? <Skeleton className="training-list-skeleton" aria-label="Загрузка рейтинга" /> : items.length ? <AdminPanel className="training-results-table-panel training-ranking-table-panel"><Table><TableHeader><TableRow><TableHead># / сотрудник</TableHead><TableHead>Лучшие результаты</TableHead><TableHead>Средний балл</TableHead><TableHead>Текущий охват</TableHead><TableHead>Попытки / время</TableHead><TableHead>Вывод</TableHead></TableRow></TableHeader><TableBody>{items.map((item, index) => <RankingRow key={item.user.id} item={item} position={(query.page - 1) * query.limit + index + 1} />)}</TableBody></Table></AdminPanel> : <AdminEmptyState title="Рейтинг пуст" description="Измените фильтры или дождитесь подтверждённых результатов." />}
    <div className="training-results-pagination"><AdminButton type="button" tone="text" disabled={query.page <= 1 || isLoading} onClick={() => setPage(query.page - 1)}>Назад</AdminButton><span>Страница {query.page} из {Math.max(1, totalPages)}</span><AdminButton type="button" tone="text" disabled={query.page >= totalPages || isLoading} onClick={() => setPage(query.page + 1)}>Далее</AdminButton></div>
  </div>;
}

function RankingRow({ item, position }: { item: TrainingAdminRankingRow; position: number }) {
  return <TableRow><TableCell><strong>{position}. {item.user.name ?? item.user.email}</strong><small className="training-table-secondary">{item.user.email}</small></TableCell><TableCell><strong>{item.passedProjectsCount} / {item.completedProjectsCount}</strong><details className="training-ranking-details"><summary>По проектам</summary><ul>{item.bestResults.map((result) => <li key={result.projectId}><span>{result.projectTitle}</span><strong>{result.finalScore}/100</strong><small>{result.isPassed ? 'пройдено' : 'не пройдено'} · {result.currentlyEligible ? 'доступен сейчас' : 'история'} · {result.accessMode === 'ALL_PARTICIPANTS' ? 'все участники' : assignmentLabel(result.assignmentStatus)}</small></li>)}</ul></details></TableCell><TableCell>{item.averageBestScore ?? '—'}<small className="training-table-secondary">последний: {formatTrainingDate(item.lastCompletedAt)}</small></TableCell><TableCell>{item.currentCoveragePercent === null ? '—' : `${item.currentCoveragePercent}%`}<small className="training-table-secondary">{item.currentCompletedEligibleProjectsCount} из {item.currentEligibleProjectsCount} · пройдено {item.currentPassedEligibleProjectsCount}</small><small className="training-table-secondary">Для всех: {item.currentAccess.allParticipantsProjectsCount} · по назначениям: {item.currentAccess.assignedProjectsCount} · активных назначений: {item.currentAccess.activeAssignmentsCount}</small><AdminStatusBadge className={item.currentEligibleProjectsCount ? 'is-ready' : 'is-muted'}>{item.currentEligibleProjectsCount ? 'Есть доступ' : 'Нет доступных'}</AdminStatusBadge></TableCell><TableCell>{item.attemptsUsed}<small className="training-table-secondary">Σ {formatTrainingDuration(item.totalDurationSeconds)} · Ø {item.averageDurationSeconds ? formatTrainingDuration(Number(item.averageDurationSeconds)) : '—'}</small></TableCell><TableCell className="training-ranking-summary">{item.summary.text}<small className="training-table-secondary">Ошибки: {item.summary.factualErrorsCount} · неподтверждённые: {item.summary.unsupportedClaimsCount}</small></TableCell></TableRow>;
}

function assignmentLabel(status: TrainingAdminRankingRow['bestResults'][number]['assignmentStatus']) {
  if (status === 'ASSIGNED') return 'назначен';
  if (status === 'REVOKED') return 'назначение отозвано';
  return 'не назначался';
}

function SelectField({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><select id={id} className="training-select" value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue || 'all'} value={optionValue}>{optionLabel}</option>)}</select></Field>;
}
