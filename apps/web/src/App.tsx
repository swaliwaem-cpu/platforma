import { FormEvent, useEffect, useRef, useState } from 'react';
import { MenuIcon, MoonIcon, SunIcon } from 'lucide-react';
import type { AuthUser, UserStatus } from '@platforma/shared';

import platformLogoUrl from '../../../_Fluffy_White_1-02.svg';
import { CatalogLinksAdminPage } from './admin/CatalogLinksAdminPage';
import { FeedsAdminPage } from './admin/FeedsAdminPage';
import { ImportAdminPage } from './admin/ImportAdminPage';
import { AdminButton, AdminPanel, AdminStatusBadge } from './admin/AdminUi';
import { ObjectsAdminPage } from './admin/ObjectsAdminPage';
import { UsersAdminPage } from './admin/UsersAdminPage';
import { apiRequest } from './admin/api';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CatalogPage } from './catalog/CatalogPage';
import { buildMediaFileContentUrl } from './files/SecureImage';
import { ObjectDetailPage, ObjectLotDetailPage } from './objects/ObjectDetailPage';
import { LotPresentationsPage } from './presentations/LotPresentationsPage';
import { canAccessLotPresentations, canAccessProjectPresentations } from './presentations/presentationAccess';
import { ProjectPresentationEditorPage } from './presentations/projects/ProjectPresentationEditorPage';
import { ProjectPresentationsPage } from './presentations/projects/ProjectPresentationsPage';
import { getAppliedAppTheme, getNextAppTheme, setAppTheme } from './appTheme';
import './styles.css';
import './app-theme.css';

type AppSection = 'cabinet' | 'catalog' | 'presentations' | 'admin';
type LoginMode = 'login' | 'register';
type NavChildItem = {
  id: string;
  label: string;
  path: string;
};
type NavItem = {
  id: string;
  label: string;
  path: string;
  section: AppSection;
  requiredPermissions: readonly string[];
  children?: readonly NavChildItem[];
};
type CabinetSection = {
  id: string;
  label: string;
  group: string;
  path: string;
  requiredPermissions: readonly string[];
};

const userStatusLabels: Record<UserStatus, string> = {
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  INVITED: 'Приглашён',
  DEACTIVATED: 'Отключён',
};

const navItems: readonly NavItem[] = [
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
    children: [
      {
        id: 'catalog-life',
        label: 'Жилая',
        path: '/catalog/life',
      },
      {
        id: 'catalog-comm',
        label: 'Коммерция',
        path: '/catalog/comm',
      },
      {
        id: 'catalog-all',
        label: 'Все',
        path: '/catalog',
      },
    ],
  },
  {
    id: 'presentations',
    label: 'Подборки',
    path: '/presentations',
    section: 'presentations',
    requiredPermissions: [],
  },
  {
    id: 'admin',
    label: 'Админка',
    path: '/admin',
    section: 'admin',
    requiredPermissions: ['admin:access'],
  },
];

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
    id: 'presentations',
    label: 'Подборки лотов',
    group: 'Презентации',
    path: '/presentations',
    requiredPermissions: [],
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
    id: 'admin-catalog-links',
    label: 'Ссылки каталога',
    group: 'Админка',
    path: '/admin/catalog-links',
    requiredPermissions: ['admin:access', 'objects:update'],
  },
  {
    id: 'admin-feeds',
    label: 'Фиды',
    group: 'Админка',
    path: '/admin/feeds',
    requiredPermissions: ['admin:access', 'feeds:read'],
  },
  {
    id: 'admin-import',
    label: 'Импорт WordPress',
    group: 'Админка',
    path: '/admin/import',
    requiredPermissions: ['admin:access', 'import:preview'],
  },
] as const satisfies readonly CabinetSection[];

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
  const [appTheme, setAppThemeState] = useState(() => getAppliedAppTheme());
  const isDarkTheme = appTheme === 'dark-premium';
  const themeToggleLabel = isDarkTheme ? 'Включить светлую тему' : 'Включить темную тему';

  const handleThemeToggle = () => {
    const nextTheme = getNextAppTheme(appTheme);

    setAppTheme(nextTheme);
    setAppThemeState(nextTheme);
  };

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
    : pathname.startsWith('/presentations')
      ? 'presentations'
    : pathname.startsWith('/catalog') || pathname.startsWith('/objects/')
      ? 'catalog'
      : 'cabinet';
  const objectLotRoute = parseObjectLotRoute(pathname);
  const objectSlug = objectLotRoute ? null : parseObjectSlug(pathname);
  const projectPresentationRoute = parseProjectPresentationRoute(pathname);
  const visibleNavItems = navItems.filter((item) => canAccessNavigationItem(hasPermission, item));

  return (
    <main className="app-shell">
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

          <button
            className="theme-toggle"
            type="button"
            aria-label={themeToggleLabel}
            title={themeToggleLabel}
            tabIndex={isSidebarOpen ? 0 : -1}
            onClick={handleThemeToggle}
          >
            {isDarkTheme ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
          </button>

          <nav className="nav-list">
            {visibleNavItems.map((item) =>
              item.children?.length ? (
                <div className="nav-group" key={item.id}>
                  <button
                    aria-haspopup="menu"
                    className={activeSection === item.section ? 'nav-item nav-item--active' : 'nav-item'}
                    type="button"
                    tabIndex={isSidebarOpen ? 0 : -1}
                    onClick={() => navigate(item.path)}
                  >
                    {item.label}
                  </button>
                  <div className="nav-submenu" role="menu" aria-label="Разделы каталога">
                    {item.children.map((child) => (
                      <button
                        key={child.id}
                        className={pathname === child.path ? 'nav-subitem nav-subitem--active' : 'nav-subitem'}
                        role="menuitem"
                        type="button"
                        tabIndex={isSidebarOpen ? 0 : -1}
                        onClick={() => navigate(child.path)}
                      >
                        {child.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  key={item.id}
                  className={activeSection === item.section ? 'nav-item nav-item--active' : 'nav-item'}
                  type="button"
                  tabIndex={isSidebarOpen ? 0 : -1}
                  onClick={() => navigate(getNavigationPath(user, item))}
                >
                  {item.label}
                </button>
              ),
            )}
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
            ) : pathname.startsWith('/admin/catalog-links') ? (
              hasPermission('objects:update') ? (
                <CatalogLinksAdminPage onBack={() => navigate('/admin')} />
              ) : (
                <AccessDenied />
              )
            ) : pathname.startsWith('/admin/feeds') ? (
              hasPermission('feeds:read') ? (
                <FeedsAdminPage pathname={pathname} navigate={navigate} onBack={() => navigate('/admin')} />
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
                onOpenCatalogLinks={() => navigate('/admin/catalog-links')}
                onOpenFeeds={() => navigate('/admin/feeds')}
                onOpenImport={() => navigate('/admin/import')}
                onOpenObjects={() => navigate('/admin/objects')}
                onOpenUsers={() => navigate('/admin/users')}
              />
            )
          ) : (
            <AccessDenied />
          )
        ) : objectLotRoute ? (
          hasPermission('objects:read') ? (
            <ObjectLotDetailPage
              navigate={navigate}
              slug={objectLotRoute.slug}
              unitId={objectLotRoute.unitId}
              onBack={() => navigate(`/objects/${encodeURIComponent(objectLotRoute.slug)}`)}
            />
          ) : (
            <AccessDenied />
          )
        ) : objectSlug ? (
          hasPermission('objects:read') ? (
            <ObjectDetailPage navigate={navigate} slug={objectSlug} onBack={() => navigate('/catalog')} />
          ) : (
            <AccessDenied />
          )
        ) : activeSection === 'presentations' ? (
          projectPresentationRoute ? (
            canAccessProjectPresentations(user) ? (
              projectPresentationRoute.kind === 'list' ? (
                <ProjectPresentationsPage navigate={navigate} />
              ) : (
                <ProjectPresentationEditorPage
                  draftId={projectPresentationRoute.kind === 'draft' ? projectPresentationRoute.draftId : null}
                  navigate={navigate}
                />
              )
            ) : (
              <AccessDenied />
            )
          ) : canAccessLotPresentations(user) ? (
            <LotPresentationsPage navigate={navigate} />
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
    pathname === '/presentations' ||
    pathname.startsWith('/presentations/') ||
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

function parseObjectLotRoute(pathname: string) {
  const match = pathname.match(/^\/objects\/([^/]+)\/lots\/([^/]+)\/?$/u);

  if (!match?.[1] || !match[2]) {
    return null;
  }

  try {
    return {
      slug: decodeURIComponent(match[1]),
      unitId: decodeURIComponent(match[2]),
    };
  } catch {
    return {
      slug: match[1],
      unitId: match[2],
    };
  }
}

function parseProjectPresentationRoute(pathname: string) {
  if (/^\/presentations\/projects\/?$/u.test(pathname)) {
    return { kind: 'list' as const };
  }

  if (/^\/presentations\/projects\/new\/?$/u.test(pathname)) {
    return { kind: 'new' as const };
  }

  const match = pathname.match(/^\/presentations\/projects\/([^/]+)\/?$/u);

  if (!match?.[1]) {
    return null;
  }

  try {
    return { kind: 'draft' as const, draftId: decodeURIComponent(match[1]) };
  } catch {
    return { kind: 'draft' as const, draftId: match[1] };
  }
}

function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const { login, requestEmailRegistration, verifyEmailRegistration } = useAuth();
  const [mode, setMode] = useState<LoginMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [registrationAuthToken, setRegistrationAuthToken] = useState<string | null>(null);
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [registrationPasswordConfirmation, setRegistrationPasswordConfirmation] = useState('');
  const [isRegistrationRequestSent, setIsRegistrationRequestSent] = useState(false);
  const [showRegistrationPassword, setShowRegistrationPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const registrationActivationHandledRef = useRef(false);

  useEffect(() => {
    if (registrationActivationHandledRef.current) {
      return;
    }

    const token = new URLSearchParams(window.location.search).get('auth_token');

    if (!token) {
      return;
    }

    const activationToken = token;

    registrationActivationHandledRef.current = true;
    setMode('register');
    setRegistrationAuthToken(activationToken);
    setRegistrationPassword('');
    setRegistrationPasswordConfirmation('');
    setIsRegistrationRequestSent(false);
    setError(null);
    setNotice('Подтверждаем регистрацию');

    async function activateRegistration() {
      setIsSubmitting(true);

      try {
        await verifyEmailRegistration({ token: activationToken });
        onSuccess();
      } catch {
        setRegistrationAuthToken(null);
        setError('Ссылка подтверждения недействительна или устарела. Запросите письмо еще раз.');
      } finally {
        setIsSubmitting(false);
      }
    }

    void activateRegistration();
  }, [onSuccess, verifyEmailRegistration]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    try {
      if (mode === 'login') {
        setIsSubmitting(true);
        await login(email, password);
        onSuccess();
        return;
      }

      if (registrationAuthToken) {
        return;
      }

      const passwordError = getRegistrationPasswordError(registrationPassword, registrationPasswordConfirmation);

      if (passwordError) {
        setError(passwordError);
        return;
      }

      setIsSubmitting(true);
      await requestEmailRegistration({
        email: registrationEmail,
        password: registrationPassword,
        passwordConfirmation: registrationPasswordConfirmation,
      });
      setIsRegistrationRequestSent(true);
      setNotice('Письмо отправлено. Перейдите по ссылке из письма, чтобы активировать аккаунт.');
    } catch {
      setError(mode === 'login' ? 'Проверьте email и пароль' : 'Не удалось отправить письмо. Проверьте email и пароль');
    } finally {
      setIsSubmitting(false);
    }
  }

  function selectMode(nextMode: LoginMode) {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setRegistrationAuthToken(null);
    setRegistrationPassword('');
    setRegistrationPasswordConfirmation('');
    setIsRegistrationRequestSent(false);
  }

  function handleRegistrationEmailChange(value: string) {
    setRegistrationEmail(value);
    setRegistrationAuthToken(null);
    setRegistrationPassword('');
    setRegistrationPasswordConfirmation('');
    setIsRegistrationRequestSent(false);
    setNotice(null);
  }

  function handleRegistrationPasswordChange(value: string) {
    setRegistrationPassword(value);
    setIsRegistrationRequestSent(false);
    setNotice(null);
  }

  function handleRegistrationPasswordConfirmationChange(value: string) {
    setRegistrationPasswordConfirmation(value);
    setIsRegistrationRequestSent(false);
    setNotice(null);
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">Платформа брокеров</p>
        <h1 id="login-title">FluffyWhite</h1>

        <div className="login-mode-toggle" aria-label="Способ входа">
          <button
            className={mode === 'login' ? 'login-mode-button login-mode-button--active' : 'login-mode-button'}
            type="button"
            aria-pressed={mode === 'login'}
            onClick={() => selectMode('login')}
          >
            Вход
          </button>
          <button
            className={mode === 'register' ? 'login-mode-button login-mode-button--active' : 'login-mode-button'}
            type="button"
            aria-pressed={mode === 'register'}
            onClick={() => selectMode('register')}
          >
            Регистрация
          </button>
        </div>

        <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
          {mode === 'login' ? (
            <>
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
            </>
          ) : (
            <>
              {registrationAuthToken ? (
                <p className="helper-text">Активируем аккаунт по ссылке из письма.</p>
              ) : (
                <>
                <label>
                  Введите ваш email
                  <input
                    autoComplete="email"
                    name="registration-email"
                    type="email"
                    value={registrationEmail}
                    onChange={(event) => handleRegistrationEmailChange(event.target.value)}
                  />
                </label>

                <div className="registration-password-panel" role="group" aria-labelledby="registration-password-title">
                  <p id="registration-password-title" className="registration-password-title">
                    Пароль для входа
                  </p>
                  <p className="helper-text">
                    Пароль должен быть от 8 символов, на английском языке, с заглавной буквой и спецсимволом.
                  </p>
                  <div className="registration-password-grid">
                    <label>
                      Придумайте пароль
                      <input
                        autoComplete="new-password"
                        name="registration-password"
                        type={showRegistrationPassword ? 'text' : 'password'}
                        value={registrationPassword}
                        onChange={(event) => handleRegistrationPasswordChange(event.target.value)}
                      />
                    </label>
                    <label>
                      Подтвердите пароль
                      <input
                        autoComplete="new-password"
                        name="registration-password-confirmation"
                        type={showRegistrationPassword ? 'text' : 'password'}
                        value={registrationPasswordConfirmation}
                        onChange={(event) => handleRegistrationPasswordConfirmationChange(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="password-visibility-toggle">
                    <input
                      checked={showRegistrationPassword}
                      type="checkbox"
                      onChange={(event) => setShowRegistrationPassword(event.target.checked)}
                    />
                    <span>Показать пароль</span>
                  </label>
                </div>
                </>
              )}
            </>
          )}

          {error ? <p className="form-error">{error}</p> : null}
          {notice ? <p className="form-notice">{notice}</p> : null}

          <button className="primary-button" disabled={isSubmitting || Boolean(registrationAuthToken)} type="submit">
            {isSubmitting
              ? mode === 'login'
                ? 'Вход'
                : registrationAuthToken
                  ? 'Подтверждение'
                  : 'Отправка'
              : mode === 'login'
                ? 'Войти'
                : isRegistrationRequestSent
                  ? 'Отправить письмо еще раз'
                  : 'Зарегистрироваться'}
          </button>
        </form>
      </section>
    </main>
  );
}

function getRegistrationPasswordError(password: string, passwordConfirmation: string) {
  if (password !== passwordConfirmation) {
    return 'Пароли не совпадают';
  }

  if (!isValidRegistrationPassword(password)) {
    return 'Пароль должен быть от 8 символов, на английском языке, с заглавной буквой и спецсимволом';
  }

  return null;
}

function isValidRegistrationPassword(password: string) {
  return (
    password.length >= 8 &&
    /^[\x21-\x7E]+$/.test(password) &&
    /[A-Z]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function CabinetHome({ navigate }: { navigate: (nextPathname: string) => void }) {
  const { accessToken, user, updateUser } = useAuth();
  const [areSectionsVisible, setAreSectionsVisible] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [brokerPhone, setBrokerPhone] = useState('');
  const [brokerEmail, setBrokerEmail] = useState('');
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
    setBrokerPhone(user?.brokerPhone ?? '');
    setBrokerEmail(user?.brokerEmail ?? '');
  }, [user?.brokerEmail, user?.brokerPhone, user?.id, user?.name]);

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
          brokerPhone,
          brokerEmail,
        }),
      });

      updateUser(data.user);
      setProfileNotice('Профиль обновлен');
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

          <label>
            Телефон брокера
            <input
              autoComplete="tel"
              name="brokerPhone"
              placeholder="+7 999 000-00-00"
              type="tel"
              value={brokerPhone}
              onChange={(event) => setBrokerPhone(event.target.value)}
            />
          </label>

          <label>
            Почта брокера
            <input
              autoComplete="email"
              name="brokerEmail"
              placeholder="broker@example.com"
              type="email"
              value={brokerEmail}
              onChange={(event) => setBrokerEmail(event.target.value)}
            />
          </label>

          <button className="primary-button primary-button--fit" disabled={isProfileSubmitting} type="submit">
            {isProfileSubmitting ? 'Сохранение' : 'Сохранить профиль'}
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
            <dt>Телефон брокера</dt>
            <dd>{user.brokerPhone ?? 'Не заполнен'}</dd>
          </div>
          <div>
            <dt>Почта брокера</dt>
            <dd>{user.brokerEmail ?? 'Не заполнена'}</dd>
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
                    <strong>{section.id === 'presentations' && canAccessProjectPresentations(user) ? 'Презентации ЖК' : section.label}</strong>
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
                    onClick={() => navigate(getCabinetSectionPath(user, section))}
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
  const [hasError, setHasError] = useState(false);
  const src = buildMediaFileContentUrl(fileId, 'thumbnail');

  useEffect(() => {
    setHasError(false);
  }, [accessToken, fileId]);

  if (hasError) {
    return <span>{fallback}</span>;
  }

  return <img alt={alt} src={src} onError={() => setHasError(true)} />;
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
  onOpenCatalogLinks,
  onOpenFeeds,
  onOpenImport,
  onOpenObjects,
  onOpenUsers,
}: {
  onOpenCatalogLinks: () => void;
  onOpenFeeds: () => void;
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
      label: 'Ссылки каталога',
      description: 'Быстрые переходы для главной выдачи каталога.',
      tone: 'secondary',
      canAccess: hasPermission('objects:update'),
      onClick: onOpenCatalogLinks,
    },
    {
      label: 'Фиды',
      description: 'Источники застройщиков, отчёты запусков и импортированные лоты.',
      tone: 'secondary',
      canAccess: hasPermission('feeds:read'),
      onClick: onOpenFeeds,
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

function getNavigationPath(user: AuthUser, item: NavItem) {
  return item.id === 'presentations' && canAccessProjectPresentations(user)
    ? '/presentations/projects'
    : item.path;
}

function getCabinetSectionPath(user: AuthUser, section: CabinetSection) {
  return section.id === 'presentations' && canAccessProjectPresentations(user)
    ? '/presentations/projects'
    : section.path;
}

function canAccessNavigationItem(hasPermission: (permission: string) => boolean, item: Pick<NavItem, 'requiredPermissions'>) {
  return canAccessPermissions(hasPermission, item.requiredPermissions);
}

function canAccessCabinetSection(user: AuthUser, section: CabinetSection) {
  const permissions = new Set(user.permissions);

  return section.requiredPermissions.every((permission) => permissions.has(permission));
}

function getAvailableCabinetSections(user: AuthUser) {
  return cabinetSections.filter((section) => canAccessCabinetSection(user, section));
}
