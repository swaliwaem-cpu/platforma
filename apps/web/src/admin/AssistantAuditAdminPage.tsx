import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react';

import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { useAuth } from '../auth/AuthProvider';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';

type AuditTab = 'runs' | 'sources' | 'geo' | 'metrics';
type AuditIssue =
  | ''
  | 'NEGATIVE_FEEDBACK'
  | 'HARD_FILTER_VIOLATION'
  | 'UNSUPPORTED_FACT'
  | 'STALE_PRICE_UNLABELED'
  | 'BROKEN_LINK'
  | 'MODEL_FALLBACK'
  | 'PROVIDER_ERROR'
  | 'LATENCY_BREACH';

type FeedbackSummary = {
  id: string;
  rating: 'LIKE' | 'DISLIKE';
  reason: string | null;
  comment: string | null;
  createdAt: string;
};

type ReviewSummary = {
  id: string;
  status: 'PENDING' | 'REVIEWED';
  classification: ReviewClassification | null;
  reviewerComment: string | null;
  reviewedAt: string | null;
};

type ReviewClassification =
  | 'CONFIRMED_ERROR'
  | 'USER_RATING_INCORRECT'
  | 'NO_ERROR'
  | 'INCONCLUSIVE';

type AuditRunSummary = {
  id: string;
  status: string;
  query: string;
  answer: string | null;
  qualityFlags: string[];
  latencyMs: number | null;
  model: string | null;
  reasoningEffort: string | null;
  fallback: boolean;
  feedback: FeedbackSummary | null;
  review: ReviewSummary | null;
  createdAt: string;
};

type AuditRunDetail = AuditRunSummary & {
  owner: { id: string; email: string; name: string | null };
  request: string;
  finalAnswer: string | null;
  structuredIntent: unknown;
  audit: {
    appliedFilters?: unknown;
    softPreferences?: unknown;
    candidateSet?: Array<Record<string, unknown>>;
    rankingDecisions?: Array<Record<string, unknown>>;
    evidenceRevisions?: Array<Record<string, unknown>>;
  };
  evidence: unknown;
  telemetry: Array<Record<string, unknown>>;
  errorClassification: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type AuditRunsResponse = {
  items: AuditRunSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type SourceRecord = {
  id: string;
  canonicalUrl: string;
  type: string;
  state: string;
  projectKey: string | null;
  connectorKey: string;
  lastSuccessAt: string | null;
  lastIndexedAt: string | null;
  lastErrorCode: string | null;
  counts: { revisions: number; facts: number; chunks: number };
};

type GeoOperation = {
  id: string;
  normalizedQuery: string;
  provider: string;
  status: string;
  durationMs: number;
  cacheHit: boolean;
  providerCallCount: number;
  errorCode: string | null;
  createdAt: string;
};

type GeoAlias = {
  id: string;
  query: string;
  locale: string;
  country: string | null;
  label: string;
  latitude: number;
  longitude: number;
  city: string | null;
  countryCode: string | null;
  updatedAt: string;
};

type UsageMetric = {
  provider: string;
  model: string | null;
  window: string;
  windowStartedAt: string;
  requestCount: number;
  completedCount: number;
  errorCount: number;
  totalTokens: number;
  totalLatencyMs: number;
};

type AliasForm = {
  query: string;
  locale: string;
  country: string;
  label: string;
  city: string;
  countryCode: string;
  latitude: string;
  longitude: string;
};

const emptyAliasForm: AliasForm = {
  query: '',
  locale: 'ru',
  country: 'ru',
  label: '',
  city: '',
  countryCode: 'ru',
  latitude: '',
  longitude: '',
};

const issueOptions: Array<{ value: AuditIssue; label: string }> = [
  { value: '', label: 'Все запуски' },
  { value: 'NEGATIVE_FEEDBACK', label: 'Негативный feedback' },
  { value: 'HARD_FILTER_VIOLATION', label: 'Нарушение hard-фильтра' },
  { value: 'UNSUPPORTED_FACT', label: 'Неподтверждённый факт' },
  { value: 'STALE_PRICE_UNLABELED', label: 'Просроченная цена без label' },
  { value: 'BROKEN_LINK', label: 'Нерабочая ссылка' },
  { value: 'MODEL_FALLBACK', label: 'Fallback модели' },
  { value: 'PROVIDER_ERROR', label: 'Ошибка provider' },
  { value: 'LATENCY_BREACH', label: 'Превышение latency' },
];

const classificationOptions: Array<{ value: ReviewClassification; label: string }> = [
  { value: 'CONFIRMED_ERROR', label: 'Ошибка подтверждена' },
  { value: 'USER_RATING_INCORRECT', label: 'Пользовательская оценка ошибочна' },
  { value: 'NO_ERROR', label: 'Ошибки нет' },
  { value: 'INCONCLUSIVE', label: 'Недостаточно данных' },
];

export function AssistantAuditAdminPage({
  pathname,
  navigate,
  onBack,
}: {
  pathname: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
}) {
  const { accessToken, hasPermission } = useAuth();
  const [activeTab, setActiveTab] = useState<AuditTab>('runs');
  const [issue, setIssue] = useState<AuditIssue>('');
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [runDetail, setRunDetail] = useState<AuditRunDetail | null>(null);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [geoOperations, setGeoOperations] = useState<GeoOperation[]>([]);
  const [aliases, setAliases] = useState<GeoAlias[]>([]);
  const [metrics, setMetrics] = useState<UsageMetric[]>([]);
  const [aliasForm, setAliasForm] = useState<AliasForm>(emptyAliasForm);
  const [classification, setClassification] = useState<ReviewClassification | ''>('');
  const [reviewComment, setReviewComment] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRunId = useMemo(() => {
    const match = pathname.match(/^\/admin\/assistant-audit\/runs\/([0-9a-f-]+)$/iu);
    return match?.[1] ?? null;
  }, [pathname]);
  const canManageSources = hasPermission('assistant:sources:manage');

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const load = selectedRunId
      ? apiRequest<{ run: AuditRunDetail }>(
          `/assistant/audit/runs/${encodeURIComponent(selectedRunId)}`,
          accessToken,
          { signal: controller.signal },
        ).then(({ run }) => {
          setRunDetail(run);
          setClassification(run.review?.classification ?? '');
          setReviewComment(run.review?.reviewerComment ?? '');
        })
      : activeTab === 'runs'
        ? loadRuns(accessToken, issue, controller.signal).then((response) => {
            setRuns(response.items);
            setRunTotal(response.total);
          })
        : activeTab === 'sources'
          ? apiRequest<{ items: SourceRecord[] }>('/assistant/audit/sources', accessToken, {
              signal: controller.signal,
            }).then((response) => setSources(response.items))
          : activeTab === 'geo'
            ? Promise.all([
                apiRequest<{ items: GeoOperation[] }>('/assistant/audit/geo/operations?limit=100', accessToken, {
                  signal: controller.signal,
                }),
                apiRequest<{ items: GeoAlias[] }>('/assistant/audit/geo/aliases', accessToken, {
                  signal: controller.signal,
                }),
              ]).then(([operations, aliasResponse]) => {
                setGeoOperations(operations.items);
                setAliases(aliasResponse.items);
              })
            : apiRequest<{ items: UsageMetric[] }>('/assistant/audit/metrics?limit=180', accessToken, {
                signal: controller.signal,
              }).then((response) => setMetrics(response.items));

    void load
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(readError(loadError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, activeTab, issue, refreshVersion, selectedRunId]);

  const refreshCurrentTab = () => {
    setNotice(null);
    setRefreshVersion((current) => current + 1);
  };

  const handleReview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !runDetail?.review || !classification) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await apiRequest<{ review: ReviewSummary }>(
        `/assistant/audit/reviews/${encodeURIComponent(runDetail.review.id)}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({
            classification,
            comment: reviewComment.trim() || null,
          }),
        },
      );
      setRunDetail({ ...runDetail, review: response.review });
      setNotice('Классификация сохранена отдельно от пользовательской оценки.');
    } catch (reviewError) {
      setError(readError(reviewError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const queueRefresh = async (kind: 'source' | 'project', value: string) => {
    if (!accessToken || !canManageSources) return;
    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    const path = kind === 'source'
      ? `/assistant/sources/${encodeURIComponent(value)}/refresh`
      : `/assistant/sources/projects/${encodeURIComponent(value)}/refresh`;
    try {
      await apiRequest(path, accessToken, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      setNotice(kind === 'source' ? 'Refresh источника поставлен в очередь.' : 'Refresh ЖК поставлен в очередь.');
    } catch (refreshError) {
      setError(readError(refreshError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const editAlias = (alias: GeoAlias) => {
    setAliasForm({
      query: alias.query,
      locale: alias.locale,
      country: alias.country ?? '',
      label: alias.label,
      city: alias.city ?? '',
      countryCode: alias.countryCode ?? '',
      latitude: String(alias.latitude),
      longitude: String(alias.longitude),
    });
  };

  const saveAlias = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !canManageSources) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await apiRequest('/assistant/geo/aliases', accessToken, {
        method: 'POST',
        body: JSON.stringify({
          query: aliasForm.query.trim(),
          locale: aliasForm.locale.trim(),
          country: aliasForm.country.trim() || null,
          candidate: {
            label: aliasForm.label.trim(),
            city: aliasForm.city.trim() || null,
            countryCode: aliasForm.countryCode.trim() || null,
            latitude: Number(aliasForm.latitude),
            longitude: Number(aliasForm.longitude),
          },
        }),
      });
      setNotice('Internal alias подтверждён и сохранён.');
      setAliasForm(emptyAliasForm);
      const response = await apiRequest<{ items: GeoAlias[] }>('/assistant/audit/geo/aliases', accessToken);
      setAliases(response.items);
    } catch (aliasError) {
      setError(readError(aliasError));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (selectedRunId) {
    return (
      <AuditRunDetailView
        classification={classification}
        error={error}
        isLoading={isLoading}
        isSubmitting={isSubmitting}
        notice={notice}
        reviewComment={reviewComment}
        run={runDetail}
        onBack={() => navigate('/admin/assistant-audit')}
        onClassificationChange={setClassification}
        onCommentChange={setReviewComment}
        onRefresh={refreshCurrentTab}
        onReview={handleReview}
      />
    );
  }

  return (
    <section className="assistant-audit-page">
      <header className="assistant-audit-header">
        <div>
          <AdminButton aria-label="Назад в админку" tone="text" type="button" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            Назад
          </AdminButton>
          <p className="eyebrow">ИИ-помощник</p>
          <h1>Аудит ответов</h1>
          <p>Feedback, evidence trail и безопасная operational telemetry без автоматического самообучения.</p>
        </div>
        <AdminStatusBadge className="status-pill--active">30 дней полного аудита</AdminStatusBadge>
      </header>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      <Tabs
        className="assistant-audit-tabs"
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value as AuditTab);
          setNotice(null);
        }}
      >
        <TabsList aria-label="Разделы аудита" variant="line">
          <TabsTrigger value="runs">Плохие ответы</TabsTrigger>
          <TabsTrigger value="sources">Источники</TabsTrigger>
          <TabsTrigger value="geo">Geo</TabsTrigger>
          <TabsTrigger value="metrics">Лимиты и метрики</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          <RunsPanel
            isLoading={isLoading}
            issue={issue}
            runs={runs}
            total={runTotal}
            onIssueChange={setIssue}
            onOpen={(runId) => navigate(`/admin/assistant-audit/runs/${runId}`)}
          />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesPanel
            canManage={canManageSources}
            isLoading={isLoading}
            isSubmitting={isSubmitting}
            sources={sources}
            onRefresh={queueRefresh}
          />
        </TabsContent>
        <TabsContent value="geo">
          <GeoPanel
            aliasForm={aliasForm}
            aliases={aliases}
            canManage={canManageSources}
            isLoading={isLoading}
            isSubmitting={isSubmitting}
            operations={geoOperations}
            onAliasFormChange={setAliasForm}
            onEditAlias={editAlias}
            onSaveAlias={saveAlias}
          />
        </TabsContent>
        <TabsContent value="metrics">
          <MetricsPanel isLoading={isLoading} metrics={metrics} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function RunsPanel({
  isLoading,
  issue,
  runs,
  total,
  onIssueChange,
  onOpen,
}: {
  isLoading: boolean;
  issue: AuditIssue;
  runs: AuditRunSummary[];
  total: number;
  onIssueChange: (issue: AuditIssue) => void;
  onOpen: (runId: string) => void;
}) {
  return (
    <AdminPanel className="assistant-audit-panel">
      <div className="assistant-audit-toolbar">
        <label>
          Сигнал качества
          <select value={issue} onChange={(event) => onIssueChange(event.target.value as AuditIssue)}>
            {issueOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <span>{total.toLocaleString('ru-RU')} запусков</span>
      </div>
      {isLoading ? <AuditSkeleton /> : runs.length === 0 ? (
        <AdminEmptyState title="Запусков с таким сигналом нет" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Запрос</TableHead>
              <TableHead>Сигналы</TableHead>
              <TableHead>Модель</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Review</TableHead>
              <TableHead><span className="sr-only">Действие</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <strong>{truncate(run.query, 92)}</strong>
                  <small>{formatDateTime(run.createdAt)}</small>
                </TableCell>
                <TableCell>
                  <div className="assistant-audit-badges">
                    {run.feedback?.rating === 'DISLIKE' ? <AdminStatusBadge>Dislike</AdminStatusBadge> : null}
                    {run.qualityFlags.map((flag) => <AdminStatusBadge key={flag}>{flag}</AdminStatusBadge>)}
                  </div>
                </TableCell>
                <TableCell>{run.model ?? '—'}{run.fallback ? <small>fallback</small> : null}</TableCell>
                <TableCell>{run.latencyMs === null ? '—' : `${run.latencyMs} мс`}</TableCell>
                <TableCell>{run.review?.status ?? '—'}</TableCell>
                <TableCell>
                  <AdminButton tone="text" type="button" onClick={() => onOpen(run.id)}>
                    <SearchIcon aria-hidden="true" />
                    Открыть
                  </AdminButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AdminPanel>
  );
}

function AuditRunDetailView({
  classification,
  error,
  isLoading,
  isSubmitting,
  notice,
  reviewComment,
  run,
  onBack,
  onClassificationChange,
  onCommentChange,
  onRefresh,
  onReview,
}: {
  classification: ReviewClassification | '';
  error: string | null;
  isLoading: boolean;
  isSubmitting: boolean;
  notice: string | null;
  reviewComment: string;
  run: AuditRunDetail | null;
  onBack: () => void;
  onClassificationChange: (value: ReviewClassification) => void;
  onCommentChange: (value: string) => void;
  onRefresh: () => void;
  onReview: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (isLoading || !run) {
    return <section className="assistant-audit-page"><AuditSkeleton /></section>;
  }
  return (
    <section className="assistant-audit-page">
      <header className="assistant-audit-header">
        <div>
          <AdminButton tone="text" type="button" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            К списку
          </AdminButton>
          <p className="eyebrow">Evidence trail</p>
          <h1>{truncate(run.request, 110)}</h1>
          <p>{run.owner.name ?? run.owner.email} · {formatDateTime(run.createdAt)}</p>
        </div>
        <AdminButton tone="secondary" type="button" onClick={onRefresh}>
          <RefreshCwIcon aria-hidden="true" />
          Обновить
        </AdminButton>
      </header>
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      <div className="assistant-audit-detail-grid">
        <AdminPanel className="assistant-audit-panel assistant-audit-span-two">
          <h2>Запрос и финальный ответ</h2>
          <div className="assistant-audit-transcript">
            <div><strong>Запрос</strong><p>{run.request}</p></div>
            <div><strong>Ответ</strong><p>{run.finalAnswer ?? 'Ответ не сформирован'}</p></div>
          </div>
        </AdminPanel>
        <AdminPanel className="assistant-audit-panel">
          <h2>Feedback</h2>
          {run.feedback ? (
            <dl className="assistant-audit-kv">
              <div><dt>Оценка</dt><dd>{run.feedback.rating}</dd></div>
              <div><dt>Причина</dt><dd>{run.feedback.reason ?? '—'}</dd></div>
              <div><dt>Комментарий</dt><dd>{run.feedback.comment ?? '—'}</dd></div>
            </dl>
          ) : <p className="muted-text">Оценки нет.</p>}
        </AdminPanel>
        <AdminPanel className="assistant-audit-panel">
          <h2>Model telemetry</h2>
          <dl className="assistant-audit-kv">
            <div><dt>Модель</dt><dd>{run.model ?? '—'}</dd></div>
            <div><dt>Reasoning</dt><dd>{run.reasoningEffort ?? '—'}</dd></div>
            <div><dt>Fallback</dt><dd>{run.fallback ? 'Да' : 'Нет'}</dd></div>
            <div><dt>Latency</dt><dd>{run.latencyMs === null ? '—' : `${run.latencyMs} мс`}</dd></div>
            <div><dt>Ошибка</dt><dd>{run.errorClassification ?? '—'}</dd></div>
          </dl>
        </AdminPanel>
        <AdminPanel className="assistant-audit-panel assistant-audit-span-two">
          <h2>Intent и applied filters</h2>
          <div className="assistant-audit-json-grid">
            <JsonBlock label="Structured intent" value={run.structuredIntent} />
            <JsonBlock label="Hard filters" value={run.audit.appliedFilters ?? {}} />
            <JsonBlock label="Soft preferences" value={run.audit.softPreferences ?? {}} />
          </div>
        </AdminPanel>
        <AuditArrayPanel title="Candidate set" values={run.audit.candidateSet ?? []} />
        <AuditArrayPanel title="Ranking decisions" values={run.audit.rankingDecisions ?? []} />
        <AuditArrayPanel title="Evidence revisions" values={run.audit.evidenceRevisions ?? []} />
        <AuditArrayPanel title="Provider attempts" values={run.telemetry ?? []} />
        {run.review ? (
          <AdminPanel className="assistant-audit-panel assistant-audit-span-two">
            <form className="assistant-audit-review" onSubmit={onReview}>
              <div>
                <h2>Классификация reviewer</h2>
                <p>Она не меняет исходный feedback, prompt, ranking или routing.</p>
              </div>
              <RadioGroup
                aria-label="Классификация результата"
                value={classification}
                onValueChange={(value) => onClassificationChange(value as ReviewClassification)}
              >
                {classificationOptions.map((option) => (
                  <label key={option.value}>
                    <RadioGroupItem value={option.value} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
              <label>
                Комментарий reviewer
                <textarea
                  maxLength={500}
                  rows={3}
                  value={reviewComment}
                  onChange={(event) => onCommentChange(event.target.value)}
                />
              </label>
              <AdminButton disabled={isSubmitting || !classification} tone="primary" type="submit">
                <CheckCircle2Icon aria-hidden="true" />
                {isSubmitting ? 'Сохраняю…' : 'Сохранить классификацию'}
              </AdminButton>
            </form>
          </AdminPanel>
        ) : null}
      </div>
    </section>
  );
}

function SourcesPanel({
  canManage,
  isLoading,
  isSubmitting,
  sources,
  onRefresh,
}: {
  canManage: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  sources: SourceRecord[];
  onRefresh: (kind: 'source' | 'project', value: string) => void;
}) {
  return (
    <AdminPanel className="assistant-audit-panel">
      <div className="assistant-audit-panel-heading">
        <div><h2>Official source operations</h2><p>Health и последняя успешная индексация.</p></div>
        {!canManage ? <AdminStatusBadge>Только чтение</AdminStatusBadge> : null}
      </div>
      {isLoading ? <AuditSkeleton /> : sources.length === 0 ? <AdminEmptyState title="Источников нет" /> : (
        <div className="assistant-audit-card-list">
          {sources.map((source) => (
            <article key={source.id}>
              <div>
                <div className="assistant-audit-badges">
                  <AdminStatusBadge>{source.state}</AdminStatusBadge>
                  <AdminStatusBadge>{source.type}</AdminStatusBadge>
                </div>
                <h3>{source.projectKey ?? source.canonicalUrl}</h3>
                <a href={source.canonicalUrl} rel="noopener noreferrer" target="_blank">{source.canonicalUrl}</a>
                <p>
                  Индексация: {formatDateTime(source.lastIndexedAt)} · Успех: {formatDateTime(source.lastSuccessAt)}
                  {source.lastErrorCode ? ` · Ошибка: ${source.lastErrorCode}` : ''}
                </p>
                <small>{source.counts.revisions} revisions · {source.counts.facts} facts · {source.counts.chunks} chunks</small>
              </div>
              {canManage ? (
                <div className="assistant-audit-card-actions">
                  <AdminButton disabled={isSubmitting || source.state !== 'ACTIVE'} type="button" onClick={() => onRefresh('source', source.id)}>
                    Refresh источника
                  </AdminButton>
                  {source.projectKey ? (
                    <AdminButton disabled={isSubmitting} tone="secondary" type="button" onClick={() => onRefresh('project', source.projectKey!)}>
                      Refresh ЖК
                    </AdminButton>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </AdminPanel>
  );
}

function GeoPanel({
  aliasForm,
  aliases,
  canManage,
  isLoading,
  isSubmitting,
  operations,
  onAliasFormChange,
  onEditAlias,
  onSaveAlias,
}: {
  aliasForm: AliasForm;
  aliases: GeoAlias[];
  canManage: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  operations: GeoOperation[];
  onAliasFormChange: (value: AliasForm) => void;
  onEditAlias: (alias: GeoAlias) => void;
  onSaveAlias: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const change = (key: keyof AliasForm, value: string) => onAliasFormChange({ ...aliasForm, [key]: value });
  return (
    <div className="assistant-audit-detail-grid">
      <AdminPanel className="assistant-audit-panel assistant-audit-span-two">
        <h2>Geo operations</h2>
        {isLoading ? <AuditSkeleton /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Запрос</TableHead><TableHead>Provider / status</TableHead>
              <TableHead>Latency</TableHead><TableHead>Cache</TableHead><TableHead>Calls</TableHead>
            </TableRow></TableHeader>
            <TableBody>{operations.map((operation) => (
              <TableRow key={operation.id}>
                <TableCell>{operation.normalizedQuery}<small>{formatDateTime(operation.createdAt)}</small></TableCell>
                <TableCell>{operation.provider} / {operation.status}{operation.errorCode ? <small>{operation.errorCode}</small> : null}</TableCell>
                <TableCell>{operation.durationMs} мс</TableCell>
                <TableCell>{operation.cacheHit ? 'hit' : 'miss'}</TableCell>
                <TableCell>{operation.providerCallCount}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </AdminPanel>
      <AdminPanel className="assistant-audit-panel">
        <h2>Internal aliases</h2>
        <div className="assistant-audit-alias-list">
          {aliases.map((alias) => (
            <button key={alias.id} disabled={!canManage} type="button" onClick={() => onEditAlias(alias)}>
              <strong>{alias.query}</strong><span>{alias.label}</span>
            </button>
          ))}
        </div>
      </AdminPanel>
      <AdminPanel className="assistant-audit-panel">
        <form className="assistant-audit-alias-form" onSubmit={onSaveAlias}>
          <div><h2>Подтвердить или исправить alias</h2><p>Выберите alias слева или заполните новый.</p></div>
          <label>Запрос<input required maxLength={240} value={aliasForm.query} onChange={(event) => change('query', event.target.value)} /></label>
          <label>Метка<input required maxLength={300} value={aliasForm.label} onChange={(event) => change('label', event.target.value)} /></label>
          <div className="assistant-audit-form-row">
            <label>Широта<input required inputMode="decimal" value={aliasForm.latitude} onChange={(event) => change('latitude', event.target.value)} /></label>
            <label>Долгота<input required inputMode="decimal" value={aliasForm.longitude} onChange={(event) => change('longitude', event.target.value)} /></label>
          </div>
          <div className="assistant-audit-form-row">
            <label>Город<input value={aliasForm.city} onChange={(event) => change('city', event.target.value)} /></label>
            <label>Страна<input maxLength={2} value={aliasForm.countryCode} onChange={(event) => change('countryCode', event.target.value)} /></label>
          </div>
          <AdminButton disabled={!canManage || isSubmitting} tone="primary" type="submit">
            {isSubmitting ? 'Сохраняю…' : 'Сохранить alias'}
          </AdminButton>
        </form>
      </AdminPanel>
    </div>
  );
}

function MetricsPanel({ isLoading, metrics }: { isLoading: boolean; metrics: UsageMetric[] }) {
  return (
    <AdminPanel className="assistant-audit-panel">
      <div className="assistant-audit-panel-heading">
        <div><h2>Server-side provider budgets</h2><p>Анонимизированные агрегаты хранятся до 180 дней.</p></div>
      </div>
      {isLoading ? <AuditSkeleton /> : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Provider / model</TableHead><TableHead>Окно</TableHead><TableHead>Requests</TableHead>
            <TableHead>Errors</TableHead><TableHead>Tokens</TableHead><TableHead>Avg latency</TableHead>
          </TableRow></TableHeader>
          <TableBody>{metrics.map((metric) => (
            <TableRow key={`${metric.provider}-${metric.model}-${metric.window}-${metric.windowStartedAt}`}>
              <TableCell>{metric.provider}<small>{metric.model ?? 'geo'}</small></TableCell>
              <TableCell>{metric.window}<small>{formatDateTime(metric.windowStartedAt)}</small></TableCell>
              <TableCell>{metric.completedCount} / {metric.requestCount}</TableCell>
              <TableCell>{metric.errorCount}</TableCell>
              <TableCell>{metric.totalTokens.toLocaleString('ru-RU')}</TableCell>
              <TableCell>{metric.completedCount > 0 ? `${Math.round(metric.totalLatencyMs / metric.completedCount)} мс` : '—'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </AdminPanel>
  );
}

function AuditArrayPanel({ title, values }: { title: string; values: Array<Record<string, unknown>> }) {
  return (
    <AdminPanel className="assistant-audit-panel">
      <h2>{title}</h2>
      {values.length === 0 ? <p className="muted-text">Нет данных.</p> : (
        <div className="assistant-audit-array">
          {values.map((value, index) => <JsonBlock key={`${title}-${index}`} label={`#${index + 1}`} value={value} />)}
        </div>
      )}
    </AdminPanel>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return <div className="assistant-audit-json"><strong>{label}</strong><pre>{formatJson(value)}</pre></div>;
}

function AuditSkeleton() {
  return <div className="assistant-audit-skeleton" aria-label="Загрузка"><Skeleton /><Skeleton /><Skeleton /></div>;
}

function loadRuns(accessToken: string, issue: AuditIssue, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' });
  if (issue) params.set('issues', issue);
  return apiRequest<AuditRunsResponse>(`/assistant/audit/runs?${params.toString()}`, accessToken, { signal });
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function truncate(value: string, maximum: number) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось загрузить audit data';
}
