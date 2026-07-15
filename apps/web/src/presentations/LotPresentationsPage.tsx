import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import type {
  AuthUser,
  CreateLotPresentationDocumentInput,
  LotPresentationCollection,
  LotPresentationCollectionResponse,
  LotPresentationCollectionsResponse,
  LotPresentationDocument,
  LotPresentationDocumentResponse,
  LotPresentationDocumentsResponse,
  LotPresentationLot,
  LotPresentationLotsResponse,
  LotPresentationWorkspaceItem,
  LotPresentationWorkspaceResponse,
} from '@platforma/shared';

import { apiRequest, apiUrl } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { SecureImage } from '../files/SecureImage';
import { LotFinishSelectionModal } from './LotFinishSelectionModal';

type LotPresentationsPageProps = {
  navigate: (nextPathname: string) => void;
};

type LotPresentationProjectResult = LotPresentationLot['object'] & {
  lotsCount: number;
};

type LotPresentationProjectRoomGroup = {
  key: string;
  label: string;
  total: number;
  areaMin: string | null;
  areaMax: string | null;
  priceMin: string | null;
  priceMax: string | null;
  items: LotPresentationLot[];
};

type LotPresentationProjectCompletionGroup = {
  key: string;
  label: string;
  buildings: string[];
  total: number;
  roomGroups: LotPresentationProjectRoomGroup[];
};

type CommentTarget =
  | {
      context: 'workspace';
      unitId: string;
      collectionId: null;
      comment: string | null;
    }
  | {
      context: 'collection';
      unitId: string;
      collectionId: string;
      comment: string | null;
    };

type LotPresentationDocumentDraft = Omit<CreateLotPresentationDocumentInput, 'unitFinishes'>;

type PendingFinishSelection = {
  input: LotPresentationDocumentDraft;
  lots: LotPresentationLot[];
};

const feedUnitStatusLabels: Record<LotPresentationLot['status'], string> = {
  AVAILABLE: 'Доступен',
  BOOKED: 'Забронирован',
  RESERVED: 'Резерв',
  SOLD: 'Продан',
  ARCHIVED: 'Архив',
  UNKNOWN: 'Неизвестно',
};

const presentationProjectSearchLimit = 80;
const presentationProjectLotsLimit = 500;
const presentationProjectModalPageSize = 20;
const commentMaxLength = 1000;

function sortCollectionsByLatestChange(left: LotPresentationCollection, right: LotPresentationCollection) {
  const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);

  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function getLotCollectionNames(collectionIds: string[], collectionNameById: Map<string, string>) {
  return collectionIds
    .map((collectionId) => collectionNameById.get(collectionId))
    .filter((name): name is string => Boolean(name));
}

export function LotPresentationsPage(_props: LotPresentationsPageProps) {
  const { accessToken, user } = useAuth();
  const [activeTab, setActiveTab] = useState<'workspace' | 'collections'>('workspace');
  const [collections, setCollections] = useState<LotPresentationCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState(() => getCollectionIdFromLocation());
  const [workspaceItems, setWorkspaceItems] = useState<LotPresentationWorkspaceItem[]>([]);
  const [documents, setDocuments] = useState<LotPresentationDocument[]>([]);
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isCreateCollectionModalOpen, setIsCreateCollectionModalOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [createCollectionError, setCreateCollectionError] = useState<string | null>(null);
  const [activeCommentTarget, setActiveCommentTarget] = useState<CommentTarget | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [isCollectionPickerOpenFor, setIsCollectionPickerOpenFor] = useState<LotPresentationLot | null>(null);
  const [pickerCollectionName, setPickerCollectionName] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectResults, setProjectResults] = useState<LotPresentationProjectResult[]>([]);
  const [selectedProject, setSelectedProject] = useState<LotPresentationProjectResult | null>(null);
  const [projectLots, setProjectLots] = useState<LotPresentationLot[]>([]);
  const [isProjectSearchLoading, setIsProjectSearchLoading] = useState(false);
  const [isProjectLotsLoading, setIsProjectLotsLoading] = useState(false);
  const [projectLotsError, setProjectLotsError] = useState<string | null>(null);
  const [isDocumentsPanelOpen, setIsDocumentsPanelOpen] = useState(false);
  const [pendingFinishSelection, setPendingFinishSelection] = useState<PendingFinishSelection | null>(null);
  const [finishSelectionError, setFinishSelectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true);
  const [isCollectionsLoading, setIsCollectionsLoading] = useState(true);
  const [isDocumentsLoading, setIsDocumentsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null,
    [collections, selectedCollectionId],
  );
  const collectionNameById = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection.name])),
    [collections],
  );
  const hasBrokerContacts = Boolean(user?.brokerPhone && user.brokerEmail);
  const projectLotGroups = useMemo(() => createProjectLotGroups(projectLots), [projectLots]);
  const shouldShowProjectSearchResults = projectSearch.trim().length > 0;

  useEffect(() => {
    const handlePopState = () => {
      const nextCollectionId = getCollectionIdFromLocation();

      setSelectedCollectionId(nextCollectionId);

      if (nextCollectionId) {
        setActiveTab('collections');
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadWorkspace();
    void loadCollections();
    void loadDocuments();
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    if (!projectSearch.trim()) {
      setProjectResults([]);
      setIsProjectSearchLoading(false);
      return;
    }

    const timerId = window.setTimeout(() => {
      void loadProjects();
    }, 250);

    return () => window.clearTimeout(timerId);
  }, [accessToken, projectSearch]);

  useEffect(() => {
    const firstCollection = collections[0];

    if (!selectedCollection && firstCollection) {
      setSelectedCollectionId(firstCollection.id);
    }
  }, [collections, selectedCollection]);

  useEffect(() => {
    if (!isDocumentsPanelOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDocumentsPanelOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDocumentsPanelOpen]);

  useEffect(() => {
    if (!isCreateCollectionModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        setIsCreateCollectionModalOpen(false);
        setNewCollectionName('');
        setCreateCollectionError(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCreateCollectionModalOpen, isSubmitting]);

  async function loadWorkspace() {
    if (!accessToken) {
      return;
    }

    setIsWorkspaceLoading(true);
    setError(null);

    try {
      const data = await apiRequest<LotPresentationWorkspaceResponse>('/lot-presentations/workspace', accessToken);

      setWorkspaceItems(data.items);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты в работе');
    } finally {
      setIsWorkspaceLoading(false);
    }
  }

  function getWorkspaceLots(items: LotPresentationWorkspaceItem[]) {
    return items.map((item) => item.unit);
  }

  async function clearWorkspace() {
    if (!accessToken || workspaceItems.length === 0) {
      return;
    }

    const confirmed = window.confirm('Очистить все лоты в работе? Подборки и PDF останутся.');

    if (!confirmed) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest('/lot-presentations/workspace/items', accessToken, {
        method: 'DELETE',
      });
      setWorkspaceItems([]);
      setNotice('Рабочая зона очищена');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось очистить рабочую зону');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function removeWorkspaceItem(unitId: string) {
    if (!accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest(`/lot-presentations/workspace/items/${encodeURIComponent(unitId)}`, accessToken, {
        method: 'DELETE',
      });
      setWorkspaceItems((currentItems) => currentItems.filter((item) => item.unitId !== unitId));
      setNotice('Лот удален из работы');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить лот из работы');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function loadCollections() {
    if (!accessToken) {
      return;
    }

    setIsCollectionsLoading(true);
    setError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionsResponse>('/lot-presentations/collections', accessToken);

      setCollections(data.items);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить подборки');
    } finally {
      setIsCollectionsLoading(false);
    }
  }

  function upsertCollection(updatedCollection: LotPresentationCollection) {
    setCollections((currentCollections) => {
      const hasCollection = currentCollections.some((collection) => collection.id === updatedCollection.id);
      const nextCollections = hasCollection
        ? currentCollections.map((collection) => (collection.id === updatedCollection.id ? updatedCollection : collection))
        : [...currentCollections, updatedCollection];

      return [...nextCollections].sort(sortCollectionsByLatestChange);
    });
  }

  function markLotAddedToCollection(unitId: string, collectionId: string) {
    const withCollectionId = (collectionIds: string[]) =>
      collectionIds.includes(collectionId) ? collectionIds : [...collectionIds, collectionId];

    setWorkspaceItems((currentItems) =>
      currentItems.map((item) =>
        item.unitId === unitId ? { ...item, unit: { ...item.unit, collectionIds: withCollectionId(item.unit.collectionIds) } } : item,
      ),
    );
    setProjectLots((currentLots) =>
      currentLots.map((lot) => (lot.id === unitId ? { ...lot, collectionIds: withCollectionId(lot.collectionIds) } : lot)),
    );
    setIsCollectionPickerOpenFor((currentLot) =>
      currentLot?.id === unitId ? { ...currentLot, collectionIds: withCollectionId(currentLot.collectionIds) } : currentLot,
    );
  }

  async function loadProjects() {
    const search = projectSearch.trim();

    if (!accessToken || !search) {
      setProjectResults([]);
      setIsProjectSearchLoading(false);
      return;
    }

    const params = new URLSearchParams({
      limit: String(presentationProjectSearchLimit),
      search,
    });

    setIsProjectSearchLoading(true);

    try {
      const data = await apiRequest<LotPresentationLotsResponse>(`/lot-presentations/lots?${params.toString()}`, accessToken);

      setProjectResults(getProjectResultsFromLots(data.items));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить проекты');
    } finally {
      setIsProjectSearchLoading(false);
    }
  }

  async function loadProjectLots(project: LotPresentationProjectResult) {
    if (!accessToken) {
      return;
    }

    const params = new URLSearchParams({
      limit: String(presentationProjectLotsLimit),
    });

    params.set('objectId', project.id);

    setIsProjectLotsLoading(true);
    setProjectLotsError(null);

    try {
      const data = await apiRequest<LotPresentationLotsResponse>(`/lot-presentations/lots?${params.toString()}`, accessToken);

      setProjectLots(data.items);
    } catch (caughtError) {
      setProjectLots([]);
      setProjectLotsError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить лоты ЖК');
    } finally {
      setIsProjectLotsLoading(false);
    }
  }

  function openProjectLotsModal(project: LotPresentationProjectResult) {
    setSelectedProject(project);
    setProjectLots([]);
    setProjectLotsError(null);
    setProjectResults([]);
    setProjectSearch('');
    setError(null);
    setNotice(null);
    void loadProjectLots(project);
  }

  function closeProjectLotsModal() {
    setSelectedProject(null);
    setProjectLots([]);
    setProjectLotsError(null);
  }

  function closeCollectionPicker() {
    setIsCollectionPickerOpenFor(null);
    setPickerCollectionName('');
    setPickerError(null);
  }

  async function loadDocuments() {
    if (!accessToken) {
      return;
    }

    setIsDocumentsLoading(true);

    try {
      const data = await apiRequest<LotPresentationDocumentsResponse>('/lot-presentations/documents?limit=12', accessToken);

      setDocuments(data.items);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить историю PDF');
    } finally {
      setIsDocumentsLoading(false);
    }
  }

  function selectCollection(collectionId: string) {
    setActiveTab('collections');
    setSelectedCollectionId(collectionId);
    window.history.pushState(null, '', `/presentations?collectionId=${encodeURIComponent(collectionId)}`);
  }

  function openCreateCollectionModal() {
    setNewCollectionName('');
    setCreateCollectionError(null);
    setError(null);
    setNotice(null);
    setIsCreateCollectionModalOpen(true);
  }

  function closeCreateCollectionModal() {
    if (isSubmitting) {
      return;
    }

    setIsCreateCollectionModalOpen(false);
    setNewCollectionName('');
    setCreateCollectionError(null);
  }

  async function handleCreateCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || isSubmitting) {
      return;
    }

    const name = newCollectionName.trim();

    if (!name) {
      setCreateCollectionError('Введите название подборки');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    setCreateCollectionError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionResponse>('/lot-presentations/collections', accessToken, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      await loadCollections();
      selectCollection(data.collection.id);
      setIsCreateCollectionModalOpen(false);
      setNewCollectionName('');
      setNotice('Подборка создана');
    } catch (caughtError) {
      setCreateCollectionError(caughtError instanceof Error ? caughtError.message : 'Не удалось создать подборку');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function renameCollection(collection: LotPresentationCollection) {
    if (!accessToken || isSubmitting) {
      return;
    }

    const name = renameValue.trim();

    if (!name) {
      setError('Введите новое название');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest<LotPresentationCollectionResponse>(
        `/lot-presentations/collections/${encodeURIComponent(collection.id)}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        },
      );
      setRenamingCollectionId(null);
      setRenameValue('');
      await loadCollections();
      setNotice('Название подборки обновлено');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось переименовать подборку');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteCollection(collection: LotPresentationCollection) {
    if (!accessToken || isSubmitting || !window.confirm(`Удалить подборку "${collection.name}"?`)) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest(`/lot-presentations/collections/${encodeURIComponent(collection.id)}`, accessToken, {
        method: 'DELETE',
      });
      setSelectedCollectionId(null);
      await loadCollections();
      setNotice('Подборка удалена');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить подборку');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function addLotToSelectedCollection(unitId: string) {
    if (!accessToken || !selectedCollection || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionResponse>(
        `/lot-presentations/collections/${encodeURIComponent(selectedCollection.id)}/items`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ unitId }),
        },
      );
      upsertCollection(data.collection);
      markLotAddedToCollection(unitId, selectedCollection.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function addLotToCollection(collectionId: string, unitId: string) {
    if (!accessToken) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setPickerError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionResponse>(
        `/lot-presentations/collections/${encodeURIComponent(collectionId)}/items`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ unitId }),
        },
      );
      upsertCollection(data.collection);
      markLotAddedToCollection(unitId, collectionId);
      closeCollectionPicker();
    } catch (caughtError) {
      setPickerError(caughtError instanceof Error ? caughtError.message : 'Не удалось добавить лот в подборку');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function createCollectionAndAddPickerLot() {
    if (!accessToken || !isCollectionPickerOpenFor) {
      return;
    }

    const name = pickerCollectionName.trim();

    if (!name) {
      setPickerError('Введите название подборки');
      return;
    }

    setIsSubmitting(true);
    setPickerError(null);

    try {
      const data = await apiRequest<LotPresentationCollectionResponse>('/lot-presentations/collections', accessToken, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      const addedData = await apiRequest<LotPresentationCollectionResponse>(
        `/lot-presentations/collections/${encodeURIComponent(data.collection.id)}/items`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ unitId: isCollectionPickerOpenFor.id }),
        },
      );
      upsertCollection(addedData.collection);
      markLotAddedToCollection(isCollectionPickerOpenFor.id, addedData.collection.id);
      closeCollectionPicker();
    } catch (caughtError) {
      setPickerError(caughtError instanceof Error ? caughtError.message : 'Не удалось создать подборку');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function removeLotFromSelectedCollection(unitId: string) {
    if (!accessToken || !selectedCollection || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest(
        `/lot-presentations/collections/${encodeURIComponent(selectedCollection.id)}/items/${encodeURIComponent(unitId)}`,
        accessToken,
        {
          method: 'DELETE',
        },
      );
      await loadCollections();
      setNotice('Лот удален из подборки');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось удалить лот');
    } finally {
      setIsSubmitting(false);
    }
  }

  function openComment(target: CommentTarget) {
    setActiveCommentTarget(target);
    setCommentDraft(target.comment ?? '');
    setError(null);
    setNotice(null);
  }

  async function saveComment() {
    if (!accessToken || !activeCommentTarget) {
      return;
    }

    if (commentDraft.length > commentMaxLength) {
      setError('Комментарий не может быть длиннее 1000 символов');
      return;
    }

    const body = JSON.stringify({ comment: commentDraft.trim() || null });
    const endpoint = activeCommentTarget.context === 'workspace'
      ? `/lot-presentations/workspace/items/${encodeURIComponent(activeCommentTarget.unitId)}`
      : `/lot-presentations/collections/${encodeURIComponent(activeCommentTarget.collectionId)}/items/${encodeURIComponent(activeCommentTarget.unitId)}`;

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest(endpoint, accessToken, {
        method: 'PATCH',
        body,
      });

      if (activeCommentTarget.context === 'workspace') {
        await loadWorkspace();
      } else {
        await loadCollections();
      }

      setActiveCommentTarget(null);
      setCommentDraft('');
      setNotice('Комментарий сохранён');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить комментарий');
    } finally {
      setIsSubmitting(false);
    }
  }

  function requestDocumentCreation(input: LotPresentationDocumentDraft, lotsForCheck: LotPresentationLot[]) {
    if (!accessToken || isSubmitting) {
      return;
    }

    setError(null);
    setNotice(null);
    setFinishSelectionError(null);

    if (!ensureCanDownload(user, lotsForCheck, setError)) {
      return;
    }

    const residentialLots = lotsForCheck.filter((lot) => lot.type === 'RESIDENTIAL');

    if (residentialLots.length > 0) {
      setPendingFinishSelection({
        input: {
          ...input,
          unitIds: input.unitIds ? [...input.unitIds] : undefined,
        },
        lots: residentialLots,
      });
      return;
    }

    void createAndDownloadDocument({ ...input, unitFinishes: [] });
  }

  function closeFinishSelectionModal() {
    if (isSubmitting) {
      return;
    }

    setPendingFinishSelection(null);
    setFinishSelectionError(null);
  }

  async function createAndDownloadDocument(input: CreateLotPresentationDocumentInput) {
    if (!accessToken || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    setFinishSelectionError(null);

    try {
      const data = await apiRequest<LotPresentationDocumentResponse>('/lot-presentations/documents', accessToken, {
        method: 'POST',
        body: JSON.stringify(input),
      });

      await loadDocuments();
      await downloadDocument(data.document, accessToken);
      setPendingFinishSelection(null);
      setNotice('PDF-презентация сформирована');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Не удалось сформировать PDF';

      setError(message);
      setFinishSelectionError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="lot-presentations-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Подборки</p>
          <h2>PDF-презентации лотов</h2>
        </div>
        <div className="header-actions">
          <button
            className="secondary-button secondary-button--fit lot-presentations-documents-trigger"
            type="button"
            onClick={() => setIsDocumentsPanelOpen(true)}
          >
            <FileTextIcon aria-hidden="true" />
            Созданные PDF
          </button>
        </div>
      </header>

      {!hasBrokerContacts ? (
        <div className="content-panel lot-presentations-warning">
          <strong>Заполните телефон и почту брокера в профиле.</strong>
          <span>Без этих данных PDF не скачивается, потому что контакты выводятся в шапке презентации.</span>
        </div>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}

      <div className="lot-presentations-tabs" role="tablist" aria-label="Разделы презентаций">
        <button
          className={activeTab === 'workspace' ? 'lot-presentations-tab is-active' : 'lot-presentations-tab'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'workspace'}
          onClick={() => setActiveTab('workspace')}
        >
          В работе
        </button>
        <button
          className={activeTab === 'collections' ? 'lot-presentations-tab is-active' : 'lot-presentations-tab'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'collections'}
          onClick={() => setActiveTab('collections')}
        >
          Мои подборки
        </button>
      </div>

      {activeTab === 'workspace' ? (
        <section className="content-panel lot-presentations-main">
          <div className="lot-presentations-workspace-toolbar">
            <button
              className="secondary-button secondary-button--fit"
              disabled={!hasBrokerContacts || workspaceItems.length === 0 || isSubmitting}
              type="button"
              onClick={() =>
                requestDocumentCreation(
                  { unitIds: workspaceItems.map((item) => item.unitId), title: 'В работе' },
                  getWorkspaceLots(workspaceItems),
                )
              }
            >
              <DownloadIcon aria-hidden="true" />
              Скачать все
            </button>
            <button
              className="secondary-button secondary-button--fit"
              disabled={workspaceItems.length === 0 || isSubmitting}
              type="button"
              onClick={() => void clearWorkspace()}
            >
              Очистить всё
            </button>
            <button className="primary-button primary-button--fit" type="button" onClick={openCreateCollectionModal}>
              <PlusIcon aria-hidden="true" />
              Добавить подборку
            </button>
          </div>

          {isWorkspaceLoading ? <p className="muted-text">Загрузка лотов в работе</p> : null}

          {workspaceItems.length ? (
            <div className="lot-presentations-grid">
              {workspaceItems.map((item) => (
                <LotPresentationLotTile
                  accessToken={accessToken ?? ''}
                  collectionNames={getLotCollectionNames(item.unit.collectionIds, collectionNameById)}
                  comment={item.comment}
                  key={item.id}
                  lot={item.unit}
                  onDownloadOne={() =>
                    requestDocumentCreation({ unitIds: [item.unitId], title: getLotTitle(item.unit) }, [item.unit])
                  }
                  onOpenCollectionPicker={() => setIsCollectionPickerOpenFor(item.unit)}
                  onOpenComment={() =>
                    openComment({ context: 'workspace', unitId: item.unitId, collectionId: null, comment: item.comment })
                  }
                  onRemove={() => void removeWorkspaceItem(item.unitId)}
                />
              ))}
            </div>
          ) : (
            <div className="lot-presentations-empty">
              <strong>В работе пока нет лотов</strong>
              <span>Добавьте лоты со страницы объекта или из таблицы лотов.</span>
            </div>
          )}
        </section>
      ) : (
        <div className="lot-presentations-layout">
          <aside className="content-panel lot-presentations-sidebar">
            <div className="lot-presentations-panel-header">
              <div>
                <p className="eyebrow">Коллекции</p>
                <h3>Подборки</h3>
              </div>
              <div className="lot-presentations-sidebar-actions">
                <span className="lot-presentations-collection-count">{collections.length}</span>
                <button
                  className="lot-presentations-create-inline"
                  disabled={isSubmitting}
                  type="button"
                  aria-label="Создать подборку"
                  title="Создать подборку"
                  onClick={openCreateCollectionModal}
                >
                  <PlusIcon aria-hidden="true" />
                </button>
              </div>
            </div>

            {isCollectionsLoading ? <p className="muted-text">Загрузка подборок</p> : null}

            <div className="lot-presentations-collection-list">
              {collections.map((collection) => (
                <article
                  key={collection.id}
                  className={
                    selectedCollection?.id === collection.id
                      ? 'lot-presentations-collection is-active'
                      : 'lot-presentations-collection'
                  }
                >
                  {renamingCollectionId === collection.id ? (
                    <form
                      className="lot-presentations-rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameCollection(collection);
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Новое название подборки"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.currentTarget.value)}
                      />
                      <button
                        className="icon-action-button"
                        aria-label="Сохранить название подборки"
                        title="Сохранить название подборки"
                        disabled={isSubmitting}
                        type="submit"
                      >
                        <CheckIcon aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button type="button" onClick={() => selectCollection(collection.id)}>
                        <strong>{collection.name}</strong>
                        <span>{collection.itemsCount} лотов</span>
                      </button>
                      <div className="lot-presentations-collection-actions">
                        <button
                          className="icon-action-button"
                          type="button"
                          aria-label="Переименовать подборку"
                          onClick={() => {
                            setRenamingCollectionId(collection.id);
                            setRenameValue(collection.name);
                          }}
                        >
                          <PencilIcon aria-hidden="true" />
                        </button>
                        <button
                          className="icon-action-button icon-action-button--danger"
                          type="button"
                          aria-label="Удалить подборку"
                          onClick={() => void deleteCollection(collection)}
                        >
                          <Trash2Icon aria-hidden="true" />
                        </button>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </div>
          </aside>

          <section className="content-panel lot-presentations-main">
            <div className="lot-presentations-panel-header">
              <div>
                <p className="eyebrow">Мои подборки</p>
                <h3>{selectedCollection?.name ?? 'Подборка не выбрана'}</h3>
              </div>
              <div className="lot-presentations-actions">
                <button
                  className="secondary-button secondary-button--fit"
                  disabled={!hasBrokerContacts || !selectedCollection || selectedCollection.items.length === 0 || isSubmitting}
                  type="button"
                  onClick={() =>
                    selectedCollection
                      ? requestDocumentCreation(
                          {
                            collectionId: selectedCollection.id,
                            unitIds: selectedCollection.items.map((item) => item.unitId),
                            title: selectedCollection.name,
                          },
                          selectedCollection.items.map((item) => item.unit),
                        )
                      : undefined
                  }
                >
                  <FileTextIcon aria-hidden="true" />
                  Вся подборка
                </button>
              </div>
            </div>

            <div className="lot-presentations-workbar">
              <div className="lot-presentations-search-area">
                <label className="lot-presentations-search">
                  <SearchIcon aria-hidden="true" />
                  <input
                    placeholder="Найти ЖК и открыть лоты"
                    type="search"
                    value={projectSearch}
                    onChange={(event) => setProjectSearch(event.currentTarget.value)}
                  />
                </label>

                {shouldShowProjectSearchResults ? (
                  <div className="lot-presentations-search-popover">
                    {isProjectSearchLoading ? <p className="muted-text">Загрузка ЖК</p> : null}
                    {!isProjectSearchLoading && projectResults.length === 0 ? (
                      <p className="lot-presentations-search-empty">Проекты не найдены</p>
                    ) : null}
                    {projectResults.map((project) => (
                      <button
                        className="lot-presentations-search-project"
                        key={project.id}
                        type="button"
                        onClick={() => openProjectLotsModal(project)}
                      >
                        <span>
                          <strong>{project.title}</strong>
                          <small>{formatProjectLocation(project)}</small>
                        </span>
                        <b>{formatProjectLotsCount(project.lotsCount)}</b>
                        <ChevronRightIcon aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {selectedCollection?.items.length ? (
              <div className="lot-presentations-grid">
                {selectedCollection.items.map((item) => (
                  <LotPresentationLotTile
                    accessToken={accessToken ?? ''}
                    comment={item.comment}
                    key={item.id}
                    lot={item.unit}
                    onDownloadOne={() =>
                      requestDocumentCreation(
                        {
                          collectionId: selectedCollection.id,
                          unitIds: [item.unitId],
                          title: getLotTitle(item.unit),
                        },
                        [item.unit],
                      )
                    }
                    onOpenComment={() =>
                      openComment({
                        context: 'collection',
                        unitId: item.unitId,
                        collectionId: selectedCollection.id,
                        comment: item.comment,
                      })
                    }
                    onRemove={() => void removeLotFromSelectedCollection(item.unitId)}
                  />
                ))}
              </div>
            ) : (
              <div className="lot-presentations-empty">
                <strong>В подборке пока нет лотов</strong>
                <span>Добавьте лоты из вкладки В работе или через поиск проекта.</span>
              </div>
            )}
          </section>
        </div>
      )}

      {selectedProject ? (
        <ProjectLotsModal
          accessToken={accessToken ?? ''}
          error={projectLotsError}
          groups={projectLotGroups}
          isLoading={isProjectLotsLoading}
          isSubmitting={isSubmitting}
          project={selectedProject}
          selectedCollection={selectedCollection}
          total={projectLots.length}
          onAddLot={(unitId) => void addLotToSelectedCollection(unitId)}
          onClose={closeProjectLotsModal}
        />
      ) : null}

      {pendingFinishSelection ? (
        <LotFinishSelectionModal
          error={finishSelectionError}
          isLoading={isSubmitting}
          lots={pendingFinishSelection.lots.map((lot) => ({
            id: lot.id,
            title: getLotTitle(lot),
            projectTitle: lot.object.title,
          }))}
          onCancel={closeFinishSelectionModal}
          onSubmit={(unitFinishes) =>
            void createAndDownloadDocument({
              ...pendingFinishSelection.input,
              unitFinishes,
            })
          }
        />
      ) : null}

      {isCreateCollectionModalOpen ? (
        <div
          className="lot-presentations-create-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCreateCollectionModal();
            }
          }}
        >
          <form
            aria-labelledby="lot-presentations-create-modal-title"
            aria-modal="true"
            className="lot-presentations-create-modal"
            role="dialog"
            onSubmit={(event) => void handleCreateCollection(event)}
          >
            <div className="lot-presentations-create-modal-header">
              <div>
                <h3 id="lot-presentations-create-modal-title">Новая подборка</h3>
                <p>Название будет видно в списке слева.</p>
              </div>
              <span className="lot-presentations-create-modal-icon">
                <PlusIcon aria-hidden="true" />
              </span>
            </div>
            <label className="lot-presentations-create-modal-field">
              <span>Название подборки</span>
              <input
                autoFocus
                placeholder="Например, Сокол для Иванова"
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.currentTarget.value)}
              />
            </label>
            {createCollectionError ? <p className="form-error lot-presentations-create-modal-error">{createCollectionError}</p> : null}
            <div className="lot-presentations-create-modal-actions">
              <button
                className="secondary-button secondary-button--fit lot-presentations-create-modal-button"
                disabled={isSubmitting}
                type="button"
                onClick={closeCreateCollectionModal}
              >
                Отмена
              </button>
              <button
                className="primary-button primary-button--fit lot-presentations-create-modal-button"
                disabled={isSubmitting}
                type="submit"
              >
                <CheckIcon aria-hidden="true" />
                Создать
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {activeCommentTarget ? (
        <div
          className="lot-presentations-create-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setActiveCommentTarget(null);
            }
          }}
        >
          <div
            className="lot-presentations-comment-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lot-presentations-comment-title"
          >
            <div className="lot-presentations-create-modal-header">
              <div>
                <h3 id="lot-presentations-comment-title">Комментарий</h3>
                <p>{commentDraft.length}/{commentMaxLength}</p>
              </div>
              <button
                className="lot-presentations-project-modal-close"
                type="button"
                aria-label="Закрыть комментарий"
                onClick={() => setActiveCommentTarget(null)}
              >
                <XIcon aria-hidden="true" />
              </button>
            </div>
            <textarea
              className="lot-presentations-comment-textarea"
              maxLength={commentMaxLength}
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.currentTarget.value)}
            />
            {commentDraft.length > commentMaxLength ? (
              <p className="form-error">Комментарий не может быть длиннее 1000 символов</p>
            ) : null}
            <div className="lot-presentations-create-modal-actions">
              <button
                className="secondary-button secondary-button--fit"
                type="button"
                onClick={() => setActiveCommentTarget(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button primary-button--fit"
                disabled={isSubmitting || commentDraft.length > commentMaxLength}
                type="button"
                onClick={() => void saveComment()}
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCollectionPickerOpenFor ? (
        <div
          className="lot-collection-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCollectionPicker();
            }
          }}
        >
          <div className="lot-collection-modal" role="dialog" aria-modal="true" aria-labelledby="lot-collection-picker-title">
            <header className="lot-collection-modal-header">
              <div>
                <p className="eyebrow">Подборки</p>
                <h3 id="lot-collection-picker-title">Добавить в подборку</h3>
              </div>
              <button
                className="lot-collection-modal-close"
                type="button"
                aria-label="Закрыть"
                onClick={closeCollectionPicker}
              >
                <XIcon aria-hidden="true" />
              </button>
            </header>

            <div className="lot-collection-list" aria-label="Список подборок">
              {collections.map((collection) => {
                const isAlreadyAdded = isCollectionPickerOpenFor.collectionIds.includes(collection.id);

                return (
                  <button
                    key={collection.id}
                    className="lot-collection-choice"
                    disabled={isSubmitting || isAlreadyAdded}
                    type="button"
                    onClick={() => void addLotToCollection(collection.id, isCollectionPickerOpenFor.id)}
                  >
                    <span>
                      <strong>{collection.name}</strong>
                      <small>{collection.itemsCount} лотов</small>
                    </span>
                    {isAlreadyAdded ? <CheckIcon aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />}
                  </button>
                );
              })}
            </div>

            <form
              className="lot-collection-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createCollectionAndAddPickerLot();
              }}
            >
              <label>
                Новая подборка
                <input
                  placeholder="Например: Клиент Иванов"
                  type="text"
                  value={pickerCollectionName}
                  onChange={(event) => setPickerCollectionName(event.currentTarget.value)}
                />
              </label>
              <div className="lot-collection-create-actions">
                <button className="secondary-button" disabled={isSubmitting} type="button" onClick={closeCollectionPicker}>
                  Отмена
                </button>
                <button className="primary-button" disabled={isSubmitting} type="submit">
                  ОК
                </button>
              </div>
            </form>

            {pickerError ? <p className="form-error">{pickerError}</p> : null}
          </div>
        </div>
      ) : null}

      {isDocumentsPanelOpen ? (
        <div
          className="lot-presentations-documents-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsDocumentsPanelOpen(false);
            }
          }}
        >
          <aside
            aria-labelledby="lot-presentations-documents-title"
            aria-modal="true"
            className="lot-presentations-documents-panel"
            role="dialog"
          >
            <div className="lot-presentations-panel-header">
              <div>
                <p className="eyebrow">Архив</p>
                <h3 id="lot-presentations-documents-title">Созданные PDF</h3>
              </div>
              <button
                className="icon-action-button"
                type="button"
                aria-label="Закрыть список PDF"
                onClick={() => setIsDocumentsPanelOpen(false)}
              >
                <XIcon aria-hidden="true" />
              </button>
            </div>

            <div className="lot-presentations-documents-list">
              {isDocumentsLoading ? <p className="muted-text">Загрузка истории</p> : null}
              {!isDocumentsLoading && documents.length === 0 ? (
                <div className="lot-presentations-empty">
                  <strong>PDF еще не создавались</strong>
                  <span>Сформированные презентации появятся здесь.</span>
                </div>
              ) : null}
              {documents.map((document) => (
                <button
                  className="lot-presentations-document"
                  key={document.id}
                  type="button"
                  onClick={() => accessToken && void downloadDocument(document, accessToken)}
                >
                  <FileTextIcon aria-hidden="true" />
                  <span>
                    <strong>{document.title}</strong>
                    <small>{document.unitsCount} лотов / {formatDate(document.createdAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ProjectLotsModal({
  accessToken,
  error,
  groups,
  isLoading,
  isSubmitting,
  project,
  selectedCollection,
  total,
  onAddLot,
  onClose,
}: {
  accessToken: string;
  error: string | null;
  groups: LotPresentationProjectCompletionGroup[];
  isLoading: boolean;
  isSubmitting: boolean;
  project: LotPresentationProjectResult;
  selectedCollection: LotPresentationCollection | null;
  total: number;
  onAddLot: (unitId: string) => void;
  onClose: () => void;
}) {
  const [expandedCompletionGroups, setExpandedCompletionGroups] = useState<Set<string>>(() => new Set());
  const [expandedRoomGroups, setExpandedRoomGroups] = useState<Set<string>>(() => new Set());
  const [visibleRoomLotCounts, setVisibleRoomLotCounts] = useState<Record<string, number>>({});
  const selectedUnitIds = useMemo(
    () => new Set(selectedCollection?.items.map((item) => item.unitId) ?? []),
    [selectedCollection],
  );

  useEffect(() => {
    setExpandedCompletionGroups(new Set());
    setExpandedRoomGroups(new Set());
    setVisibleRoomLotCounts({});
  }, [project.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function toggleCompletionGroup(groupKey: string) {
    setExpandedCompletionGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);

      if (nextGroups.has(groupKey)) {
        nextGroups.delete(groupKey);
      } else {
        nextGroups.add(groupKey);
      }

      return nextGroups;
    });
  }

  function toggleRoomGroup(roomExpansionKey: string) {
    setExpandedRoomGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);

      if (nextGroups.has(roomExpansionKey)) {
        nextGroups.delete(roomExpansionKey);
      } else {
        nextGroups.add(roomExpansionKey);
      }

      return nextGroups;
    });
  }

  return (
    <div
      className="lot-presentations-project-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="lot-presentations-project-modal-title"
        aria-modal="true"
        className="lot-presentations-project-modal"
        role="dialog"
      >
        <div className="lot-presentations-project-modal-header">
          <div>
            <p className="eyebrow">Проект</p>
            <h3 id="lot-presentations-project-modal-title">Лоты ЖК</h3>
            <strong>{project.title}</strong>
            <span>{formatProjectLocation(project)}</span>
          </div>
          <button
            className="lot-presentations-project-modal-close"
            type="button"
            aria-label="Закрыть лоты ЖК"
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>

        <div className="lot-presentations-project-modal-summary">
          <span>
            <strong>{isLoading ? '...' : formatNumber(total)}</strong>
            <small>лотов</small>
          </span>
          <span>
            <strong>{selectedCollection?.name ?? 'Не выбрана'}</strong>
            <small>подборка</small>
          </span>
        </div>

        {isLoading ? (
          <div className="object-feed-units-state">
            <strong>Загрузка лотов</strong>
            <span>Собираем структуру по корпусам и срокам сдачи.</span>
          </div>
        ) : null}

        {!isLoading && error ? (
          <div className="object-feed-units-state object-feed-units-state--error">
            <strong>Не удалось загрузить лоты ЖК</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {!isLoading && !error && groups.length === 0 ? (
          <div className="object-feed-units-state">
            <strong>Лоты не найдены</strong>
            <span>Для этого ЖК нет доступных лотов для презентации.</span>
          </div>
        ) : null}

        {!isLoading && !error && groups.length > 0 ? (
          <div className="object-feed-groups lot-presentations-project-groups">
            {groups.map((group) => (
              <ProjectCompletionGroup
                accessToken={accessToken}
                expandedRoomGroups={expandedRoomGroups}
                group={group}
                isExpanded={expandedCompletionGroups.has(group.key)}
                key={group.key}
                selectedCollection={selectedCollection}
                selectedUnitIds={selectedUnitIds}
                visibleRoomLotCounts={visibleRoomLotCounts}
                isSubmitting={isSubmitting}
                onAddLot={onAddLot}
                onShowMoreLots={(roomExpansionKey, visibleCount) => {
                  setVisibleRoomLotCounts((currentCounts) => ({
                    ...currentCounts,
                    [roomExpansionKey]: visibleCount + presentationProjectModalPageSize,
                  }));
                }}
                onToggleCompletionGroup={toggleCompletionGroup}
                onToggleRoomGroup={toggleRoomGroup}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ProjectCompletionGroup({
  accessToken,
  expandedRoomGroups,
  group,
  isExpanded,
  isSubmitting,
  selectedCollection,
  selectedUnitIds,
  visibleRoomLotCounts,
  onAddLot,
  onShowMoreLots,
  onToggleCompletionGroup,
  onToggleRoomGroup,
}: {
  accessToken: string;
  expandedRoomGroups: Set<string>;
  group: LotPresentationProjectCompletionGroup;
  isExpanded: boolean;
  isSubmitting: boolean;
  selectedCollection: LotPresentationCollection | null;
  selectedUnitIds: Set<string>;
  visibleRoomLotCounts: Record<string, number>;
  onAddLot: (unitId: string) => void;
  onShowMoreLots: (roomExpansionKey: string, visibleCount: number) => void;
  onToggleCompletionGroup: (groupKey: string) => void;
  onToggleRoomGroup: (roomExpansionKey: string) => void;
}) {
  const buildingsLabel = group.buildings.length > 0 ? group.buildings.join(', ') : 'Корпуса не указаны';

  return (
    <section className="object-feed-completion-group lot-presentations-project-completion-group">
      <button
        aria-expanded={isExpanded}
        className="object-feed-completion-button"
        type="button"
        onClick={() => onToggleCompletionGroup(group.key)}
      >
        {isExpanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        <span>
          <strong>{buildingsLabel}</strong>
          <small>{group.label}</small>
        </span>
        <b>{formatNumber(group.total)}</b>
      </button>

      {isExpanded ? (
        <div className="object-feed-room-groups">
          {group.roomGroups.map((roomGroup) => {
            const roomExpansionKey = makeRoomGroupExpansionKey(group.key, roomGroup.key);

            return (
              <ProjectRoomGroup
                accessToken={accessToken}
                isExpanded={expandedRoomGroups.has(roomExpansionKey)}
                isSubmitting={isSubmitting}
                key={roomExpansionKey}
                roomExpansionKey={roomExpansionKey}
                roomGroup={roomGroup}
                selectedCollection={selectedCollection}
                selectedUnitIds={selectedUnitIds}
                visibleCount={visibleRoomLotCounts[roomExpansionKey] ?? presentationProjectModalPageSize}
                onAddLot={onAddLot}
                onShowMoreLots={onShowMoreLots}
                onToggleRoomGroup={onToggleRoomGroup}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ProjectRoomGroup({
  accessToken,
  isExpanded,
  isSubmitting,
  roomExpansionKey,
  roomGroup,
  selectedCollection,
  selectedUnitIds,
  visibleCount,
  onAddLot,
  onShowMoreLots,
  onToggleRoomGroup,
}: {
  accessToken: string;
  isExpanded: boolean;
  isSubmitting: boolean;
  roomExpansionKey: string;
  roomGroup: LotPresentationProjectRoomGroup;
  selectedCollection: LotPresentationCollection | null;
  selectedUnitIds: Set<string>;
  visibleCount: number;
  onAddLot: (unitId: string) => void;
  onShowMoreLots: (roomExpansionKey: string, visibleCount: number) => void;
  onToggleRoomGroup: (roomExpansionKey: string) => void;
}) {
  const visibleItems = roomGroup.items.slice(0, visibleCount);
  const hiddenItemsCount = Math.max(0, roomGroup.items.length - visibleItems.length);

  return (
    <section className="object-feed-room-group lot-presentations-project-room-group">
      <button
        aria-expanded={isExpanded}
        className="object-feed-room-row"
        type="button"
        onClick={() => onToggleRoomGroup(roomExpansionKey)}
      >
        {isExpanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        <strong>{roomGroup.label}</strong>
        <span>{formatFeedUnitRange(roomGroup.areaMin, roomGroup.areaMax, formatArea)}</span>
        <span>{formatFeedUnitRange(roomGroup.priceMin, roomGroup.priceMax, (value) => formatPrice(value, null))}</span>
        <b>{formatNumber(roomGroup.total)}</b>
      </button>

      {isExpanded ? (
        <>
          <div className="table-scroll object-feed-units-table-wrap">
            <Table className="object-feed-units-table lot-presentations-project-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Медиа</TableHead>
                  <TableHead>Корпус</TableHead>
                  <TableHead>Секц.</TableHead>
                  <TableHead>Эт.</TableHead>
                  <TableHead>Номер квартиры</TableHead>
                  <TableHead>Площадь</TableHead>
                  <TableHead>Цена</TableHead>
                  <TableHead>Цена со скидкой</TableHead>
                  <TableHead>За м²</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead aria-label="Подборка" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.map((lot) => (
                  <ProjectLotRow
                    accessToken={accessToken}
                    isSubmitting={isSubmitting}
                    key={lot.id}
                    lot={lot}
                    selectedCollection={selectedCollection}
                    selectedUnitIds={selectedUnitIds}
                    onAddLot={onAddLot}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {hiddenItemsCount > 0 ? (
            <button
              className="text-button object-feed-room-show-more"
              type="button"
              onClick={() => onShowMoreLots(roomExpansionKey, visibleCount)}
            >
              Показать еще {formatNumber(Math.min(presentationProjectModalPageSize, hiddenItemsCount))}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ProjectLotRow({
  accessToken,
  isSubmitting,
  lot,
  selectedCollection,
  selectedUnitIds,
  onAddLot,
}: {
  accessToken: string;
  isSubmitting: boolean;
  lot: LotPresentationLot;
  selectedCollection: LotPresentationCollection | null;
  selectedUnitIds: Set<string>;
  onAddLot: (unitId: string) => void;
}) {
  const primaryMedia = lot.media.find((media) => media.file) ?? null;
  const title = getLotTitle(lot);
  const alreadyAdded = selectedUnitIds.has(lot.id);
  const addButtonLabel = !selectedCollection
    ? 'Выберите подборку'
    : alreadyAdded
      ? 'Лот уже в подборке'
      : 'Добавить лот в подборку';

  return (
    <TableRow className="object-feed-unit-row lot-presentations-project-lot-row">
      <TableCell>
        {primaryMedia?.file ? (
          <span className="object-feed-media-preview">
            <SecureImage
              accessToken={accessToken}
              alt={primaryMedia.label ?? title}
              className="object-feed-media-image"
              fileId={primaryMedia.file.id}
              lazy
              placeholderClassName="object-feed-media-placeholder"
              variant="thumbnail"
            />
          </span>
        ) : (
          <span className="object-feed-media-empty">{formatMediaCount(0)}</span>
        )}
      </TableCell>
      <TableCell>{formatFeedUnitBuildingValue(lot.building)}</TableCell>
      <TableCell>{formatFeedUnitShortValue(lot.section)}</TableCell>
      <TableCell>{lot.floor ?? 'Не указан'}</TableCell>
      <TableCell>
        <div className="object-feed-unit-cell">
          <a
            className="object-feed-unit-link"
            href={`/objects/${encodeURIComponent(lot.object.slug)}/lots/${encodeURIComponent(lot.id)}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            <strong>{title}</strong>
          </a>
          {lot.address ? <span>{lot.address}</span> : null}
        </div>
      </TableCell>
      <TableCell>{formatArea(lot.area)}</TableCell>
      <TableCell>{formatPrice(lot.price, lot.currency)}</TableCell>
      <TableCell>
        {hasLotRealDiscount(lot) ? (
          <strong>{formatDiscountPrice(lot)}</strong>
        ) : (
          formatDiscountPrice(lot)
        )}
      </TableCell>
      <TableCell>{formatPricePerMeter(lot)}</TableCell>
      <TableCell>
        <span className={`object-feed-status object-feed-status--${lot.status.toLowerCase()}`}>
          {feedUnitStatusLabels[lot.status]}
        </span>
      </TableCell>
      <TableCell>
        <button
          className={`icon-action-button lot-presentations-project-add-button${alreadyAdded ? ' is-added' : ''}`}
          disabled={!selectedCollection || alreadyAdded || isSubmitting}
          type="button"
          aria-label={addButtonLabel}
          title={addButtonLabel}
          onClick={() => onAddLot(lot.id)}
        >
          {alreadyAdded ? <CheckIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
        </button>
      </TableCell>
    </TableRow>
  );
}

function LotPresentationLotTile({
  accessToken,
  collectionNames = [],
  comment,
  lot,
  onDownloadOne,
  onOpenCollectionPicker,
  onOpenComment,
  onRemove,
}: {
  accessToken: string;
  collectionNames?: string[];
  comment: string | null;
  lot: LotPresentationLot;
  onDownloadOne: () => void;
  onOpenCollectionPicker?: () => void;
  onOpenComment: () => void;
  onRemove: () => void;
}) {
  const collectionTooltipId = `lot-collection-tooltip-${lot.id}`;
  const hasCollectionTooltip = Boolean(onOpenCollectionPicker && collectionNames.length > 0);

  return (
    <article className="lot-presentations-lot-tile">
      <LotThumb accessToken={accessToken} lot={lot} />
      <div className="lot-presentations-lot-tile-body">
        <h3>{getLotTitle(lot)}</h3>
        <span>{lot.object.title}</span>
        <strong>{formatPrice(lot.effectivePrice ?? lot.discountPrice ?? lot.price, lot.currency)}</strong>
        <small>{[formatArea(lot.area), formatFloor(lot.floor)].filter(Boolean).join(' / ')}</small>
        <p>{feedUnitStatusLabels[lot.status]}</p>
      </div>
      <div className="lot-presentations-tile-actions">
        <button className="icon-action-button" type="button" aria-label="Скачать PDF лота" onClick={onDownloadOne}>
          <DownloadIcon aria-hidden="true" />
        </button>
        {onOpenCollectionPicker ? (
          <span className="lot-presentations-collection-action">
            <button
              className="icon-action-button"
              type="button"
              aria-label="Добавить в подборку"
              aria-describedby={hasCollectionTooltip ? collectionTooltipId : undefined}
              onClick={onOpenCollectionPicker}
            >
              <FolderPlusIcon aria-hidden="true" />
            </button>
            {hasCollectionTooltip ? (
              <span className="lot-presentations-collection-tooltip" id={collectionTooltipId} role="tooltip">
                <strong>Подборка:</strong>
                {collectionNames.map((name, index) => (
                  <span key={`${name}-${index}`}>{name}</span>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
        <button
          className={
            comment
              ? 'icon-action-button lot-presentations-comment-action is-active'
              : 'icon-action-button lot-presentations-comment-action'
          }
          type="button"
          aria-label={comment ? 'Открыть комментарий' : 'Добавить комментарий'}
          onClick={onOpenComment}
        >
          <MessageSquareIcon aria-hidden="true" />
        </button>
        <button className="icon-action-button icon-action-button--danger" type="button" aria-label="Удалить лот" onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
        </button>
      </div>
      <button className="lot-presentations-comment-button" type="button" onClick={onOpenComment}>
        {comment ? 'Изменить комментарий' : 'Добавить комментарий'}
      </button>
    </article>
  );
}

function LotThumb({ accessToken, lot }: { accessToken: string; lot: LotPresentationLot }) {
  const media = lot.media.find((item) => item.file)?.file ?? null;

  return (
    <div className="lot-presentations-thumb">
      {media ? (
        <SecureImage
          accessToken={accessToken}
          alt={getLotTitle(lot)}
          fileId={media.id}
          lazy
          placeholderClassName="object-feed-media-placeholder"
          variant="thumbnail"
        />
      ) : (
        <span>Нет плана</span>
      )}
    </div>
  );
}

function getProjectResultsFromLots(lots: LotPresentationLot[]) {
  const projects = new Map<string, LotPresentationProjectResult>();

  for (const lot of lots) {
    const currentProject = projects.get(lot.object.id);

    if (currentProject) {
      currentProject.lotsCount += 1;
    } else {
      projects.set(lot.object.id, {
        ...lot.object,
        lotsCount: 1,
      });
    }
  }

  return Array.from(projects.values()).sort((leftProject, rightProject) =>
    leftProject.title.localeCompare(rightProject.title, 'ru', { sensitivity: 'base' }),
  );
}

function createProjectLotGroups(lots: LotPresentationLot[]) {
  type CompletionGroupDraft = {
    key: string;
    label: string;
    sortYear: number | null;
    sortQuarter: number | null;
    buildings: Set<string>;
    items: LotPresentationLot[];
  };
  const completionGroups = new Map<string, CompletionGroupDraft>();

  for (const lot of lots) {
    const groupInfo = getLotCompletionGroupInfo(lot);
    const group = completionGroups.get(groupInfo.key) ?? {
      ...groupInfo,
      buildings: new Set<string>(),
      items: [],
    };
    const building = lot.building?.trim();

    if (building) {
      group.buildings.add(building);
    }

    group.items.push(lot);
    completionGroups.set(group.key, group);
  }

  return Array.from(completionGroups.values())
    .sort(compareCompletionGroups)
    .map((group) => ({
      key: group.key,
      label: group.label,
      buildings: Array.from(group.buildings).sort((leftBuilding, rightBuilding) =>
        leftBuilding.localeCompare(rightBuilding, 'ru', { numeric: true, sensitivity: 'base' }),
      ),
      total: group.items.length,
      roomGroups: createProjectRoomGroups(group.items),
    }));
}

function getLotCompletionGroupInfo(lot: LotPresentationLot) {
  if (lot.completionYear !== null && lot.completionYear < 1900) {
    return {
      key: 'delivered',
      label: 'Сдан',
      sortYear: 0,
      sortQuarter: 0,
    };
  }

  if (lot.completionYear && lot.completionQuarter) {
    return {
      key: `${lot.completionYear}-q${lot.completionQuarter}`,
      label: `${lot.completionQuarter} кв. ${lot.completionYear}`,
      sortYear: lot.completionYear,
      sortQuarter: lot.completionQuarter,
    };
  }

  if (lot.completionYear) {
    return {
      key: `${lot.completionYear}`,
      label: String(lot.completionYear),
      sortYear: lot.completionYear,
      sortQuarter: 0,
    };
  }

  return {
    key: 'unknown',
    label: 'Срок не указан',
    sortYear: null,
    sortQuarter: null,
  };
}

function compareCompletionGroups(
  leftGroup: { sortYear: number | null; sortQuarter: number | null },
  rightGroup: { sortYear: number | null; sortQuarter: number | null },
) {
  if (leftGroup.sortYear === null && rightGroup.sortYear === null) {
    return 0;
  }

  if (leftGroup.sortYear === null) {
    return 1;
  }

  if (rightGroup.sortYear === null) {
    return -1;
  }

  return leftGroup.sortYear - rightGroup.sortYear || (leftGroup.sortQuarter ?? 0) - (rightGroup.sortQuarter ?? 0);
}

function createProjectRoomGroups(lots: LotPresentationLot[]) {
  type RoomGroupDraft = {
    key: string;
    label: string;
    sortOrder: number;
    items: LotPresentationLot[];
  };
  const roomGroups = new Map<string, RoomGroupDraft>();

  for (const lot of lots) {
    const groupInfo = getLotRoomGroupInfo(lot);
    const group = roomGroups.get(groupInfo.key) ?? {
      ...groupInfo,
      items: [],
    };

    group.items.push(lot);
    roomGroups.set(group.key, group);
  }

  return Array.from(roomGroups.values())
    .sort((leftGroup, rightGroup) => leftGroup.sortOrder - rightGroup.sortOrder || leftGroup.label.localeCompare(rightGroup.label, 'ru'))
    .map((group) => ({
      key: group.key,
      label: group.label,
      total: group.items.length,
      areaMin: findLotDecimalBoundary(group.items, 'area', 'min'),
      areaMax: findLotDecimalBoundary(group.items, 'area', 'max'),
      priceMin: findLotPriceBoundary(group.items, 'min'),
      priceMax: findLotPriceBoundary(group.items, 'max'),
      items: [...group.items].sort(compareLotsByPrice),
    }));
}

function getLotRoomGroupInfo(lot: LotPresentationLot) {
  if (lot.type === 'COMMERCIAL') {
    return {
      key: 'commercial',
      label: 'Коммерция',
      sortOrder: 1000,
    };
  }

  if (lot.rooms === 0) {
    return {
      key: 'studio',
      label: 'Студии',
      sortOrder: 0,
    };
  }

  if (lot.rooms) {
    return {
      key: `${lot.rooms}-rooms`,
      label: `${lot.rooms}-комн.`,
      sortOrder: lot.rooms,
    };
  }

  return {
    key: 'unknown',
    label: 'Комнатность не указана',
    sortOrder: 999,
  };
}

function findLotDecimalBoundary(lots: LotPresentationLot[], field: 'area', mode: 'min' | 'max') {
  const values = lots
    .map((lot) => parseNullableNumber(lot[field]))
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return null;
  }

  return String(mode === 'min' ? Math.min(...values) : Math.max(...values));
}

function findLotPriceBoundary(lots: LotPresentationLot[], mode: 'min' | 'max') {
  const values = lots
    .map(getEffectiveLotPrice)
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return null;
  }

  return String(mode === 'min' ? Math.min(...values) : Math.max(...values));
}

function compareLotsByPrice(leftLot: LotPresentationLot, rightLot: LotPresentationLot) {
  return (
    compareNullableNumber(getEffectiveLotPrice(leftLot), getEffectiveLotPrice(rightLot)) ||
    compareNullableNumber(parseNullableNumber(leftLot.area), parseNullableNumber(rightLot.area)) ||
    getLotTitle(leftLot).localeCompare(getLotTitle(rightLot), 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function getEffectiveLotPrice(lot: LotPresentationLot) {
  return parseNullableNumber(lot.effectivePrice) ?? parseNullableNumber(lot.discountPrice) ?? parseNullableNumber(lot.price);
}

function parseNullableNumber(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function compareNullableNumber(leftValue: number | null, rightValue: number | null) {
  if (leftValue === null && rightValue === null) {
    return 0;
  }

  if (leftValue === null) {
    return 1;
  }

  if (rightValue === null) {
    return -1;
  }

  return leftValue - rightValue;
}

function makeRoomGroupExpansionKey(completionGroupKey: string, roomGroupKey: string) {
  return `${completionGroupKey}:${roomGroupKey}`;
}

function formatFeedUnitRange(valueMin: string | null, valueMax: string | null, formatter: (value: string) => string) {
  if (!valueMin && !valueMax) {
    return 'Не указано';
  }

  if (valueMin && valueMax && valueMin !== valueMax) {
    return `${formatter(valueMin)} - ${formatter(valueMax)}`;
  }

  return formatter(valueMin ?? valueMax ?? '');
}

function formatFeedUnitShortValue(value: string | null) {
  return value?.trim() || 'Не указано';
}

function formatFeedUnitBuildingValue(value: string | null) {
  return value?.trim() || 'Корпус не указан';
}

function formatDiscountPrice(lot: LotPresentationLot) {
  return formatPrice(lot.discountPrice ?? lot.price, lot.currency);
}

function hasLotRealDiscount(lot: LotPresentationLot) {
  const price = parseNullableNumber(lot.price);
  const discountPrice = parseNullableNumber(lot.discountPrice);

  return price !== null && discountPrice !== null && price > 0 && discountPrice > 0 && discountPrice < price;
}

function formatProjectLocation(project: LotPresentationProjectResult) {
  return [project.developer?.name, project.primaryLocation?.name, project.address].filter(Boolean).join(' / ') || 'Локация не указана';
}

function formatProjectLotsCount(value: number) {
  return `${formatNumber(value)} ${formatPlural(value, ['лот', 'лота', 'лотов'])}`;
}

function formatMediaCount(value: number) {
  if (value === 0) {
    return 'Нет';
  }

  return `${formatNumber(value)} ${formatPlural(value, ['файл', 'файла', 'файлов'])}`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return 'Не указано';
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 100 ? 1 : 0,
  }).format(value);
}

function formatPlural(value: number, forms: [string, string, string]) {
  const normalizedValue = Math.abs(value) % 100;
  const lastDigit = normalizedValue % 10;

  if (normalizedValue > 10 && normalizedValue < 20) {
    return forms[2];
  }

  if (lastDigit > 1 && lastDigit < 5) {
    return forms[1];
  }

  if (lastDigit === 1) {
    return forms[0];
  }

  return forms[2];
}

function ensureCanDownload(
  user: AuthUser | null,
  lots: LotPresentationLot[],
  setError: (message: string | null) => void,
) {
  if (!user?.brokerPhone || !user.brokerEmail) {
    setError('Заполните телефон и почту брокера в профиле перед скачиванием презентации');
    return false;
  }

  const lotWithoutPlan = lots.find((lot) => !lot.hasPlanImage);

  if (lotWithoutPlan) {
    setError(`Планировка отсутствует в лоте: ${getLotTitle(lotWithoutPlan)}`);
    return false;
  }

  return true;
}

async function downloadDocument(document: LotPresentationDocument, accessToken: string) {
  const response = await fetch(`${apiUrl}/lot-presentations/documents/${encodeURIComponent(document.id)}/content`, {
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Не удалось скачать PDF');
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = window.document.createElement('a');

  link.href = url;
  link.download = `${document.title || 'lot-presentation'}.pdf`;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function getCollectionIdFromLocation() {
  return new URLSearchParams(window.location.search).get('collectionId');
}

function getLotTitle(lot: LotPresentationLot) {
  return lot.title?.trim() || lot.residentialDetails?.apartmentNumber || `Лот ${lot.externalId}`;
}

function formatPrice(value: string | null, currency: string | null) {
  if (!value) {
    return 'По запросу';
  }

  const parsed = Number(value);
  const formatted = Number.isFinite(parsed) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(parsed) : value;

  if (currency && !['RUB', 'RUR'].includes(currency.toUpperCase())) {
    return `${formatted} ${currency}`;
  }

  return `${formatted} ₽`;
}

function formatPricePerMeter(lot: LotPresentationLot) {
  const value = lot.effectivePricePerMeter ?? lot.discountPricePerMeter ?? lot.pricePerMeter;

  return value ? `${formatPrice(value, lot.currency)}/м²` : 'м² по запросу';
}

function formatArea(value: string | null) {
  if (!value) {
    return 'Площадь не указана';
  }

  const parsed = Number(value);

  return `${Number.isFinite(parsed) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(parsed) : value} м²`;
}

function formatFloor(value: number | null) {
  return value === null ? 'Этаж не указан' : `${value} этаж`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}
