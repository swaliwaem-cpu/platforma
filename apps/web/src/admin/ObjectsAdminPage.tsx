import {
  FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
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
  ObjectImageSection,
  ObjectLocation,
  ObjectMetroStation,
  ObjectResponse,
  ObjectStoredFile,
  ObjectsResponse,
  RealEstateObjectDetail,
  RealEstateObjectSummary,
} from '@platforma/shared';

import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';

import { useAuth } from '../auth/AuthProvider';
import { SecureImage, buildMediaFileContentUrl } from '../files/SecureImage';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import {
  ObjectQuickEditTable,
  objectStatusLabels,
  type ObjectQuickEditCellValue,
  type ObjectQuickEditColumnKey,
  type SortDirection,
  type SortField,
} from './ObjectQuickEditTable';
import { apiRequest } from './api';
import { getLinkedFileOriginalName, getLinkedFileTitle } from './fileDisplay';
import {
  createObjectQuickEditRequest,
  shouldRemoveObjectQuickEditRow,
  updateObjectQuickEditRows,
} from './objectQuickEditPersistence';
import {
  matchesQuickEditSearch,
  normalizeCeilingHeight,
  normalizeObjectPriceValue,
} from './objectQuickEditTransforms';

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
  coordinates: string;
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
  kind: 'existing' | 'new' | 'staged';
  imageId: string | null;
  stagedFileId?: string | null;
  file: File | null;
  previewUrl: string | null;
  name: string;
  section: ObjectImageSection | null;
  isUploading?: boolean;
};

type GalleryStreamUploadResponse = ObjectResponse & {
  file: ObjectStoredFile;
};

const fileTypeLabels: Record<ObjectFileType, string> = {
  PRESENTATION: 'Презентация',
  FLOOR_PLAN: 'Планировка',
  DOCUMENT: 'Документ',
  OTHER: 'Другое',
};

const objectPdfUploadLimit = 10;
const objectListPageSize = 20;
const searchableMultiSelectResultLimit = 24;
const galleryPreviewMaxDimension = 640;
const galleryPreviewMimeType = 'image/jpeg';
const galleryPreviewQuality = 0.82;

const gallerySectionOptions: {
  value: ObjectImageSection;
  label: string;
}[] = [
  { value: 'ARCHITECTURE', label: 'Архитектура' },
  { value: 'INTERIORS', label: 'Интерьеры' },
  { value: 'FILLING', label: 'Наполнение' },
];

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
  coordinates: '',
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
  const [isObjectFiltersExpanded, setIsObjectFiltersExpanded] = useState(false);
  const [districtSearch, setDistrictSearch] = useState('');
  const [areaSearch, setAreaSearch] = useState('');
  const [metroSearch, setMetroSearch] = useState('');
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
  const [galleryModalProgressPercent, setGalleryModalProgressPercent] = useState<number | null>(null);
  const [objectFiles, setObjectFiles] = useState<File[]>([]);
  const [objectFileType, setObjectFileType] = useState<ObjectFileType>('PRESENTATION');
  const [objectFileTitle, setObjectFileTitle] = useState('');
  const galleryDraftItemsRef = useRef<GalleryDraftItem[]>([]);
  const galleryModalSaveInFlightRef = useRef(false);
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
  const hasActiveAdvancedListFilters = Boolean(districtSearch.trim() || areaSearch.trim() || metroSearch.trim());
  const hasActiveListFilters = Boolean(search.trim() || statusFilter || hasActiveAdvancedListFilters);

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
  }, [
    accessToken,
    areaSearch,
    districtSearch,
    isListRoute,
    metroSearch,
    page,
    search,
    sortBy,
    sortDirection,
    statusFilter,
  ]);

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
    setObjectFiles([]);
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
    setGalleryModalProgressPercent(null);
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
    void hydrateNewGalleryDraftPreviews(nextNewItems);

    if (!galleryCoverDraftId) {
      setGalleryCoverDraftId(nextNewItems[0]?.draftId ?? null);
    }
  }

  async function hydrateNewGalleryDraftPreviews(items: GalleryDraftItem[]) {
    for (const item of items) {
      if (item.kind !== 'new' || !item.file) {
        continue;
      }

      const previewUrl = await createGalleryPreviewUrl(item.file);
      const currentItems = galleryDraftItemsRef.current;
      const currentItem = currentItems.find((draftItem) => draftItem.draftId === item.draftId);

      if (!currentItem || currentItem.kind !== 'new') {
        URL.revokeObjectURL(previewUrl);
        continue;
      }

      const nextDraftItems = currentItems.map((draftItem) =>
        draftItem.draftId === item.draftId ? { ...draftItem, previewUrl } : draftItem,
      );

      galleryDraftItemsRef.current = nextDraftItems;
      setGalleryDraftItems(nextDraftItems);

      if (currentItem.previewUrl) {
        URL.revokeObjectURL(currentItem.previewUrl);
      }
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

  function assignGalleryDraftSection(draftId: string, section: ObjectImageSection | null) {
    const nextDraftItems = galleryDraftItemsRef.current.map((item) =>
      item.draftId === draftId ? { ...item, section } : item,
    );

    galleryDraftItemsRef.current = nextDraftItems;
    setGalleryDraftItems(nextDraftItems);
    setGalleryModalError(null);
  }

  function resetGalleryModalDraft() {
    revokeGalleryDraftPreviewUrls(galleryDraftItemsRef.current);
    galleryDraftItemsRef.current = [];
    galleryModalSaveInFlightRef.current = false;
    setIsGalleryModalOpen(false);
    setGalleryDraftItems([]);
    setGalleryCoverDraftId(null);
    setGalleryDeletedImageIds([]);
    setGalleryModalError(null);
    setGalleryModalProgress(null);
    setGalleryModalProgressPercent(null);
  }

  function setGallerySaveProgress(message: string, percent: number | null) {
    setGalleryModalProgress(message);
    setGalleryModalProgressPercent(percent);
  }

  async function saveGalleryModalChanges() {
    if (!accessToken) {
      setGalleryModalError('Нет доступа');
      return;
    }

    if (galleryModalProgress || galleryModalSaveInFlightRef.current) {
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
    galleryModalSaveInFlightRef.current = true;

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
        setGallerySaveProgress('Создание объекта', 5);

        const payload = createPayloadFromForm(form);
        const createData = await apiRequest<ObjectResponse>('/objects', accessToken, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        setObject(createData.object);
        setForm(createFormFromObject(createData.object));

        try {
          const layoutData = await persistGalleryDraftForObject(createData.object.id);

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

      const layoutData = await persistGalleryDraftForObject(editObjectId);

      setObject(layoutData.object);
      setForm(createFormFromObject(layoutData.object));
      resetGalleryModalDraft();
      setNotice('Галерея сохранена');
    } catch (caughtError) {
      setGalleryModalError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить галерею');
    } finally {
      galleryModalSaveInFlightRef.current = false;
      setGalleryModalProgress(null);
      setGalleryModalProgressPercent(null);
      setIsSubmitting(false);
    }
  }

  async function persistGalleryDraftForObject(objectId: string) {
    if (!accessToken) {
      throw new Error('Нет доступа');
    }

    setGallerySaveProgress('Проверка актуальной галереи', 10);

    const currentData = await apiRequest<ObjectResponse>(`/objects/${objectId}`, accessToken);
    const reconciledDraft = reconcileGalleryDraftItemsWithCurrentGallery(
      galleryDraftItemsRef.current,
      galleryCoverDraftId,
      currentData.object.images,
    );

    galleryDraftItemsRef.current = reconciledDraft.draftItems;
    setGalleryDraftItems(reconciledDraft.draftItems);
    setGalleryCoverDraftId(reconciledDraft.coverDraftId);

    const uploadedDraft = await uploadGalleryDraftFiles(objectId, reconciledDraft.draftItems);

    galleryDraftItemsRef.current = uploadedDraft.draftItems;
    setGalleryDraftItems(uploadedDraft.draftItems);

    let savedData: ObjectResponse;

    try {
      const batchBody = createGalleryBatchBody(uploadedDraft.draftItems, reconciledDraft.coverDraftId);

      if (batchBody.fileCount !== 0) {
        throw new Error('Не удалось подготовить галерею к сохранению');
      }

      setGallerySaveProgress('Сохранение галереи', 95);

      savedData = await apiRequest<ObjectResponse>(`/objects/${objectId}/gallery/batch`, accessToken, {
        method: 'PATCH',
        body: batchBody.formData,
      });
    } catch (caughtError) {
      await cleanupStagedGalleryFiles(uploadedDraft.stagedFileIds);

      const restoredDraftItems = restoreStagedGalleryDraftItems(uploadedDraft.draftItems, uploadedDraft.stagedFileIds);
      galleryDraftItemsRef.current = restoredDraftItems;
      setGalleryDraftItems(restoredDraftItems);

      throw caughtError;
    }

    setGallerySaveProgress('Галерея сохранена', 100);

    return savedData;
  }

  async function uploadGalleryDraftFiles(objectId: string, draftItems: GalleryDraftItem[]) {
    if (!accessToken) {
      throw new Error('Нет доступа');
    }

    const newItems = draftItems.filter((item): item is GalleryDraftItem & { kind: 'new'; file: File } => item.kind === 'new' && item.file !== null);

    if (newItems.length === 0) {
      return {
        draftItems,
        stagedFileIds: [],
      };
    }

    const uploadedFiles = new Map<string, ObjectStoredFile>();
    const stagedFileIds: string[] = [];

    try {
      for (const item of newItems) {
        setGallerySaveProgress(
          `Загрузка изображений ${uploadedFiles.size + 1}/${newItems.length}`,
          calculateGalleryUploadProgressPercent(uploadedFiles.size, newItems.length),
        );

        const uploadedData = await apiRequest<GalleryStreamUploadResponse>(
          `/objects/${objectId}/gallery/stream`,
          accessToken,
          {
            method: 'POST',
            body: item.file,
            headers: {
              'Content-Type': item.file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(item.file.name || 'image'),
            },
          },
        );

        uploadedFiles.set(item.draftId, uploadedData.file);
        stagedFileIds.push(uploadedData.file.id);
      }
    } catch (caughtError) {
      await cleanupStagedGalleryFiles(stagedFileIds);
      throw caughtError;
    }

    const nextDraftItems: GalleryDraftItem[] = draftItems.map((item) => {
      if (item.kind !== 'new') {
        return item;
      }

      const uploadedFile = uploadedFiles.get(item.draftId);

      if (!uploadedFile) {
        throw new Error('Не удалось сохранить изображение галереи');
      }

      return {
        ...item,
        kind: 'staged',
        imageId: null,
        stagedFileId: uploadedFile.id,
        file: item.file,
        name: getGalleryDraftFileName(uploadedFile, item.name),
        section: item.section,
      };
    });

    return {
      draftItems: nextDraftItems,
      stagedFileIds,
    };
  }

  async function cleanupStagedGalleryFiles(fileIds: string[]) {
    if (!accessToken || !canDeleteMedia || fileIds.length === 0) {
      return;
    }

    await Promise.all(
      fileIds.map((fileId) =>
        apiRequest<void>(`/files/${fileId}`, accessToken, {
          method: 'DELETE',
        }).catch(() => undefined),
      ),
    );
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
        limit: String(objectListPageSize),
        sortBy,
        sortDirection,
      });

      if (search.trim()) {
        params.set('search', search.trim());
      }

      if (statusFilter) {
        params.set('status', statusFilter);
      }

      if (districtSearch.trim()) {
        params.set('districtSearch', districtSearch.trim());
      }

      if (areaSearch.trim()) {
        params.set('areaSearch', areaSearch.trim());
      }

      if (metroSearch.trim()) {
        params.set('metroSearch', metroSearch.trim());
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

  async function handleInlineEditCommit({
    objectId,
    columnKey,
    value,
  }: {
    objectId: string;
    columnKey: ObjectQuickEditColumnKey;
    value: ObjectQuickEditCellValue;
  }) {
    if (!accessToken) {
      const inlineEditErrorMessage = 'Нет доступа';

      setError(inlineEditErrorMessage);
      throw new Error(inlineEditErrorMessage);
    }

    setError(null);
    setNotice(null);

    try {
      const request = createObjectQuickEditRequest({
        objectId,
        columnKey,
        value,
        developers,
        parseCoordinates: parseCoordinatePair,
      });
      const data = await apiRequest<ObjectResponse>(request.path, accessToken, {
        method: request.method,
        body: JSON.stringify(request.payload),
      });
      const shouldRemoveRow = shouldRemoveObjectQuickEditRow(objects, data.object, statusFilter);

      setObjects((currentObjects) => updateObjectQuickEditRows(currentObjects, data.object, statusFilter));

      if (shouldRemoveRow) {
        const nextTotal = Math.max(0, total - 1);

        setTotal(nextTotal);
        setTotalPages(Math.max(1, Math.ceil(nextTotal / objectListPageSize)));
      }

      setNotice('Объект сохранён');
    } catch (caughtError) {
      const inlineEditErrorMessage = caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить ячейку';

      setError(inlineEditErrorMessage);
      throw new Error(inlineEditErrorMessage);
    }
  }

  async function uploadLinkedFiles(selectedFiles: FileList | File[]) {
    if (!accessToken) {
      return;
    }

    const filesToUpload = Array.from(selectedFiles);

    if (filesToUpload.length === 0) {
      setObjectFiles([]);
      return;
    }

    const currentFileCount = object?.files.length ?? 0;
    const remainingSlots = objectPdfUploadLimit - currentFileCount;

    if (remainingSlots <= 0) {
      setObjectFiles([]);
      setError(`Можно загрузить не больше ${objectPdfUploadLimit} PDF-файлов на объект`);
      return;
    }

    if (filesToUpload.length > remainingSlots) {
      setObjectFiles([]);
      setError(`Можно добавить ещё ${remainingSlots} PDF-файлов`);
      return;
    }

    setObjectFiles(filesToUpload);
    setIsUploading(true);
    setError(null);
    setNotice(null);

    let targetObjectId = editObjectId;
    let createdObjectId: string | null = null;
    let shouldResetSubmitting = false;
    let uploadedCount = 0;
    const uploadTitle = filesToUpload.length === 1 ? objectFileTitle : '';

    try {
      if (!targetObjectId && isCreateRoute) {
        const validationError = validateObjectForm(form);

        if (validationError) {
          setObjectFiles([]);
          setError(validationError);
          return;
        }

        if (!canCreate) {
          setObjectFiles([]);
          setError('Нет прав на создание объекта');
          return;
        }

        setIsSubmitting(true);
        shouldResetSubmitting = true;

        const payload = createPayloadFromForm(form);
        const createData = await apiRequest<ObjectResponse>('/objects', accessToken, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        targetObjectId = createData.object.id;
        createdObjectId = createData.object.id;
        setObject(createData.object);
        setForm(createFormFromObject(createData.object));
      }

      if (!targetObjectId) {
        setObjectFiles([]);
        setError('Нет доступа');
        return;
      }

      let latestObject: RealEstateObjectDetail | null = null;

      for (const selectedFile of filesToUpload) {
        const body = new FormData();
        body.append('file', selectedFile);
        body.append('type', objectFileType);
        body.append('title', uploadTitle);

        const data = await apiRequest<ObjectResponse>(`/objects/${targetObjectId}/files`, accessToken, {
          method: 'POST',
          body,
        });

        latestObject = data.object;
        uploadedCount += 1;
        setObject(data.object);
      }

      if (latestObject) {
        setObject(latestObject);
      }

      setObjectFiles([]);
      setObjectFileTitle('');

      if (createdObjectId) {
        if (latestObject) {
          setForm(createFormFromObject(latestObject));
        }
        pendingEditorNoticeRef.current = getUploadedPdfNotice(uploadedCount, true);
        navigate(`/admin/objects/${createdObjectId}/edit`);
      } else {
        setNotice(getUploadedPdfNotice(uploadedCount));
      }
    } catch (caughtError) {
      const uploadErrorMessage = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить PDF';

      if (createdObjectId) {
        setObjectFiles([]);
        pendingEditorErrorRef.current = `Объект создан, но PDF не загрузился: ${uploadErrorMessage}`;
        navigate(`/admin/objects/${createdObjectId}/edit`);
      } else if (uploadedCount > 0) {
        setError(`Часть PDF-файлов загружена, но загрузка остановилась: ${uploadErrorMessage}`);
      } else {
        setError(uploadErrorMessage);
      }
    } finally {
      setObjectFiles([]);
      setIsUploading(false);

      if (shouldResetSubmitting) {
        setIsSubmitting(false);
      }
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
    setDistrictSearch('');
    setAreaSearch('');
    setMetroSearch('');
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
        galleryModalProgressPercent={galleryModalProgressPercent}
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
        objectFiles={objectFiles}
        objectFileTitle={objectFileTitle}
        objectFileType={objectFileType}
        onBack={() => navigate('/admin/objects')}
        onFormChange={setForm}
        onGalleryCoverDraftChange={setGalleryCoverDraftId}
        onGalleryDraftMove={moveGalleryDraftItem}
        onGalleryDraftRemove={removeGalleryDraftItem}
        onGalleryDraftReorder={reorderGalleryDraftItem}
        onGalleryDraftSectionChange={assignGalleryDraftSection}
        onGalleryFilesAdd={addGalleryDraftFiles}
        onGalleryModalClose={closeGalleryModal}
        onGalleryModalOpen={openGalleryModal}
        onGalleryModalSave={() => void saveGalleryModalChanges()}
        onLinkedFileDelete={(objectFileId) => void deleteLinkedFile(objectFileId)}
        onObjectFilesChange={(files) => {
          void uploadLinkedFiles(files);
        }}
        onObjectFileTitleChange={setObjectFileTitle}
        onObjectFileTypeChange={setObjectFileType}
        onPublish={() => void publishObject()}
        onSubmit={(event) => void handleSubmit(event)}
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
          <AdminButton
            aria-controls="object-location-filters"
            aria-expanded={isObjectFiltersExpanded}
            tone="secondary"
            type="button"
            onClick={() => setIsObjectFiltersExpanded((isExpanded) => !isExpanded)}
          >
            {isObjectFiltersExpanded ? (
              <>
                <ChevronUpIcon data-icon="inline-start" />
                Скрыть фильтры
              </>
            ) : (
              <>
                <ChevronDownIcon data-icon="inline-start" />
                + Фильтры
              </>
            )}
          </AdminButton>
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

        {isObjectFiltersExpanded ? (
          <div className="object-toolbar-advanced" id="object-location-filters">
            <label className="toolbar-field">
              <span>Районы</span>
              <Input
                aria-label="Поиск по районам"
                placeholder="Название или slug"
                type="search"
                value={districtSearch}
                onChange={(event) => {
                  setDistrictSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>

            <label className="toolbar-field">
              <span>Окружение</span>
              <Input
                aria-label="Поиск по окружению"
                placeholder="Название или slug"
                type="search"
                value={areaSearch}
                onChange={(event) => {
                  setAreaSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>

            <label className="toolbar-field">
              <span>Метро</span>
              <Input
                aria-label="Поиск по метро"
                placeholder="Станция, линия или slug"
                type="search"
                value={metroSearch}
                onChange={(event) => {
                  setMetroSearch(event.target.value);
                  setPage(1);
                }}
              />
            </label>
          </div>
        ) : null}
      </section>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <AdminPanel className="table-panel object-table-panel" role="region" aria-label="Список объектов">
        <div className="table-meta object-table-meta">
          <span>{isLoading ? 'Загрузка объектов' : `Найдено: ${total}`}</span>
          <span>
            Страница {page} из {totalPages}
          </span>
        </div>

        <ObjectQuickEditTable
          developers={developers}
          hasActiveListFilters={hasActiveListFilters}
          isLoading={isLoading}
          metroStations={metroStations}
          objects={objects}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onInlineEditCommit={handleInlineEditCommit}
          onOpenObject={(objectId) => navigate(`/admin/objects/${objectId}/edit`)}
          onSort={handleSort}
        />

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
  galleryModalProgressPercent: number | null;
  isGalleryModalOpen: boolean;
  isCreateRoute: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  metroStations: ObjectMetroStation[];
  notice: string | null;
  object: RealEstateObjectDetail | null;
  objectFiles: File[];
  objectFileTitle: string;
  objectFileType: ObjectFileType;
  onBack: () => void;
  onFormChange: (form: ObjectFormState) => void;
  onGalleryCoverDraftChange: (draftId: string) => void;
  onGalleryDraftMove: (draftId: string, direction: 'up' | 'down') => void;
  onGalleryDraftRemove: (draftId: string) => void;
  onGalleryDraftReorder: (draggedDraftId: string, targetDraftId: string) => void;
  onGalleryDraftSectionChange: (draftId: string, section: ObjectImageSection | null) => void;
  onGalleryFilesAdd: (files: FileList | File[]) => void;
  onGalleryModalClose: () => void;
  onGalleryModalOpen: () => void;
  onGalleryModalSave: () => void;
  onLinkedFileDelete: (objectFileId: string) => void;
  onObjectFilesChange: (files: File[]) => void;
  onObjectFileTitleChange: (title: string) => void;
  onObjectFileTypeChange: (type: ObjectFileType) => void;
  onPublish: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function ObjectEditor(props: ObjectEditorProps) {
  const [isJsonFieldsOpen, setIsJsonFieldsOpen] = useState(false);
  const coverImage = props.object?.images.find((image) => image.isCover) ?? props.object?.images[0] ?? null;
  const previewStatus = props.object?.status ?? 'DRAFT';
  const previewCatalogPath = props.object ? `/objects/${encodeURIComponent(props.object.slug)}` : null;
  const saveButtonLabel = props.isCreateRoute ? 'Создать' : 'Сохранить';
  const isSaveDisabled = props.isLoading || props.isSubmitting || (props.isCreateRoute ? !props.canCreate : !props.canUpdate);
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
  const objectFileCount = props.object?.files.length ?? 0;
  const isObjectFileLimitReached = objectFileCount >= objectPdfUploadLimit;

  useEffect(() => {
    if (props.error?.startsWith('Features JSON')) {
      setIsJsonFieldsOpen(true);
    }
  }, [props.error]);

  return (
    <div className="admin-objects admin-objects--editor">
      <header className="page-header">
        <div>
          <div className="object-editor-kicker">
            <p className="eyebrow">{props.isCreateRoute ? 'Новый объект' : 'Редактирование объекта'}</p>
            {!props.isCreateRoute ? (
              <AdminStatusBadge className={`object-status object-status--${previewStatus.toLowerCase()}`}>
                {objectStatusLabels[previewStatus]}
              </AdminStatusBadge>
            ) : null}
          </div>
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
        <form className="object-form editor-panel" id="object-editor-form" onSubmit={props.onSubmit}>
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
                      onBlur={() =>
                        props.onFormChange({
                          ...props.form,
                          priceFrom: normalizeObjectPriceValue(props.form.priceFrom),
                        })
                      }
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
                      onBlur={() =>
                        props.onFormChange({
                          ...props.form,
                          pricePerMeterFrom: normalizeObjectPriceValue(props.form.pricePerMeterFrom),
                        })
                      }
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
                      onBlur={() =>
                        props.onFormChange({
                          ...props.form,
                          ceilingHeight: normalizeCeilingHeight(props.form.ceilingHeight),
                        })
                      }
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

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-coordinates">Координаты</FieldLabel>
                    <Input
                      id="object-coordinates"
                      inputMode="decimal"
                      placeholder="55.713384, 37.651074"
                      type="text"
                      value={props.form.coordinates}
                      onChange={(event) => props.onFormChange({ ...props.form, coordinates: event.target.value })}
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
                    <SearchableSelect
                      id="object-primary-location"
                      emptyLabel="Районы не найдены"
                      label="основной район"
                      options={props.districtLocations}
                      placeholder="Поиск основного района"
                      selectedIds={props.form.primaryLocationId ? [props.form.primaryLocationId] : []}
                      onSelectedIdsChange={(ids) =>
                        props.onFormChange({ ...props.form, primaryLocationId: ids[0] ?? '' })
                      }
                      getOptionLabel={(location) => location.name}
                      getSearchValues={(location) => [location.name, location.slug]}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-districts">Районы</FieldLabel>
                    <SearchableSelect
                      id="object-districts"
                      multiple
                      emptyLabel="Районы не найдены"
                      label="район"
                      options={props.districtLocations}
                      placeholder="Поиск районов"
                      selectedIds={props.form.districtLocationIds}
                      onSelectedIdsChange={(ids) =>
                        props.onFormChange({ ...props.form, districtLocationIds: ids })
                      }
                      getOptionLabel={(location) => location.name}
                      getSearchValues={(location) => [location.name, location.slug]}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="object-areas">Окружение</FieldLabel>
                    <SearchableSelect
                      id="object-areas"
                      multiple
                      emptyLabel="Окружение не найдено"
                      label="окружение"
                      options={props.areaLocations}
                      placeholder="Поиск окружения"
                      selectedIds={props.form.areaLocationIds}
                      onSelectedIdsChange={(ids) => props.onFormChange({ ...props.form, areaLocationIds: ids })}
                      getOptionLabel={(location) => location.name}
                      getSearchValues={(location) => [location.name, location.slug]}
                    />
                  </Field>

                  <Field className="field-wide">
                    <FieldLabel htmlFor="object-metro">Метро</FieldLabel>
                    <SearchableSelect
                      id="object-metro"
                      multiple
                      emptyLabel="Метро не найдено"
                      label="метро"
                      options={props.metroStations}
                      placeholder="Поиск метро"
                      selectedIds={props.form.metroStationIds}
                      onSelectedIdsChange={(ids) => props.onFormChange({ ...props.form, metroStationIds: ids })}
                      getOptionLabel={(station) => (station.lineName ? `${station.name}, ${station.lineName}` : station.name)}
                      getSearchValues={(station) => [station.name, station.slug, station.lineName]}
                    />
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
              <AdminButton disabled={isSaveDisabled} tone="primary" type="submit">
                <SaveIcon data-icon="inline-start" />
                {saveButtonLabel}
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
              <div className="object-preview-actions">
                <AdminButton disabled={isSaveDisabled} form="object-editor-form" tone="primary" type="submit">
                  <SaveIcon data-icon="inline-start" />
                  {saveButtonLabel}
                </AdminButton>
                {previewCatalogPath ? (
                  <AdminButton className="object-preview-catalog-link" tone="secondary" asChild>
                    <a aria-label="Открыть объект в каталоге" href={previewCatalogPath}>
                      <ExternalLinkIcon data-icon="inline-start" />
                      В каталоге
                    </a>
                  </AdminButton>
                ) : null}
              </div>
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
                <dd>{formatPriceFrom(props.form.priceFrom)}</dd>
              </div>
              <div>
                <dt>За м²</dt>
                <dd>{formatPricePerMeterFrom(props.form.pricePerMeterFrom)}</dd>
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

          <AdminPanel className="editor-panel media-panel" role="region" aria-label="Файлы объекта">
            <div className="panel-title-row">
              <div>
                <p className="eyebrow">PDF-файлы</p>
                <h3>Документы объекта</h3>
              </div>
              <span className="panel-count">
                {objectFileCount}/{objectPdfUploadLimit} файлов
              </span>
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
              disabled={!props.canUpload || props.isUploading || props.isSubmitting || isObjectFileLimitReached}
              files={props.objectFiles}
              label="Файл"
              multiple
              onChange={props.onObjectFilesChange}
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
            {(props.object?.files.length ?? 0) === 0 ? (
              <AdminEmptyState title="PDF-файлов нет" description="Добавьте презентацию, планировку или другой документ." />
            ) : null}
          </AdminPanel>
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
          progressPercent={props.galleryModalProgressPercent}
          onAddFiles={props.onGalleryFilesAdd}
          onCancel={props.onGalleryModalClose}
          onClose={props.onGalleryModalClose}
          onCoverChange={props.onGalleryCoverDraftChange}
          onDraftMove={props.onGalleryDraftMove}
          onDraftRemove={props.onGalleryDraftRemove}
          onDraftReorder={props.onGalleryDraftReorder}
          onSectionChange={props.onGalleryDraftSectionChange}
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
  progressPercent,
  onAddFiles,
  onCancel,
  onClose,
  onCoverChange,
  onDraftMove,
  onDraftRemove,
  onDraftReorder,
  onSectionChange,
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
  progressPercent: number | null;
  onAddFiles: (files: FileList | File[]) => void;
  onCancel: () => void;
  onClose: () => void;
  onCoverChange: (draftId: string) => void;
  onDraftMove: (draftId: string, direction: 'up' | 'down') => void;
  onDraftRemove: (draftId: string) => void;
  onDraftReorder: (draggedDraftId: string, targetDraftId: string) => void;
  onSectionChange: (draftId: string, section: ObjectImageSection | null) => void;
  onSave: () => void;
}) {
  const [draggedDraftId, setDraggedDraftId] = useState<string | null>(null);
  const [dropTargetDraftId, setDropTargetDraftId] = useState<string | null>(null);
  const [isCoverDropTarget, setIsCoverDropTarget] = useState(false);
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const draggedDraftIdRef = useRef<string | null>(null);
  const dropTargetDraftIdRef = useRef<string | null>(null);
  const isCoverDropTargetRef = useRef(false);
  const isSavingRef = useRef(isSaving);
  const draftItemsRef = useRef(draftItems);
  const existingImageById = useMemo(() => new Map(existingImages.map((image) => [image.id, image])), [existingImages]);
  const hasUnsavedChanges = useMemo(
    () => hasGalleryDraftChanges(draftItems, coverDraftId, existingImages),
    [coverDraftId, draftItems, existingImages],
  );
  const coverDraftItem = draftItems.find((item) => item.draftId === coverDraftId) ?? null;
  const coverExistingImage = coverDraftItem?.imageId ? existingImageById.get(coverDraftItem.imageId) ?? null : null;
  const coverSlotClassName = [
    'gallery-cover-slot',
    coverDraftItem ? 'gallery-cover-slot--active' : null,
    isCoverDropTarget ? 'gallery-cover-slot--drop-target' : null,
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    if (!hasUnsavedChanges) {
      setIsCloseConfirmOpen(false);
    }
  }, [hasUnsavedChanges]);

  useEffect(() => {
    isSavingRef.current = isSaving;
  }, [isSaving]);

  useEffect(() => {
    draftItemsRef.current = draftItems;
  }, [draftItems]);

  const clearGalleryDragState = useCallback(() => {
    draggedDraftIdRef.current = null;
    dropTargetDraftIdRef.current = null;
    isCoverDropTargetRef.current = false;
    setDraggedDraftId(null);
    setDropTargetDraftId(null);
    setIsCoverDropTarget(false);
  }, []);

  const getDraggedDraftId = useCallback(
    (event: DragEvent<HTMLElement>) => event.dataTransfer.getData('text/plain') || draggedDraftIdRef.current,
    [],
  );

  const handleTileDragStart = useCallback((event: DragEvent<HTMLLIElement>, draftId: string) => {
    if (isSavingRef.current) {
      event.preventDefault();
      return;
    }

    draggedDraftIdRef.current = draftId;
    dropTargetDraftIdRef.current = null;
    isCoverDropTargetRef.current = false;
    setDraggedDraftId(draftId);
    setDropTargetDraftId(null);
    setIsCoverDropTarget(false);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draftId);
  }, []);

  const handleTileDragOver = useCallback((event: DragEvent<HTMLLIElement>, targetDraftId: string) => {
    const draggedDraftId = draggedDraftIdRef.current;
    const dropTargetDraftId = dropTargetDraftIdRef.current;
    const isCoverDropTarget = isCoverDropTargetRef.current;

    if (isSavingRef.current || !draggedDraftId || draggedDraftId === targetDraftId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    if (dropTargetDraftId === targetDraftId && !isCoverDropTarget) {
      return;
    }

    dropTargetDraftIdRef.current = targetDraftId;
    isCoverDropTargetRef.current = false;
    setDropTargetDraftId(targetDraftId);
    setIsCoverDropTarget(false);
  }, []);

  const handleTileDrop = useCallback((event: DragEvent<HTMLLIElement>, targetDraftId: string) => {
    event.preventDefault();

    const nextDraggedDraftId = getDraggedDraftId(event);

    clearGalleryDragState();

    if (!nextDraggedDraftId || nextDraggedDraftId === targetDraftId) {
      return;
    }

    onDraftReorder(nextDraggedDraftId, targetDraftId);
  }, [clearGalleryDragState, getDraggedDraftId, onDraftReorder]);

  const handleCoverSlotDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (isSavingRef.current || !draggedDraftIdRef.current) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    if (isCoverDropTargetRef.current && dropTargetDraftIdRef.current === null) {
      return;
    }

    dropTargetDraftIdRef.current = null;
    isCoverDropTargetRef.current = true;
    setDropTargetDraftId(null);
    setIsCoverDropTarget(true);
  }, []);

  const handleCoverSlotDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    const nextDraggedDraftId = getDraggedDraftId(event);

    clearGalleryDragState();

    if (!nextDraggedDraftId || !draftItemsRef.current.some((item) => item.draftId === nextDraggedDraftId)) {
      return;
    }

    onCoverChange(nextDraggedDraftId);
  }, [clearGalleryDragState, getDraggedDraftId, onCoverChange]);

  const handleCoverSlotDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    isCoverDropTargetRef.current = false;
    setIsCoverDropTarget(false);
  }, []);

  function requestGalleryModalClose() {
    if (hasUnsavedChanges) {
      setIsCloseConfirmOpen(true);
      return;
    }

    onClose();
  }

  function confirmGalleryModalClose() {
    setIsCloseConfirmOpen(false);
    onClose();
  }

  function cancelGalleryModalClose() {
    setIsCloseConfirmOpen(false);
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
          <div className="gallery-modal-header-actions">
            <AdminButton
              className="gallery-modal-header-save"
              disabled={isSaving}
              tone="primary"
              type="button"
              onClick={onSave}
            >
              <SaveIcon data-icon="inline-start" />
              Сохранить
            </AdminButton>
            <AdminButton
              aria-label="Закрыть"
              className="gallery-modal-close"
              disabled={isSaving}
              tone="text"
              type="button"
              onClick={requestGalleryModalClose}
            >
              <XIcon />
            </AdminButton>
            {isCloseConfirmOpen ? (
              <div
                aria-describedby="gallery-close-confirm-description"
                aria-labelledby="gallery-close-confirm-title"
                className="gallery-close-confirm"
                role="alertdialog"
              >
                <strong id="gallery-close-confirm-title">Вы точно хотите закрыть?</strong>
                <span id="gallery-close-confirm-description">Были изменения</span>
                <div className="gallery-close-confirm-actions">
                  <AdminButton
                    className="gallery-close-confirm-action"
                    disabled={isSaving}
                    tone="secondary"
                    type="button"
                    onClick={confirmGalleryModalClose}
                  >
                    Да
                  </AdminButton>
                  <AdminButton
                    className="gallery-close-confirm-action"
                    disabled={isSaving}
                    tone="primary"
                    type="button"
                    onClick={cancelGalleryModalClose}
                  >
                    Нет
                  </AdminButton>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
        {progress ? <AdminAlert tone="notice">{progress}</AdminAlert> : null}
        {progressPercent !== null ? (
          <div className="gallery-modal-progress-row">
            <div
              aria-label={progress ?? 'Загрузка галереи'}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progressPercent}
              className="gallery-modal-progress"
              role="progressbar"
            >
              <span className="gallery-modal-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <span className="gallery-modal-progress-value">{progressPercent}%</span>
          </div>
        ) : null}

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

              return (
                <GalleryDraftTile
                  key={item.draftId}
                  accessToken={accessToken}
                  canDeleteMedia={canDeleteMedia}
                  existingImage={existingImage}
                  handleTileDragOver={handleTileDragOver}
                  handleTileDragStart={handleTileDragStart}
                  handleTileDrop={handleTileDrop}
                  isCover={isCover}
                  isDragging={item.draftId === draggedDraftId}
                  isDropTarget={item.draftId === dropTargetDraftId}
                  isFirst={itemIndex === 0}
                  isLast={itemIndex === draftItems.length - 1}
                  isSaving={isSaving}
                  item={item}
                  onCoverChange={onCoverChange}
                  onDraftMove={onDraftMove}
                  onDraftRemove={onDraftRemove}
                  onDragEnd={clearGalleryDragState}
                  onSectionChange={onSectionChange}
                />
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

const GalleryDraftTile = memo(function GalleryDraftTile({
  accessToken,
  canDeleteMedia,
  existingImage,
  handleTileDragOver,
  handleTileDragStart,
  handleTileDrop,
  isCover,
  isDragging,
  isDropTarget,
  isFirst,
  isLast,
  isSaving,
  item,
  onCoverChange,
  onDraftMove,
  onDraftRemove,
  onDragEnd,
  onSectionChange,
}: {
  accessToken: string | null;
  canDeleteMedia: boolean;
  existingImage: ObjectImage | null;
  handleTileDragOver: (event: DragEvent<HTMLLIElement>, targetDraftId: string) => void;
  handleTileDragStart: (event: DragEvent<HTMLLIElement>, draftId: string) => void;
  handleTileDrop: (event: DragEvent<HTMLLIElement>, targetDraftId: string) => void;
  isCover: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  isFirst: boolean;
  isLast: boolean;
  isSaving: boolean;
  item: GalleryDraftItem;
  onCoverChange: (draftId: string) => void;
  onDraftMove: (draftId: string, direction: 'up' | 'down') => void;
  onDraftRemove: (draftId: string) => void;
  onDragEnd: () => void;
  onSectionChange: (draftId: string, section: ObjectImageSection | null) => void;
}) {
  const sectionLabel = getGallerySectionLabel(item.section);
  const fullSizeHref = getGalleryDraftFullSizeHref(item, existingImage);
  const tileClassName = [
    'gallery-tile',
    isCover ? 'gallery-tile--cover' : null,
    isDragging ? 'gallery-tile--dragging' : null,
    isDropTarget ? 'gallery-tile--drop-target' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={tileClassName}
      draggable={!isSaving}
      onDragEnd={onDragEnd}
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
      {fullSizeHref ? (
        <a
          aria-label={`Открыть ${item.name} в полном размере`}
          className="gallery-tile-open-original"
          draggable={false}
          href={fullSizeHref}
          rel="noreferrer"
          target="_blank"
          title="Открыть оригинал"
        >
          <ExternalLinkIcon />
        </a>
      ) : null}
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
        <span className="gallery-tile-status-row">
          {item.kind === 'new' ? <span className="gallery-tile-status">Новое</span> : null}
          {isCover ? <span className="gallery-tile-status">Обложка</span> : null}
          {sectionLabel ? (
            <span className="gallery-tile-status gallery-tile-status--section">{sectionLabel}</span>
          ) : null}
        </span>
      </button>
      <label className="gallery-tile-section-field">
        <span>Раздел</span>
        <select
          className="gallery-tile-section-select"
          disabled={isSaving}
          value={item.section ?? ''}
          onChange={(event) =>
            onSectionChange(
              item.draftId,
              event.currentTarget.value ? (event.currentTarget.value as ObjectImageSection) : null,
            )
          }
        >
          <option value="">Без раздела</option>
          {gallerySectionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="gallery-tile-order-actions" aria-label={`Порядок ${item.name}`}>
        <AdminButton
          aria-label={`Поднять ${item.name}`}
          className="gallery-tile-order-button"
          disabled={isSaving || isFirst}
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
          disabled={isSaving || isLast}
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
});

function getGalleryDraftFullSizeHref(item: GalleryDraftItem, existingImage: ObjectImage | null) {
  const fileId = item.kind === 'staged' ? item.stagedFileId : existingImage?.file.id ?? null;

  return fileId ? buildMediaFileContentUrl(fileId, 'original') : null;
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
    if (item.previewUrl) {
      return <img alt={item.name} decoding="async" loading="lazy" src={item.previewUrl} />;
    }

    return <span>Фото</span>;
  }

  if (item.previewUrl) {
    return <img alt={item.name} decoding="async" loading="lazy" src={item.previewUrl} />;
  }

  if (accessToken && existingImage) {
    return (
      <SecureImage
        accessToken={accessToken}
        alt={existingImage.alt ?? existingImage.title ?? item.name}
        decoding="async"
        fileId={existingImage.file.id}
        lazy={variant === 'thumbnail'}
        loading="lazy"
        variant={variant}
      />
    );
  }

  return <span>Фото</span>;
}

type SearchableSelectOption = {
  id: string;
};

function SearchableSelect<T extends SearchableSelectOption>({
  emptyLabel,
  getOptionLabel,
  getSearchValues,
  id,
  label,
  multiple = false,
  onSelectedIdsChange,
  options,
  placeholder,
  selectedIds,
}: {
  emptyLabel: string;
  getOptionLabel: (option: T) => string;
  getSearchValues: (option: T) => Array<string | null | undefined>;
  id: string;
  label: string;
  multiple?: boolean;
  onSelectedIdsChange: (ids: string[]) => void;
  options: T[];
  placeholder: string;
  selectedIds: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `${id}-results`;
  const optionById = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const selectedOptions = useMemo(
    () => selectedIds.map((selectedId) => optionById.get(selectedId)).filter((option): option is T => Boolean(option)),
    [optionById, selectedIds],
  );
  const filteredOptions = useMemo(() => {
    const matchedOptions = options.filter((option) => matchesQuickEditSearch(query, getSearchValues(option)));

    return matchedOptions.slice(0, searchableMultiSelectResultLimit);
  }, [getSearchValues, options, query]);

  function changeSelectedIds(ids: string[]) {
    onSelectedIdsChange(multiple ? ids : ids.slice(0, 1));
  }

  function toggleOption(optionId: string) {
    if (!multiple) {
      changeSelectedIds([optionId]);
      setQuery('');
      setIsOpen(false);
      return;
    }

    const nextIds = selectedIds.includes(optionId)
      ? selectedIds.filter((selectedId) => selectedId !== optionId)
      : [...selectedIds, optionId];

    changeSelectedIds(nextIds);
    setQuery('');
    setIsOpen(true);
    inputRef.current?.focus();
  }

  function removeOption(optionId: string) {
    if (!optionId) {
      return;
    }

    changeSelectedIds(selectedIds.filter((selectedId) => selectedId !== optionId));
    inputRef.current?.focus();
  }

  function clearSelection() {
    changeSelectedIds([]);
    setQuery('');
    inputRef.current?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsOpen(false);
    setQuery('');
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
      return;
    }

    if (event.key === 'Enter' && isOpen && filteredOptions[0]) {
      event.preventDefault();
      toggleOption(filteredOptions[0].id);
      return;
    }

    if (event.key === 'Backspace' && !query && selectedIds.length > 0) {
      removeOption(selectedIds[selectedIds.length - 1] ?? '');
    }
  }

  return (
    <div className="searchable-multi-select" onBlur={handleBlur}>
      <div
        className={isOpen ? 'searchable-multi-select-control is-open' : 'searchable-multi-select-control'}
        onClick={() => {
          setIsOpen(true);
          inputRef.current?.focus();
        }}
      >
        <div className="searchable-multi-select-value">
          {selectedOptions.map((option) => (
            <button
              key={option.id}
              className="searchable-multi-select-chip"
              type="button"
              aria-label={`Убрать ${getOptionLabel(option)}`}
              onClick={(event) => {
                event.stopPropagation();
                removeOption(option.id);
              }}
            >
              <span>{getOptionLabel(option)}</span>
              <XIcon aria-hidden="true" />
            </button>
          ))}
          <input
            id={id}
            ref={inputRef}
            aria-controls={listboxId}
            aria-expanded={isOpen}
            aria-label={label}
            role="combobox"
            type="search"
            value={query}
            placeholder={selectedOptions.length === 0 ? placeholder : ''}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        {selectedIds.length > 0 ? (
          <button
            className="searchable-multi-select-clear"
            type="button"
            aria-label={`Очистить ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              clearSelection();
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        ) : null}
        <ChevronDownIcon className="searchable-multi-select-chevron" aria-hidden="true" />
      </div>
      {isOpen ? (
        <div
          id={listboxId}
          className="searchable-multi-select-menu"
          role="listbox"
          aria-multiselectable={multiple ? true : undefined}
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => {
              const isSelected = selectedIds.includes(option.id);

              return (
                <button
                  key={option.id}
                  className={
                    isSelected
                      ? 'searchable-multi-select-option searchable-multi-select-option--selected'
                      : 'searchable-multi-select-option'
                  }
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggleOption(option.id)}
                >
                  <span>{getOptionLabel(option)}</span>
                  {isSelected ? <span className="searchable-multi-select-check">Выбрано</span> : null}
                </button>
              );
            })
          ) : (
            <p className="searchable-multi-select-empty">{emptyLabel}</p>
          )}
        </div>
      ) : null}
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
  disabled,
  files,
  label,
  multiple = false,
  onChange,
}: {
  accept: string;
  disabled: boolean;
  files: File[];
  label: string;
  multiple?: boolean;
  onChange: (files: File[]) => void;
}) {
  const fileLabel =
    files.length === 0 ? 'Файл не выбран' : files.length === 1 ? files[0]?.name : `Выбрано файлов: ${files.length}`;

  return (
    <div className="upload-row">
      <label className={disabled ? 'upload-field upload-field--disabled' : 'upload-field'}>
        <span>{label}</span>
        <span className="upload-file-control">
          <span className="upload-file-button">Выбрать файл</span>
          <input
            accept={accept}
            disabled={disabled}
            multiple={multiple}
            type="file"
            onChange={(event) => {
              const nextFiles = Array.from(event.target.files ?? []);

              onChange(nextFiles);
              event.currentTarget.value = '';
            }}
          />
        </span>
      </label>
      <div className="upload-action">
        <span className={files.length > 0 ? 'upload-file-name' : 'upload-file-name upload-file-name--empty'}>
          {fileLabel}
        </span>
      </div>
    </div>
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
    coordinates: formatCoordinatePair(object.latitude?.toString() ?? '', object.longitude?.toString() ?? ''),
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
  const coordinates = parseCoordinatePair(form.coordinates);
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
    ceilingHeight: emptyToNull(normalizeCeilingHeight(form.ceilingHeight)),
    propertyClass: emptyToNull(form.propertyClass),
    floorRange: emptyToNull(form.floorRange),
    apartmentsCountText: emptyToNull(form.apartmentsCountText),
    priceFrom: emptyToNull(normalizeObjectPriceValue(form.priceFrom)),
    pricePerMeterFrom: emptyToNull(normalizeObjectPriceValue(form.pricePerMeterFrom)),
    completionYear: emptyToNull(form.completionYear),
    completionQuarter: emptyToNull(form.completionQuarter),
    address: emptyToNull(form.address),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
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

  const coordinateParse = parseCoordinatePair(form.coordinates);

  if (coordinateParse.error) {
    return coordinateParse.error;
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

function emptyToNull(value: string) {
  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}

function formatCoordinatePair(latitude: string, longitude: string) {
  if (latitude && longitude) {
    return `${latitude}, ${longitude}`;
  }

  return latitude || longitude;
}

function parseCoordinatePair(value: string): { latitude: string | null; longitude: string | null; error: string | null } {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return {
      latitude: null,
      longitude: null,
      error: null,
    };
  }

  const parts = trimmedValue.split(',');

  if (parts.length !== 2) {
    return {
      latitude: null,
      longitude: null,
      error: 'Координаты нужно указать в формате: широта, долгота',
    };
  }

  const [rawLatitude, rawLongitude] = parts as [string, string];
  const latitude = rawLatitude.trim();
  const longitude = rawLongitude.trim();

  if (!latitude || !longitude) {
    return {
      latitude: null,
      longitude: null,
      error: 'Координаты нужно указать в формате: широта, долгота',
    };
  }

  const latitudeNumber = Number(latitude);
  const longitudeNumber = Number(longitude);

  if (!Number.isFinite(latitudeNumber) || !Number.isFinite(longitudeNumber)) {
    return {
      latitude: null,
      longitude: null,
      error: 'Координаты должны быть числами через точку',
    };
  }

  if (latitudeNumber < -90 || latitudeNumber > 90) {
    return {
      latitude: null,
      longitude: null,
      error: 'Широта должна быть от -90 до 90',
    };
  }

  if (longitudeNumber < -180 || longitudeNumber > 180) {
    return {
      latitude: null,
      longitude: null,
      error: 'Долгота должна быть от -180 до 180',
    };
  }

  return {
    latitude,
    longitude,
    error: null,
  };
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
    previewUrl: null,
    name: getGalleryDraftImageName(image),
    section: image.section,
  }));
}

function createNewGalleryDraftItems(files: FileList | File[]): GalleryDraftItem[] {
  return Array.from(files).map((file) => ({
    draftId: getNewGalleryDraftId(),
    kind: 'new',
    imageId: null,
    file,
    previewUrl: null,
    name: file.name || 'Новое изображение',
    section: null,
  }));
}

async function createGalleryPreviewUrl(file: File) {
  const createOriginalPreviewUrl = () => URL.createObjectURL(file);

  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    return createOriginalPreviewUrl();
  }

  try {
    const imageBitmap = await createImageBitmap(file);

    try {
      const previewSize = getGalleryPreviewSize(imageBitmap.width, imageBitmap.height);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      if (!context) {
        return createOriginalPreviewUrl();
      }

      canvas.width = previewSize.width;
      canvas.height = previewSize.height;
      context.fillStyle = '#eef3f7';
      context.fillRect(0, 0, previewSize.width, previewSize.height);
      context.drawImage(imageBitmap, 0, 0, previewSize.width, previewSize.height);

      const previewBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, galleryPreviewMimeType, galleryPreviewQuality);
      });

      return previewBlob ? URL.createObjectURL(previewBlob) : createOriginalPreviewUrl();
    } finally {
      imageBitmap.close();
    }
  } catch {
    return createOriginalPreviewUrl();
  }
}

function getGalleryPreviewSize(width: number, height: number) {
  if (width <= 0 || height <= 0) {
    return {
      width: galleryPreviewMaxDimension,
      height: galleryPreviewMaxDimension,
    };
  }

  const scale = Math.min(1, galleryPreviewMaxDimension / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function reconcileGalleryDraftItemsWithCurrentGallery(
  draftItems: GalleryDraftItem[],
  coverDraftId: string | null,
  currentImages: ObjectImage[],
) {
  const currentImageIds = new Set(currentImages.map((image) => image.id));
  const reconciledDraftItems = draftItems.filter(
    (item) => (item.kind === 'new' || item.kind === 'staged') || (item.imageId !== null && currentImageIds.has(item.imageId)),
  );
  const reconciledCoverDraftId = coverDraftId && reconciledDraftItems.some((item) => item.draftId === coverDraftId)
    ? coverDraftId
    : reconciledDraftItems[0]?.draftId ?? null;

  return {
    draftItems: reconciledDraftItems,
    coverDraftId: reconciledCoverDraftId,
  };
}

function createGalleryBatchBody(draftItems: GalleryDraftItem[], coverDraftId: string | null) {
  const formData = new FormData();
  const files: File[] = [];
  const coverIndex = coverDraftId ? draftItems.findIndex((item) => item.draftId === coverDraftId) : null;

  if (draftItems.length > 0 && (coverIndex === null || coverIndex === -1)) {
    throw new Error('Не удалось сохранить обложку галереи');
  }

  const items = draftItems.map((item) => {
    if (item.kind === 'staged') {
      if (!item.stagedFileId) {
        throw new Error('Не удалось сохранить изображение галереи');
      }

      return {
        kind: 'staged',
        fileId: item.stagedFileId,
        section: item.section,
      };
    }

    if (item.kind === 'new') {
      if (!item.file) {
        throw new Error('Не удалось прочитать файл галереи');
      }

      const fileIndex = files.length;
      files.push(item.file);

      return {
        kind: 'new',
        fileIndex,
        section: item.section,
      };
    }

    if (!item.imageId) {
      throw new Error('Не удалось сохранить изображение галереи');
    }

    return {
      kind: 'existing',
      imageId: item.imageId,
      section: item.section,
    };
  });

  formData.append('layout', JSON.stringify({
    items,
    coverIndex,
  }));
  files.forEach((file) => formData.append('files', file));

  return {
    fileCount: files.length,
    formData,
  };
}

function restoreStagedGalleryDraftItems(draftItems: GalleryDraftItem[], stagedFileIds: string[]): GalleryDraftItem[] {
  const stagedFileIdSet = new Set(stagedFileIds);

  return draftItems.map((item) => {
    if (item.kind !== 'staged' || !item.stagedFileId || !stagedFileIdSet.has(item.stagedFileId)) {
      return item;
    }

    return {
      ...item,
      kind: 'new' as const,
      imageId: null,
      stagedFileId: null,
    };
  });
}

function calculateGalleryUploadProgressPercent(uploadedCount: number, totalCount: number) {
  if (totalCount <= 0) {
    return 35;
  }

  const progressStart = 15;
  const progressSpan = 75;
  const percent = progressStart + Math.round((uploadedCount / totalCount) * progressSpan);

  return Math.min(90, Math.max(progressStart, percent));
}

function getInitialGalleryCoverDraftId(images: ObjectImage[]) {
  const coverImage = images.find((image) => image.isCover) ?? images[0] ?? null;

  return coverImage ? getExistingGalleryDraftId(coverImage.id) : null;
}

function hasGalleryDraftChanges(
  draftItems: GalleryDraftItem[],
  coverDraftId: string | null,
  existingImages: ObjectImage[],
) {
  if (draftItems.length !== existingImages.length) {
    return true;
  }

  if (coverDraftId !== getInitialGalleryCoverDraftId(existingImages)) {
    return true;
  }

  return draftItems.some((item, index) => {
    const existingImage = existingImages[index];

    return (
      !existingImage ||
      item.kind !== 'existing' ||
      item.imageId !== existingImage.id ||
      item.section !== existingImage.section
    );
  });
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

function getGalleryDraftFileName(file: ObjectStoredFile, fallbackName: string) {
  return file.originalName ?? fallbackName;
}

function getGallerySectionLabel(section: ObjectImageSection | null) {
  return gallerySectionOptions.find((option) => option.value === section)?.label ?? null;
}

function revokeGalleryDraftPreviewUrl(item: GalleryDraftItem) {
  if ((item.kind !== 'new' && item.kind !== 'staged') || !item.previewUrl) {
    return;
  }

  URL.revokeObjectURL(item.previewUrl);
}

function revokeGalleryDraftPreviewUrls(items: GalleryDraftItem[]) {
  items.forEach((item) => revokeGalleryDraftPreviewUrl(item));
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

function formatPriceFrom(value: string | null) {
  if (!value) {
    return 'Не указана';
  }

  return `от ${formatPrice(value)}`;
}

function formatPricePerMeterFrom(value: string | null) {
  if (!value) {
    return 'за м² не указана';
  }

  return `от ${formatPrice(value)}/м²`;
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

function getUploadedPdfNotice(count: number, createdObject = false) {
  if (count === 1) {
    return createdObject ? 'Объект создан, PDF-файл добавлен' : 'PDF-файл добавлен';
  }

  return createdObject ? `Объект создан, PDF-файлы добавлены: ${count}` : `PDF-файлы добавлены: ${count}`;
}

function formatCompletion(year: number | string | null, quarter: number | string | null) {
  if (!year) {
    return 'Не указан';
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}
