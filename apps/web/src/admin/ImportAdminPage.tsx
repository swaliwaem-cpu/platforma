import { useEffect, useMemo, useState } from 'react';
import {
  ImportMode,
  ImportReport,
  ImportReportResponse,
  ImportReportsResponse,
  ImportStatus,
} from '@platforma/shared';

import { useAuth } from '../auth/AuthProvider';
import { apiRequest } from './api';

type ImportAdminPageProps = {
  onBack: () => void;
};

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
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canPreview = hasPermission('import:preview');
  const canRun = hasPermission('import:run');

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

  async function runImportCommand(mode: 'preview' | 'run') {
    if (!accessToken) {
      return;
    }

    const confirmed = mode === 'preview' || window.confirm('Запустить импорт с записью данных?');

    if (!confirmed) {
      return;
    }

    setIsRunning(true);
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
      setIsRunning(false);
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

  return (
    <div className="admin-import">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Импорт WordPress</h2>
        </div>
        <div className="header-actions">
          <button
            className="secondary-button secondary-button--fit"
            disabled={!canPreview || isRunning}
            type="button"
            onClick={() => void runImportCommand('preview')}
          >
            Preview
          </button>
          <button
            className="primary-button primary-button--fit"
            disabled={!canRun || isRunning}
            type="button"
            onClick={() => void runImportCommand('run')}
          >
            Run
          </button>
          <button className="secondary-button secondary-button--fit" type="button" onClick={() => void loadReports()}>
            Обновить
          </button>
          <button className="secondary-button secondary-button--fit" type="button" onClick={onBack}>
            Назад
          </button>
        </div>
      </header>

      <section className="toolbar" aria-label="Фильтры отчётов импорта">
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
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}

      <div className="import-layout">
        <section className="table-panel" aria-label="Отчёты импорта">
          <div className="table-meta">
            <span>{isLoading ? 'Загрузка' : `Всего: ${total}`}</span>
            <span>
              Страница {page} из {totalPages}
            </span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Старт</th>
                  <th>Режим</th>
                  <th>Статус</th>
                  <th>Объекты</th>
                  <th>Предупреждения</th>
                  <th>Ошибки</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => {
                  const summary = isPlainObject(report.summaryJson) ? report.summaryJson : null;

                  return (
                    <tr key={report.id} className={selectedReport?.id === report.id ? 'is-selected' : undefined}>
                      <td>
                        <strong>{formatDateTime(report.startedAt)}</strong>
                        <span className="table-subtext">{report.finishedAt ? formatDuration(report.startedAt, report.finishedAt) : 'Не завершён'}</span>
                      </td>
                      <td>{modeLabels[report.mode]}</td>
                      <td>
                        <span className={`status-pill import-status import-status--${report.status.toLowerCase()}`}>
                          {statusLabels[report.status]}
                        </span>
                      </td>
                      <td>{formatSummaryNumber(summary?.objectsImported ?? summary?.objectsMapped)}</td>
                      <td>{formatSummaryNumber(summary?.warningsCount)}</td>
                      <td>{formatSummaryNumber(summary?.errorsCount)}</td>
                      <td>
                        <button className="text-button" type="button" onClick={() => void openReport(report.id)}>
                          Открыть
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {!isLoading && reports.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <span className="empty-row">Отчёты не найдены</span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button
              className="secondary-button secondary-button--fit"
              disabled={page <= 1}
              type="button"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
            >
              Назад
            </button>
            <button
              className="secondary-button secondary-button--fit"
              disabled={page >= totalPages}
              type="button"
              onClick={() => setPage((currentPage) => currentPage + 1)}
            >
              Вперёд
            </button>
          </div>
        </section>

        <aside className="editor-panel import-report-panel" aria-label="Детали отчёта">
          {selectedReport ? (
            <>
              <p className="eyebrow">{modeLabels[selectedReport.mode]}</p>
              <h3>{statusLabels[selectedReport.status]}</h3>
              <dl className="details-list import-details">
                <div>
                  <dt>Старт</dt>
                  <dd>{formatDateTime(selectedReport.startedAt)}</dd>
                </div>
                <div>
                  <dt>Финиш</dt>
                  <dd>{selectedReport.finishedAt ? formatDateTime(selectedReport.finishedAt) : 'Не завершён'}</dd>
                </div>
                <div>
                  <dt>Источник</dt>
                  <dd>{selectedReport.source}</dd>
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
        </aside>
      </div>
    </div>
  );
}

function ReportSummary({ summary }: { summary: Record<string, unknown> | null }) {
  if (!summary) {
    return null;
  }

  const items: [string, unknown][] = [
    ['Найдено', summary.objectsFound],
    ['Сопоставлено', summary.objectsMapped],
    ['Импортировано', summary.objectsImported],
    ['Создано', summary.objectsCreated],
    ['Обновлено', summary.objectsUpdated],
    ['Изображения', summary.validImagesMapped],
    ['Файлы', summary.validFilesMapped],
  ];

  return (
    <dl className="report-summary">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{formatSummaryNumber(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportIssues({ title, issues }: { title: string; issues: unknown[] }) {
  return (
    <section className="report-issues">
      <h4>{title}</h4>
      {issues.length > 0 ? (
        <pre>{JSON.stringify(issues.slice(0, 40), null, 2)}</pre>
      ) : (
        <p className="helper-text">Нет</p>
      )}
    </section>
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatSummaryNumber(value: unknown) {
  if (typeof value !== 'number') {
    return '0';
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(startedAt: string, finishedAt: string) {
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'Завершён';
  }

  const seconds = Math.round(durationMs / 1000);

  return `${seconds} сек.`;
}
