import { FormEvent, useEffect, useRef, useState } from 'react';
import { MenuIcon } from 'lucide-react';
import { platformName, type AuthUser, type UserStatus } from '@platforma/shared';

import platformLogoUrl from '../../../_Fluffy_White_1-02.svg';
import { ImportAdminPage } from './admin/ImportAdminPage';
import { AdminButton, AdminPanel, AdminStatusBadge } from './admin/AdminUi';
import { ObjectsAdminPage } from './admin/ObjectsAdminPage';
import { UsersAdminPage } from './admin/UsersAdminPage';
import { apiRequest, apiUrl } from './admin/api';
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
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    if (!isSidebarOpen) {
      return;
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node) || !sidebarRef.current) {
        return;
      }

      if (sidebarRef.current.contains(event.target)) {
        return;
      }

      setIsSidebarOpen(false);
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown);

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
    };
  }, [isSidebarOpen]);

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
    <main className={isSidebarOpen ? 'app-shell app-shell--sidebar-open' : 'app-shell'}>
      <aside
        ref={sidebarRef}
        className={isSidebarOpen ? 'sidebar sidebar--open' : 'sidebar'}
        aria-label="Основная навигация"
      >
        <button
          className="sidebar-toggle"
          type="button"
          aria-controls="main-sidebar-content"
          aria-expanded={isSidebarOpen}
          aria-label={isSidebarOpen ? 'Свернуть меню' : 'Раскрыть меню'}
          onClick={() => setIsSidebarOpen((isOpen) => !isOpen)}
        >
          <MenuIcon aria-hidden="true" />
        </button>

        <div id="main-sidebar-content" className="sidebar-content" aria-hidden={!isSidebarOpen}>
          <div className="sidebar-brand">
            <img className="sidebar-logo" src={platformLogoUrl} alt="" aria-hidden="true" />
            <h1 className="sidebar-title">Платформа брокеров</h1>
          </div>

          <nav className="nav-list">
            {visibleNavItems.map((item) => (
              <button
                key={item.id}
                className={activeSection === item.section ? 'nav-item nav-item--active' : 'nav-item'}
                type="button"
                tabIndex={isSidebarOpen ? 0 : -1}
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <button
            className="secondary-button"
            type="button"
            tabIndex={isSidebarOpen ? 0 : -1}
            onClick={() => void logout()}
          >
            Выйти
          </button>
        </div>
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
  const { accessToken, user, updateUser } = useAuth();
  const [areSectionsVisible, setAreSectionsVisible] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profilePhotoFile, setProfilePhotoFile] = useState<File | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [isProfileSubmitting, setIsProfileSubmitting] = useState(false);
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [isPasswordSubmitting, setIsPasswordSubmitting] = useState(false);

  useEffect(() => {
    setProfileName(user?.name ?? '');
  }, [user?.id, user?.name]);

  if (!user) {
    return null;
  }

  const availableSections = getAvailableCabinetSections(user);

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      setProfileError('Сессия не найдена');
      return;
    }

    setProfileError(null);
    setProfileNotice(null);
    setIsProfileSubmitting(true);

    try {
      const data = await apiRequest<{ user: AuthUser }>('/users/me', accessToken, {
        method: 'PATCH',
        body: JSON.stringify({
          name: profileName,
        }),
      });

      updateUser(data.user);
      setProfileNotice('Имя обновлено');
    } catch (caughtError) {
      setProfileError(caughtError instanceof Error ? caughtError.message : 'Не удалось обновить профиль');
    } finally {
      setIsProfileSubmitting(false);
    }
  }

  async function handleProfilePhotoUpload() {
    if (!accessToken) {
      setProfileError('Сессия не найдена');
      return;
    }

    if (!profilePhotoFile) {
      setProfileError('Выберите изображение');
      return;
    }

    setProfileError(null);
    setProfileNotice(null);
    setIsPhotoUploading(true);

    try {
      const body = new FormData();
      body.append('file', profilePhotoFile);

      const data = await apiRequest<{ user: AuthUser }>('/users/me/profile-photo', accessToken, {
        method: 'POST',
        body,
      });

      updateUser(data.user);
      setProfilePhotoFile(null);
      setProfileNotice('Фото профиля обновлено');
    } catch (caughtError) {
      setProfileError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить фото');
    } finally {
      setIsPhotoUploading(false);
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      setPasswordError('Сессия не найдена');
      return;
    }

    if (newPassword !== newPasswordRepeat) {
      setPasswordError('Новый пароль и повтор не совпадают');
      return;
    }

    setPasswordError(null);
    setPasswordNotice(null);
    setIsPasswordSubmitting(true);

    try {
      const data = await apiRequest<{ user: AuthUser }>('/users/me/password', accessToken, {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      updateUser(data.user);
      setCurrentPassword('');
      setNewPassword('');
      setNewPasswordRepeat('');
      setPasswordNotice('Пароль обновлен');
    } catch (caughtError) {
      setPasswordError(caughtError instanceof Error ? caughtError.message : 'Не удалось обновить пароль');
    } finally {
      setIsPasswordSubmitting(false);
    }
  }

  return (
    <div className="cabinet-page">
      <section className="content-panel">
        <div className="cabinet-profile-header">
          <div className="cabinet-profile-identity">
            <ProfileAvatar accessToken={accessToken} user={user} />
            <div>
              <p className="eyebrow">Профиль</p>
              <h2>{user.name ?? user.email}</h2>
            </div>
          </div>
          <div className="cabinet-badges" aria-label="Роль и статус">
            <span className="role-pill">{user.role.name}</span>
            <span className={`status-pill status-pill--${user.status.toLowerCase()}`}>
              {userStatusLabels[user.status]}
            </span>
          </div>
        </div>

        <form className="profile-form" onSubmit={(event) => void handleProfileSubmit(event)}>
          <label>
            Имя
            <input
              autoComplete="name"
              name="name"
              type="text"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
            />
          </label>

          <button className="primary-button primary-button--fit" disabled={isProfileSubmitting} type="submit">
            {isProfileSubmitting ? 'Сохранение' : 'Сохранить имя'}
          </button>
        </form>

        <div className="profile-photo-form">
          <label>
            Фото профиля
            <input
              key={profilePhotoFile ? 'profile-photo-selected' : 'profile-photo-empty'}
              accept="image/jpeg,image/png,image/webp"
              type="file"
              onChange={(event) => setProfilePhotoFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button
            className="secondary-button secondary-button--fit"
            disabled={isPhotoUploading || !profilePhotoFile}
            type="button"
            onClick={() => void handleProfilePhotoUpload()}
          >
            {isPhotoUploading ? 'Загрузка' : 'Загрузить фото'}
          </button>
        </div>

        {profileError ? <p className="form-error">{profileError}</p> : null}
        {profileNotice ? <p className="form-notice">{profileNotice}</p> : null}

        <dl className="details-list">
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Роль</dt>
            <dd>{user.role.name}</dd>
          </div>
        </dl>
      </section>

      <section className="content-panel">
        <div className="cabinet-section-header">
          <div>
            <p className="eyebrow">Доступные разделы</p>
            <h2>Разделы для роли</h2>
          </div>

          <button
            aria-expanded={areSectionsVisible}
            className="secondary-button secondary-button--fit"
            type="button"
            onClick={() => setAreSectionsVisible((value) => !value)}
          >
            {areSectionsVisible ? 'Скрыть разделы' : `Показать разделы (${availableSections.length})`}
          </button>
        </div>

        {areSectionsVisible ? (
          availableSections.length ? (
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
          ) : (
            <p className="muted-text">Для текущей роли нет доступных разделов.</p>
          )
        ) : null}
      </section>

      <section className="content-panel">
        <p className="eyebrow">Безопасность</p>
        <h2>Смена пароля</h2>

        <form className="password-form" onSubmit={(event) => void handlePasswordSubmit(event)}>
          <label>
            Текущий пароль
            <input
              autoComplete="current-password"
              name="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>

          <label>
            Новый пароль
            <input
              autoComplete="new-password"
              name="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>

          <label>
            Повторите новый пароль
            <input
              autoComplete="new-password"
              name="new-password-repeat"
              type="password"
              value={newPasswordRepeat}
              onChange={(event) => setNewPasswordRepeat(event.target.value)}
            />
          </label>

          {passwordError ? <p className="form-error">{passwordError}</p> : null}
          {passwordNotice ? <p className="form-notice">{passwordNotice}</p> : null}

          <button className="primary-button primary-button--fit" disabled={isPasswordSubmitting} type="submit">
            {isPasswordSubmitting ? 'Сохранение' : 'Сменить пароль'}
          </button>
        </form>
      </section>
    </div>
  );
}

function ProfileAvatar({ accessToken, user }: { accessToken: string | null; user: AuthUser }) {
  const fallback = getProfileInitials(user);

  return (
    <div className="profile-avatar" aria-label="Фото профиля">
      {accessToken && user.profilePhotoFile ? (
        <SecureProfileImage accessToken={accessToken} alt={user.name ?? user.email} fallback={fallback} fileId={user.profilePhotoFile.id} />
      ) : (
        <span>{fallback}</span>
      )}
    </div>
  );
}

function SecureProfileImage({
  accessToken,
  alt,
  fallback,
  fileId,
}: {
  accessToken: string;
  alt: string;
  fallback: string;
  fileId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;

    async function loadImage() {
      const response = await fetch(`${apiUrl}/users/me/profile-photo/content?v=${encodeURIComponent(fileId)}`, {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return;
      }

      const blob = await response.blob();

      if (isCancelled) {
        return;
      }

      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }

    void loadImage();

    return () => {
      isCancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, fileId]);

  if (!src) {
    return <span>{fallback}</span>;
  }

  return <img alt={alt} src={src} />;
}

function getProfileInitials(user: AuthUser) {
  const source = (user.name ?? user.email).trim();
  const words = source.split(/\s+/u).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  return initials || 'P';
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
      description: 'Каталог, публикация, медиа и данные объектов.',
      tone: 'primary',
      canAccess: hasPermission('objects:read'),
      onClick: onOpenObjects,
    },
    {
      label: 'Пользователи',
      description: 'Роли, статусы и доступы сотрудников.',
      tone: 'secondary',
      canAccess: hasPermission('users:read'),
      onClick: onOpenUsers,
    },
    {
      label: 'Импорт',
      description: 'Preview, run и отчеты WordPress-импорта.',
      tone: 'secondary',
      canAccess: hasPermission('import:preview'),
      onClick: onOpenImport,
    },
  ].filter((action) => action.canAccess);

  return (
    <AdminPanel className="content-panel admin-home-panel">
      <div className="admin-home-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Панель управления</h2>
        </div>
        <AdminStatusBadge className="status-pill--active">Доступно</AdminStatusBadge>
      </div>
      <div className="admin-actions">
        {actions.length ? (
          actions.map((action) => (
            <article className="admin-action-card" key={action.label}>
              <div>
                <h3>{action.label}</h3>
                <p>{action.description}</p>
              </div>
              <AdminButton tone={action.tone === 'primary' ? 'primary' : 'secondary'} type="button" onClick={action.onClick}>
                Открыть
              </AdminButton>
            </article>
          ))
        ) : (
          <p className="muted-text">Для текущей роли нет доступных разделов админки.</p>
        )}
      </div>
    </AdminPanel>
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
