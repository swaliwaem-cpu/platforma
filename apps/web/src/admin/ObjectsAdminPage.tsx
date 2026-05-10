import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import {
  DevelopersResponse,
  LocationsResponse,
  MetroStationsResponse,
  ObjectDeveloper,
  ObjectFileType,
  ObjectImage,
  ObjectLocation,
  ObjectMetroStation,
  ObjectResponse,
  ObjectsResponse,
  ObjectStatus,
  RealEstateObjectDetail,
  RealEstateObjectSummary,
} from '@platforma/shared';

import { useAuth } from '../auth/AuthProvider';
import { apiRequest, apiUrl } from './api';

type ObjectsAdminPageProps = {
  pathname: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

type ObjectFormState = {
  title: string;
  description: string;
  shortDescription: string;
  layoutsUrl: string;
  priceFrom: string;
  pricePerMeterFrom: string;
  completionYear: string;
  completionQuarter: string;
  address: string;
  latitude: string;
  longitude: string;
  developerId: string;
  primaryLocationId: string;
  districtLocationIds: string[];
  areaLocationIds: string[];
  preservedLocationIds: string[];
  metroStationIds: string[];
  featuresText: string;
};

type SortField = 'createdAt' | 'updatedAt' | 'title' | 'status' | 'priceFrom' | 'completionYear';
type SortDirection = 'asc' | 'desc';

const objectStatusLabels: Record<ObjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'Архив',
};

const fileTypeLabels: Record<ObjectFileType, string> = {
  PRESENTATION: 'Презентация',
  FLOOR_PLAN: 'Планировка',
  DOCUMENT: 'Документ',
  OTHER: 'Другое',
};

const emptyForm: ObjectFormState = {
  title: '',
  description: '',
  shortDescription: '',
  layoutsUrl: '',
  priceFrom: '',
  pricePerMeterFrom: '',
  completionYear: '',
  completionQuarter: '',
  address: '',
  latitude: '',
  longitude: '',
  developerId: '',
  primaryLocationId: '',
  districtLocationIds: [],
  areaLocationIds: [],
  preservedLocationIds: [],
  metroStationIds: [],
  featuresText: '{}',
};

export function ObjectsAdminPage({ pathname, navigate, onBack }: ObjectsAdminPageProps) {
  const { accessToken, hasPermission } = useAuth();
  const [objects, setObjects] = useState<RealEstateObjectSummary[]>([]);
  const [developers, setDevelopers] = useState<ObjectDeveloper[]>([]);
  const [districtLocations, setDistrictLocations] = useState<ObjectLocation[]>([]);
  const [areaLocations, setAreaLocations] = useState<ObjectLocation[]>([]);
  const [metroStations, setMetroStations] = useState<ObjectMetroStation[]>([]);
  const [object, setObject] = useState<RealEstateObjectDetail | null>(null);
  const [form, setForm] = useState<ObjectFormState>(emptyForm);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [galleryFile, setGalleryFile] = useState<File | null>(null);
  const [objectFile, setObjectFile] = useState<File | null>(null);
  const [objectFileType, setObjectFileType] = useState<ObjectFileType>('PRESENTATION');
  const [objectFileTitle, setObjectFileTitle] = useState('');
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null);

  const canCreate = hasPermission('objects:create');
  const canUpdate = hasPermission('objects:update');
  const canPublish = hasPermission('objects:publish');
  const canUpload = hasPermission('files:upload') && canUpdate;
  const canDeleteMedia = hasPermission('files:delete') && canUpdate;
  const editObjectId = useMemo(() => {
    const match = pathname.match(/^\/admin\/objects\/([0-9a-f-]+)\/edit$/i);

    return match?.[1] ?? null;
  }, [pathname]);
  const isCreateRoute = pathname === '/admin/objects/new';
  const isListRoute = pathname === '/admin/objects';

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadDirectories(accessToken).catch(() => {
      setError('Не удалось загрузить справочники');
    });
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !isListRoute) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadObjects();
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [accessToken, isListRoute, page, search, sortBy, sortDirection, statusFilter]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    if (isCreateRoute) {
      setObject(null);
      setForm(emptyForm);
      resetUploads();
      setError(null);
      setNotice(null);
      return;
    }

    if (editObjectId) {
      void loadObjectDetail(editObjectId);
    }
  }, [accessToken, editObjectId, isCreateRoute]);

  function resetUploads() {
    setCoverFile(null);
    setGalleryFile(null);
    setObjectFile(null);
    setObjectFileTitle('');
    setObjectFileType('PRESENTATION');
  }

  async function loadDirectories(token: string) {
    const [developersData, districtLocationsData, areaLocationsData, metroData] = await Promise.all([
      apiRequest<DevelopersResponse>('/developers?limit=500', token),
      apiRequest<LocationsResponse>('/locations?type=DISTRICT&limit=500', token),
      apiRequest<LocationsResponse>('/locations?type=AREA&limit=500', token),
      apiRequest<MetroStationsResponse>('/metro?limit=500', token),
    ]);

    setDevelopers(developersData.items);
    setDistrictLocations(districtLocationsData.items);
    setAreaLocations(areaLocationsData.items);
    setMetroStations(metroData.items);
  }

  async function loadObjects() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        sortBy,
        sortDirection,
      });

      if (search.trim()) {
        params.set('search', search.trim());
      }

      if (statusFilter) {
        params.set('status', statusFilter);
      }

      const data = await apiRequest<ObjectsResponse>(`/objects?${params.toString()}`, accessToken);

      setObjects(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      setError('Не удалось загрузить объекты');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadObjectDetail(id: string) {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ObjectResponse>(`/objects/${id}`, accessToken);
      setObject(data.object);
      setForm(createFormFromObject(data.object));
      resetUploads();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить объект');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    const validationError = validateObjectForm(form);

    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const payload = createPayloadFromForm(form);

      if (isCreateRoute) {
        const data = await apiRequest<ObjectResponse>('/objects', accessToken, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        setNotice('Объект создан');
        navigate(`/admin/objects/${data.object.id}/edit`);
      } else if (editObjectId) {
        const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}`, accessToken, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });

        setObject(data.object);
        setForm(createFormFromObject(data.object));
        setNotice('Объект сохранён');
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить объект');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function publishObject() {
    if (!accessToken || !editObjectId) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}/publish`, accessToken, {
        method: 'POST',
      });

      setObject(data.object);
      setForm(createFormFromObject(data.object));
      setNotice('Объект опубликован');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось опубликовать объект');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function uploadCover() {
    await uploadMedia('cover');
  }

  async function uploadGalleryImage() {
    await uploadMedia('gallery');
  }

  async function uploadMedia(kind: 'cover' | 'gallery') {
    if (!accessToken || !editObjectId) {
      return;
    }

    const selectedFile = kind === 'cover' ? coverFile : galleryFile;

    if (!selectedFile) {
      setError('Выберите изображение');
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);

    try {
      const body = new FormData();
      body.append('file', selectedFile);

      const data = await apiRequest<ObjectResponse>(
        `/objects/${editObjectId}/${kind}`,
        accessToken,
        {
          method: 'POST',
          body,
        },
      );

      setObject(data.object);
      setForm(createFormFromObject(data.object));
      setNotice(kind === 'cover' ? 'Обложка загружена' : 'Изображение добавлено');

      if (kind === 'cover') {
        setCoverFile(null);
      } else {
        setGalleryFile(null);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить изображение');
    } finally {
      setIsUploading(false);
    }
  }

  async function uploadLinkedFile() {
    if (!accessToken || !editObjectId) {
      return;
    }

    if (!objectFile) {
      setError('Выберите PDF-файл');
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);

    try {
      const body = new FormData();
      body.append('file', objectFile);
      body.append('type', objectFileType);
      body.append('title', objectFileTitle);

      const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}/files`, accessToken, {
        method: 'POST',
        body,
      });

      setObject(data.object);
      setObjectFile(null);
      setObjectFileTitle('');
      setNotice('PDF-файл добавлен');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить PDF');
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteGalleryImage(imageId: string) {
    if (!accessToken || !editObjectId) {
      return;
    }

    const confirmed = window.confirm('Удалить изображение из объекта?');

    if (!confirmed) {
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}/gallery/${imageId}`, accessToken, {
        method: 'DELETE',
      });

      setObject(data.object);
      setNotice('Изображение удалено');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить изображение');
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteLinkedFile(objectFileId: string) {
    if (!accessToken || !editObjectId) {
      return;
    }

    const confirmed = window.confirm('Удалить PDF-файл из объекта?');

    if (!confirmed) {
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}/files/${objectFileId}`, accessToken, {
        method: 'DELETE',
      });

      setObject(data.object);
      setNotice('PDF-файл удалён');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить PDF');
    } finally {
      setIsUploading(false);
    }
  }

  async function persistGalleryOrder(nextImages: ObjectImage[]) {
    if (!accessToken || !editObjectId || !object) {
      return;
    }

    const previousObject = object;
    const nextObject = {
      ...object,
      images: nextImages.map((image, index) => ({
        ...image,
        sortOrder: index,
      })),
    };

    setObject(nextObject);
    setError(null);
    setNotice(null);

    try {
      const data = await apiRequest<ObjectResponse>(`/objects/${editObjectId}/gallery/sort`, accessToken, {
        method: 'PATCH',
        body: JSON.stringify({
          imageIds: nextImages.map((image) => image.id),
        }),
      });

      setObject(data.object);
      setNotice('Порядок галереи обновлён');
    } catch (caughtError) {
      setObject(previousObject);
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось отсортировать галерею');
    }
  }

  function handleSort(sortField: SortField) {
    setPage(1);

    if (sortBy === sortField) {
      setSortDirection((currentDirection) => (currentDirection === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortBy(sortField);
    setSortDirection(sortField === 'title' ? 'asc' : 'desc');
  }

  function handleGalleryDrop(targetImageId: string) {
    if (!object || !draggedImageId || draggedImageId === targetImageId) {
      setDraggedImageId(null);
      return;
    }

    const nextImages = moveImage(object.images, draggedImageId, targetImageId);
    setDraggedImageId(null);
    void persistGalleryOrder(nextImages);
  }

  function moveGalleryImage(imageId: string, direction: -1 | 1) {
    if (!object) {
      return;
    }

    const currentIndex = object.images.findIndex((image) => image.id === imageId);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= object.images.length) {
      return;
    }

    const nextImages = [...object.images];
    const [movedImage] = nextImages.splice(currentIndex, 1);

    if (!movedImage) {
      return;
    }

    nextImages.splice(nextIndex, 0, movedImage);
    void persistGalleryOrder(nextImages);
  }

  if (isCreateRoute || editObjectId) {
    return (
      <ObjectEditor
        accessToken={accessToken}
        canPublish={canPublish}
        canUpdate={canUpdate}
        canDeleteMedia={canDeleteMedia}
        canUpload={canUpload}
        coverFile={coverFile}
        developers={developers}
        draggedImageId={draggedImageId}
        error={error}
        form={form}
        galleryFile={galleryFile}
        isCreateRoute={isCreateRoute}
        isLoading={isLoading}
        isSubmitting={isSubmitting}
        isUploading={isUploading}
        areaLocations={areaLocations}
        districtLocations={districtLocations}
        metroStations={metroStations}
        notice={notice}
        object={object}
        objectFile={objectFile}
        objectFileTitle={objectFileTitle}
        objectFileType={objectFileType}
        onBack={() => navigate('/admin/objects')}
        onCoverFileChange={setCoverFile}
        onDragEnd={() => setDraggedImageId(null)}
        onDragOver={(event) => event.preventDefault()}
        onDragStart={setDraggedImageId}
        onDrop={handleGalleryDrop}
        onFormChange={setForm}
        onGalleryFileChange={setGalleryFile}
        onGalleryMove={moveGalleryImage}
        onGalleryDelete={(imageId) => void deleteGalleryImage(imageId)}
        onLinkedFileDelete={(objectFileId) => void deleteLinkedFile(objectFileId)}
        onObjectFileChange={setObjectFile}
        onObjectFileTitleChange={setObjectFileTitle}
        onObjectFileTypeChange={setObjectFileType}
        onPublish={() => void publishObject()}
        onSubmit={(event) => void handleSubmit(event)}
        onUploadCover={() => void uploadCover()}
        onUploadGalleryImage={() => void uploadGalleryImage()}
        onUploadLinkedFile={() => void uploadLinkedFile()}
      />
    );
  }

  return (
    <div className="admin-objects">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Объекты</h2>
        </div>
        <button className="secondary-button secondary-button--fit" type="button" onClick={onBack}>
          Назад
        </button>
      </header>

      <section className="toolbar" aria-label="Фильтры объектов">
        <input
          aria-label="Поиск объектов"
          placeholder="Поиск по названию, адресу, застройщику"
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Фильтр по статусу"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value);
            setPage(1);
          }}
        >
          <option value="">Все статусы</option>
          {Object.entries(objectStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="primary-button primary-button--fit"
          disabled={!canCreate}
          type="button"
          onClick={() => navigate('/admin/objects/new')}
        >
          Новый объект
        </button>
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}

      <section className="table-panel" aria-label="Список объектов">
        <div className="table-meta">
          <span>{isLoading ? 'Загрузка' : `Всего: ${total}`}</span>
          <span>
            Страница {page} из {totalPages}
          </span>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>
                  <SortButton active={sortBy === 'title'} direction={sortDirection} onClick={() => handleSort('title')}>
                    Название
                  </SortButton>
                </th>
                <th>
                  <SortButton active={sortBy === 'status'} direction={sortDirection} onClick={() => handleSort('status')}>
                    Статус
                  </SortButton>
                </th>
                <th>Застройщик</th>
                <th>Район</th>
                <th>
                  <SortButton
                    active={sortBy === 'priceFrom'}
                    direction={sortDirection}
                    onClick={() => handleSort('priceFrom')}
                  >
                    Цена
                  </SortButton>
                </th>
                <th>
                  <SortButton
                    active={sortBy === 'completionYear'}
                    direction={sortDirection}
                    onClick={() => handleSort('completionYear')}
                  >
                    Срок
                  </SortButton>
                </th>
                <th>
                  <SortButton
                    active={sortBy === 'createdAt'}
                    direction={sortDirection}
                    onClick={() => handleSort('createdAt')}
                  >
                    Создан
                  </SortButton>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {objects.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    <span className="table-subtext">{item.slug}</span>
                  </td>
                  <td>
                    <span className={`status-pill object-status object-status--${item.status.toLowerCase()}`}>
                      {objectStatusLabels[item.status]}
                    </span>
                  </td>
                  <td>{item.developer?.name ?? 'Нет'}</td>
                  <td>{getObjectDistrictName(item) ?? 'Нет'}</td>
                  <td>{formatPrice(item.priceFrom)}</td>
                  <td>{formatCompletion(item.completionYear, item.completionQuarter)}</td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => navigate(`/admin/objects/${item.id}/edit`)}
                    >
                      Открыть
                    </button>
                  </td>
                </tr>
              ))}

              {!isLoading && objects.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <span className="empty-row">Объекты не найдены</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <button
            className="secondary-button secondary-button--fit"
            disabled={page <= 1}
            type="button"
            onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
          >
            Назад
          </button>
          <button
            className="secondary-button secondary-button--fit"
            disabled={page >= totalPages}
            type="button"
            onClick={() => setPage((currentPage) => currentPage + 1)}
          >
            Вперёд
          </button>
        </div>
      </section>
    </div>
  );
}

type ObjectEditorProps = {
  accessToken: string | null;
  canDeleteMedia: boolean;
  canPublish: boolean;
  canUpdate: boolean;
  canUpload: boolean;
  coverFile: File | null;
  developers: ObjectDeveloper[];
  districtLocations: ObjectLocation[];
  areaLocations: ObjectLocation[];
  draggedImageId: string | null;
  error: string | null;
  form: ObjectFormState;
  galleryFile: File | null;
  isCreateRoute: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  metroStations: ObjectMetroStation[];
  notice: string | null;
  object: RealEstateObjectDetail | null;
  objectFile: File | null;
  objectFileTitle: string;
  objectFileType: ObjectFileType;
  onBack: () => void;
  onCoverFileChange: (file: File | null) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDragStart: (imageId: string) => void;
  onDrop: (imageId: string) => void;
  onFormChange: (form: ObjectFormState) => void;
  onGalleryFileChange: (file: File | null) => void;
  onGalleryDelete: (imageId: string) => void;
  onGalleryMove: (imageId: string, direction: -1 | 1) => void;
  onLinkedFileDelete: (objectFileId: string) => void;
  onObjectFileChange: (file: File | null) => void;
  onObjectFileTitleChange: (title: string) => void;
  onObjectFileTypeChange: (type: ObjectFileType) => void;
  onPublish: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUploadCover: () => void;
  onUploadGalleryImage: () => void;
  onUploadLinkedFile: () => void;
};

function ObjectEditor(props: ObjectEditorProps) {
  const coverImage = props.object?.images.find((image) => image.isCover) ?? props.object?.images[0] ?? null;

  return (
    <div className="admin-objects admin-objects--editor">
      <header className="page-header">
        <div>
          <p className="eyebrow">{props.isCreateRoute ? 'Новый объект' : 'Редактирование объекта'}</p>
          <h2>{props.isCreateRoute ? 'Создание объекта' : props.object?.title ?? 'Объект'}</h2>
        </div>
        <div className="header-actions">
          {props.object?.status !== 'PUBLISHED' && !props.isCreateRoute ? (
            <button
              className="success-button"
              disabled={!props.canPublish || props.isSubmitting}
              type="button"
              onClick={props.onPublish}
            >
              Опубликовать
            </button>
          ) : null}
          <button className="secondary-button secondary-button--fit" type="button" onClick={props.onBack}>
            Назад
          </button>
        </div>
      </header>

      {props.error ? <p className="form-error">{props.error}</p> : null}
      {props.notice ? <p className="form-notice">{props.notice}</p> : null}

      <div className="object-editor-layout">
        <form className="object-form editor-panel" onSubmit={props.onSubmit}>
          <fieldset disabled={props.isLoading || props.isSubmitting || (!props.isCreateRoute && !props.canUpdate)}>
            <div className="form-grid">
              <label className="field-wide">
                Название
                <input
                  required
                  maxLength={240}
                  type="text"
                  value={props.form.title}
                  onChange={(event) => props.onFormChange({ ...props.form, title: event.target.value })}
                />
              </label>

              <label className="field-wide">
                Короткое описание
                <textarea
                  rows={3}
                  value={props.form.shortDescription}
                  onChange={(event) => props.onFormChange({ ...props.form, shortDescription: event.target.value })}
                />
              </label>

              <label className="field-wide">
                Описание
                <textarea
                  rows={7}
                  value={props.form.description}
                  onChange={(event) => props.onFormChange({ ...props.form, description: event.target.value })}
                />
              </label>

              <label className="field-wide">
                Планировки и цены
                <input
                  inputMode="url"
                  placeholder="https://developer.example/plans"
                  type="url"
                  value={props.form.layoutsUrl}
                  onChange={(event) => props.onFormChange({ ...props.form, layoutsUrl: event.target.value })}
                />
              </label>

              <label>
                Цена от
                <input
                  inputMode="decimal"
                  type="text"
                  value={props.form.priceFrom}
                  onChange={(event) => props.onFormChange({ ...props.form, priceFrom: event.target.value })}
                />
              </label>

              <label>
                Цена за метр от
                <input
                  inputMode="decimal"
                  type="text"
                  value={props.form.pricePerMeterFrom}
                  onChange={(event) => props.onFormChange({ ...props.form, pricePerMeterFrom: event.target.value })}
                />
              </label>

              <label>
                Год сдачи
                <input
                  inputMode="numeric"
                  type="text"
                  value={props.form.completionYear}
                  onChange={(event) => props.onFormChange({ ...props.form, completionYear: event.target.value })}
                />
              </label>

              <label>
                Квартал
                <select
                  value={props.form.completionQuarter}
                  onChange={(event) => props.onFormChange({ ...props.form, completionQuarter: event.target.value })}
                >
                  <option value="">Не указан</option>
                  <option value="1">1 квартал</option>
                  <option value="2">2 квартал</option>
                  <option value="3">3 квартал</option>
                  <option value="4">4 квартал</option>
                </select>
              </label>

              <label className="field-wide">
                Адрес
                <input
                  type="text"
                  value={props.form.address}
                  onChange={(event) => props.onFormChange({ ...props.form, address: event.target.value })}
                />
              </label>

              <label>
                Широта
                <input
                  inputMode="decimal"
                  type="text"
                  value={props.form.latitude}
                  onChange={(event) => props.onFormChange({ ...props.form, latitude: event.target.value })}
                />
              </label>

              <label>
                Долгота
                <input
                  inputMode="decimal"
                  type="text"
                  value={props.form.longitude}
                  onChange={(event) => props.onFormChange({ ...props.form, longitude: event.target.value })}
                />
              </label>

              <label>
                Застройщик
                <select
                  value={props.form.developerId}
                  onChange={(event) => props.onFormChange({ ...props.form, developerId: event.target.value })}
                >
                  <option value="">Не выбран</option>
                  {props.developers.map((developer) => (
                    <option key={developer.id} value={developer.id}>
                      {developer.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Основной район
                <select
                  value={props.form.primaryLocationId}
                  onChange={(event) => props.onFormChange({ ...props.form, primaryLocationId: event.target.value })}
                >
                  <option value="">Не выбрана</option>
                  {props.districtLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Районы
                <select
                  multiple
                  value={props.form.districtLocationIds}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, districtLocationIds: getSelectedValues(event) })
                  }
                >
                  {props.districtLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Окружение
                <select
                  multiple
                  value={props.form.areaLocationIds}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, areaLocationIds: getSelectedValues(event) })
                  }
                >
                  {props.areaLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Метро
                <select
                  multiple
                  value={props.form.metroStationIds}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, metroStationIds: getSelectedValues(event) })
                  }
                >
                  {props.metroStations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.lineName ? `${station.name}, ${station.lineName}` : station.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-wide">
                Features JSON
                <textarea
                  rows={5}
                  spellCheck={false}
                  value={props.form.featuresText}
                  onChange={(event) => props.onFormChange({ ...props.form, featuresText: event.target.value })}
                />
              </label>
            </div>

            <div className="form-actions object-form-actions">
              <button
                className="primary-button primary-button--fit"
                disabled={props.isSubmitting || (props.isCreateRoute ? false : !props.canUpdate)}
                type="submit"
              >
                {props.isCreateRoute ? 'Создать' : 'Сохранить'}
              </button>
            </div>
          </fieldset>
        </form>

        <aside className="object-side">
          <section className="editor-panel object-preview" aria-label="Предпросмотр карточки">
            <p className="eyebrow">Предпросмотр</p>
            <div className="preview-media">
              {coverImage && props.accessToken ? (
                <SecureImage accessToken={props.accessToken} alt={coverImage.alt ?? props.form.title} fileId={coverImage.file.id} />
              ) : (
                <span>Нет обложки</span>
              )}
            </div>
            <h3>{props.form.title.trim() || 'Название объекта'}</h3>
            <p className="preview-meta">
              {objectStatusLabels[props.object?.status ?? 'DRAFT']} · {formatPrice(props.form.priceFrom)}
            </p>
            <p className="preview-address">{props.form.address.trim() || 'Адрес не указан'}</p>
            <p className="helper-text">{props.form.shortDescription.trim() || 'Короткое описание появится здесь'}</p>
          </section>

          {!props.isCreateRoute ? (
            <>
              <section className="editor-panel media-panel" aria-label="Медиа объекта">
                <p className="eyebrow">Медиа</p>
                <FileUploadRow
                  accept="image/jpeg,image/png,image/webp"
                  buttonLabel="Загрузить обложку"
                  disabled={!props.canUpload || props.isUploading}
                  file={props.coverFile}
                  label="Обложка"
                  onChange={props.onCoverFileChange}
                  onUpload={props.onUploadCover}
                />
                <FileUploadRow
                  accept="image/jpeg,image/png,image/webp"
                  buttonLabel="Добавить в галерею"
                  disabled={!props.canUpload || props.isUploading}
                  file={props.galleryFile}
                  label="Галерея"
                  onChange={props.onGalleryFileChange}
                  onUpload={props.onUploadGalleryImage}
                />

                <ul className="gallery-list">
                  {props.object?.images.map((image, index) => (
                    <li
                      key={image.id}
                      draggable
                      className={props.draggedImageId === image.id ? 'gallery-item gallery-item--dragging' : 'gallery-item'}
                      onDragEnd={props.onDragEnd}
                      onDragOver={props.onDragOver}
                      onDragStart={() => props.onDragStart(image.id)}
                      onDrop={() => props.onDrop(image.id)}
                    >
                      <span>{image.isCover ? 'Обложка' : `Фото ${index + 1}`}</span>
                      <div className="gallery-actions">
                        <button
                          className="text-button"
                          disabled={index === 0}
                          type="button"
                          onClick={() => props.onGalleryMove(image.id, -1)}
                        >
                          Выше
                        </button>
                        <button
                          className="text-button"
                          disabled={index === (props.object?.images.length ?? 0) - 1}
                          type="button"
                          onClick={() => props.onGalleryMove(image.id, 1)}
                        >
                          Ниже
                        </button>
                        <button
                          className="text-button text-button--danger"
                          disabled={!props.canDeleteMedia || props.isUploading}
                          type="button"
                          onClick={() => props.onGalleryDelete(image.id)}
                        >
                          Удалить
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="editor-panel media-panel" aria-label="Файлы объекта">
                <p className="eyebrow">PDF-файлы</p>
                <label>
                  Тип
                  <select
                    value={props.objectFileType}
                    onChange={(event) => props.onObjectFileTypeChange(event.target.value as ObjectFileType)}
                  >
                    {Object.entries(fileTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Название
                  <input
                    type="text"
                    value={props.objectFileTitle}
                    onChange={(event) => props.onObjectFileTitleChange(event.target.value)}
                  />
                </label>
                <FileUploadRow
                  accept="application/pdf"
                  buttonLabel="Загрузить PDF"
                  disabled={!props.canUpload || props.isUploading}
                  file={props.objectFile}
                  label="Файл"
                  onChange={props.onObjectFileChange}
                  onUpload={props.onUploadLinkedFile}
                />
                <ul className="file-list">
                  {props.object?.files.map((file) => (
                    <li key={file.id}>
                      <span>{file.title || file.file.originalName || fileTypeLabels[file.type]}</span>
                      <div className="file-actions">
                        <strong>{fileTypeLabels[file.type]}</strong>
                        <button
                          className="text-button text-button--danger"
                          disabled={!props.canDeleteMedia || props.isUploading}
                          type="button"
                          onClick={() => props.onLinkedFileDelete(file.id)}
                        >
                          Удалить
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <section className="editor-panel media-panel">
              <p className="eyebrow">Медиа</p>
              <p className="helper-text">Загрузка обложки, галереи и PDF откроется после создания объекта.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function FileUploadRow({
  accept,
  buttonLabel,
  disabled,
  file,
  label,
  onChange,
  onUpload,
}: {
  accept: string;
  buttonLabel: string;
  disabled: boolean;
  file: File | null;
  label: string;
  onChange: (file: File | null) => void;
  onUpload: () => void;
}) {
  return (
    <div className="upload-row">
      <label>
        {label}
        <input
          accept={accept}
          type="file"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
      </label>
      <button className="secondary-button secondary-button--fit" disabled={disabled || !file} type="button" onClick={onUpload}>
        {buttonLabel}
      </button>
    </div>
  );
}

function SortButton({
  active,
  children,
  direction,
  onClick,
}: {
  active: boolean;
  children: string;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <button className={active ? 'table-sort-button table-sort-button--active' : 'table-sort-button'} type="button" onClick={onClick}>
      {children}
      {active ? <span>{direction === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
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

function createFormFromObject(object: RealEstateObjectDetail): ObjectFormState {
  const districtLocation = getObjectDistrictLocation(object);

  return {
    title: object.title,
    description: object.description ?? '',
    shortDescription: object.shortDescription ?? '',
    layoutsUrl: object.layoutsUrl ?? '',
    priceFrom: object.priceFrom ?? '',
    pricePerMeterFrom: object.pricePerMeterFrom ?? '',
    completionYear: object.completionYear?.toString() ?? '',
    completionQuarter: object.completionQuarter?.toString() ?? '',
    address: object.address ?? '',
    latitude: object.latitude?.toString() ?? '',
    longitude: object.longitude?.toString() ?? '',
    developerId: object.developer?.id ?? '',
    primaryLocationId: districtLocation?.id ?? '',
    districtLocationIds: getObjectLocationsByType(object, 'DISTRICT').map((location) => location.id),
    areaLocationIds: getObjectLocationsByType(object, 'AREA').map((location) => location.id),
    preservedLocationIds: getPreservedLocationIds(object),
    metroStationIds: object.metroStations.map((station) => station.id),
    featuresText: JSON.stringify(object.featuresJson ?? {}, null, 2),
  };
}

function createPayloadFromForm(form: ObjectFormState) {
  const primaryLocationId = emptyToNull(form.primaryLocationId);
  const locationIds = unique([
    ...(primaryLocationId ? [primaryLocationId] : []),
    ...form.districtLocationIds,
    ...form.areaLocationIds,
    ...form.preservedLocationIds,
  ]);

  return {
    title: form.title.trim(),
    description: emptyToNull(form.description),
    shortDescription: emptyToNull(form.shortDescription),
    layoutsUrl: emptyToNull(form.layoutsUrl),
    priceFrom: emptyToNull(form.priceFrom),
    pricePerMeterFrom: emptyToNull(form.pricePerMeterFrom),
    completionYear: emptyToNull(form.completionYear),
    completionQuarter: emptyToNull(form.completionQuarter),
    address: emptyToNull(form.address),
    latitude: emptyToNull(form.latitude),
    longitude: emptyToNull(form.longitude),
    featuresJson: JSON.parse(form.featuresText) as Record<string, unknown>,
    developerId: emptyToNull(form.developerId),
    primaryLocationId,
    locationIds,
    metroStationIds: form.metroStationIds,
  };
}

type ObjectWithLocations = {
  primaryLocation: ObjectLocation | null;
  locations: ObjectLocation[];
};

function getObjectDistrictName(object: ObjectWithLocations) {
  return getObjectDistrictLocation(object)?.name ?? null;
}

function getObjectDistrictLocation(object: ObjectWithLocations) {
  if (object.primaryLocation?.type === 'DISTRICT') {
    return object.primaryLocation;
  }

  return object.locations.find((location) => location.type === 'DISTRICT') ?? null;
}

function getObjectLocationsByType(object: ObjectWithLocations, type: ObjectLocation['type']) {
  return uniqueLocationsById([
    ...(object.primaryLocation?.type === type ? [object.primaryLocation] : []),
    ...object.locations.filter((location) => location.type === type),
  ]);
}

function getPreservedLocationIds(object: ObjectWithLocations) {
  return uniqueLocationsById([
    ...(object.primaryLocation && !isEditableObjectLocationType(object.primaryLocation.type) ? [object.primaryLocation] : []),
    ...object.locations.filter((location) => !isEditableObjectLocationType(location.type)),
  ]).map((location) => location.id);
}

function isEditableObjectLocationType(type: ObjectLocation['type']) {
  return type === 'DISTRICT' || type === 'AREA';
}

function uniqueLocationsById(locations: ObjectLocation[]) {
  const seenIds = new Set<string>();

  return locations.filter((location) => {
    if (seenIds.has(location.id)) {
      return false;
    }

    seenIds.add(location.id);
    return true;
  });
}

function validateObjectForm(form: ObjectFormState) {
  if (!form.title.trim()) {
    return 'Название обязательно';
  }

  if (form.completionQuarter && !form.completionYear) {
    return 'Год сдачи обязателен, если указан квартал';
  }

  if ((form.latitude && !form.longitude) || (!form.latitude && form.longitude)) {
    return 'Широта и долгота заполняются вместе';
  }

  if (form.layoutsUrl.trim()) {
    try {
      const url = new URL(form.layoutsUrl.trim());

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'Ссылка на планировки должна начинаться с http:// или https://';
      }
    } catch {
      return 'Ссылка на планировки некорректна';
    }
  }

  try {
    const parsed = JSON.parse(form.featuresText);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Features JSON должен быть объектом';
    }
  } catch {
    return 'Features JSON содержит ошибку';
  }

  return null;
}

function getSelectedValues(event: ChangeEvent<HTMLSelectElement>) {
  return Array.from(event.target.selectedOptions, (option) => option.value);
}

function emptyToNull(value: string) {
  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}

function unique(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function moveImage(images: ObjectImage[], movedId: string, targetId: string) {
  const currentIndex = images.findIndex((image) => image.id === movedId);
  const targetIndex = images.findIndex((image) => image.id === targetId);

  if (currentIndex < 0 || targetIndex < 0) {
    return images;
  }

  const nextImages = [...images];
  const [movedImage] = nextImages.splice(currentIndex, 1);

  if (!movedImage) {
    return images;
  }

  nextImages.splice(targetIndex, 0, movedImage);

  return nextImages;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
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

function formatCompletion(year: number | string | null, quarter: number | string | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}
