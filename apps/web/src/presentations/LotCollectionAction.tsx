import { FormEvent, useEffect, useState } from 'react';
import { CheckIcon, FolderPlusIcon, XIcon } from 'lucide-react';
import type {
  LotPresentationCollection,
  LotPresentationCollectionResponse,
  LotPresentationCollectionsResponse,
} from '@platforma/shared';

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
  const [collections, setCollections] = useState<LotPresentationCollection[]>([]);
  const [addedCollectionId, setAddedCollectionId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadStateOnMount || !accessToken) {
      return;
    }

    void loadCollections();
  }, [accessToken, loadStateOnMount, unitId]);

  async function loadCollections() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionsResponse>(
        `/lot-presentations/collections?unitId=${encodeURIComponent(unitId)}`,
        accessToken,
      );
      const containingCollection = data.items.find((collection) => collection.containsRequestedUnit);

      setCollections(data.items);
      setAddedCollectionId(containingCollection?.id ?? null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить подборки');
    } finally {
      setIsLoading(false);
    }
  }

  async function openPicker() {
    if (addedCollectionId) {
      navigate(`/presentations?collectionId=${encodeURIComponent(addedCollectionId)}`);
      return;
    }

    setIsModalOpen(true);
    await loadCollections();
  }

  async function addToCollection(collectionId: string) {
    if (!accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest<LotPresentationCollectionResponse>(
        `/lot-presentations/collections/${encodeURIComponent(collectionId)}/items`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ unitId }),
        },
      );

      setAddedCollectionId(collectionId);
      setIsModalOpen(false);
      onChanged?.();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCreateCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || isSubmitting) {
      return;
    }

    const name = newCollectionName.trim() || 'Новая подборка';

    setIsSubmitting(true);
    setError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionResponse>('/lot-presentations/collections', accessToken, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      setNewCollectionName('');
      await addToCollection(data.collection.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось создать подборку');
      setIsSubmitting(false);
    }
  }

  const isAdded = Boolean(addedCollectionId);

  return (
    <>
      <button
        className={
          mode === 'icon'
            ? `lot-collection-icon-button${isAdded ? ' lot-collection-icon-button--added' : ''}`
            : isAdded
              ? 'secondary-button secondary-button--fit'
              : 'primary-button primary-button--fit'
        }
        type="button"
        aria-label={isAdded ? 'Перейти в подборку' : 'Добавить в подборку'}
        title={isAdded ? 'Перейти в подборку' : 'Добавить в подборку'}
        onClick={(event) => {
          event.stopPropagation();
          void openPicker();
        }}
      >
        {mode === 'icon' ? (
          isAdded ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />
        ) : isAdded ? (
          'Перейти в подборку'
        ) : (
          'Добавить в подборку'
        )}
      </button>

      {isModalOpen ? (
        <div className="lot-collection-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setIsModalOpen(false);
          }
        }}>
          <div className="lot-collection-modal" role="dialog" aria-modal="true" aria-labelledby="lot-collection-modal-title">
            <header className="lot-collection-modal-header">
              <div>
                <p className="eyebrow">Подборки</p>
                <h3 id="lot-collection-modal-title">Добавить лот</h3>
              </div>
              <button
                className="lot-collection-modal-close"
                type="button"
                aria-label="Закрыть"
                onClick={() => setIsModalOpen(false)}
              >
                <XIcon aria-hidden="true" />
              </button>
            </header>

            {isLoading ? <p className="muted-text">Загрузка подборок</p> : null}

            {collections.length > 0 ? (
              <div className="lot-collection-list" aria-label="Список подборок">
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    className="lot-collection-choice"
                    disabled={isSubmitting || Boolean(collection.containsRequestedUnit)}
                    type="button"
                    onClick={() => void addToCollection(collection.id)}
                  >
                    <span>
                      <strong>{collection.name}</strong>
                      <small>{collection.itemsCount} лотов</small>
                    </span>
                    {collection.containsRequestedUnit ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />}
                  </button>
                ))}
              </div>
            ) : !isLoading ? (
              <p className="muted-text">Создайте первую подборку для этого лота.</p>
            ) : null}

            <form className="lot-collection-create-form" onSubmit={(event) => void handleCreateCollection(event)}>
              <label>
                Новая подборка
                <input
                  placeholder="Например: Клиент Иванов"
                  type="text"
                  value={newCollectionName}
                  onChange={(event) => setNewCollectionName(event.currentTarget.value)}
                />
              </label>
              <button className="secondary-button secondary-button--fit" disabled={isSubmitting} type="submit">
                Создать и добавить
              </button>
            </form>

            {error ? <p className="form-error">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
