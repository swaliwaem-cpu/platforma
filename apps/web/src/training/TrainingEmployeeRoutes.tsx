import { AdminButton, AdminPanel } from '../admin/AdminUi';
import { TrainingAttemptPage } from './TrainingAttemptPage';
import { TrainingProjectsPage } from './TrainingProjectsPage';
import type { TrainingRoutesProps } from './TrainingRoutes';
import './training.css';

export function TrainingEmployeeRoutes({ pathname, navigate }: TrainingRoutesProps) {
  if (/^\/training\/?$/u.test(pathname)) {
    return <TrainingProjectsPage navigate={navigate} />;
  }

  const attemptId = parseRouteId(pathname, /^\/training\/attempts\/([^/]+)\/?$/u);

  return attemptId
    ? <TrainingAttemptPage key={attemptId} attemptId={attemptId} navigate={navigate} />
    : <TrainingRouteNotFound navigate={navigate} />;
}

function TrainingRouteNotFound({
  navigate,
}: {
  navigate: (pathname: string) => void;
}) {
  return (
    <AdminPanel className="training-route-message">
      <p className="eyebrow">Обучение</p>
      <h2>Страница не найдена</h2>
      <AdminButton type="button" onClick={() => navigate('/training')}>Вернуться</AdminButton>
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
