import type { TrainingOperationsResponse } from '@platforma/shared';
import {
  AlertTriangleIcon,
  HeartPulseIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  AdminAlert,
  AdminButton,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import {
  getTrainingOperations,
  retryTrainingJob,
} from './trainingResultsApi';
import './trainingResults.css';

type TrainingOperationsPageProps = {
  onBack: () => void;
};

export function TrainingOperationsPage({
  onBack,
}: TrainingOperationsPageProps) {
  const { accessToken, hasPermission } = useAuth();
  const [summary, setSummary] =
    useState<TrainingOperationsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [retryReason, setRetryReason] = useState('');
  const [retryIdempotencyKey, setRetryIdempotencyKey] = useState('');
  const [retrySubmittedReason, setRetrySubmittedReason] = useState<
    string | null
  >(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    try {
      setSummary(await getTrainingOperations(accessToken));
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить состояние модуля'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitRetry() {
    if (!accessToken || !retryJobId) return;
    const normalizedReason = retryReason.trim();
    const idempotencyKey =
      retrySubmittedReason === null ||
      retrySubmittedReason === normalizedReason
        ? retryIdempotencyKey
        : createOperationsRetryIdempotencyKey();
    setRetryIdempotencyKey(idempotencyKey);
    setRetrySubmittedReason(normalizedReason);
    setIsRetrying(true);
    setError(null);
    try {
      await retryTrainingJob(
        accessToken,
        retryJobId,
        normalizedReason,
        idempotencyKey,
      );
      resetRetryDialog();
      setNotice('Задание возвращено в очередь. Действие записано в аудит.');
      await load();
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось повторить задание'));
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className="training-results training-operations">
      <header className="training-results-header">
        <div>
          <button
            className="training-results-back"
            type="button"
            onClick={onBack}
          >
            Назад
          </button>
          <p className="eyebrow">Обучение · Operations</p>
          <h2>Состояние модуля</h2>
          <p>
            Безопасная operational-сводка без секретов, расшифровок,
            аудиоданных и содержимого заданий.
          </p>
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
          Загрузка operational-сводки
        </div>
      ) : null}

      {summary ? (
        <>
          <section
            className="training-operations-overview"
            aria-label="Ключевые индикаторы"
          >
            <OperationMetric
              icon={<HeartPulseIcon aria-hidden="true" />}
              label="Модуль"
              value={
                summary.training.enabled
                  ? 'Включён'
                  : 'Безопасно отключён'
              }
              tone={summary.training.enabled ? 'success' : 'warning'}
            />
            <OperationMetric
              icon={<ShieldCheckIcon aria-hidden="true" />}
              label="Приватность аудио"
              value={
                summary.audioPrivacy.status === 'VERIFIED'
                  ? 'Проверена'
                  : 'Не подтверждена'
              }
              tone={
                summary.audioPrivacy.status === 'VERIFIED'
                  ? 'success'
                  : 'warning'
              }
            />
            <OperationMetric
              icon={<AlertTriangleIcon aria-hidden="true" />}
              label="Попытки"
              value={`${summary.activeAttempts} активных · ${summary.stuckAttempts} зависших`}
              tone={
                summary.stuckAttempts > 0 ? 'warning' : 'success'
              }
            />
            <OperationMetric
              icon={<RefreshCwIcon aria-hidden="true" />}
              label="Ожидание / review"
              value={`${formatDuration(summary.oldestPendingAgeSeconds)} · ${summary.attemptsRequiringReview} на проверке`}
              tone={
                summary.attemptsRequiringReview > 0 ? 'warning' : 'neutral'
              }
            />
          </section>

          <AdminPanel>
            <CardHeader>
              <CardTitle>Очередь заданий</CardTitle>
              <AdminStatusBadge>
                {summary.queue.reduce((total, item) => total + item.count, 0)}
              </AdminStatusBadge>
            </CardHeader>
            <CardContent className="training-operations-table-wrap">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Тип</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead className="training-operations-number">
                      Количество
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.queue.length ? (
                    summary.queue.map((item) => (
                      <TableRow key={`${item.kind}:${item.status}`}>
                        <TableCell>{formatCode(item.kind)}</TableCell>
                        <TableCell>
                          <AdminStatusBadge
                            className={statusTone(item.status)}
                          >
                            {formatCode(item.status)}
                          </AdminStatusBadge>
                        </TableCell>
                        <TableCell className="training-operations-number">
                          {item.count}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={3}>Очередь пуста.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </AdminPanel>

          <div className="training-operations-columns">
            <AdminPanel>
              <CardHeader>
                <CardTitle>Воркеры</CardTitle>
              </CardHeader>
              <CardContent className="training-operations-list">
                {summary.workers.length ? (
                  summary.workers.map((worker) => (
                    <article key={worker.kind}>
                      <div>
                        <strong>{formatCode(worker.kind)}</strong>
                        <span>
                          Последний сигнал {formatDateTime(worker.lastSeenAt)}
                        </span>
                      </div>
                      <AdminStatusBadge
                        className={
                          worker.status === 'ONLINE'
                            ? 'training-status--success'
                            : 'training-status--warning'
                        }
                      >
                        {worker.status === 'ONLINE' ? 'Онлайн' : 'Нет сигнала'}
                      </AdminStatusBadge>
                    </article>
                  ))
                ) : (
                  <p className="muted-text">Heartbeat ещё не зафиксирован.</p>
                )}
              </CardContent>
            </AdminPanel>

            <AdminPanel>
              <CardHeader>
                <CardTitle>Активные правила</CardTitle>
              </CardHeader>
              <CardContent className="training-operations-policy">
                {summary.activePolicy ? (
                  <>
                    <strong>{summary.activePolicy.title}</strong>
                    <span>Версия {summary.activePolicy.version}</span>
                    <span>
                      Действует с{' '}
                      {formatDateTime(summary.activePolicy.effectiveAt)}
                    </span>
                    <AdminStatusBadge
                      className={
                        summary.activePolicy.approvalStatus === 'APPROVED'
                          ? 'training-status--success'
                          : 'training-status--warning'
                      }
                    >
                      {summary.activePolicy.approvalStatus === 'APPROVED'
                        ? 'Утверждено'
                        : 'Требует утверждения'}
                    </AdminStatusBadge>
                  </>
                ) : (
                  <p className="muted-text">Активная версия не настроена.</p>
                )}
              </CardContent>
            </AdminPanel>
          </div>

          <AdminPanel>
            <CardHeader>
              <CardTitle>Последние безопасные коды ошибок</CardTitle>
            </CardHeader>
            <CardContent className="training-operations-table-wrap">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Код</TableHead>
                    <TableHead>Задание</TableHead>
                    <TableHead>Время</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.recentErrors.length ? (
                    summary.recentErrors.map((item) => (
                      <TableRow key={item.jobId}>
                        <TableCell>{item.code ?? 'Без кода'}</TableCell>
                        <TableCell>{formatCode(item.kind)}</TableCell>
                        <TableCell>{formatDateTime(item.occurredAt)}</TableCell>
                        <TableCell>
                          {hasPermission('training:operations:manage') &&
                          (item.status === 'FAILED' ||
                            item.status === 'DEAD') ? (
                            <AdminButton
                              tone="text"
                              onClick={() => {
                                setRetryJobId(item.jobId);
                                setRetryReason('');
                                setRetryIdempotencyKey(
                                  createOperationsRetryIdempotencyKey(),
                                );
                                setRetrySubmittedReason(null);
                              }}
                            >
                              <RotateCcwIcon
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                              Повторить
                            </AdminButton>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4}>
                        Ошибок с безопасным кодом нет.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </AdminPanel>

          <AdminPanel>
            <CardHeader>
              <CardTitle>Подтверждения активных правил</CardTitle>
            </CardHeader>
            <CardContent className="training-operations-table-wrap">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Агрегат</TableHead>
                    <TableHead>Количество</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Действующие</TableCell>
                    <TableCell>
                      {summary.policyAcceptances.activeCount}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Отозванные</TableCell>
                    <TableCell>
                      {summary.policyAcceptances.revokedCount}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Platforma</TableCell>
                    <TableCell>
                      {summary.policyAcceptances.bySource.PLATFORM}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Telegram</TableCell>
                    <TableCell>
                      {summary.policyAcceptances.bySource.TELEGRAM}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </AdminPanel>
        </>
      ) : null}

      <Dialog
        open={retryJobId !== null}
        onOpenChange={(open) => {
          if (!open && !isRetrying) resetRetryDialog();
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Повторить задание</DialogTitle>
            <DialogDescription>
              Укажите причину. Повтор и причина будут записаны в AuditLog.
            </DialogDescription>
          </DialogHeader>
          <label className="training-operations-retry-reason">
            <span>Причина</span>
            <textarea
              autoFocus
              maxLength={500}
              rows={4}
              value={retryReason}
              onChange={(event) => setRetryReason(event.target.value)}
            />
          </label>
          <DialogFooter>
            <AdminButton
              disabled={isRetrying}
              tone="text"
              onClick={resetRetryDialog}
            >
              Отмена
            </AdminButton>
            <AdminButton
              disabled={
                isRetrying ||
                retryReason.trim().length < 3
              }
              tone="primary"
              onClick={() => void submitRetry()}
            >
              Повторить задание
            </AdminButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  function resetRetryDialog() {
    setRetryJobId(null);
    setRetryReason('');
    setRetryIdempotencyKey('');
    setRetrySubmittedReason(null);
  }
}

function OperationMetric({
  icon,
  label,
  tone,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'success' | 'warning' | 'neutral';
  value: string;
}) {
  return (
    <AdminPanel className="training-operation-metric">
      <div className={`training-operation-metric-icon training-operation-metric-icon--${tone}`}>
        {icon}
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </AdminPanel>
  );
}

function statusTone(status: string) {
  if (status === 'SUCCEEDED') return 'training-status--success';
  if (status === 'FAILED' || status === 'DEAD') {
    return 'training-status--warning';
  }
  return 'training-status--neutral';
}

function formatCode(value: string) {
  return value
    .toLocaleLowerCase('ru-RU')
    .split('_')
    .map((part) => part[0]?.toLocaleUpperCase('ru-RU') + part.slice(1))
    .join(' ');
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('ru-RU');
}

function formatDuration(value: number | null) {
  if (value === null) return 'нет ожидающих';
  if (value < 60) return `${value} сек`;
  return `${Math.floor(value / 60)} мин`;
}

function createOperationsRetryIdempotencyKey() {
  return crypto.randomUUID();
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
