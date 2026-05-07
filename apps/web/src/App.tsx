import { FormEvent, useEffect, useState } from 'react';
import { platformName } from '@platforma/shared';

import { ImportAdminPage } from './admin/ImportAdminPage';
import { ObjectsAdminPage } from './admin/ObjectsAdminPage';
import { UsersAdminPage } from './admin/UsersAdminPage';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CatalogPage } from './catalog/CatalogPage';
import './styles.css';

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);

    window.addEventListener('popstate', handlePopState);

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return {
    pathname,
    navigate: (nextPathname: string) => {
      window.history.pushState(null, '', nextPathname);
      setPathname(nextPathname);
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

  const activeSection = pathname.startsWith('/admin')
    ? 'admin'
    : pathname.startsWith('/catalog')
      ? 'catalog'
      : 'cabinet';

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Основная навигация">
        <div>
          <p className="eyebrow">Closed platform</p>
          <h1>{platformName}</h1>
        </div>

        <nav className="nav-list">
          <button
            className={activeSection === 'cabinet' ? 'nav-item nav-item--active' : 'nav-item'}
            type="button"
            onClick={() => navigate('/cabinet')}
          >
            Кабинет
          </button>
          <button
            className={activeSection === 'catalog' ? 'nav-item nav-item--active' : 'nav-item'}
            type="button"
            onClick={() => navigate('/catalog')}
          >
            Каталог
          </button>
          <button
            className={activeSection === 'admin' ? 'nav-item nav-item--active' : 'nav-item'}
            type="button"
            onClick={() => navigate('/admin')}
          >
            Админка
          </button>
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
        ) : activeSection === 'catalog' ? (
          <CatalogPage />
        ) : (
          <CabinetHome />
        )}
      </section>
    </main>
  );
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

function CabinetHome() {
  const { user } = useAuth();

  return (
    <div className="content-panel">
      <p className="eyebrow">Профиль</p>
      <h2>{user?.name ?? user?.email}</h2>
      <dl className="details-list">
        <div>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
        </div>
        <div>
          <dt>Роль</dt>
          <dd>{user?.role.name}</dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>{user?.status}</dd>
        </div>
      </dl>
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

  return (
    <div className="content-panel">
      <p className="eyebrow">Админка</p>
      <h2>Панель управления</h2>
      <div className="admin-actions">
        <button
          className="primary-button primary-button--fit"
          disabled={!hasPermission('objects:read')}
          type="button"
          onClick={onOpenObjects}
        >
          Объекты
        </button>
        <button
          className="secondary-button secondary-button--fit"
          disabled={!hasPermission('users:read')}
          type="button"
          onClick={onOpenUsers}
        >
          Пользователи
        </button>
        <button
          className="secondary-button secondary-button--fit"
          disabled={!hasPermission('import:preview')}
          type="button"
          onClick={onOpenImport}
        >
          Импорт
        </button>
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
