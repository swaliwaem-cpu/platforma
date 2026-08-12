import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  TrainingAudioDeletionManifestResponse,
  TrainingAudioStorageItem,
  TrainingAudioStorageReport,
  TrainingAudioStorageState,
} from '@platforma/shared';
import {
  CircleAlertIcon,
  DatabaseIcon,
  HardDriveIcon,
  LinkIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';

import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createTrainingAudioDeletionManifest,
  executeTrainingAudioDeletionManifest,
  getTrainingAudioStorage,
  type TrainingAudioStorageQuery,
} from './trainingApi';
import './trainingAudioStorage.css';

const initialQuery: TrainingAudioStorageQuery = {
  page: 1,
  limit: 50,
  project: '',
  user: '',
  createdFrom: '',
  createdTo: '',
  state: '',
};

const storageStateLabels: Record<TrainingAudioStorageState, string> = {
  LINKED: 'Используется',
  UNLINKED: 'Без активной ссылки',
  DB_ONLY: 'Нет объекта',
  STORAGE_ONLY: 'Нет записи File',
  MISSING: 'Отсутствует',
  PENDING_DELETE: 'Ожидает удаления',
  DELETED: 'Удалён вручную',
};

export function TrainingAudioStoragePage({
  canDeleteFiles,
  navigate,
}: {
  canDeleteFiles: boolean;
  navigate: (pathname: string) => void;
}) {
  const { accessToken } = useAuth();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [report, setReport] = useState<TrainingAudioStorageReport | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [lastManifest, setLastManifest] = useState<TrainingAudioDeletionManifestResponse | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAudioStorage(accessToken, query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setReport(response);
        const available = new Set(response.items.filter((item) => item.canDelete).map((item) => item.selectionId));
        setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось сверить аудиохранилище');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, query, reloadKey]);

  const selectedItems = useMemo(
    () => report?.items.filter((item) => selectedIds.has(item.selectionId)) ?? [],
    [report, selectedIds],
  );
  const deletablePageItems = report?.items.filter((item) => item.canDelete) ?? [];
  const allPageItemsSelected = deletablePageItems.length > 0 &&
    deletablePageItems.every((item) => selectedIds.has(item.selectionId));
  const confirmationPhrase = `УДАЛИТЬ ${selectedItems.length}`;

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setSelectedIds(new Set());
    setQuery({ ...draft, page: 1 });
  };
  const resetFilters = () => {
    setSelectedIds(new Set());
    setDraft(initialQuery);
    setQuery(initialQuery);
  };
  const setPage = (page: number) => {
    const next = { ...query, page };
    setSelectedIds(new Set());
    setDraft(next);
    setQuery(next);
  };
  const toggleSelection = (selectionId: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(selectionId);
      else next.delete(selectionId);
      return next;
    });
  };
  const togglePageSelection = (selected: boolean) => {
    setSelectedIds(selected
      ? new Set(deletablePageItems.map((item) => item.selectionId))
      : new Set());
  };
  const refresh = () => {
    setSelectedIds(new Set());
    setReloadKey((value) => value + 1);
  };

  const deleteSelected = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !accessToken ||
      !canDeleteFiles ||
      isDeleting ||
      selectedItems.length === 0 ||
      !reason.trim() ||
      confirmation !== confirmationPhrase
    ) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const manifest = await createTrainingAudioDeletionManifest(accessToken, {
        selectionIds: selectedItems.map((item) => item.selectionId),
        reason: reason.trim(),
      });
      const executed = await executeTrainingAudioDeletionManifest(accessToken, manifest.id);
      setLastManifest(executed);
      setSelectedIds(new Set());
      setReason('');
      setConfirmation('');
      setIsDeleteDialogOpen(false);
      setReloadKey((value) => value + 1);
    } catch (actionError) {
      setDeleteError(actionError instanceof Error ? actionError.message : 'Не удалось выполнить ручное удаление');
    } finally {
      setIsDeleting(false);
    }
  };

  const retryManifest = async (manifestId: string) => {
    if (!accessToken || !canDeleteFiles || isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      const executed = await executeTrainingAudioDeletionManifest(accessToken, manifestId);
      setLastManifest(executed);
      setReloadKey((value) => value + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Не удалось повторить удаление');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="training-page training-admin-page training-audio-storage-page">
      <header className="training-page-header training-audio-storage-header">
        <div>
          <p className="eyebrow">Админка · Обучение · Storage</p>
          <h2>Хранилище аудио</h2>
          <p className="muted-text">
            Read-only сверка базы и private MinIO. Файлы удаляются только выбранным вручную манифестом.
          </p>
        </div>
        <div className="training-audio-storage-header-actions">
          <AdminButton type="button" tone="secondary" onClick={refresh} disabled={isLoading}>
            <RefreshCwIcon data-icon="inline-start" />
            Обновить
          </AdminButton>
          <AdminButton type="button" tone="secondary" onClick={() => navigate('/admin/training')}>
            К проектам
          </AdminButton>
        </div>
      </header>

      <AdminPanel className="training-audio-storage-filter-panel">
        <form onSubmit={applyFilters}>
          <FieldGroup className="training-audio-storage-filters">
            <Field>
              <FieldLabel htmlFor="audio-storage-project">Проект</FieldLabel>
              <Input
                id="audio-storage-project"
                list="audio-storage-projects"
                value={draft.project}
                placeholder="Название, включая удалённые"
                autoComplete="off"
                onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value }))}
              />
              <datalist id="audio-storage-projects">
                {report?.facets.projects.map((project) => <option key={`${project.id}-${project.title}`} value={project.title} />)}
              </datalist>
            </Field>
            <Field>
              <FieldLabel htmlFor="audio-storage-user">Пользователь</FieldLabel>
              <Input
                id="audio-storage-user"
                list="audio-storage-users"
                value={draft.user}
                placeholder="Имя или email"
                autoComplete="off"
                onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))}
              />
              <datalist id="audio-storage-users">
                {report?.facets.users.map((user) => (
                  <option
                    key={`${user.id}-${user.name}-${user.email}`}
                    value={user.name ?? user.email ?? ''}
                    label={user.email ?? undefined}
                  />
                ))}
              </datalist>
            </Field>
            <Field>
              <FieldLabel htmlFor="audio-storage-from">Дата от</FieldLabel>
              <Input
                id="audio-storage-from"
                type="date"
                value={draft.createdFrom}
                onChange={(event) => setDraft((current) => ({ ...current, createdFrom: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audio-storage-to">Дата до</FieldLabel>
              <Input
                id="audio-storage-to"
                type="date"
                value={draft.createdTo}
                onChange={(event) => setDraft((current) => ({ ...current, createdTo: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audio-storage-state">Состояние</FieldLabel>
              <select
                id="audio-storage-state"
                className="training-audio-storage-select"
                value={draft.state}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  state: event.target.value as TrainingAudioStorageState | '',
                }))}
              >
                <option value="">Все актуальные</option>
                {Object.entries(storageStateLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Field>
          </FieldGroup>
          <div className="training-audio-storage-filter-actions">
            <AdminButton type="submit" tone="primary" disabled={isLoading}>Показать</AdminButton>
            <AdminButton type="button" tone="secondary" onClick={resetFilters}>Сбросить</AdminButton>
          </div>
        </form>
      </AdminPanel>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={refresh}>Повторить</AdminButton>
        </AdminAlert>
      ) : null}
      {lastManifest?.status === 'COMPLETED' ? (
        <AdminAlert tone="notice">
          Манифест {shortId(lastManifest.id)} выполнен: удалено {lastManifest.deletedItems} объектов.
        </AdminAlert>
      ) : null}
      {lastManifest?.status === 'PENDING' ? (
        <AdminAlert tone="error">
          Манифест {shortId(lastManifest.id)} выполнен частично: осталось {lastManifest.pendingItems}.
          Он сохранён ниже для ручного повтора.
        </AdminAlert>
      ) : null}

      {report?.pendingManifests.length ? (
        <AdminPanel className="training-audio-storage-pending-panel">
          <div>
            <p className="eyebrow">Ручное удаление</p>
            <h3>Незавершённые манифесты</h3>
          </div>
          <div className="training-audio-storage-pending-list">
            {report.pendingManifests.map((manifest) => (
              <div className="training-audio-storage-pending-item" key={manifest.id}>
                <div>
                  <strong>{manifest.reason}</strong>
                  <span>
                    {formatDateTime(manifest.createdAt)} · осталось {manifest.pendingItems}
                    {manifest.lastErrorCodes.length ? ` · ${manifest.lastErrorCodes.join(', ')}` : ''}
                  </span>
                </div>
                {canDeleteFiles ? (
                  <AdminButton
                    type="button"
                    tone="secondary"
                    disabled={isDeleting}
                    onClick={() => void retryManifest(manifest.id)}
                  >
                    Повторить
                  </AdminButton>
                ) : null}
              </div>
            ))}
          </div>
        </AdminPanel>
      ) : null}

      <section className="training-audio-storage-metrics" aria-label="Сводка хранилища">
        <StorageMetric icon={LinkIcon} label="Активные ссылки" value={report?.summary.linked ?? null} />
        <StorageMetric icon={Trash2Icon} label="Можно удалить" value={report?.summary.deletable ?? null} />
        <StorageMetric icon={CircleAlertIcon} label="Расхождения" value={report?.summary.missing ?? null} />
        <StorageMetric icon={HardDriveIcon} label="Объём выборки" value={report ? formatBytes(report.summary.totalBytes) : null} />
      </section>

      <div className="training-audio-storage-section-heading">
        <div>
          <h3>Объекты private bucket</h3>
          <p>{report ? `Сверено ${report.total} · ${formatDateTime(report.reportGeneratedAt)}` : 'Выполняется сверка…'}</p>
        </div>
        {canDeleteFiles && selectedItems.length ? (
          <AdminButton
            type="button"
            tone="danger"
            onClick={() => {
              setDeleteError(null);
              setIsDeleteDialogOpen(true);
            }}
          >
            <Trash2Icon data-icon="inline-start" />
            Удалить выбранные · {selectedItems.length}
          </AdminButton>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="training-audio-storage-table-skeleton" />
      ) : report?.items.length ? (
        <AdminPanel className="training-audio-storage-table-panel">
          <div className="training-audio-storage-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="training-audio-storage-check-cell">
                    {canDeleteFiles ? (
                      <input
                        type="checkbox"
                        aria-label="Выбрать доступные объекты на странице"
                        checked={allPageItemsSelected}
                        onChange={(event) => togglePageSelection(event.target.checked)}
                      />
                    ) : null}
                  </TableHead>
                  <TableHead>Файл</TableHead>
                  <TableHead>Проект / пользователь</TableHead>
                  <TableHead>Состояние</TableHead>
                  <TableHead>Размер</TableHead>
                  <TableHead>Дата</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.items.map((item) => (
                  <AudioStorageRow
                    key={item.selectionId}
                    item={item}
                    canSelect={canDeleteFiles && item.canDelete}
                    selected={selectedIds.has(item.selectionId)}
                    onSelect={(selected) => toggleSelection(item.selectionId, selected)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </AdminPanel>
      ) : (
        <AdminEmptyState
          title="Файлы не найдены"
          description="Измените фильтры или обновите read-only отчёт."
        />
      )}

      <div className="training-audio-storage-pagination">
        <AdminButton
          type="button"
          tone="secondary"
          disabled={!report || query.page <= 1 || isLoading}
          onClick={() => setPage(query.page - 1)}
        >
          Назад
        </AdminButton>
        <span>Страница {query.page} из {Math.max(1, report?.totalPages ?? 0)}</span>
        <AdminButton
          type="button"
          tone="secondary"
          disabled={!report || query.page >= report.totalPages || isLoading}
          onClick={() => setPage(query.page + 1)}
        >
          Далее
        </AdminButton>
      </div>

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (isDeleting) return;
          setIsDeleteDialogOpen(open);
          if (!open) setDeleteError(null);
        }}
      >
        <DialogContent
          className="training-audio-storage-delete-dialog"
          showCloseButton={!isDeleting}
          onEscapeKeyDown={(event) => {
            if (isDeleting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (isDeleting) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Удалить {selectedItems.length} аудиофайлов вручную?</DialogTitle>
            <DialogDescription>
              Будет создан audit manifest с bucket, key и checksum. Операция необратима, но безопасно повторяется после частичного сбоя.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void deleteSelected(event)}>
            <FieldGroup>
              <Field data-disabled={isDeleting || undefined} data-invalid={Boolean(deleteError && !reason.trim())}>
                <FieldLabel htmlFor="audio-storage-delete-reason">Причина удаления *</FieldLabel>
                <Input
                  id="audio-storage-delete-reason"
                  value={reason}
                  required
                  maxLength={500}
                  disabled={isDeleting}
                  placeholder="Например: подтверждённый orphan после удаления проекта"
                  onChange={(event) => setReason(event.target.value)}
                />
                <FieldDescription>Причина сохраняется в manifest и audit log.</FieldDescription>
              </Field>
              <Field
                data-disabled={isDeleting || undefined}
                data-invalid={Boolean(confirmation && confirmation !== confirmationPhrase)}
              >
                <FieldLabel htmlFor="audio-storage-delete-confirmation">
                  Введите «{confirmationPhrase}»
                </FieldLabel>
                <Input
                  id="audio-storage-delete-confirmation"
                  value={confirmation}
                  required
                  autoComplete="off"
                  disabled={isDeleting}
                  aria-invalid={Boolean(confirmation && confirmation !== confirmationPhrase)}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                {confirmation && confirmation !== confirmationPhrase ? (
                  <FieldError>Фраза подтверждения не совпадает.</FieldError>
                ) : null}
              </Field>
            </FieldGroup>
            {deleteError ? <AdminAlert tone="error">{deleteError}</AdminAlert> : null}
            <DialogFooter>
              <AdminButton
                type="button"
                tone="secondary"
                disabled={isDeleting}
                onClick={() => setIsDeleteDialogOpen(false)}
              >
                Отмена
              </AdminButton>
              <AdminButton
                type="submit"
                tone="danger"
                disabled={
                  isDeleting ||
                  !reason.trim() ||
                  confirmation !== confirmationPhrase ||
                  selectedItems.length === 0
                }
              >
                <Trash2Icon data-icon="inline-start" />
                {isDeleting ? 'Удаление…' : 'Создать и выполнить manifest'}
              </AdminButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AudioStorageRow({
  item,
  canSelect,
  selected,
  onSelect,
}: {
  item: TrainingAudioStorageItem;
  canSelect: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  return (
    <TableRow data-selected={selected || undefined}>
      <TableCell className="training-audio-storage-check-cell">
        {canSelect ? (
          <input
            type="checkbox"
            aria-label={`Выбрать ${item.key}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}
      </TableCell>
      <TableCell>
        <div className="training-audio-storage-file-cell">
          <span className="training-audio-storage-file-icon" aria-hidden="true">
            {item.dbRowExists ? <DatabaseIcon /> : <HardDriveIcon />}
          </span>
          <div>
            <strong>{item.kind === 'MERGED' ? 'Собранный ответ' : 'Сегмент ответа'}</strong>
            <code title={item.key}>{item.key}</code>
            <span>{item.mimeType ?? 'MIME неизвестен'} · {shortChecksum(item.checksum ?? item.etag)}</span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="training-audio-storage-owner-cell">
          <strong>{item.project?.title ?? 'Проект неизвестен'}</strong>
          <span>{item.user?.name ?? item.user?.email ?? 'Пользователь неизвестен'}</span>
          {item.user?.name && item.user.email ? <small>{item.user.email}</small> : null}
        </div>
      </TableCell>
      <TableCell>
        <AdminStatusBadge className={`audio-storage-state audio-storage-state--${item.state.toLowerCase()}`}>
          {storageStateLabels[item.state]}
        </AdminStatusBadge>
        {!item.canDelete && item.isLinked ? <small className="training-audio-storage-lock-note">Есть активная ссылка</small> : null}
      </TableCell>
      <TableCell className="training-audio-storage-number-cell">{formatBytes(item.sizeBytes)}</TableCell>
      <TableCell className="training-audio-storage-date-cell">{formatDateTime(item.createdAt)}</TableCell>
    </TableRow>
  );
}

function StorageMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof LinkIcon;
  label: string;
  value: string | number | null;
}) {
  return (
    <AdminPanel className="training-audio-storage-metric">
      <span aria-hidden="true"><Icon /></span>
      <div>
        <small>{label}</small>
        {value === null ? <Skeleton className="training-audio-storage-metric-skeleton" /> : <strong>{value}</strong>}
      </div>
    </AdminPanel>
  );
}

function formatBytes(value: string | null) {
  if (value === null) return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  return `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shortChecksum(value: string | null) {
  return value ? `${value.slice(0, 10)}…` : 'checksum неизвестен';
}

function shortId(value: string) {
  return value.slice(0, 8);
}
