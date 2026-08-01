import { AdminButton, AdminPanel } from '../admin/AdminUi';
import { TrainingAdminAttemptPage } from './TrainingAdminAttemptPage';
import { TrainingAdminProjectEditorPage } from './TrainingAdminProjectEditorPage';
import { TrainingAdminProjectsPage } from './TrainingAdminProjectsPage';
import { TrainingAttemptPage } from './TrainingAttemptPage';
import { TrainingProjectsPage } from './TrainingProjectsPage';
import './training.css';

type TrainingRoutesProps = {
  pathname: string;
  navigate: (pathname: string) => void;
};

export function TrainingEmployeeRoutes({ pathname, navigate }: TrainingRoutesProps) {
  if (/^\/training\/?$/u.test(pathname)) {
    return <TrainingProjectsPage navigate={navigate} />;
  }

  const attemptId = parseRouteId(pathname, /^\/training\/attempts\/([^/]+)\/?$/u);

  return attemptId
    ? <TrainingAttemptPage key={attemptId} attemptId={attemptId} navigate={navigate} />
    : <TrainingRouteNotFound navigate={navigate} fallback="/training" />;
}

export function TrainingAdminRoutes({
  pathname,
  navigate,
  canManageProjects,
  canReadResults,
}: TrainingRoutesProps & { canManageProjects: boolean; canReadResults: boolean }) {
  if (/^\/admin\/training\/?$/u.test(pathname)) {
    return (
      <TrainingAdminProjectsPage
        canManageProjects={canManageProjects}
        canReadResults={canReadResults}
        navigate={navigate}
      />
    );
  }

  const projectId = parseRouteId(
    pathname,
    /^\/admin\/training\/projects\/([^/]+)\/?$/u,
  );

  if (projectId) {
    return canManageProjects
      ? <TrainingAdminProjectEditorPage key={projectId} projectId={projectId} navigate={navigate} />
      : <TrainingRouteDenied />;
  }

  const attemptId = parseRouteId(
    pathname,
    /^\/admin\/training\/attempts\/([^/]+)\/?$/u,
  );

  if (attemptId) {
    return canReadResults
      ? <TrainingAdminAttemptPage key={attemptId} attemptId={attemptId} navigate={navigate} />
      : <TrainingRouteDenied />;
  }

  return <TrainingRouteNotFound navigate={navigate} fallback="/admin/training" />;
}

function TrainingRouteDenied() {
  return (
    <AdminPanel className="training-route-message">
      <p className="eyebrow">Доступ</p>
      <h2>Недостаточно прав</h2>
      <p className="muted-text">Текущая роль не открывает этот Training-раздел.</p>
    </AdminPanel>
  );
}

function TrainingRouteNotFound({
  navigate,
  fallback,
}: {
  navigate: (pathname: string) => void;
  fallback: string;
}) {
  return (
    <AdminPanel className="training-route-message">
      <p className="eyebrow">Обучение</p>
      <h2>Страница не найдена</h2>
      <AdminButton type="button" onClick={() => navigate(fallback)}>Вернуться</AdminButton>
    </AdminPanel>
  );
}

function parseRouteId(pathname: string, pattern: RegExp) {
  const value = pathname.match(pattern)?.[1];

  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
