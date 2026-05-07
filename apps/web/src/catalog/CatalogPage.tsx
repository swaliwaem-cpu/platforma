import { useEffect, useState } from 'react';
import { ObjectsResponse, RealEstateObjectSummary } from '@platforma/shared';

import { apiRequest, apiUrl } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';

export function CatalogPage() {
  const { accessToken } = useAuth();
  const [objects, setObjects] = useState<RealEstateObjectSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadObjects();
  }, [accessToken, page]);

  async function loadObjects() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '12',
        status: 'PUBLISHED',
        sortBy: 'createdAt',
        sortDirection: 'desc',
      });
      const data = await apiRequest<ObjectsResponse>(`/objects?${params.toString()}`, accessToken);

      setObjects(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить каталог');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="catalog-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Каталог</p>
          <h2>Объекты недвижимости</h2>
        </div>
        <span className="catalog-count">{isLoading ? 'Загрузка' : `Всего: ${total}`}</span>
      </header>

      {error ? <p className="form-error">{error}</p> : null}

      {!isLoading && objects.length === 0 ? (
        <div className="content-panel">
          <p className="eyebrow">Каталог</p>
          <h2>Нет объектов</h2>
          <p className="muted-text">Опубликованные объекты пока не найдены.</p>
        </div>
      ) : (
        <div className="catalog-grid">
          {objects.map((object) => (
            <CatalogCard key={object.id} object={object} accessToken={accessToken ?? ''} />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="pagination catalog-pagination">
          <button
            className="secondary-button secondary-button--fit"
            disabled={page <= 1}
            type="button"
            onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
          >
            Назад
          </button>
          <span>
            Страница {page} из {totalPages}
          </span>
          <button
            className="secondary-button secondary-button--fit"
            disabled={page >= totalPages}
            type="button"
            onClick={() => setPage((currentPage) => currentPage + 1)}
          >
            Вперёд
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CatalogCard({ accessToken, object }: { accessToken: string; object: RealEstateObjectSummary }) {
  const coverImage = object.coverImage;

  return (
    <article className="catalog-card">
      <div className="catalog-card-media">
        {coverImage ? (
          <SecureImage accessToken={accessToken} alt={coverImage.alt ?? object.title} fileId={coverImage.file.id} />
        ) : (
          <span>Нет обложки</span>
        )}
      </div>
      <div className="catalog-card-body">
        <div>
          <h3>{object.title}</h3>
          <p>{object.primaryLocation?.name ?? object.address ?? 'Локация не указана'}</p>
        </div>
        <dl className="catalog-card-meta">
          <div>
            <dt>Цена</dt>
            <dd>{formatPrice(object.priceFrom)}</dd>
          </div>
          <div>
            <dt>Срок</dt>
            <dd>{formatCompletion(object.completionYear, object.completionQuarter)}</dd>
          </div>
          <div>
            <dt>Застройщик</dt>
            <dd>{object.developer?.name ?? 'Не указан'}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

function SecureImage({ accessToken, alt, fileId }: { accessToken: string; alt: string; fileId: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;

    async function loadImage() {
      const response = await fetch(`${apiUrl}/files/${fileId}/content`, {
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
    return <span>Загрузка изображения</span>;
  }

  return <img alt={alt} src={src} />;
}

function formatPrice(value: string | null) {
  if (!value) {
    return 'Не указана';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    style: 'currency',
    currency: 'RUB',
  }).format(parsed);
}

function formatCompletion(year: number | null, quarter: number | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}
