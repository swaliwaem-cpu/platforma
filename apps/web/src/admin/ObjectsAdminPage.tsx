import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
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

type GalleryDraftItem = {
  draftId: string;
  kind: 'existing' | 'new';
  imageId: string | null;
  file: File | null;
  previewUrl: string;
  name: string;
  isUploading?: boolean;
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
  const [isGalleryModalOpen, setIsGalleryModalOpen] = useState(false);
  const [galleryDraftItems, setGalleryDraftItems] = useState<GalleryDraftItem[]>([]);
  const [galleryCoverDraftId, setGalleryCoverDraftId] = useState<string | null>(null);
  const [galleryDeletedImageIds, setGalleryDeletedImageIds] = useState<string[]>([]);
  const [galleryModalError, setGalleryModalError] = useState<string | null>(null);
  const [galleryModalProgress, setGalleryModalProgress] = useState<string | null>(null);
  const [objectFile, setObjectFile] = useState<File | null>(null);
  const [objectFileType, setObjectFileType] = useState<ObjectFileType>('PRESENTATION');
  const [objectFileTitle, setObjectFileTitle] = useState('');
  const galleryDraftItemsRef = useRef<GalleryDraftItem[]>([]);
  const pendingEditorErrorRef = useRef<string | null>(null);
  const pendingEditorNoticeRef = useRef<string | null>(null);

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

  useEffect(() => () => {
    revokeGalleryDraftPreviewUrls(galleryDraftItemsRef.current);
    galleryDraftItemsRef.current = [];
  }, []);

  function resetUploads() {
    resetGalleryModalDraft();
    setObjectFile(null);
    setObjectFileTitle('');
    setObjectFileType('PRESENTATION');
  }

  function openGalleryModal() {
    const nextDraftItems = createGalleryDraftItems(object?.images ?? []);

    revokeGalleryDraftPreviewUrls(galleryDraftItemsRef.current);
    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryCoverDraftId(getInitialGalleryCoverDraftId(object?.images ?? []));
    setGalleryDeletedImageIds([]);
    setGalleryModalError(null);
    setGalleryModalProgress(null);
    setIsGalleryModalOpen(true);
  }

  function closeGalleryModal() {
    resetGalleryModalDraft();
  }

  function addGalleryDraftFiles(files: FileList | File[]) {
    const nextNewItems = createNewGalleryDraftItems(files);

    if (nextNewItems.length === 0) {
      return;
    }

    const nextDraftItems = [...galleryDraftItemsRef.current, ...nextNewItems];
    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryModalError(null);

    if (!galleryCoverDraftId) {
      setGalleryCoverDraftId(nextNewItems[0]?.draftId ?? null);
    }
  }

  function removeGalleryDraftItem(draftId: string) {
    const removedItem = galleryDraftItemsRef.current.find((item) => item.draftId === draftId);

    if (!removedItem) {
      return;
    }

    revokeGalleryDraftPreviewUrl(removedItem);

    const removedImageId = removedItem.kind === 'existing' ? removedItem.imageId : null;

    if (removedImageId) {
      setGalleryDeletedImageIds((currentIds) =>
        currentIds.includes(removedImageId) ? currentIds : [...currentIds, removedImageId],
      );
    }

    const nextDraftItems = galleryDraftItemsRef.current.filter((item) => item.draftId !== draftId);
    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryModalError(null);

    if (galleryCoverDraftId === draftId) {
      setGalleryCoverDraftId(null);
    }
  }

  function reorderGalleryDraftItem(draggedDraftId: string, targetDraftId: string) {
    if (draggedDraftId === targetDraftId) {
      return;
    }

    const currentItems = galleryDraftItemsRef.current;
    const draggedIndex = currentItems.findIndex((item) => item.draftId === draggedDraftId);
    const targetIndex = currentItems.findIndex((item) => item.draftId === targetDraftId);

    if (draggedIndex === -1 || targetIndex === -1) {
      return;
    }

    const nextDraftItems = [...currentItems];
    const draggedItem = nextDraftItems.splice(draggedIndex, 1)[0];
    const nextTargetIndex = nextDraftItems.findIndex((item) => item.draftId === targetDraftId);

    if (!draggedItem || nextTargetIndex === -1) {
      return;
    }

    nextDraftItems.splice(nextTargetIndex, 0, draggedItem);
    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryModalError(null);
  }

  function moveGalleryDraftItem(draftId: string, direction: 'up' | 'down') {
    const currentItems = galleryDraftItemsRef.current;
    const currentIndex = currentItems.findIndex((item) => item.draftId === draftId);

    if (currentIndex === -1) {
      return;
    }

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    if (targetIndex < 0 || targetIndex >= currentItems.length) {
      return;
    }

    const nextDraftItems = [...currentItems];
    const movedItem = nextDraftItems.splice(currentIndex, 1)[0];

    if (!movedItem) {
      return;
    }

    nextDraftItems.splice(targetIndex, 0, movedItem);
    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryModalError(null);
  }

  function resetGalleryModalDraft() {
    revokeGalleryDraftPreviewUrls(galleryDraftItemsRef.current);
    galleryDraftItemsRef.current = [];
    setIsGalleryModalOpen(false);
    setGalleryDraftItems([]);
    setGalleryCoverDraftId(null);
    setGalleryDeletedImageIds([]);
    setGalleryModalError(null);
    setGalleryModalProgress(null);
  }

  async function saveGalleryModalChanges() {
    if (!accessToken) {
      setGalleryModalError('Нет доступа');
      return;
    }

    if (galleryModalProgress) {
      return;
    }

    const draftItems = galleryDraftItemsRef.current;

    if (draftItems.length > 0 && !galleryCoverDraftId) {
      setGalleryModalError('Выберите обложку для галереи');
      return;
    }

    const coverDraftItem = galleryCoverDraftId
      ? draftItems.find((item) => item.draftId === galleryCoverDraftId) ?? null
      : null;

    if (galleryCoverDraftId && !coverDraftItem) {
      setGalleryModalError('Выберите обложку для галереи');
      return;
    }

    if (!canUpdate) {
      setGalleryModalError('Нет прав на изменение галереи');
      return;
    }

    if (draftItems.some((item) => item.kind === 'new') && !canUpload) {
      setGalleryModalError('Нет прав на загрузку изображений');
      return;
    }

    if (galleryDeletedImageIds.length > 0 && !canDeleteMedia) {
      setGalleryModalError('Нет прав на удаление изображений');
      return;
    }

    setGalleryModalError(null);
    setNotice(null);

    try {
      if (isCreateRoute) {
        const validationError = validateObjectForm(form);

        if (validationError) {
          setGalleryModalError(validationError);
          return;
        }

        if (!canCreate) {
          setGalleryModalError('Нет прав на создание объекта');
          return;
        }

        setIsSubmitting(true);
        setGalleryModalProgress('Создание объекта');

        const payload = createPayloadFromForm(form);
        const createData = await apiRequest<ObjectResponse>('/objects', accessToken, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        setObject(createData.object);
        setForm(createFormFromObject(createData.object));

        try {
          const layoutData = await persistGalleryDraftForObject(createData.object.id, createData.object.images);

          setObject(layoutData.object);
          setForm(createFormFromObject(layoutData.object));
          resetGalleryModalDraft();
          pendingEditorNoticeRef.current = 'Объект создан, галерея сохранена';
          navigate(`/admin/objects/${layoutData.object.id}/edit`);
          setNotice('Объект создан, галерея сохранена');
        } catch (caughtError) {
          const mediaErrorMessage =
            caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить галерею';

          resetGalleryModalDraft();
          pendingEditorErrorRef.current = `Объект создан, но медиа не загрузились: ${mediaErrorMessage}`;
          navigate(`/admin/objects/${createData.object.id}/edit`);
        }

        return;
      }

      if (!editObjectId) {
        setGalleryModalError('Нет доступа');
        return;
      }

      const layoutData = await persistGalleryDraftForObject(editObjectId, object?.images ?? []);

      setObject(layoutData.object);
      setForm(createFormFromObject(layoutData.object));
      resetGalleryModalDraft();
      setNotice('Галерея сохранена');
    } catch (caughtError) {
      setGalleryModalError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить галерею');
    } finally {
      setGalleryModalProgress(null);
      setIsSubmitting(false);
    }
  }

  async function persistGalleryDraftForObject(objectId: string, initialImages: ObjectImage[]) {
    if (!accessToken) {
      throw new Error('Нет доступа');
    }

    const draftItems = galleryDraftItemsRef.current;
    const coverDraftItem = galleryCoverDraftId
      ? draftItems.find((item) => item.draftId === galleryCoverDraftId) ?? null
      : null;
    const imageIdByDraftId = new Map<string, string>();
    let currentImages = initialImages;

    draftItems.forEach((item) => {
      if (item.kind === 'existing' && item.imageId) {
        imageIdByDraftId.set(item.draftId, item.imageId);
      }
    });

    if (galleryDeletedImageIds.length > 0) {
      setGalleryModalProgress('Удаление изображений');
    }

    for (const imageId of galleryDeletedImageIds) {
      const deleteData = await apiRequest<ObjectResponse>(`/objects/${objectId}/gallery/${imageId}`, accessToken, {
        method: 'DELETE',
      });

      currentImages = deleteData.object.images;
    }

    if (coverDraftItem?.kind === 'new') {
      if (!coverDraftItem.file) {
        throw new Error('Не удалось прочитать файл обложки');
      }

      setGalleryModalProgress('Загрузка обложки');

      const coverData = await uploadObjectMedia(objectId, 'cover', coverDraftItem.file);
      const uploadedCoverImage = findUploadedGalleryImage(currentImages, coverData.object.images);

      imageIdByDraftId.set(coverDraftItem.draftId, uploadedCoverImage.id);
      currentImages = coverData.object.images;
    }

    const galleryUploadItems = draftItems.filter((item) => item.kind === 'new' && item.draftId !== galleryCoverDraftId);

    if (galleryUploadItems.length > 0) {
      setGalleryModalProgress('Загрузка изображений');
    }

    for (const item of galleryUploadItems) {
      if (!item.file) {
        throw new Error('Не удалось прочитать файл галереи');
      }

      const galleryData = await uploadObjectMedia(objectId, 'gallery', item.file);
      const uploadedGalleryImage = findUploadedGalleryImage(currentImages, galleryData.object.images);

      imageIdByDraftId.set(item.draftId, uploadedGalleryImage.id);
      currentImages = galleryData.object.images;
    }

    const imageIds = draftItems.map((item) => {
      const imageId = imageIdByDraftId.get(item.draftId);

      if (!imageId) {
        throw new Error('Не удалось сохранить изображение галереи');
      }

      return imageId;
    });
    const coverImageId = coverDraftItem ? imageIdByDraftId.get(coverDraftItem.draftId) ?? null : null;

    if (draftItems.length > 0 && !coverImageId) {
      throw new Error('Не удалось сохранить обложку галереи');
    }

    setGalleryModalProgress('Сохранение порядка');

    return apiRequest<ObjectResponse>(`/objects/${objectId}/gallery/layout`, accessToken, {
      method: 'PATCH',
      body: JSON.stringify({
        imageIds,
        coverImageId,
      }),
    });
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

      if (pendingEditorErrorRef.current) {
        setError(pendingEditorErrorRef.current);
        pendingEditorErrorRef.current = null;
      }

      if (pendingEditorNoticeRef.current) {
        setNotice(pendingEditorNoticeRef.current);
        pendingEditorNoticeRef.current = null;
      }
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

  async function uploadObjectMedia(objectId: string, kind: 'cover' | 'gallery', file: File) {
    if (!accessToken) {
      throw new Error('Нет доступа');
    }

    const body = new FormData();
    body.append('file', file);

    return apiRequest<ObjectResponse>(`/objects/${objectId}/${kind}`, accessToken, {
      method: 'POST',
      body,
    });
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

  if (isCreateRoute || editObjectId) {
    return (
      <ObjectEditor
        accessToken={accessToken}
        canPublish={canPublish}
        canCreate={canCreate}
        canUpdate={canUpdate}
        canDeleteMedia={canDeleteMedia}
        canUpload={canUpload}
        developers={developers}
        error={error}
        form={form}
        galleryCoverDraftId={galleryCoverDraftId}
        galleryDraftItems={galleryDraftItems}
        galleryModalError={galleryModalError}
        galleryModalProgress={galleryModalProgress}
        isGalleryModalOpen={isGalleryModalOpen}
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
        onFormChange={setForm}
        onGalleryCoverDraftChange={setGalleryCoverDraftId}
        onGalleryDraftMove={moveGalleryDraftItem}
        onGalleryDraftRemove={removeGalleryDraftItem}
        onGalleryDraftReorder={reorderGalleryDraftItem}
        onGalleryFilesAdd={addGalleryDraftFiles}
        onGalleryModalClose={closeGalleryModal}
        onGalleryModalOpen={openGalleryModal}
        onGalleryModalSave={() => void saveGalleryModalChanges()}
        onLinkedFileDelete={(objectFileId) => void deleteLinkedFile(objectFileId)}
        onObjectFileChange={setObjectFile}
        onObjectFileTitleChange={setObjectFileTitle}
        onObjectFileTypeChange={setObjectFileType}
        onPublish={() => void publishObject()}
        onSubmit={(event) => void handleSubmit(event)}
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
  canCreate: boolean;
  canPublish: boolean;
  canUpdate: boolean;
  canUpload: boolean;
  developers: ObjectDeveloper[];
  districtLocations: ObjectLocation[];
  areaLocations: ObjectLocation[];
  error: string | null;
  form: ObjectFormState;
  galleryCoverDraftId: string | null;
  galleryDraftItems: GalleryDraftItem[];
  galleryModalError: string | null;
  galleryModalProgress: string | null;
  isGalleryModalOpen: boolean;
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
  onFormChange: (form: ObjectFormState) => void;
  onGalleryCoverDraftChange: (draftId: string) => void;
  onGalleryDraftMove: (draftId: string, direction: 'up' | 'down') => void;
  onGalleryDraftRemove: (draftId: string) => void;
  onGalleryDraftReorder: (draggedDraftId: string, targetDraftId: string) => void;
  onGalleryFilesAdd: (files: FileList | File[]) => void;
  onGalleryModalClose: () => void;
  onGalleryModalOpen: () => void;
  onGalleryModalSave: () => void;
  onLinkedFileDelete: (objectFileId: string) => void;
  onObjectFileChange: (file: File | null) => void;
  onObjectFileTitleChange: (title: string) => void;
  onObjectFileTypeChange: (type: ObjectFileType) => void;
  onPublish: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
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
          <fieldset
            disabled={props.isLoading || props.isSubmitting || (props.isCreateRoute ? !props.canCreate : !props.canUpdate)}
          >
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
                disabled={props.isSubmitting || (props.isCreateRoute ? !props.canCreate : !props.canUpdate)}
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

          <AdminPanel className="editor-panel media-panel" role="region" aria-label="Медиа объекта">
            <div className="panel-title-row">
              <div>
                <p className="eyebrow">Медиа</p>
                <h3>Обложка и галерея</h3>
              </div>
              <span className="panel-count">{props.object?.images.length ?? props.galleryDraftItems.length} фото</span>
            </div>

            <AdminButton
              disabled={
                !props.canUpdate ||
                props.isSubmitting ||
                (!props.canUpload && (props.object?.images.length ?? props.galleryDraftItems.length) === 0)
              }
              tone="secondary"
              type="button"
              onClick={props.onGalleryModalOpen}
            >
              <ImageIcon data-icon="inline-start" />
              Управлять галереей
            </AdminButton>
          </AdminPanel>

          {!props.isCreateRoute ? (
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
          ) : (
            <AdminPanel className="editor-panel media-panel" role="region">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">PDF-файлы</p>
                  <h3>Документы объекта</h3>
                </div>
              </div>
              <p className="helper-text">PDF-файлы можно будет добавить после создания объекта.</p>
            </AdminPanel>
          )}
        </aside>
      </div>
      {props.isGalleryModalOpen ? (
        <GalleryManagementModal
          accessToken={props.accessToken}
          canDeleteMedia={props.canDeleteMedia}
          canUpload={props.canUpload}
          coverDraftId={props.galleryCoverDraftId}
          draftItems={props.galleryDraftItems}
          error={props.galleryModalError}
          existingImages={props.object?.images ?? []}
          isSaving={Boolean(props.galleryModalProgress)}
          progress={props.galleryModalProgress}
          onAddFiles={props.onGalleryFilesAdd}
          onCancel={props.onGalleryModalClose}
          onClose={props.onGalleryModalClose}
          onCoverChange={props.onGalleryCoverDraftChange}
          onDraftMove={props.onGalleryDraftMove}
          onDraftRemove={props.onGalleryDraftRemove}
          onDraftReorder={props.onGalleryDraftReorder}
          onSave={props.onGalleryModalSave}
        />
      ) : null}
    </div>
  );
}

function GalleryManagementModal({
  accessToken,
  canDeleteMedia,
  canUpload,
  coverDraftId,
  draftItems,
  error,
  existingImages,
  isSaving,
  progress,
  onAddFiles,
  onCancel,
  onClose,
  onCoverChange,
  onDraftMove,
  onDraftRemove,
  onDraftReorder,
  onSave,
}: {
  accessToken: string | null;
  canDeleteMedia: boolean;
  canUpload: boolean;
  coverDraftId: string | null;
  draftItems: GalleryDraftItem[];
  error: string | null;
  existingImages: ObjectImage[];
  isSaving: boolean;
  progress: string | null;
  onAddFiles: (files: FileList | File[]) => void;
  onCancel: () => void;
  onClose: () => void;
  onCoverChange: (draftId: string) => void;
  onDraftMove: (draftId: string, direction: 'up' | 'down') => void;
  onDraftRemove: (draftId: string) => void;
  onDraftReorder: (draggedDraftId: string, targetDraftId: string) => void;
  onSave: () => void;
}) {
  const [draggedDraftId, setDraggedDraftId] = useState<string | null>(null);
  const [dropTargetDraftId, setDropTargetDraftId] = useState<string | null>(null);
  const [isCoverDropTarget, setIsCoverDropTarget] = useState(false);
  const existingImageById = useMemo(() => new Map(existingImages.map((image) => [image.id, image])), [existingImages]);
  const coverDraftItem = draftItems.find((item) => item.draftId === coverDraftId) ?? null;
  const coverExistingImage = coverDraftItem?.imageId ? existingImageById.get(coverDraftItem.imageId) ?? null : null;
  const coverSlotClassName = [
    'gallery-cover-slot',
    coverDraftItem ? 'gallery-cover-slot--active' : null,
    isCoverDropTarget ? 'gallery-cover-slot--drop-target' : null,
  ]
    .filter(Boolean)
    .join(' ');

  function clearGalleryDragState() {
    setDraggedDraftId(null);
    setDropTargetDraftId(null);
    setIsCoverDropTarget(false);
  }

  function getDraggedDraftId(event: DragEvent<HTMLElement>) {
    return event.dataTransfer.getData('text/plain') || draggedDraftId;
  }

  function handleTileDragStart(event: DragEvent<HTMLLIElement>, draftId: string) {
    if (isSaving) {
      event.preventDefault();
      return;
    }

    setDraggedDraftId(draftId);
    setDropTargetDraftId(null);
    setIsCoverDropTarget(false);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draftId);
  }

  function handleTileDragOver(event: DragEvent<HTMLLIElement>, targetDraftId: string) {
    if (isSaving || !draggedDraftId || draggedDraftId === targetDraftId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetDraftId(targetDraftId);
    setIsCoverDropTarget(false);
  }

  function handleTileDrop(event: DragEvent<HTMLLIElement>, targetDraftId: string) {
    event.preventDefault();

    const nextDraggedDraftId = getDraggedDraftId(event);

    clearGalleryDragState();

    if (!nextDraggedDraftId || nextDraggedDraftId === targetDraftId) {
      return;
    }

    onDraftReorder(nextDraggedDraftId, targetDraftId);
  }

  function handleCoverSlotDragOver(event: DragEvent<HTMLDivElement>) {
    if (isSaving || !draggedDraftId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetDraftId(null);
    setIsCoverDropTarget(true);
  }

  function handleCoverSlotDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();

    const nextDraggedDraftId = getDraggedDraftId(event);

    clearGalleryDragState();

    if (!nextDraggedDraftId || !draftItems.some((item) => item.draftId === nextDraggedDraftId)) {
      return;
    }

    onCoverChange(nextDraggedDraftId);
  }

  function handleCoverSlotDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsCoverDropTarget(false);
  }

  return (
    <div className="gallery-modal-backdrop">
      <section
        aria-labelledby="gallery-modal-title"
        aria-modal="true"
        className="gallery-modal"
        role="dialog"
      >
        <div className="gallery-modal-header">
          <div>
            <p className="eyebrow">Медиа</p>
            <h3 id="gallery-modal-title">Обложка и галерея</h3>
          </div>
          <AdminButton
            aria-label="Закрыть"
            className="gallery-modal-close"
            disabled={isSaving}
            tone="text"
            type="button"
            onClick={onClose}
          >
            <XIcon />
          </AdminButton>
        </div>

        {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
        {progress ? <AdminAlert tone="notice">{progress}</AdminAlert> : null}

        <div
          className={coverSlotClassName}
          onDragLeave={handleCoverSlotDragLeave}
          onDragOver={handleCoverSlotDragOver}
          onDrop={handleCoverSlotDrop}
        >
          {coverDraftItem ? (
            <>
              <div className="gallery-cover-preview">
                <GalleryDraftPreview
                  accessToken={accessToken}
                  existingImage={coverExistingImage}
                  item={coverDraftItem}
                  variant="card"
                />
              </div>
              <div className="gallery-cover-meta">
                <span>Обложка</span>
                <strong>{coverDraftItem.name}</strong>
              </div>
            </>
          ) : (
            <div className="gallery-cover-placeholder">
              <ImageIcon />
              <span>Обложка не выбрана</span>
            </div>
          )}
        </div>

        <label aria-disabled={!canUpload || isSaving} className="gallery-upload-dropzone">
          <UploadIcon />
          <span>Добавить изображения</span>
          <input
            accept="image/jpeg,image/png,image/webp"
            disabled={!canUpload || isSaving}
            multiple
            type="file"
            onChange={(event) => {
              if (event.currentTarget.files) {
                onAddFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }
            }}
          />
        </label>

        {draftItems.length > 0 ? (
          <ul className="gallery-tile-grid">
            {draftItems.map((item, itemIndex) => {
              const existingImage = item.imageId ? existingImageById.get(item.imageId) ?? null : null;
              const isCover = item.draftId === coverDraftId;
              const tileClassName = [
                'gallery-tile',
                isCover ? 'gallery-tile--cover' : null,
                item.draftId === draggedDraftId ? 'gallery-tile--dragging' : null,
                item.draftId === dropTargetDraftId ? 'gallery-tile--drop-target' : null,
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <li
                  key={item.draftId}
                  className={tileClassName}
                  draggable={!isSaving}
                  onDragEnd={clearGalleryDragState}
                  onDragOver={(event) => handleTileDragOver(event, item.draftId)}
                  onDragStart={(event) => handleTileDragStart(event, item.draftId)}
                  onDrop={(event) => handleTileDrop(event, item.draftId)}
                >
                  <AdminButton
                    aria-label={`Удалить ${item.name}`}
                    className="gallery-tile-remove-button"
                    disabled={isSaving || (item.kind === 'existing' && !canDeleteMedia)}
                    fit={false}
                    size="icon"
                    title="Удалить"
                    tone="danger"
                    type="button"
                    onClick={() => onDraftRemove(item.draftId)}
                  >
                    <Trash2Icon />
                  </AdminButton>
                  <button
                    aria-pressed={isCover}
                    className="gallery-tile-button"
                    disabled={isSaving}
                    type="button"
                    onClick={() => onCoverChange(item.draftId)}
                  >
                    <div className="gallery-tile-preview">
                      <GalleryDraftPreview
                        accessToken={accessToken}
                        existingImage={existingImage}
                        item={item}
                        variant="thumbnail"
                      />
                    </div>
                    <span className="gallery-tile-name">{item.name}</span>
                    {item.kind === 'new' ? <span className="gallery-tile-status">Новое</span> : null}
                    {isCover ? <span className="gallery-tile-status">Обложка</span> : null}
                  </button>
                  <div className="gallery-tile-order-actions" aria-label={`Порядок ${item.name}`}>
                    <AdminButton
                      aria-label={`Поднять ${item.name}`}
                      className="gallery-tile-order-button"
                      disabled={isSaving || itemIndex === 0}
                      fit={false}
                      size="icon"
                      title="Выше"
                      tone="text"
                      type="button"
                      onClick={() => onDraftMove(item.draftId, 'up')}
                    >
                      <ArrowUpIcon />
                    </AdminButton>
                    <AdminButton
                      aria-label={`Опустить ${item.name}`}
                      className="gallery-tile-order-button"
                      disabled={isSaving || itemIndex === draftItems.length - 1}
                      fit={false}
                      size="icon"
                      title="Ниже"
                      tone="text"
                      type="button"
                      onClick={() => onDraftMove(item.draftId, 'down')}
                    >
                      <ArrowDownIcon />
                    </AdminButton>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <AdminEmptyState title="Галерея пустая" description="Добавьте изображения перед сохранением галереи." />
        )}

        <div className="gallery-modal-actions">
          <AdminButton disabled={isSaving} tone="secondary" type="button" onClick={onCancel}>
            Отмена
          </AdminButton>
          <AdminButton disabled={isSaving} tone="primary" type="button" onClick={onSave}>
            <SaveIcon data-icon="inline-start" />
            Сохранить
          </AdminButton>
        </div>
      </section>
    </div>
  );
}

function GalleryDraftPreview({
  accessToken,
  existingImage,
  item,
  variant,
}: {
  accessToken: string | null;
  existingImage: ObjectImage | null;
  item: GalleryDraftItem;
  variant: 'card' | 'thumbnail';
}) {
  if (item.kind === 'new') {
    return <img alt={item.name} src={item.previewUrl} />;
  }

  if (accessToken && existingImage) {
    return (
      <SecureImage
        accessToken={accessToken}
        alt={existingImage.alt ?? existingImage.title ?? item.name}
        fileId={existingImage.file.id}
        variant={variant}
      />
    );
  }

  return <span>Фото</span>;
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

function createGalleryDraftItems(images: ObjectImage[]): GalleryDraftItem[] {
  return images.map((image) => ({
    draftId: getExistingGalleryDraftId(image.id),
    kind: 'existing',
    imageId: image.id,
    file: null,
    previewUrl: image.file.url ?? '',
    name: getGalleryDraftImageName(image),
  }));
}

function createNewGalleryDraftItems(files: FileList | File[]): GalleryDraftItem[] {
  return Array.from(files).map((file) => ({
    draftId: getNewGalleryDraftId(),
    kind: 'new',
    imageId: null,
    file,
    previewUrl: URL.createObjectURL(file),
    name: file.name || 'Новое изображение',
  }));
}

function findUploadedGalleryImage(previousImages: ObjectImage[], nextImages: ObjectImage[]) {
  const previousImageIds = new Set(previousImages.map((image) => image.id));
  const uploadedImage = nextImages.find((image) => !previousImageIds.has(image.id));

  if (!uploadedImage) {
    throw new Error('Не удалось определить загруженное изображение');
  }

  return uploadedImage;
}

function getInitialGalleryCoverDraftId(images: ObjectImage[]) {
  const coverImage = images.find((image) => image.isCover) ?? images[0] ?? null;

  return coverImage ? getExistingGalleryDraftId(coverImage.id) : null;
}

function getExistingGalleryDraftId(imageId: string) {
  return `existing:${imageId}`;
}

function getNewGalleryDraftId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `new:${crypto.randomUUID()}`;
  }

  return `new:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function getGalleryDraftImageName(image: ObjectImage) {
  return image.title || image.file.originalName || `Фото ${image.sortOrder + 1}`;
}

function revokeGalleryDraftPreviewUrl(item: GalleryDraftItem) {
  if (item.kind !== 'new') {
    return;
  }

  URL.revokeObjectURL(item.previewUrl);
}

function revokeGalleryDraftPreviewUrls(items: GalleryDraftItem[]) {
  items.forEach((item) => revokeGalleryDraftPreviewUrl(item));
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
