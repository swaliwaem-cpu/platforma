import { FormEvent, useEffect, useState } from 'react';
import { platformName } from '@platforma/shared';
import type { AuthUser, UserStatus } from '@platforma/shared';

import { ImportAdminPage } from './admin/ImportAdminPage';
import { ObjectsAdminPage } from './admin/ObjectsAdminPage';
import { UsersAdminPage } from './admin/UsersAdminPage';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CatalogPage } from './catalog/CatalogPage';
import { ObjectDetailPage } from './objects/ObjectDetailPage';
import './styles.css';

type AppSection = 'cabinet' | 'catalog' | 'admin';

const userStatusLabels: Record<UserStatus, string> = {
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  INVITED: 'Приглашён',
  DEACTIVATED: 'Отключён',
};

const navItems = [
  {
    id: 'cabinet',
    label: 'Кабинет',
    path: '/cabinet',
    section: 'cabinet',
    requiredPermissions: [],
  },
  {
    id: 'catalog',
    label: 'Каталог',
    path: '/catalog',
    section: 'catalog',
    requiredPermissions: ['objects:read'],
  },
  {
    id: 'admin',
    label: 'Админка',
    path: '/admin',
    section: 'admin',
    requiredPermissions: ['admin:access'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  path: string;
  section: AppSection;
  requiredPermissions: readonly string[];
}>;

const cabinetSections = [
  {
    id: 'profile',
    label: 'Профиль',
    group: 'Кабинет',
    path: '/cabinet',
    requiredPermissions: [],
  },
  {
    id: 'catalog',
    label: 'Каталог объектов',
    group: 'Каталог',
    path: '/catalog',
    requiredPermissions: ['objects:read'],
  },
  {
    id: 'catalog-map',
    label: 'Карта каталога',
    group: 'Каталог',
    path: '/catalog/map',
    requiredPermissions: ['objects:read'],
  },
  {
    id: 'admin-objects',
    label: 'Управление объектами',
    group: 'Админка',
    path: '/admin/objects',
    requiredPermissions: ['admin:access', 'objects:read'],
  },
  {
    id: 'admin-users',
    label: 'Пользователи',
    group: 'Админка',
    path: '/admin/users',
    requiredPermissions: ['admin:access', 'users:read'],
  },
  {
    id: 'admin-import',
    label: 'Импорт WordPress',
    group: 'Админка',
    path: '/admin/import',
    requiredPermissions: ['admin:access', 'import:preview'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  group: string;
  path: string;
  requiredPermissions: readonly string[];
}>;

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    const handleDocumentClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      if (!(event.target instanceof Element)) {
        return;
      }

      const link = event.target.closest('a[href]');

      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self')) {
        return;
      }

      const url = new URL(link.href);

      if (url.origin !== window.location.origin || !isAppRoute(url.pathname)) {
        return;
      }

      event.preventDefault();
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setPathname(window.location.pathname);
    };

    window.addEventListener('popstate', handlePopState);
    document.addEventListener('click', handleDocumentClick);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('click', handleDocumentClick);
    };
  }, []);

  return {
    pathname,
    navigate: (nextPathname: string) => {
      window.history.pushState(null, '', nextPathname);
      setPathname(window.location.pathname);
    },
  };
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

function AppRoutes() {
  const { pathname, navigate } = usePathname();
  const { user, isLoading, logout, hasPermission } = useAuth();

  if (isLoading) {
    return <main className="app-shell app-shell--center">Загрузка</main>;
  }

  if (pathname === '/login') {
    return <LoginPage onSuccess={() => navigate('/cabinet')} />;
  }

  if (!user) {
    return <LoginPage onSuccess={() => navigate(pathname === '/' ? '/cabinet' : pathname)} />;
  }

  const activeSection: AppSection = pathname.startsWith('/admin')
    ? 'admin'
    : pathname.startsWith('/catalog') || pathname.startsWith('/objects/')
      ? 'catalog'
      : 'cabinet';
  const objectSlug = parseObjectSlug(pathname);
  const visibleNavItems = navItems.filter(
    (item) => canShowNavItem(item, user) && canAccessPermissions(hasPermission, item.requiredPermissions),
  );

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Основная навигация" tabIndex={0}>
        <div className="sidebar-handle" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div>
          <p className="eyebrow">Closed platform</p>
          <h1>{platformName}</h1>
        </div>

        <nav className="nav-list">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              className={activeSection === item.section ? 'nav-item nav-item--active' : 'nav-item'}
              type="button"
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <button className="secondary-button" type="button" onClick={() => void logout()}>
          Выйти
        </button>
      </aside>

      <section className="workspace">
        {activeSection === 'admin' ? (
          hasPermission('admin:access') ? (
            pathname.startsWith('/admin/users') ? (
              hasPermission('users:read') ? (
                <UsersAdminPage onBack={() => navigate('/admin')} />
              ) : (
                <AccessDenied />
              )
            ) : pathname.startsWith('/admin/objects') ? (
              hasPermission('objects:read') ? (
                <ObjectsAdminPage pathname={pathname} navigate={navigate} onBack={() => navigate('/admin')} />
              ) : (
                <AccessDenied />
              )
            ) : pathname.startsWith('/admin/import') ? (
              hasPermission('import:preview') ? (
                <ImportAdminPage onBack={() => navigate('/admin')} />
              ) : (
                <AccessDenied />
              )
            ) : (
              <AdminHome
                onOpenImport={() => navigate('/admin/import')}
                onOpenObjects={() => navigate('/admin/objects')}
                onOpenUsers={() => navigate('/admin/users')}
              />
            )
          ) : (
            <AccessDenied />
          )
        ) : objectSlug ? (
          hasPermission('objects:read') ? (
            <ObjectDetailPage slug={objectSlug} onBack={() => navigate('/catalog')} />
          ) : (
            <AccessDenied />
          )
        ) : activeSection === 'catalog' ? (
          hasPermission('objects:read') ? (
            <CatalogPage navigate={navigate} pathname={pathname} />
          ) : (
            <AccessDenied />
          )
        ) : (
          <CabinetHome navigate={navigate} />
        )}
      </section>
    </main>
  );
}

function isAppRoute(pathname: string) {
  return (
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/cabinet' ||
    pathname === '/catalog' ||
    pathname.startsWith('/catalog/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/objects/')
  );
}

function parseObjectSlug(pathname: string) {
  const match = pathname.match(/^\/objects\/([^/]+)\/?$/u);

  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email, password);
      onSuccess();
    } catch {
      setError('Проверьте email и пароль');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">Closed platform</p>
        <h1 id="login-title">{platformName}</h1>

        <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Email
            <input
              autoComplete="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label>
            Пароль
            <input
              autoComplete="current-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Вход' : 'Войти'}
          </button>
        </form>
      </section>
    </main>
  );
}

function CabinetHome({ navigate }: { navigate: (nextPathname: string) => void }) {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  const availableSections = getAvailableCabinetSections(user);

  return (
    <div className="cabinet-page">
      <section className="content-panel">
        <div className="cabinet-profile-header">
          <div>
            <p className="eyebrow">Профиль</p>
            <h2>{user.name ?? user.email}</h2>
          </div>
          <div className="cabinet-badges" aria-label="Роль и статус">
            <span className="role-pill">{user.role.name}</span>
            <span className={`status-pill status-pill--${user.status.toLowerCase()}`}>
              {userStatusLabels[user.status]}
            </span>
          </div>
        </div>

        <dl className="details-list">
          <div>
            <dt>Имя</dt>
            <dd>{user.name ?? 'Не указано'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Роль</dt>
            <dd>{user.role.name}</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>{userStatusLabels[user.status]}</dd>
          </div>
        </dl>
      </section>

      <section className="content-panel">
        <p className="eyebrow">Доступные разделы</p>
        <h2>Разделы для роли</h2>

        <ul className="cabinet-section-list">
          {availableSections.map((section) => (
            <li key={section.id}>
              <div className="cabinet-section-main">
                <strong>{section.label}</strong>
                <span>{section.group}</span>
                {section.requiredPermissions.length ? (
                  <div className="permission-chip-list" aria-label="Права">
                    {section.requiredPermissions.map((permission) => (
                      <span className="permission-chip" key={permission}>
                        {permission}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <button
                className="secondary-button secondary-button--fit"
                type="button"
                onClick={() => navigate(section.path)}
              >
                Открыть
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function AdminHome({
  onOpenImport,
  onOpenObjects,
  onOpenUsers,
}: {
  onOpenImport: () => void;
  onOpenObjects: () => void;
  onOpenUsers: () => void;
}) {
  const { hasPermission } = useAuth();
  const actions = [
    {
      label: 'Объекты',
      className: 'primary-button primary-button--fit',
      canAccess: hasPermission('objects:read'),
      onClick: onOpenObjects,
    },
    {
      label: 'Пользователи',
      className: 'secondary-button secondary-button--fit',
      canAccess: hasPermission('users:read'),
      onClick: onOpenUsers,
    },
    {
      label: 'Импорт',
      className: 'secondary-button secondary-button--fit',
      canAccess: hasPermission('import:preview'),
      onClick: onOpenImport,
    },
  ].filter((action) => action.canAccess);

  return (
    <div className="content-panel">
      <p className="eyebrow">Админка</p>
      <h2>Панель управления</h2>
      <div className="admin-actions">
        {actions.length ? (
          actions.map((action) => (
            <button className={action.className} key={action.label} type="button" onClick={action.onClick}>
              {action.label}
            </button>
          ))
        ) : (
          <p className="muted-text">Для текущей роли нет доступных разделов админки.</p>
        )}
      </div>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="content-panel">
      <p className="eyebrow">Доступ</p>
      <h2>Недостаточно прав</h2>
      <p className="muted-text">Текущая роль не открывает этот раздел.</p>
    </div>
  );
}

function canAccessPermissions(
  hasPermission: (permission: string) => boolean,
  requiredPermissions: readonly string[],
) {
  return requiredPermissions.every((permission) => hasPermission(permission));
}

function canShowNavItem(item: (typeof navItems)[number], user: AuthUser) {
  return !(user.role.name === 'user' && item.id === 'cabinet');
}

function getAvailableCabinetSections(user: AuthUser) {
  const permissions = new Set(user.permissions);

  return cabinetSections.filter((section) =>
    section.requiredPermissions.every((permission) => permissions.has(permission)),
  );
}
