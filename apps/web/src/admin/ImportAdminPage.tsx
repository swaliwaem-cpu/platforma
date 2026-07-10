import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  EyeIcon,
  FileTextIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from 'lucide-react';
import {
  ImportMode,
  ImportReport,
  ImportReportResponse,
  ImportReportsResponse,
  ImportStatus,
} from '@platforma/shared';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

import { useAuth } from '../auth/AuthProvider';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';

type ImportAdminPageProps = {
  onBack: () => void;
};

type ImportCommandMode = 'preview' | 'run';

const modeLabels: Record<ImportMode, string> = {
  PREVIEW: 'Preview',
  RUN: 'Run',
};

const statusLabels: Record<ImportStatus, string> = {
  PENDING: 'В процессе',
  SUCCESS: 'Успешно',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
};

export function ImportAdminPage({ onBack }: ImportAdminPageProps) {
  const { accessToken, hasPermission } = useAuth();
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [selectedReport, setSelectedReport] = useState<ImportReport | null>(null);
  const [modeFilter, setModeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [runningMode, setRunningMode] = useState<ImportCommandMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canPreview = hasPermission('import:preview');
  const canRun = hasPermission('import:run');
  const hasActiveFilters = Boolean(modeFilter || statusFilter);
  const isRunning = runningMode !== null;

  const selectedSummary = useMemo(
    () => (isPlainObject(selectedReport?.summaryJson) ? selectedReport.summaryJson : null),
    [selectedReport],
  );
  const selectedWarnings = useMemo(
    () => (Array.isArray(selectedReport?.warningsJson) ? selectedReport.warningsJson : []),
    [selectedReport],
  );
  const selectedErrors = useMemo(
    () => (Array.isArray(selectedReport?.errorsJson) ? selectedReport.errorsJson : []),
    [selectedReport],
  );

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadReports();
  }, [accessToken, page, modeFilter, statusFilter]);

  async function loadReports() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
      });

      if (modeFilter) {
        params.set('mode', modeFilter);
      }

      if (statusFilter) {
        params.set('status', statusFilter);
      }

      const data = await apiRequest<ImportReportsResponse>(`/wordpress-import/reports?${params.toString()}`, accessToken);

      setReports(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);

      if (selectedReport && !data.items.some((report) => report.id === selectedReport.id)) {
        setSelectedReport(null);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить отчёты импорта');
    } finally {
      setIsLoading(false);
    }
  }

  async function runImportCommand(mode: ImportCommandMode) {
    if (!accessToken) {
      return;
    }

    const confirmed = mode === 'preview' || window.confirm('Запустить импорт с записью данных?');

    if (!confirmed) {
      return;
    }

    setRunningMode(mode);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ImportReportResponse>(`/wordpress-import/${mode}`, accessToken, {
        method: 'POST',
      });

      setSelectedReport(data.report);
      setNotice(mode === 'preview' ? 'Preview завершён' : 'Импорт завершён');
      await loadReports();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Команда импорта не выполнена');
    } finally {
      setRunningMode(null);
    }
  }

  async function openReport(reportId: string) {
    if (!accessToken) {
      return;
    }

    setError(null);

    try {
      const data = await apiRequest<ImportReportResponse>(`/wordpress-import/reports/${reportId}`, accessToken);
      setSelectedReport(data.report);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось открыть отчёт');
    }
  }

  function resetFilters() {
    setModeFilter('');
    setStatusFilter('');
    setPage(1);
  }

  return (
    <div className="admin-import">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Импорт WordPress</h2>
        </div>
        <div className="header-actions">
          <AdminButton
            disabled={!canPreview || isRunning}
            title={canPreview ? undefined : 'Нет права import:preview'}
            tone="secondary"
            type="button"
            onClick={() => void runImportCommand('preview')}
          >
            <EyeIcon data-icon="inline-start" />
            {runningMode === 'preview' ? 'Preview...' : 'Preview'}
          </AdminButton>
          <AdminButton
            disabled={!canRun || isRunning}
            title={canRun ? undefined : 'Нет права import:run'}
            tone="primary"
            type="button"
            onClick={() => void runImportCommand('run')}
          >
            <PlayIcon data-icon="inline-start" />
            {runningMode === 'run' ? 'Run...' : 'Run'}
          </AdminButton>
          <AdminButton disabled={isLoading || isRunning} tone="secondary" type="button" onClick={() => void loadReports()}>
            <RefreshCwIcon data-icon="inline-start" />
            Обновить
          </AdminButton>
          <AdminButton disabled={isRunning} tone="secondary" type="button" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Назад
          </AdminButton>
        </div>
      </header>

      <section className="toolbar" aria-label="Фильтры отчётов импорта">
        <div className="import-toolbar-main">
          <label className="toolbar-field">
            <span>Режим</span>
            <select
              aria-label="Фильтр по режиму"
              value={modeFilter}
              onChange={(event) => {
                setModeFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Все режимы</option>
              {Object.entries(modeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="toolbar-field">
            <span>Статус</span>
            <select
              aria-label="Фильтр по статусу"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Все статусы</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="import-toolbar-actions">
          <AdminButton disabled={!hasActiveFilters} tone="secondary" type="button" onClick={resetFilters}>
            <RotateCcwIcon data-icon="inline-start" />
            Сбросить
          </AdminButton>
        </div>
      </section>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <div className="import-layout">
        <AdminPanel className="table-panel" role="region" aria-label="Отчёты импорта">
          <div className="table-meta">
            <span>{isLoading ? 'Загрузка' : `Всего: ${total}`}</span>
            <span>
              Страница {page} из {totalPages}
            </span>
          </div>

          <Table className="admin-table">
            <TableHeader>
              <TableRow>
                <TableHead className="import-start-column">Старт</TableHead>
                <TableHead className="import-duration-column">Длительность</TableHead>
                <TableHead className="import-mode-column">Режим</TableHead>
                <TableHead className="import-status-column">Статус</TableHead>
                <TableHead className="import-count-column">Объекты</TableHead>
                <TableHead className="import-count-column">Warnings</TableHead>
                <TableHead className="import-count-column">Errors</TableHead>
                <TableHead className="import-action-column">
                  <span className="sr-only">Действия</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? <ReportTableSkeleton /> : null}

              {!isLoading ? (
                <>
                {reports.map((report) => {
                  const summary = isPlainObject(report.summaryJson) ? report.summaryJson : null;
                  const warningsCount = getReportIssueCount(report, 'warnings');
                  const errorsCount = getReportIssueCount(report, 'errors');
                  const profileLabel = getReportProfileLabel(summary);

                  return (
                    <TableRow
                      key={report.id}
                      aria-selected={selectedReport?.id === report.id}
                      className={selectedReport?.id === report.id ? 'is-selected' : undefined}
                      data-state={selectedReport?.id === report.id ? 'selected' : undefined}
                    >
                      <TableCell className="import-start-column">
                        <div className="import-start-cell">
                          <strong>{formatDateTime(report.startedAt)}</strong>
                          <span className="table-subtext">ID {shortenId(report.id)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="import-duration-column">
                        <span className="import-duration-cell">{formatReportDuration(report)}</span>
                      </TableCell>
                      <TableCell className="import-mode-column">
                        <span className={`import-mode-pill import-mode-pill--${report.mode.toLowerCase()}`}>
                          {modeLabels[report.mode]}
                        </span>
                        {profileLabel ? <span className="table-subtext">{profileLabel}</span> : null}
                      </TableCell>
                      <TableCell className="import-status-column">
                        <AdminStatusBadge className={`import-status import-status--${report.status.toLowerCase()}`}>
                          {statusLabels[report.status]}
                        </AdminStatusBadge>
                      </TableCell>
                      <TableCell className="import-count-column">
                        <MetricCell
                          primary={formatSummaryNumber(summary?.objectsImported ?? summary?.objectsMapped)}
                          secondary={summary?.objectsImported !== undefined ? 'imported' : 'mapped'}
                        />
                      </TableCell>
                      <TableCell className="import-count-column">
                        <MetricCell primary={formatSummaryNumber(warningsCount)} secondary="warnings" />
                      </TableCell>
                      <TableCell className="import-count-column">
                        <MetricCell primary={formatSummaryNumber(errorsCount)} secondary="errors" />
                      </TableCell>
                      <TableCell className="import-action-column">
                        <AdminButton tone="text" type="button" onClick={() => void openReport(report.id)}>
                          <FileTextIcon data-icon="inline-start" />
                          Открыть
                        </AdminButton>
                      </TableCell>
                    </TableRow>
                  );
                })}

                {!isLoading && reports.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <AdminEmptyState title="Отчёты не найдены" description="Запустите preview или измените фильтры." />
                    </TableCell>
                  </TableRow>
                ) : null}
                </>
              ) : null}
            </TableBody>
          </Table>

          <div className="pagination">
            <AdminButton
              disabled={page <= 1}
              tone="secondary"
              type="button"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
            >
              Назад
            </AdminButton>
            <AdminButton
              disabled={page >= totalPages}
              tone="secondary"
              type="button"
              onClick={() => setPage((currentPage) => currentPage + 1)}
            >
              Вперёд
            </AdminButton>
          </div>
        </AdminPanel>

        <AdminPanel className="editor-panel import-report-panel" role="region" aria-label="Детали отчёта">
          {selectedReport ? (
            <>
              <div className="import-report-heading">
                <div>
                  <p className="eyebrow">{modeLabels[selectedReport.mode]}</p>
                  <h3>{statusLabels[selectedReport.status]}</h3>
                </div>
                <AdminStatusBadge className={`import-status import-status--${selectedReport.status.toLowerCase()}`}>
                  {selectedReport.status}
                </AdminStatusBadge>
              </div>

              <dl className="details-list import-details">
                <div>
                  <dt>Источник</dt>
                  <dd>{selectedReport.source}</dd>
                </div>
                <div>
                  <dt>Старт</dt>
                  <dd>{formatDateTime(selectedReport.startedAt)}</dd>
                </div>
                <div>
                  <dt>Финиш</dt>
                  <dd>{selectedReport.finishedAt ? formatDateTime(selectedReport.finishedAt) : 'Не завершён'}</dd>
                </div>
                <div>
                  <dt>Длительность</dt>
                  <dd>{formatReportDuration(selectedReport)}</dd>
                </div>
                <div>
                  <dt>Автор</dt>
                  <dd>
                    <ReportUserValue user={selectedReport.createdBy} />
                  </dd>
                </div>
              </dl>

              <ReportSummary summary={selectedSummary} />
              <ReportIssues title="Предупреждения" issues={selectedWarnings} />
              <ReportIssues title="Ошибки" issues={selectedErrors} />
            </>
          ) : (
            <>
              <p className="eyebrow">Отчёт</p>
              <h3>Не выбран</h3>
              <p className="helper-text">Выберите строку в таблице.</p>
            </>
          )}
        </AdminPanel>
      </div>
    </div>
  );
}

function ReportTableSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <TableRow key={index}>
          <TableCell colSpan={8}>
            <Skeleton className="import-table-skeleton" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function MetricCell({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <span className="import-metric-cell">
      <strong>{primary}</strong>
      <span>{secondary}</span>
    </span>
  );
}

function ReportUserValue({ user }: { user: ImportReport['createdBy'] }) {
  if (!user) {
    return <>Система</>;
  }

  return (
    <span className="import-report-user">
      <strong>{user.name || user.email}</strong>
      {user.name ? <span>{user.email}</span> : null}
    </span>
  );
}

function ReportSummary({ summary }: { summary: Record<string, unknown> | null }) {
  if (!summary) {
    return (
      <section className="report-summary-section">
        <div className="report-section-header">
          <h4>Summary</h4>
        </div>
        <p className="helper-text">Summary отсутствует в отчёте.</p>
      </section>
    );
  }

  const items: Array<{ label: string; value: unknown; tone?: 'warning' | 'danger' }> = [
    { label: 'Профиль', value: summary.profile },
    { label: 'Тип объектов', value: summary.objectType },
    { label: 'WP post type', value: summary.postType },
    { label: 'Найдено', value: summary.objectsFound },
    { label: 'Сопоставлено', value: summary.objectsMapped },
    { label: 'Импортировано', value: summary.objectsImported },
    { label: 'Создано', value: summary.objectsCreated },
    { label: 'Обновлено', value: summary.objectsUpdated },
    { label: 'Не импортировано', value: summary.objectsFailed, tone: 'danger' },
    { label: 'Застройщики', value: summary.developersMapped },
    { label: 'Локации', value: summary.locationsMapped },
    { label: 'Метро', value: summary.metroStationsMapped },
    { label: 'Изображения', value: summary.validImagesMapped },
    { label: 'Файлы', value: summary.validFilesMapped },
    { label: 'Warnings', value: summary.warningsCount, tone: 'warning' },
    { label: 'Errors', value: summary.errorsCount, tone: 'danger' },
  ];

  return (
    <section className="report-summary-section">
      <div className="report-section-header">
        <h4>Summary</h4>
        <span>{summary.dryRun ? 'Preview' : 'Run'}</span>
      </div>
      <dl className="report-summary">
        {items.map((item) => (
          <div key={item.label} className={item.tone ? `report-summary-item--${item.tone}` : undefined}>
            <dt>{item.label}</dt>
            <dd>{formatSummaryValue(item.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ReportIssues({ title, issues }: { title: string; issues: unknown[] }) {
  return (
    <section className="report-issues">
      <div className="report-section-header">
        <h4>{title}</h4>
        <span>{formatSummaryNumber(issues.length)}</span>
      </div>
      {issues.length > 0 ? (
        <ul className="report-issue-list">
          {issues.map((issue, index) => {
            const issueView = toIssueView(issue, index);

            return (
              <li key={index} className={`report-issue-card report-issue-card--${issueView.severity}`}>
                <div className="report-issue-heading">
                  <span className="report-issue-code">{issueView.code}</span>
                  <span className="report-issue-severity">{issueView.severity}</span>
                </div>
                <p>{issueView.message}</p>
                {issueView.meta.length > 0 ? (
                  <dl className="report-issue-meta">
                    {issueView.meta.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <details className="report-issue-raw">
                  <summary>Исходные данные</summary>
                  <pre>{issueView.raw}</pre>
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="helper-text">Нет</p>
      )}
    </section>
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getReportIssueCount(report: ImportReport, type: 'warnings' | 'errors') {
  const summary = isPlainObject(report.summaryJson) ? report.summaryJson : null;
  const summaryKey = type === 'warnings' ? 'warningsCount' : 'errorsCount';
  const jsonKey = type === 'warnings' ? 'warningsJson' : 'errorsJson';
  const summaryValue = summary?.[summaryKey];
  const jsonValue = report[jsonKey];

  if (typeof summaryValue === 'number') {
    return summaryValue;
  }

  if (Array.isArray(jsonValue)) {
    return jsonValue.length;
  }

  return 0;
}

function formatSummaryNumber(value: unknown) {
  if (typeof value !== 'number') {
    return '0';
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatSummaryValue(value: unknown) {
  if (typeof value === 'number') {
    return formatSummaryNumber(value);
  }

  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  return '0';
}

function getReportProfileLabel(summary: Record<string, unknown> | null) {
  if (!summary) {
    return null;
  }

  const profile = typeof summary.profile === 'string' && summary.profile.trim() ? summary.profile : null;
  const objectType = typeof summary.objectType === 'string' && summary.objectType.trim() ? summary.objectType : null;

  return [profile, objectType].filter(Boolean).join(' · ') || null;
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return 'Не указано';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(startedAt: string, finishedAt: string) {
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'Не указано';
  }

  return formatDurationMs(durationMs);
}

function formatReportDuration(report: ImportReport) {
  const summary = isPlainObject(report.summaryJson) ? report.summaryJson : null;
  const durationMs = summary?.durationMs;

  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    return formatDurationMs(durationMs);
  }

  if (report.finishedAt) {
    return formatDuration(report.startedAt, report.finishedAt);
  }

  return report.status === 'PENDING' ? 'В процессе' : 'Не завершён';
}

function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds} сек.`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes} мин. ${seconds} сек.` : `${minutes} мин.`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  return restMinutes > 0 ? `${hours} ч. ${restMinutes} мин.` : `${hours} ч.`;
}

function shortenId(id: string) {
  return id.slice(0, 8);
}

function toIssueView(issue: unknown, index: number) {
  const raw = stringifyJson(issue);

  if (!isPlainObject(issue)) {
    return {
      code: `item-${index + 1}`,
      message: formatIssueValue(issue),
      meta: [] as [string, string][],
      raw,
      severity: 'info',
    };
  }

  const severityValue = issue.severity;
  const severity =
    severityValue === 'error' || severityValue === 'warning' || severityValue === 'info'
      ? severityValue
      : 'info';
  const code = typeof issue.code === 'string' && issue.code.trim() ? issue.code : `item-${index + 1}`;
  const message =
    typeof issue.message === 'string' && issue.message.trim()
      ? issue.message
      : formatIssueValue(issue);
  const meta = Object.entries(issue)
    .filter(([key]) => !['severity', 'code', 'message'].includes(key))
    .map(([key, value]) => [formatIssueKey(key), formatIssueValue(value)] as [string, string]);

  return {
    code,
    message,
    meta,
    raw,
    severity,
  };
}

function formatIssueKey(key: string) {
  const labels: Record<string, string> = {
    metaKey: 'Meta key',
    wpAttachmentId: 'WP attachment',
    wpPostId: 'WP post',
  };

  return labels[key] ?? key;
}

function formatIssueValue(value: unknown) {
  if (value === null || value === undefined) {
    return 'Не указано';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return stringifyJson(value);
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
