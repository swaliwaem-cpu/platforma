import { useEffect, useState } from 'react';
import { CheckIcon, FolderPlusIcon } from 'lucide-react';
import type { LotPresentationWorkspaceResponse } from '@platforma/shared';

import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';

type LotCollectionActionProps = {
  unitId: string;
  navigate: (nextPathname: string) => void;
  mode?: 'button' | 'icon';
  loadStateOnMount?: boolean;
  onChanged?: () => void;
};

export function LotCollectionAction({
  unitId,
  navigate,
  mode = 'button',
  loadStateOnMount = false,
  onChanged,
}: LotCollectionActionProps) {
  const { accessToken } = useAuth();
  const [isAdded, setIsAdded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadStateOnMount || !accessToken) {
      return;
    }

    void loadWorkspaceState();
  }, [accessToken, loadStateOnMount, unitId]);

  async function loadWorkspaceState() {
    if (!accessToken) {
      return;
    }

    try {
      const data = await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace', accessToken);
      setIsAdded(data.items.some((item) => item.unitId === unitId));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось проверить лот');
    }
  }

  async function addToWorkspace() {
    if (!accessToken || isSubmitting) {
      return;
    }

    if (isAdded) {
      navigate('/presentations');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace/items', accessToken, {
        method: 'POST',
        body: JSON.stringify({ unitId }),
      });
      setIsAdded(true);
      onChanged?.();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот в работу');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <span className="lot-workspace-action">
      <button
        className={
          mode === 'icon'
            ? `lot-collection-icon-button${isAdded ? ' lot-collection-icon-button--added' : ''}`
            : isAdded
              ? 'secondary-button secondary-button--fit'
              : 'primary-button primary-button--fit'
        }
        disabled={isSubmitting}
        type="button"
        aria-label={isAdded ? 'Перейти в работу' : 'Добавить в работу'}
        title={isAdded ? 'Перейти в работу' : 'Добавить в работу'}
        onClick={(event) => {
          event.stopPropagation();
          void addToWorkspace();
        }}
      >
        {mode === 'icon' ? (
          isAdded ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />
        ) : isAdded ? (
          'В работе'
        ) : (
          'Добавить в работу'
        )}
      </button>
      {error ? <span className="lot-workspace-action-error">{error}</span> : null}
    </span>
  );
}
