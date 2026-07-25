import type { TrainingModuleConfigResponse } from '@platforma/shared';
import { useEffect, useState } from 'react';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';

type TrainingShellMode = 'employee' | 'admin';

type TrainingShellPageProps = {
  mode: TrainingShellMode;
  onBack?: () => void;
};

const shellCopy = {
  employee: {
    eyebrow: 'Обучение',
    title: 'Модуль обучения',
    description: 'Здесь появятся доступные проекты и собственные результаты обучения.',
  },
  admin: {
    eyebrow: 'Админка',
    title: 'Управление обучением',
    description: 'Здесь появятся проекты, результаты и настройки модуля обучения.',
  },
} as const;

export function TrainingShellPage({ mode, onBack }: TrainingShellPageProps) {
  const { accessToken } = useAuth();
  const [config, setConfig] = useState<TrainingModuleConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = shellCopy[mode];

  useEffect(() => {
    if (!accessToken) {
      setError('Сессия не найдена');
      return;
    }

    let isCancelled = false;

    setConfig(null);
    setError(null);

    void apiRequest<TrainingModuleConfigResponse>('/training/config', accessToken)
      .then((response) => {
        if (!isCancelled) {
          setConfig(response);
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить конфигурацию обучения');
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [accessToken]);

  return (
    <div className="content-panel">
      <div className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2>{copy.title}</h2>
          <p className="muted-text">{copy.description}</p>
        </div>

        {onBack ? (
          <button className="secondary-button secondary-button--fit" type="button" onClick={onBack}>
            Назад
          </button>
        ) : null}
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {!error && !config ? <p className="muted-text">Проверка доступности модуля</p> : null}
      {config?.status === 'disabled' ? (
        <p className="muted-text">Модуль обучения отключён feature flag.</p>
      ) : null}
      {config?.status === 'enabled' ? (
        <p className="form-notice">Каркас модуля подключён. Предметная логика будет добавлена на следующих этапах.</p>
      ) : null}
    </div>
  );
}
