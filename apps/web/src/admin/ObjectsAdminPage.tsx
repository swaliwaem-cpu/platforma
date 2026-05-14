import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
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

import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useAuth } from '../auth/AuthProvider';
import { SecureImage } from '../files/SecureImage';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';
import { getLinkedFileOriginalName, getLinkedFileTitle } from './fileDisplay';

type ObjectsAdminPageProps = {
  pathname: string;
  navigate: (nextPathname: string) => void;
  onBack: () => void;
};

type ObjectFormState = {
  title: string;
  description: string;
  architectureDescription: string;
  infrastructureDescription: string;
  fillingDescription: string;
  layoutsUrl: string;
  krtName: string;
  apartmentAreaRange: string;
  ceilingHeight: string;
  propertyClass: string;
  floorRange: string;
  apartmentsCountText: string;
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
  architectureDescription: '',
  infrastructureDescription: '',
  fillingDescription: '',
  layoutsUrl: '',
  krtName: '',
  apartmentAreaRange: '',
  ceilingHeight: '',
  propertyClass: '',
  floorRange: '',
  apartmentsCountText: '',
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
  const hasActiveListFilters = Boolean(search.trim() || statusFilter);

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
      setIsLoading(false);
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

  function resetListFilters() {
    setSearch('');
    setStatusFilter('');
    setPage(1);
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
        <AdminButton tone="secondary" type="button" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Назад
        </AdminButton>
      </header>

      <section className="toolbar" aria-label="Фильтры объектов">
        <div className="object-toolbar-main">
          <label className="toolbar-field toolbar-field--search">
            <span>Поиск</span>
            <span className="toolbar-input-shell">
              <SearchIcon data-icon="inline-start" />
              <Input
                aria-label="Поиск объектов"
                className="admin-toolbar-search"
                placeholder="Название, slug, адрес, застройщик"
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </span>
          </label>

          <label className="toolbar-field toolbar-field--status">
            <span>Статус</span>
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
          </label>
        </div>

        <div className="object-toolbar-actions">
          <AdminButton disabled={!hasActiveListFilters} tone="secondary" type="button" onClick={resetListFilters}>
            Сбросить
          </AdminButton>
          <AdminButton
            disabled={!canCreate}
            tone="primary"
            type="button"
            onClick={() => navigate('/admin/objects/new')}
          >
            <PlusIcon data-icon="inline-start" />
            Новый объект
          </AdminButton>
        </div>
      </section>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <AdminPanel className="table-panel" role="region" aria-label="Список объектов">
        <div className="table-meta object-table-meta">
          <span>{isLoading ? 'Загрузка объектов' : `Найдено: ${total}`}</span>
          <span>
            Страница {page} из {totalPages}
          </span>
        </div>

        <Table className="admin-table">
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={getSortAria(sortBy, sortDirection, 'title')} className="object-title-column">
                <SortButton active={sortBy === 'title'} direction={sortDirection} onClick={() => handleSort('title')}>
                  Название
                </SortButton>
              </TableHead>
              <TableHead aria-sort={getSortAria(sortBy, sortDirection, 'status')}>
                <SortButton active={sortBy === 'status'} direction={sortDirection} onClick={() => handleSort('status')}>
                  Статус
                </SortButton>
              </TableHead>
              <TableHead>Застройщик</TableHead>
              <TableHead>Локация</TableHead>
              <TableHead aria-sort={getSortAria(sortBy, sortDirection, 'priceFrom')}>
                <SortButton
                  active={sortBy === 'priceFrom'}
                  direction={sortDirection}
                  onClick={() => handleSort('priceFrom')}
                >
                  Цена
                </SortButton>
              </TableHead>
              <TableHead aria-sort={getSortAria(sortBy, sortDirection, 'completionYear')}>
                <SortButton
                  active={sortBy === 'completionYear'}
                  direction={sortDirection}
                  onClick={() => handleSort('completionYear')}
                >
                  Срок
                </SortButton>
              </TableHead>
              <TableHead aria-sort={getSortAria(sortBy, sortDirection, 'createdAt')}>
                <SortButton
                  active={sortBy === 'createdAt'}
                  direction={sortDirection}
                  onClick={() => handleSort('createdAt')}
                >
                  Создан
                </SortButton>
              </TableHead>
              <TableHead className="object-action-column">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {objects.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="object-title-column">
                  <div className="object-title-cell">
                    <strong>{item.title}</strong>
                    <code>{item.slug}</code>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="object-status-cell">
                    <AdminStatusBadge className={`object-status object-status--${item.status.toLowerCase()}`}>
                      {objectStatusLabels[item.status]}
                    </AdminStatusBadge>
                    <span className="table-subtext">Обновлен: {formatDate(item.updatedAt)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className={item.developer ? undefined : 'muted-cell'}>
                    {item.developer?.name ?? 'Не указан'}
                  </span>
                </TableCell>
                <TableCell>
                  <span className={getObjectDistrictName(item) ? undefined : 'muted-cell'}>
                    {getObjectDistrictName(item) ?? 'Не указана'}
                  </span>
                  {getObjectMetroSummary(item) ? <span className="table-subtext">{getObjectMetroSummary(item)}</span> : null}
                </TableCell>
                <TableCell>
                  <strong className="object-price-cell">{formatPrice(item.priceFrom)}</strong>
                  {item.pricePerMeterFrom ? (
                    <span className="table-subtext">{formatPrice(item.pricePerMeterFrom)} за м²</span>
                  ) : null}
                </TableCell>
                <TableCell>{formatCompletion(item.completionYear, item.completionQuarter)}</TableCell>
                <TableCell>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                </TableCell>
                <TableCell className="object-action-column">
                  <AdminButton
                    tone="text"
                    type="button"
                    onClick={() => navigate(`/admin/objects/${item.id}/edit`)}
                  >
                    Открыть
                  </AdminButton>
                </TableCell>
              </TableRow>
            ))}

            {!isLoading && objects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <AdminEmptyState
                    title="Объекты не найдены"
                    description={
                      hasActiveListFilters
                        ? 'Сбросьте фильтры или измените поисковый запрос.'
                        : 'Создайте первый объект, чтобы он появился в списке.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        <div className="pagination">
          <AdminButton
            disabled={page <= 1}
            tone="secondary"
            type="button"
            onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
          >
            Назад
          </AdminButton>
          <AdminButton
            disabled={page >= totalPages}
            tone="secondary"
            type="button"
            onClick={() => setPage((currentPage) => currentPage + 1)}
          >
            Вперёд
          </AdminButton>
        </div>
      </AdminPanel>
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
  const [isJsonFieldsOpen, setIsJsonFieldsOpen] = useState(false);
  const coverImage = props.object?.images.find((image) => image.isCover) ?? props.object?.images[0] ?? null;
  const previewStatus = props.object?.status ?? 'DRAFT';
  const previewDeveloperName =
    findById(props.developers, props.form.developerId)?.name ?? props.object?.developer?.name ?? 'Не выбран';
  const previewDistrictName =
    findById(props.districtLocations, props.form.primaryLocationId)?.name ??
    getNamesByIds(props.districtLocations, props.form.districtLocationIds)[0] ??
    (props.object ? getObjectDistrictName(props.object) : null) ??
    'Не указан';
  const previewMetroSummary =
    getNamesByIds(props.metroStations, props.form.metroStationIds).slice(0, 2).join(', ') ||
    (props.object ? getObjectMetroSummary(props.object) : null) ||
    'Не указано';

  useEffect(() => {
    if (props.error?.startsWith('Features JSON')) {
      setIsJsonFieldsOpen(true);
    }
  }, [props.error]);

  return (
    <div className="admin-objects admin-objects--editor">
      <header className="page-header">
        <div>
          <p className="eyebrow">{props.isCreateRoute ? 'Новый объект' : 'Редактирование объекта'}</p>
          <h2>{props.isCreateRoute ? 'Создание объекта' : props.object?.title ?? 'Объект'}</h2>
        </div>
        <div className="header-actions">
          {props.object?.status !== 'PUBLISHED' && !props.isCreateRoute ? (
            <AdminButton
              disabled={!props.canPublish || props.isSubmitting}
              tone="success"
              type="button"
              onClick={props.onPublish}
            >
              <SendIcon data-icon="inline-start" />
              Опубликовать
            </AdminButton>
          ) : null}
          <AdminButton tone="secondary" type="button" onClick={props.onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Назад
          </AdminButton>
        </div>
      </header>

      {props.error ? <AdminAlert tone="error">{props.error}</AdminAlert> : null}
      {props.notice ? <AdminAlert tone="notice">{props.notice}</AdminAlert> : null}

      <div className="object-editor-layout">
        <form className="object-form editor-panel" onSubmit={props.onSubmit}>
          <fieldset disabled={props.isLoading || props.isSubmitting || (!props.isCreateRoute && !props.canUpdate)}>
            <div className="object-form-sections">
              <ObjectFormSection title="Основные данные" description="Название, описание и ссылка на материалы застройщика.">
                <FieldGroup className="form-grid">
                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-title">Название</FieldLabel>
                    <Input
                      id="object-title"
                      required
                      maxLength={240}
                      type="text"
                      value={props.form.title}
                      onChange={(event) => props.onFormChange({ ...props.form, title: event.target.value })}
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-description">Описание</FieldLabel>
                    <textarea
                      id="object-description"
                      rows={7}
                      value={props.form.description}
                      onChange={(event) => props.onFormChange({ ...props.form, description: event.target.value })}
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-architecture-description">Архитектура</FieldLabel>
                    <textarea
                      id="object-architecture-description"
                      maxLength={10000}
                      rows={5}
                      value={props.form.architectureDescription}
                      onChange={(event) =>
                        props.onFormChange({ ...props.form, architectureDescription: event.target.value })
                      }
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-infrastructure-description">Инфраструктура</FieldLabel>
                    <textarea
                      id="object-infrastructure-description"
                      maxLength={10000}
                      rows={5}
                      value={props.form.infrastructureDescription}
                      onChange={(event) =>
                        props.onFormChange({ ...props.form, infrastructureDescription: event.target.value })
                      }
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-filling-description">Наполнение</FieldLabel>
                    <textarea
                      id="object-filling-description"
                      maxLength={10000}
                      rows={5}
                      value={props.form.fillingDescription}
                      onChange={(event) =>
                        props.onFormChange({ ...props.form, fillingDescription: event.target.value })
                      }
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-layouts-url">Планировки и цены</FieldLabel>
                    <Input
                      id="object-layouts-url"
                      inputMode="url"
                      placeholder="https://developer.example/plans"
                      type="url"
                      value={props.form.layoutsUrl}
                      onChange={(event) => props.onFormChange({ ...props.form, layoutsUrl: event.target.value })}
                    />
                  </Field>
                </FieldGroup>
              </ObjectFormSection>

              <ObjectFormSection title="Цены и сроки" description="Публичные значения для карточек, каталога и предпросмотра.">
                <FieldGroup className="form-grid">
                  <Field>
                    <FieldLabel htmlFor="object-price-from">Цена от</FieldLabel>
                    <Input
                      id="object-price-from"
                      inputMode="decimal"
                      type="text"
                      value={props.form.priceFrom}
                      onChange={(event) => props.onFormChange({ ...props.form, priceFrom: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-price-meter">Цена за метр от</FieldLabel>
                    <Input
                      id="object-price-meter"
                      inputMode="decimal"
                      type="text"
                      value={props.form.pricePerMeterFrom}
                      onChange={(event) => props.onFormChange({ ...props.form, pricePerMeterFrom: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-completion-year">Год сдачи</FieldLabel>
                    <Input
                      id="object-completion-year"
                      inputMode="numeric"
                      type="text"
                      value={props.form.completionYear}
                      onChange={(event) => props.onFormChange({ ...props.form, completionYear: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-completion-quarter">Квартал</FieldLabel>
                    <select
                      id="object-completion-quarter"
                      value={props.form.completionQuarter}
                      onChange={(event) => props.onFormChange({ ...props.form, completionQuarter: event.target.value })}
                    >
                      <option value="">Не указан</option>
                      <option value="1">1 квартал</option>
                      <option value="2">2 квартал</option>
                      <option value="3">3 квартал</option>
                      <option value="4">4 квартал</option>
                    </select>
                  </Field>
                </FieldGroup>
              </ObjectFormSection>

              <ObjectFormSection
                title="Параметры карточки"
                description="Ручные значения для блока основных параметров на публичной карточке."
              >
                <FieldGroup className="form-grid">
                  <Field>
                    <FieldLabel htmlFor="object-krt-name">КРТ</FieldLabel>
                    <Input
                      id="object-krt-name"
                      maxLength={240}
                      type="text"
                      value={props.form.krtName}
                      onChange={(event) => props.onFormChange({ ...props.form, krtName: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-apartment-area-range">Площадь квартир</FieldLabel>
                    <Input
                      id="object-apartment-area-range"
                      maxLength={120}
                      placeholder="От 35 м²"
                      type="text"
                      value={props.form.apartmentAreaRange}
                      onChange={(event) =>
                        props.onFormChange({ ...props.form, apartmentAreaRange: event.target.value })
                      }
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-ceiling-height">Высота потолков</FieldLabel>
                    <Input
                      id="object-ceiling-height"
                      maxLength={120}
                      placeholder="3,1 метра"
                      type="text"
                      value={props.form.ceilingHeight}
                      onChange={(event) => props.onFormChange({ ...props.form, ceilingHeight: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-property-class">Класс недвижимости</FieldLabel>
                    <Input
                      id="object-property-class"
                      maxLength={120}
                      placeholder="Премиум-класс"
                      type="text"
                      value={props.form.propertyClass}
                      onChange={(event) => props.onFormChange({ ...props.form, propertyClass: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-floor-range">Этажность</FieldLabel>
                    <Input
                      id="object-floor-range"
                      maxLength={120}
                      placeholder="8 - 25 этажей"
                      type="text"
                      value={props.form.floorRange}
                      onChange={(event) => props.onFormChange({ ...props.form, floorRange: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-apartments-count-text">Количество квартир</FieldLabel>
                    <Input
                      id="object-apartments-count-text"
                      maxLength={120}
                      placeholder="672 квартиры"
                      type="text"
                      value={props.form.apartmentsCountText}
                      onChange={(event) =>
                        props.onFormChange({ ...props.form, apartmentsCountText: event.target.value })
                      }
                    />
                  </Field>
                </FieldGroup>
              </ObjectFormSection>

              <ObjectFormSection title="Локация" description="Адрес, координаты, районы, окружение и метро.">
                <FieldGroup className="form-grid">
                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-address">Адрес</FieldLabel>
                    <Input
                      id="object-address"
                      type="text"
                      value={props.form.address}
                      onChange={(event) => props.onFormChange({ ...props.form, address: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-latitude">Широта</FieldLabel>
                    <Input
                      id="object-latitude"
                      inputMode="decimal"
                      type="text"
                      value={props.form.latitude}
                      onChange={(event) => props.onFormChange({ ...props.form, latitude: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-longitude">Долгота</FieldLabel>
                    <Input
                      id="object-longitude"
                      inputMode="decimal"
                      type="text"
                      value={props.form.longitude}
                      onChange={(event) => props.onFormChange({ ...props.form, longitude: event.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-developer">Застройщик</FieldLabel>
                    <select
                      id="object-developer"
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
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-primary-location">Основной район</FieldLabel>
                    <select
                      id="object-primary-location"
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
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-districts">Районы</FieldLabel>
                    <select
                      id="object-districts"
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
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-areas">Окружение</FieldLabel>
                    <select
                      id="object-areas"
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
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-metro">Метро</FieldLabel>
                    <select
                      id="object-metro"
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
                  </Field>
                </FieldGroup>
              </ObjectFormSection>

              <ObjectFormSection
                title="JSON-поля"
                description="Технические свойства объекта. Формат должен остаться валидным JSON-объектом."
                action={
                  <AdminButton
                    aria-controls="object-json-fields"
                    aria-expanded={isJsonFieldsOpen}
                    tone="secondary"
                    type="button"
                    onClick={() => setIsJsonFieldsOpen((currentValue) => !currentValue)}
                  >
                    {isJsonFieldsOpen ? (
                      <ChevronUpIcon data-icon="inline-start" />
                    ) : (
                      <ChevronDownIcon data-icon="inline-start" />
                    )}
                    {isJsonFieldsOpen ? 'Скрыть JSON-поля' : 'Показать JSON-поля'}
                  </AdminButton>
                }
              >
                {isJsonFieldsOpen ? (
                  <FieldGroup id="object-json-fields">
                    <Field>
                      <FieldLabel htmlFor="object-features-json">Features JSON</FieldLabel>
                      <textarea
                        id="object-features-json"
                        rows={7}
                        spellCheck={false}
                        value={props.form.featuresText}
                        onChange={(event) => props.onFormChange({ ...props.form, featuresText: event.target.value })}
                      />
                    </Field>
                  </FieldGroup>
                ) : null}
              </ObjectFormSection>
            </div>

            <div className="form-actions object-form-actions">
              <AdminButton
                disabled={props.isSubmitting || (props.isCreateRoute ? false : !props.canUpdate)}
                tone="primary"
                type="submit"
              >
                <SaveIcon data-icon="inline-start" />
                {props.isCreateRoute ? 'Создать' : 'Сохранить'}
              </AdminButton>
            </div>
          </fieldset>
        </form>

        <aside className="object-side">
          <AdminPanel className="editor-panel object-preview" role="region" aria-label="Предпросмотр карточки">
            <div className="panel-title-row">
              <div>
                <p className="eyebrow">Предпросмотр</p>
                <h3>{props.form.title.trim() || 'Название объекта'}</h3>
              </div>
              <AdminStatusBadge className={`object-status object-status--${previewStatus.toLowerCase()}`}>
                {objectStatusLabels[previewStatus]}
              </AdminStatusBadge>
            </div>
            <div className="preview-media">
              {coverImage && props.accessToken ? (
                <SecureImage
                  accessToken={props.accessToken}
                  alt={coverImage.alt ?? props.form.title}
                  fileId={coverImage.file.id}
                  variant="card"
                />
              ) : (
                <span>Нет обложки</span>
              )}
            </div>
            <dl className="preview-facts">
              <div>
                <dt>Цена</dt>
                <dd>{formatPrice(props.form.priceFrom)}</dd>
              </div>
              <div>
                <dt>За м²</dt>
                <dd>{formatPrice(props.form.pricePerMeterFrom)}</dd>
              </div>
              <div>
                <dt>Срок</dt>
                <dd>{formatCompletion(props.form.completionYear, props.form.completionQuarter)}</dd>
              </div>
              <div>
                <dt>Район</dt>
                <dd>{previewDistrictName}</dd>
              </div>
            </dl>
            <div className="preview-detail-list">
              <div>
                <span>Адрес</span>
                <strong>{props.form.address.trim() || 'Адрес не указан'}</strong>
              </div>
              <div>
                <span>Застройщик</span>
                <strong>{previewDeveloperName}</strong>
              </div>
              <div>
                <span>Метро</span>
                <strong>{previewMetroSummary}</strong>
              </div>
            </div>
          </AdminPanel>

          {!props.isCreateRoute ? (
            <>
              <AdminPanel className="editor-panel media-panel" role="region" aria-label="Медиа объекта">
                <div className="panel-title-row">
                  <div>
                    <p className="eyebrow">Медиа</p>
                    <h3>Обложка и галерея</h3>
                  </div>
                  <span className="panel-count">{props.object?.images.length ?? 0} фото</span>
                </div>

                <div className="upload-stack">
                  <FileUploadRow
                    accept="image/jpeg,image/png,image/webp"
                    buttonLabel="Загрузить"
                    disabled={!props.canUpload || props.isUploading}
                    file={props.coverFile}
                    label="Обложка"
                    onChange={props.onCoverFileChange}
                    onUpload={props.onUploadCover}
                  />
                  <FileUploadRow
                    accept="image/jpeg,image/png,image/webp"
                    buttonLabel="Добавить"
                    disabled={!props.canUpload || props.isUploading}
                    file={props.galleryFile}
                    label="Галерея"
                    onChange={props.onGalleryFileChange}
                    onUpload={props.onUploadGalleryImage}
                  />
                </div>

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
                      <div className="gallery-item-main">
                        <div className="gallery-thumb">
                          {props.accessToken ? (
                            <SecureImage
                              accessToken={props.accessToken}
                              alt={image.alt ?? image.title ?? `Фото ${index + 1}`}
                              fileId={image.file.id}
                              variant="thumbnail"
                            />
                          ) : (
                            <span>Фото</span>
                          )}
                        </div>
                        <div>
                          <strong>{image.isCover ? 'Обложка' : `Фото ${index + 1}`}</strong>
                          <span>{image.title || image.file.originalName || `sortOrder ${image.sortOrder}`}</span>
                        </div>
                      </div>
                      <div className="gallery-actions">
                        <AdminButton
                          tone="text"
                          disabled={index === 0}
                          type="button"
                          onClick={() => props.onGalleryMove(image.id, -1)}
                        >
                          <ChevronUpIcon data-icon="inline-start" />
                          Выше
                        </AdminButton>
                        <AdminButton
                          tone="text"
                          disabled={index === (props.object?.images.length ?? 0) - 1}
                          type="button"
                          onClick={() => props.onGalleryMove(image.id, 1)}
                        >
                          <ChevronDownIcon data-icon="inline-start" />
                          Ниже
                        </AdminButton>
                        <AdminButton
                          className="text-button--danger"
                          tone="text"
                          disabled={!props.canDeleteMedia || props.isUploading}
                          type="button"
                          onClick={() => props.onGalleryDelete(image.id)}
                        >
                          <Trash2Icon data-icon="inline-start" />
                          Удалить
                        </AdminButton>
                      </div>
                    </li>
                  ))}
                </ul>
                {props.object?.images.length === 0 ? (
                  <AdminEmptyState title="Галерея пустая" description="Сначала загрузите обложку или добавьте фото в галерею." />
                ) : null}
              </AdminPanel>

              <AdminPanel className="editor-panel media-panel" role="region" aria-label="Файлы объекта">
                <div className="panel-title-row">
                  <div>
                    <p className="eyebrow">PDF-файлы</p>
                    <h3>Документы объекта</h3>
                  </div>
                  <span className="panel-count">{props.object?.files.length ?? 0} файлов</span>
                </div>

                <FieldGroup className="file-upload-fields">
                  <Field>
                    <FieldLabel htmlFor="object-file-type">Тип</FieldLabel>
                    <select
                      id="object-file-type"
                      value={props.objectFileType}
                      onChange={(event) => props.onObjectFileTypeChange(event.target.value as ObjectFileType)}
                    >
                      {Object.entries(fileTypeLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="object-file-title">Название</FieldLabel>
                    <Input
                      id="object-file-title"
                      type="text"
                      value={props.objectFileTitle}
                      onChange={(event) => props.onObjectFileTitleChange(event.target.value)}
                    />
                  </Field>
                </FieldGroup>

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
                  {props.object?.files.map((file) => {
                    const displayTitle = getLinkedFileTitle(file, fileTypeLabels);
                    const displayOriginalName = getLinkedFileOriginalName(file);

                    return (
                      <li key={file.id}>
                        <div className="file-main">
                          <strong>{displayTitle}</strong>
                          <span>{displayOriginalName}</span>
                        </div>
                        <div className="file-actions">
                          <strong>{fileTypeLabels[file.type]}</strong>
                          {file.file.sizeBytes ? <span>{formatFileSize(file.file.sizeBytes)}</span> : null}
                          <AdminButton
                            className="text-button--danger"
                            tone="text"
                            disabled={!props.canDeleteMedia || props.isUploading}
                            type="button"
                            onClick={() => props.onLinkedFileDelete(file.id)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            Удалить
                          </AdminButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {props.object?.files.length === 0 ? (
                  <AdminEmptyState title="PDF-файлов нет" description="Добавьте презентацию, планировку или другой документ." />
                ) : null}
              </AdminPanel>
            </>
          ) : (
            <AdminPanel className="editor-panel media-panel" role="region">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">Медиа</p>
                  <h3>Файлы появятся после создания</h3>
                </div>
              </div>
              <p className="helper-text">Загрузка обложки, галереи и PDF откроется после создания объекта.</p>
            </AdminPanel>
          )}
        </aside>
      </div>
    </div>
  );
}

function ObjectFormSection({
  action,
  children,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="object-form-section">
      <div className="object-form-section-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {action ? <div className="object-form-section-action">{action}</div> : null}
      </div>
      {children}
    </section>
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
      <label className="upload-field">
        {label}
        <input
          accept={accept}
          type="file"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
      </label>
      <div className="upload-action">
        <span className={file ? 'upload-file-name' : 'upload-file-name upload-file-name--empty'}>
          {file?.name ?? 'Файл не выбран'}
        </span>
        <AdminButton disabled={disabled || !file} tone="secondary" type="button" onClick={onUpload}>
          <UploadIcon data-icon="inline-start" />
          {buttonLabel}
        </AdminButton>
      </div>
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
    <AdminButton
      className={active ? 'table-sort-button table-sort-button--active' : 'table-sort-button'}
      fit={false}
      tone="text"
      type="button"
      onClick={onClick}
    >
      {children}
      {active ? (
        direction === 'asc' ? (
          <ArrowUpIcon data-icon="inline-end" />
        ) : (
          <ArrowDownIcon data-icon="inline-end" />
        )
      ) : (
        <ArrowUpDownIcon data-icon="inline-end" />
      )}
    </AdminButton>
  );
}

function createFormFromObject(object: RealEstateObjectDetail): ObjectFormState {
  const districtLocation = getObjectDistrictLocation(object);

  return {
    title: object.title,
    description: object.description ?? '',
    architectureDescription: object.architectureDescription ?? '',
    infrastructureDescription: object.infrastructureDescription ?? '',
    fillingDescription: object.fillingDescription ?? '',
    layoutsUrl: object.layoutsUrl ?? '',
    krtName: object.krtName ?? '',
    apartmentAreaRange: object.apartmentAreaRange ?? '',
    ceilingHeight: object.ceilingHeight ?? '',
    propertyClass: object.propertyClass ?? '',
    floorRange: object.floorRange ?? '',
    apartmentsCountText: object.apartmentsCountText ?? '',
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
    architectureDescription: emptyToNull(form.architectureDescription),
    infrastructureDescription: emptyToNull(form.infrastructureDescription),
    fillingDescription: emptyToNull(form.fillingDescription),
    layoutsUrl: emptyToNull(form.layoutsUrl),
    krtName: emptyToNull(form.krtName),
    apartmentAreaRange: emptyToNull(form.apartmentAreaRange),
    ceilingHeight: emptyToNull(form.ceilingHeight),
    propertyClass: emptyToNull(form.propertyClass),
    floorRange: emptyToNull(form.floorRange),
    apartmentsCountText: emptyToNull(form.apartmentsCountText),
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

type ObjectWithMetroStations = {
  metroStations: Array<Pick<ObjectMetroStation, 'lineName' | 'name'>>;
};

function getSortAria(activeSortBy: SortField, direction: SortDirection, sortField: SortField) {
  if (activeSortBy !== sortField) {
    return undefined;
  }

  return direction === 'asc' ? 'ascending' : 'descending';
}

function getObjectDistrictName(object: ObjectWithLocations) {
  return getObjectDistrictLocation(object)?.name ?? null;
}

function getObjectDistrictLocation(object: ObjectWithLocations) {
  if (object.primaryLocation?.type === 'DISTRICT') {
    return object.primaryLocation;
  }

  return object.locations.find((location) => location.type === 'DISTRICT') ?? null;
}

function getObjectMetroSummary(object: ObjectWithMetroStations) {
  if (object.metroStations.length === 0) {
    return null;
  }

  const stationNames = object.metroStations.map((station) =>
    station.lineName ? `${station.name}, ${station.lineName}` : station.name,
  );

  if (stationNames.length <= 2) {
    return stationNames.join(', ');
  }

  return `${stationNames.slice(0, 2).join(', ')} и еще ${stationNames.length - 2}`;
}

function findById<T extends { id: string }>(items: T[], id: string) {
  if (!id) {
    return null;
  }

  return items.find((item) => item.id === id) ?? null;
}

function getNamesByIds(items: Array<{ id: string; name: string }>, ids: string[]) {
  const itemById = new Map(items.map((item) => [item.id, item.name]));

  return ids.map((id) => itemById.get(id)).filter((name): name is string => Boolean(name));
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

  const contentSectionFields = [
    ['Архитектура', form.architectureDescription],
    ['Инфраструктура', form.infrastructureDescription],
    ['Наполнение', form.fillingDescription],
  ] as const;

  const tooLongContentSectionField = contentSectionFields.find(([, value]) => value.trim().length > 10000);

  if (tooLongContentSectionField) {
    return `${tooLongContentSectionField[0]} не должно быть длиннее 10000 символов`;
  }

  if (form.krtName.trim().length > 240) {
    return 'КРТ не должен быть длиннее 240 символов';
  }

  const manualDetailFields = [
    ['Площадь квартир', form.apartmentAreaRange],
    ['Высота потолков', form.ceilingHeight],
    ['Класс недвижимости', form.propertyClass],
    ['Этажность', form.floorRange],
    ['Количество квартир', form.apartmentsCountText],
  ] as const;

  const tooLongManualDetailField = manualDetailFields.find(([, value]) => value.trim().length > 120);

  if (tooLongManualDetailField) {
    return `${tooLongManualDetailField[0]} не должно быть длиннее 120 символов`;
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

function formatFileSize(value: string) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return value;
  }

  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  if (bytes < 1024 * 1024) {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024)} КБ`;
  }

  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} МБ`;
}

function formatCompletion(year: number | string | null, quarter: number | string | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}
