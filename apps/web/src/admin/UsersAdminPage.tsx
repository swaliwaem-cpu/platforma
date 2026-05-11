import { FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  UserRoundIcon,
  XCircleIcon,
} from 'lucide-react';
import {
  AdminRole,
  AdminRolesResponse,
  AdminUser,
  AdminUsersResponse,
  UserStatus,
} from '@platforma/shared';

import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useAuth } from '../auth/AuthProvider';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';

const statusLabels: Record<UserStatus, string> = {
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  INVITED: 'Приглашён',
  DEACTIVATED: 'Деактивирован',
};

const permissionGroupLabels: Record<string, string> = {
  admin: 'Админка',
  import: 'Импорт',
  objects: 'Объекты',
  users: 'Пользователи',
};

const permissionActionLabels: Record<string, string> = {
  access: 'Доступ',
  create: 'Создание',
  delete: 'Деактивация',
  preview: 'Preview',
  read: 'Просмотр',
  run: 'Запуск',
  update: 'Редактирование',
};

const emptyForm = {
  email: '',
  name: '',
  password: '',
  roleId: '',
  status: 'INVITED' as UserStatus,
};

type UserFormState = typeof emptyForm;

type PermissionGroup = {
  label: string;
  permissions: Array<{
    actionLabel: string;
    key: string;
  }>;
  scope: string;
};

type UsersAdminPageProps = {
  onBack: () => void;
};

export function UsersAdminPage({ onBack }: UsersAdminPageProps) {
  const { accessToken, hasPermission, user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmingDeactivation, setIsConfirmingDeactivation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canCreate = hasPermission('users:create');
  const canUpdate = hasPermission('users:update');
  const canDelete = hasPermission('users:delete');

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === form.roleId) ?? null,
    [form.roleId, roles],
  );
  const selectedRolePermissionGroups = useMemo(
    () => groupPermissionsByScope(selectedRole?.permissions ?? []),
    [selectedRole],
  );
  const hasActiveListFilters = Boolean(search.trim() || statusFilter || roleFilter);
  const isEditingUser = Boolean(selectedUser);
  const isFormDisabled = isSubmitting || (!isEditingUser && !canCreate) || (isEditingUser && !canUpdate);
  const submitDisabledReason = getSubmitDisabledReason(isEditingUser, canCreate, canUpdate);
  const activateDisabledReason = getActivateDisabledReason(canUpdate);
  const deactivateDisabledReason = getDeactivateDisabledReason(selectedUser, currentUser?.id, canDelete);
  const visibleActionRestrictions = [
    submitDisabledReason,
    selectedUser?.status === 'DEACTIVATED' ? activateDisabledReason : deactivateDisabledReason,
  ].filter((message): message is string => Boolean(message));

  useEffect(() => {
    const token = accessToken;

    if (!token) {
      return;
    }

    async function loadRoles(token: string) {
      const data = await apiRequest<AdminRolesResponse>('/users/roles', token);
      setRoles(data.items);

      if (data.items[0]) {
        setForm((currentForm) => ({
          ...currentForm,
          roleId: currentForm.roleId || data.items[0]?.id || '',
        }));
      }
    }

    void loadRoles(token).catch(() => {
      setError('Не удалось загрузить роли');
    });
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadUsers();
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [accessToken, page, roleFilter, search, statusFilter]);

  async function loadUsers() {
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

      if (search.trim()) {
        params.set('search', search.trim());
      }

      if (statusFilter) {
        params.set('status', statusFilter);
      }

      if (roleFilter) {
        params.set('roleId', roleFilter);
      }

      const data = await apiRequest<AdminUsersResponse>(`/users?${params.toString()}`, accessToken);

      setUsers(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      setError('Не удалось загрузить пользователей');
    } finally {
      setIsLoading(false);
    }
  }

  function resetForm() {
    setSelectedUser(null);
    setIsConfirmingDeactivation(false);
    setForm({
      ...emptyForm,
      roleId: roles[0]?.id ?? '',
    });
  }

  function startCreate() {
    resetForm();
    setNotice(null);
    setError(null);
  }

  function startEdit(user: AdminUser) {
    setSelectedUser(user);
    setIsConfirmingDeactivation(false);
    setForm({
      email: user.email,
      name: user.name ?? '',
      password: '',
      roleId: user.role.id,
      status: user.status,
    });
    setNotice(null);
    setError(null);
  }

  function resetListFilters() {
    setSearch('');
    setStatusFilter('');
    setRoleFilter('');
    setPage(1);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    const payload = {
      email: form.email,
      name: form.name,
      roleId: form.roleId,
      status: form.status,
      ...(form.password ? { password: form.password } : {}),
    };

    try {
      if (selectedUser) {
        const data = await apiRequest<{ user: AdminUser }>(`/users/${selectedUser.id}`, accessToken, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setSelectedUser(data.user);
        setIsConfirmingDeactivation(false);
        setForm({
          email: data.user.email,
          name: data.user.name ?? '',
          password: '',
          roleId: data.user.role.id,
          status: data.user.status,
        });
        setNotice('Пользователь обновлён');
      } else {
        await apiRequest('/users', accessToken, {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            password: form.password,
          }),
        });
        setNotice('Пользователь создан');
        resetForm();
      }

      await loadUsers();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить пользователя');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deactivateSelectedUser() {
    if (!selectedUser || !accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      await apiRequest(`/users/${selectedUser.id}/deactivate`, accessToken, {
        method: 'POST',
      });
      setNotice('Пользователь деактивирован');
      setIsConfirmingDeactivation(false);
      resetForm();
      await loadUsers();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось деактивировать пользователя');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function activateSelectedUser() {
    if (!selectedUser || !accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<{ user: AdminUser }>(`/users/${selectedUser.id}/activate`, accessToken, {
        method: 'POST',
      });
      setSelectedUser(data.user);
      setIsConfirmingDeactivation(false);
      setForm({
        email: data.user.email,
        name: data.user.name ?? '',
        password: '',
        roleId: data.user.role.id,
        status: data.user.status,
      });
      setNotice('Пользователь активирован');
      await loadUsers();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось активировать пользователя');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="admin-users">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Пользователи</h2>
        </div>
        <AdminButton tone="secondary" type="button" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Назад
        </AdminButton>
      </header>

      <section className="toolbar user-toolbar" aria-label="Фильтры пользователей">
        <div className="user-toolbar-main">
          <label className="toolbar-field user-toolbar-search">
            <span>Поиск</span>
            <span className="toolbar-input-shell">
              <SearchIcon aria-hidden="true" />
              <Input
                aria-label="Поиск пользователей"
                className="admin-toolbar-search"
                placeholder="Email или имя"
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </span>
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

          <label className="toolbar-field">
            <span>Роль</span>
            <select
              aria-label="Фильтр по роли"
              value={roleFilter}
              onChange={(event) => {
                setRoleFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Все роли</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="user-toolbar-actions">
          <AdminButton disabled={!hasActiveListFilters} tone="secondary" type="button" onClick={resetListFilters}>
            <RotateCcwIcon data-icon="inline-start" />
            Сбросить
          </AdminButton>
          <AdminButton
            disabled={!canCreate}
            title={canCreate ? undefined : 'Нет права users:create'}
            tone="primary"
            type="button"
            onClick={startCreate}
          >
            <PlusIcon data-icon="inline-start" />
            Новый пользователь
          </AdminButton>
        </div>
      </section>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <div className="users-layout">
        <AdminPanel className="table-panel" role="region" aria-label="Список пользователей">
          <div className="table-meta">
            <span>{isLoading ? 'Загрузка пользователей' : `Найдено: ${total}`}</span>
            <span>
              Страница {page} из {totalPages}
            </span>
          </div>

          <Table className="admin-table">
            <TableHeader>
              <TableRow>
                <TableHead className="user-email-column">Email</TableHead>
                <TableHead className="user-name-column">Имя</TableHead>
                <TableHead className="user-role-column">Роль</TableHead>
                <TableHead className="user-status-column">Статус</TableHead>
                <TableHead className="user-created-column">Создан</TableHead>
                <TableHead className="user-action-column">
                  <span className="sr-only">Действия</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
                {users.map((user) => (
                  <TableRow
                    key={user.id}
                    aria-selected={selectedUser?.id === user.id}
                    className={getUserRowClassName(user, selectedUser)}
                    data-state={selectedUser?.id === user.id ? 'selected' : undefined}
                  >
                    <TableCell className="user-email-column">
                      <div className="user-identity-cell">
                        <strong>{user.email}</strong>
                        <span className="table-subtext">
                          {user.id === currentUser?.id ? 'Текущий пользователь' : `ID ${shortenId(user.id)}`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={user.name ? undefined : 'muted-cell'}>
                        {user.name || 'Не указано'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="role-pill role-pill--table">{user.role.name}</span>
                    </TableCell>
                    <TableCell className="user-status-column">
                      <div className="user-status-cell">
                        <AdminStatusBadge className={`status-pill--${user.status.toLowerCase()}`}>
                          {statusLabels[user.status]}
                        </AdminStatusBadge>
                      </div>
                    </TableCell>
                    <TableCell className="user-created-column">
                      <strong>{formatDate(user.createdAt)}</strong>
                    </TableCell>
                    <TableCell className="user-action-column">
                      <AdminButton tone="text" type="button" onClick={() => startEdit(user)}>
                        <UserRoundIcon data-icon="inline-start" />
                        Открыть
                      </AdminButton>
                    </TableCell>
                  </TableRow>
                ))}

                {!isLoading && users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <AdminEmptyState
                        title="Пользователи не найдены"
                        description="Измените фильтры или создайте нового пользователя."
                      />
                    </TableCell>
                  </TableRow>
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

        <AdminPanel className="editor-panel" role="region" aria-labelledby="user-editor-title">
          <p className="eyebrow">{selectedUser ? 'Редактирование' : 'Создание'}</p>
          <h3 id="user-editor-title">{selectedUser ? selectedUser.email : 'Новый пользователь'}</h3>
          <p className="helper-text">
            {selectedUser
              ? 'Изменения сохраняются только при наличии users:update.'
              : 'Для нового пользователя нужен email, роль и временный пароль.'}
          </p>

          <form className="user-form" onSubmit={(event) => void handleSubmit(event)}>
            <fieldset className="user-form-fields" disabled={isFormDisabled}>
              <div className="user-form-sections">
                <UserFormSection title="Данные пользователя" description="Контакты и отображаемое имя в кабинете.">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="admin-user-email">Email</FieldLabel>
                      <Input
                        id="admin-user-email"
                        required
                        autoComplete="email"
                        type="email"
                        value={form.email}
                        onChange={(event) => setForm({ ...form, email: event.target.value })}
                      />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="admin-user-name">Имя</FieldLabel>
                      <Input
                        id="admin-user-name"
                        autoComplete="name"
                        type="text"
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                      />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="admin-user-password">Пароль</FieldLabel>
                      <Input
                        id="admin-user-password"
                        required={!selectedUser}
                        autoComplete="new-password"
                        minLength={8}
                        type="password"
                        value={form.password}
                        onChange={(event) => setForm({ ...form, password: event.target.value })}
                      />
                      <FieldDescription>
                        {selectedUser ? 'Оставьте пустым, если пароль менять не нужно.' : 'Минимум 8 символов.'}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </UserFormSection>

                <UserFormSection title="Доступ" description="Роль определяет permissions, статус управляет доступом к платформе.">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="admin-user-role">Роль</FieldLabel>
                      <select
                        id="admin-user-role"
                        required
                        value={form.roleId}
                        onChange={(event) => setForm({ ...form, roleId: event.target.value })}
                      >
                        <option value="" disabled>
                          Выберите роль
                        </option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="admin-user-status">Статус</FieldLabel>
                      <select
                        id="admin-user-status"
                        required
                        value={form.status}
                        onChange={(event) => setForm({ ...form, status: event.target.value as UserStatus })}
                      >
                        {Object.entries(statusLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </FieldGroup>
                </UserFormSection>
              </div>
            </fieldset>

            <RolePermissionsPanel groups={selectedRolePermissionGroups} role={selectedRole} />

            <div className="form-actions">
              <AdminButton
                disabled={isSubmitting || Boolean(submitDisabledReason)}
                title={submitDisabledReason ?? undefined}
                tone="primary"
                type="submit"
              >
                <SaveIcon data-icon="inline-start" />
                {isSubmitting ? 'Сохранение' : selectedUser ? 'Сохранить' : 'Создать'}
              </AdminButton>
              {selectedUser?.status === 'DEACTIVATED' ? (
                <AdminButton
                  disabled={isSubmitting || Boolean(activateDisabledReason)}
                  title={activateDisabledReason ?? undefined}
                  tone="success"
                  type="button"
                  onClick={() => void activateSelectedUser()}
                >
                  <CheckCircle2Icon data-icon="inline-start" />
                  Активировать
                </AdminButton>
              ) : null}
              {selectedUser && selectedUser.status !== 'DEACTIVATED' ? (
                <AdminButton
                  disabled={isSubmitting || Boolean(deactivateDisabledReason)}
                  title={deactivateDisabledReason ?? undefined}
                  tone="danger"
                  type="button"
                  onClick={() => setIsConfirmingDeactivation(true)}
                >
                  <XCircleIcon data-icon="inline-start" />
                  Деактивировать
                </AdminButton>
              ) : null}
            </div>

            {visibleActionRestrictions.length ? (
              <ul className="action-hint-list">
                {visibleActionRestrictions.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}

            {selectedUser && isConfirmingDeactivation ? (
              <div className="deactivation-confirm" role="alert">
                <p>Деактивировать пользователя {selectedUser.email}?</p>
                <div className="deactivation-confirm-actions">
                  <AdminButton
                    disabled={isSubmitting}
                    tone="danger"
                    type="button"
                    onClick={() => void deactivateSelectedUser()}
                  >
                    <XCircleIcon data-icon="inline-start" />
                    Подтвердить
                  </AdminButton>
                  <AdminButton
                    disabled={isSubmitting}
                    tone="secondary"
                    type="button"
                    onClick={() => setIsConfirmingDeactivation(false)}
                  >
                    Отмена
                  </AdminButton>
                </div>
              </div>
            ) : null}
          </form>
        </AdminPanel>
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

function shortenId(value: string) {
  return value.slice(0, 8);
}

function getUserRowClassName(user: AdminUser, selectedUser: AdminUser | null) {
  const classNames = [];

  if (selectedUser?.id === user.id) {
    classNames.push('is-selected');
  }

  if (user.status === 'DEACTIVATED') {
    classNames.push('user-row--deactivated');
  }

  return classNames.length ? classNames.join(' ') : undefined;
}

function getSubmitDisabledReason(isEditingUser: boolean, canCreate: boolean, canUpdate: boolean) {
  if (isEditingUser && !canUpdate) {
    return 'Нет права users:update для сохранения изменений.';
  }

  if (!isEditingUser && !canCreate) {
    return 'Нет права users:create для создания пользователя.';
  }

  return null;
}

function getActivateDisabledReason(canUpdate: boolean) {
  return canUpdate ? null : 'Нет права users:update для активации.';
}

function getDeactivateDisabledReason(selectedUser: AdminUser | null, currentUserId: string | undefined, canDelete: boolean) {
  if (!selectedUser) {
    return null;
  }

  if (!canDelete) {
    return 'Нет права users:delete для деактивации.';
  }

  if (selectedUser.id === currentUserId) {
    return 'Нельзя деактивировать собственную учётную запись.';
  }

  return null;
}

function groupPermissionsByScope(permissions: string[]): PermissionGroup[] {
  const groupedPermissions = new Map<string, PermissionGroup>();

  for (const key of [...permissions].sort()) {
    const [scope = 'other', action = key] = key.split(':');
    const group = groupedPermissions.get(scope) ?? {
      label: permissionGroupLabels[scope] ?? scope,
      permissions: [],
      scope,
    };

    group.permissions.push({
      actionLabel: permissionActionLabels[action] ?? action,
      key,
    });
    groupedPermissions.set(scope, group);
  }

  return Array.from(groupedPermissions.values()).sort((firstGroup, secondGroup) =>
    firstGroup.label.localeCompare(secondGroup.label, 'ru'),
  );
}

function UserFormSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="user-form-section">
      <div className="user-form-section-header">
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function RolePermissionsPanel({
  groups,
  role,
}: {
  groups: PermissionGroup[];
  role: AdminRole | null;
}) {
  if (!role) {
    return (
      <section className="role-permissions-panel role-permissions-panel--empty" aria-label="Права роли">
        <h4>Права роли</h4>
        <p>Выберите роль, чтобы увидеть permissions.</p>
      </section>
    );
  }

  return (
    <section className="role-permissions-panel" aria-label="Права выбранной роли">
      <div className="role-permissions-header">
        <div className="role-permissions-title">
          <span className="role-pill role-pill--panel">{role.name}</span>
          <h4>Права роли</h4>
          <p>{role.description || 'Описание роли не заполнено.'}</p>
        </div>
        <span className="panel-count">{role.permissions.length}</span>
      </div>

      {groups.length ? (
        <div className="permission-groups">
          {groups.map((group) => (
            <div key={group.scope} className="permission-group">
              <p className="permission-group-title">{group.label}</p>
              <div className="permission-chip-list permission-chip-list--grid">
                {group.permissions.map((permission) => (
                  <span key={permission.key} className="permission-chip permission-chip--role">
                    <span>{permission.actionLabel}</span>
                    <code>{permission.key}</code>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="helper-text">У роли нет permissions.</p>
      )}
    </section>
  );
}
