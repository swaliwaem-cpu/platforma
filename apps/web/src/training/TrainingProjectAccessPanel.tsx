import { useEffect, useMemo, useState } from 'react';
import type {
  TrainingAdminProject,
  TrainingProjectAccessMode,
  TrainingProjectAssignmentFilter,
  TrainingProjectAssignmentUser,
} from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel } from '../admin/AdminUi';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
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
import {
  bulkTrainingAssignments,
  getTrainingAssignmentUsers,
  updateTrainingAdminProject,
} from './trainingApi';

type TrainingProjectAccessPanelProps = {
  accessToken: string;
  project: TrainingAdminProject;
  onProjectChanged: (project: TrainingAdminProject) => void;
};

const PAGE_SIZE = 20;

export function TrainingProjectAccessPanel({
  accessToken,
  project,
  onProjectChanged,
}: TrainingProjectAccessPanelProps) {
  const [users, setUsers] = useState<TrainingProjectAssignmentUser[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [assigned, setAssigned] = useState<TrainingProjectAssignmentFilter>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [activeAssignments, setActiveAssignments] = useState(project.activeAssignments);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAssignmentUsers(
      accessToken,
      project.id,
      { page, limit: PAGE_SIZE, search, assigned },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setUsers(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
        setActiveAssignments(response.activeAssignments);
        setSelectedIds(new Set());
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Не удалось загрузить список сотрудников',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, assigned, page, project.id, reloadKey, search]);

  const selectableIds = useMemo(() => users.map((user) => user.userId), [users]);
  const allCurrentPageSelected =
    selectableIds.length > 0 && selectableIds.every((userId) => selectedIds.has(userId));

  const updateMode = async (accessMode: TrainingProjectAccessMode) => {
    if (accessMode === project.accessMode || pendingAction) return;

    setPendingAction('mode');
    setError(null);
    setNotice(null);
    try {
      const updated = await updateTrainingAdminProject(accessToken, project.id, { accessMode });
      onProjectChanged(updated);
      setNotice(
        accessMode === 'ALL_PARTICIPANTS'
          ? 'Новые попытки доступны всем сотрудникам с правом участия.'
          : 'Новые попытки доступны только назначенным сотрудникам.',
      );
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : 'Не удалось изменить режим доступа');
    } finally {
      setPendingAction(null);
    }
  };

  const runBulk = async (action: 'ASSIGN' | 'REVOKE') => {
    if (!selectedIds.size || pendingAction) return;

    setPendingAction(action);
    setError(null);
    setNotice(null);
    try {
      const response = await bulkTrainingAssignments(accessToken, project.id, {
        action,
        userIds: [...selectedIds],
      });
      setActiveAssignments(response.activeAssignments);
      onProjectChanged({ ...project, activeAssignments: response.activeAssignments });
      setNotice(
        action === 'ASSIGN'
          ? `Назначено: ${response.assigned}. Без изменений: ${response.unchanged}.`
          : `Отозвано: ${response.revoked}. Без изменений: ${response.unchanged}.`,
      );
      setReloadKey((value) => value + 1);
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : 'Массовое действие не выполнено');
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="training-access-stack">
      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>
            Повторить
          </AdminButton>
        </AdminAlert>
      ) : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <AdminPanel className="training-editor-section training-access-mode-panel">
        <div>
          <p className="eyebrow">Режим доступа</p>
          <h3>Кто может начать новую попытку</h3>
          <p className="muted-text">
            Изменение режима не останавливает активные попытки и не удаляет историю.
          </p>
        </div>
        <RadioGroup
          aria-label="Режим доступа к учебному проекту"
          className="training-access-modes"
          disabled={Boolean(pendingAction)}
          value={project.accessMode}
          onValueChange={(value) => void updateMode(value as TrainingProjectAccessMode)}
        >
          <label
            className="training-access-mode-option"
            data-selected={project.accessMode === 'ASSIGNED_USERS'}
          >
            <RadioGroupItem className="training-access-mode-radio" value="ASSIGNED_USERS" />
            <span className="training-access-mode-copy">
              <span className="training-access-mode-title">
                <strong>Только назначенные сотрудники</strong>
                {project.accessMode === 'ASSIGNED_USERS' ? (
                  <Badge className="training-access-mode-selected" aria-hidden="true">Выбрано</Badge>
                ) : null}
              </span>
              <small>Нужны право участия в обучении и активное назначение.</small>
            </span>
          </label>
          <label
            className="training-access-mode-option"
            data-selected={project.accessMode === 'ALL_PARTICIPANTS'}
          >
            <RadioGroupItem className="training-access-mode-radio" value="ALL_PARTICIPANTS" />
            <span className="training-access-mode-copy">
              <span className="training-access-mode-title">
                <strong>Все участники обучения</strong>
                {project.accessMode === 'ALL_PARTICIPANTS' ? (
                  <Badge className="training-access-mode-selected" aria-hidden="true">Выбрано</Badge>
                ) : null}
              </span>
              <small>Доступ получают все активные сотрудники с правом участия.</small>
            </span>
          </label>
        </RadioGroup>
        {project.accessMode === 'ASSIGNED_USERS' && activeAssignments === 0 ? (
          <AdminAlert tone="notice">
            В проекте нет активных назначений. Новую попытку пока не сможет начать никто.
          </AdminAlert>
        ) : null}
      </AdminPanel>

      <AdminPanel className="training-editor-section training-assignments-panel">
        <div className="training-assignment-heading">
          <div>
            <p className="eyebrow">Назначения</p>
            <h3>Сотрудники</h3>
          </div>
          <Badge variant="secondary">Активных назначений: {activeAssignments}</Badge>
        </div>

        <div className="training-assignment-filters">
          <label>
            <span>Поиск</span>
            <Input
              type="search"
              value={searchInput}
              placeholder="Имя или электронная почта"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <label>
            <span>Назначение</span>
            <select
              className="training-select"
              value={assigned}
              onChange={(event) => {
                setAssigned(event.target.value as TrainingProjectAssignmentFilter);
                setPage(1);
              }}
            >
              <option value="all">Все</option>
              <option value="yes">Назначены</option>
              <option value="no">Не назначены</option>
            </select>
          </label>
        </div>

        <div className="training-bulk-toolbar" aria-live="polite">
          <span>Выбрано на странице: {selectedIds.size}</span>
          <div>
            <AdminButton
              type="button"
              tone="primary"
              disabled={!selectedIds.size || Boolean(pendingAction)}
              onClick={() => void runBulk('ASSIGN')}
            >
              {pendingAction === 'ASSIGN' ? 'Назначаем…' : 'Назначить выбранных'}
            </AdminButton>
            <AdminButton
              type="button"
              tone="secondary"
              disabled={!selectedIds.size || Boolean(pendingAction)}
              onClick={() => void runBulk('REVOKE')}
            >
              {pendingAction === 'REVOKE' ? 'Снимаем…' : 'Снять выбранных'}
            </AdminButton>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="training-assignment-skeleton" />
        ) : users.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="training-assignment-check">
                  <input
                    type="checkbox"
                    aria-label="Выбрать всех сотрудников на текущей странице"
                    checked={allCurrentPageSelected}
                    onChange={(event) =>
                      setSelectedIds(event.target.checked ? new Set(selectableIds) : new Set())
                    }
                  />
                </TableHead>
                <TableHead>Сотрудник</TableHead>
                <TableHead>Право участия</TableHead>
                <TableHead>Назначение</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.userId} data-state={selectedIds.has(user.userId) ? 'selected' : undefined}>
                  <TableCell className="training-assignment-check">
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${user.name || user.email}`}
                      checked={selectedIds.has(user.userId)}
                      onChange={(event) => {
                        const next = new Set(selectedIds);
                        if (event.target.checked) next.add(user.userId);
                        else next.delete(user.userId);
                        setSelectedIds(next);
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="training-assignment-user">
                      <strong>{user.name || 'Без имени'}</strong>
                      <small>{user.email}</small>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="training-assignment-state">
                      <Badge variant={user.canParticipate ? 'secondary' : 'outline'}>
                        {user.canParticipate ? 'Есть' : 'Нет'}
                      </Badge>
                      {!user.canParticipate ? (
                        <small>Назначение не даст доступ без права участия в обучении.</small>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="training-assignment-state">
                      <Badge variant={user.isAssigned ? 'default' : 'outline'}>
                        {user.isAssigned ? 'Назначен' : 'Не назначен'}
                      </Badge>
                      {user.assignedAt ? <small>{formatAssignmentDate(user.assignedAt)}</small> : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty className="training-assignment-empty">
            <EmptyHeader>
              <EmptyTitle>Сотрудники не найдены</EmptyTitle>
              <EmptyDescription>Измените поиск или фильтр назначений.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <div className="training-assignment-pagination">
          <span>{total ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} из ${total}` : '0 сотрудников'}</span>
          <div>
            <AdminButton type="button" tone="text" disabled={page <= 1 || isLoading} onClick={() => setPage((value) => value - 1)}>Назад</AdminButton>
            <span>Страница {page} из {Math.max(1, totalPages)}</span>
            <AdminButton type="button" tone="text" disabled={page >= totalPages || isLoading} onClick={() => setPage((value) => value + 1)}>Далее</AdminButton>
          </div>
        </div>
      </AdminPanel>
    </div>
  );
}

function formatAssignmentDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
