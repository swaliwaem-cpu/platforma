import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AdminRole,
  AdminRolesResponse,
  AdminUser,
  AdminUsersResponse,
  UserStatus,
} from '@platforma/shared';

import { useAuth } from '../auth/AuthProvider';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const statusLabels: Record<UserStatus, string> = {
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  INVITED: 'Приглашён',
  DEACTIVATED: 'Деактивирован',
};

const emptyForm = {
  email: '',
  name: '',
  password: '',
  roleId: '',
  status: 'INVITED' as UserStatus,
};

type UserFormState = typeof emptyForm;

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canCreate = hasPermission('users:create');
  const canUpdate = hasPermission('users:update');
  const canDelete = hasPermission('users:delete');

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === form.roleId) ?? null,
    [form.roleId, roles],
  );

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

    const confirmed = window.confirm(`Деактивировать пользователя ${selectedUser.email}?`);

    if (!confirmed) {
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
        <button className="secondary-button secondary-button--fit" type="button" onClick={onBack}>
          Назад
        </button>
      </header>

      <section className="toolbar" aria-label="Фильтры пользователей">
        <input
          aria-label="Поиск пользователей"
          placeholder="Поиск по email или имени"
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
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
        <button
          className="primary-button primary-button--fit"
          disabled={!canCreate}
          type="button"
          onClick={startCreate}
        >
          Новый пользователь
        </button>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}

      <div className="users-layout">
        <section className="table-panel" aria-label="Список пользователей">
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
                  <th>Email</th>
                  <th>Имя</th>
                  <th>Роль</th>
                  <th>Статус</th>
                  <th>Создан</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={getUserRowClassName(user, selectedUser)}>
                    <td>{user.email}</td>
                    <td>{user.name ?? 'Нет'}</td>
                    <td>{user.role.name}</td>
                    <td>
                      <span className={`status-pill status-pill--${user.status.toLowerCase()}`}>
                        {statusLabels[user.status]}
                      </span>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>
                      <button className="text-button" type="button" onClick={() => startEdit(user)}>
                        Открыть
                      </button>
                    </td>
                  </tr>
                ))}

                {!isLoading && users.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <span className="empty-row">Пользователи не найдены</span>
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

        <section className="editor-panel" aria-labelledby="user-editor-title">
          <p className="eyebrow">{selectedUser ? 'Редактирование' : 'Создание'}</p>
          <h3 id="user-editor-title">{selectedUser ? selectedUser.email : 'Новый пользователь'}</h3>

          <form className="user-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              Email
              <input
                required
                autoComplete="email"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </label>

            <label>
              Имя
              <input
                autoComplete="name"
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>

            <label>
              Роль
              <select
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
            </label>

            <label>
              Статус
              <select
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
            </label>

            <label>
              Пароль
              <input
                required={!selectedUser}
                autoComplete="new-password"
                minLength={8}
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </label>

            {selectedRole ? (
              <p className="helper-text">
                Права: {selectedRole.permissions.length ? selectedRole.permissions.join(', ') : 'нет'}
              </p>
            ) : null}

            <div className="form-actions">
              <button
                className="primary-button primary-button--fit"
                disabled={isSubmitting || (!selectedUser && !canCreate) || (Boolean(selectedUser) && !canUpdate)}
                type="submit"
              >
                {selectedUser ? 'Сохранить' : 'Создать'}
              </button>
              {selectedUser?.status === 'DEACTIVATED' ? (
                <button
                  className="success-button"
                  disabled={isSubmitting || !canUpdate}
                  type="button"
                  onClick={() => void activateSelectedUser()}
                >
                  Активировать
                </button>
              ) : null}
              {selectedUser && selectedUser.status !== 'DEACTIVATED' ? (
                <button
                  className="danger-button"
                  disabled={isSubmitting || !canDelete || selectedUser.id === currentUser?.id}
                  type="button"
                  onClick={() => void deactivateSelectedUser()}
                >
                  Деактивировать
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

async function apiRequest<T = unknown>(path: string, accessToken: string, options: RequestInit = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await resolveErrorMessage(response));
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

async function resolveErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;

    return message || 'Запрос не выполнен';
  } catch {
    return 'Запрос не выполнен';
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
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
