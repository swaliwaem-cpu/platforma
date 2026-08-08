import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from 'react';

import { AdminButton, AdminPanel } from '../admin/AdminUi';

export type TrainingRoutesProps = {
  pathname: string;
  navigate: (pathname: string) => void;
};

type TrainingAdminRoutesProps = TrainingRoutesProps & {
  canManageProjects: boolean;
  canReadResults: boolean;
  canReviewResults: boolean;
  canReadAudio: boolean;
  canDeleteFiles: boolean;
};

const TrainingEmployeeRoutesChunk = lazy(() =>
  import('./TrainingEmployeeRoutes').then((module) => ({
    default: module.TrainingEmployeeRoutes,
  })),
);

const TrainingAdminRoutesChunk = lazy(() =>
  import('./TrainingAdminRoutes').then((module) => ({
    default: module.TrainingAdminRoutes,
  })),
);

export function TrainingEmployeeRoutes(props: TrainingRoutesProps) {
  return (
    <TrainingRouteChunkBoundary pathname={props.pathname}>
      <Suspense fallback={<TrainingRouteLoading />}>
        <TrainingEmployeeRoutesChunk {...props} />
      </Suspense>
    </TrainingRouteChunkBoundary>
  );
}

export function TrainingAdminRoutes(props: TrainingAdminRoutesProps) {
  return (
    <TrainingRouteChunkBoundary pathname={props.pathname}>
      <Suspense fallback={<TrainingRouteLoading />}>
        <TrainingAdminRoutesChunk {...props} />
      </Suspense>
    </TrainingRouteChunkBoundary>
  );
}

function TrainingRouteLoading() {
  return (
    <AdminPanel className="content-panel training-route-chunk-state" role="status" aria-live="polite">
      <p className="eyebrow">Обучение</p>
      <h2>Загрузка раздела</h2>
      <p className="muted-text">Подготавливаем страницу обучения…</p>
    </AdminPanel>
  );
}

class TrainingRouteChunkBoundary extends Component<
  { children: ReactNode; pathname: string },
  { failedPathname: string | null }
> {
  override state: { failedPathname: string | null } = { failedPathname: null };

  static getDerivedStateFromError() {
    return { failedPathname: window.location.pathname };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Failed to render a training route chunk.', error, errorInfo);
  }

  override render() {
    if (this.state.failedPathname === this.props.pathname) {
      return (
        <AdminPanel className="content-panel training-route-chunk-state" role="alert">
          <p className="eyebrow">Обучение</p>
          <h2>Не удалось открыть раздел</h2>
          <p className="muted-text">Обновите страницу, чтобы загрузить модуль ещё раз.</p>
          <AdminButton type="button" tone="primary" onClick={() => window.location.reload()}>
            Обновить страницу
          </AdminButton>
        </AdminPanel>
      );
    }

    return this.props.children;
  }
}
