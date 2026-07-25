import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  EyeIcon,
  FilePlus2Icon,
  ImageIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';

import { useAuth } from '../../auth/AuthProvider';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { SecureImage } from '../../files/SecureImage';
import {
  createProjectPresentationDocument,
  createProjectPresentationDraft,
  downloadProjectPresentationDocument,
  getProjectPresentationDocument,
  getProjectPresentationDraft,
  replaceProjectPresentationObjects,
  searchProjectPresentationObjects,
  updateProjectPresentationDraft,
  uploadProjectPresentationCover,
} from './projectPresentationApi';
import { ProjectPresentationPreview } from './ProjectPresentationPreview';
import {
  createDraftObject,
  createProjectPresentationForm,
  findProjectImage,
  reorderDraftObjects,
  toDraftObjectInputs,
  validateProjectPresentationForm,
} from './projectPresentationState';
import type {
  ProjectPresentationDocument,
  ProjectPresentationDraft,
  ProjectPresentationDraftForm,
  ProjectPresentationObject,
  ProjectPresentationValidationIssue,
} from './projectPresentationTypes';
import {
  projectPresentationMaxCoverFileSizeBytes,
  projectPresentationMaxImages,
  projectPresentationMaxObjects,
} from './projectPresentationTypes';
import './projectPresentations.css';

type ProjectPresentationEditorPageProps = {
  draftId: string | null;
  navigate: (pathname: string) => void;
};

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'conflict' | 'error';
type ImagePickerTarget = { kind: 'cover' } | { kind: 'project'; objectId: string };
type EditorStepId = 'objects' | 'cards' | 'cover' | 'review';

const editorSteps: Array<{ id: EditorStepId; label: string }> = [
  { id: 'objects', label: 'Выбор ЖК' },
  { id: 'cards', label: 'Карточки' },
  { id: 'cover', label: 'Обложка' },
  { id: 'review', label: 'Проверка' },
];

const activeDocumentStatuses = new Set<ProjectPresentationDocument['status']>(['PENDING', 'RUNNING']);
const acceptedCoverImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const coverImageAccept = [...acceptedCoverImageMimeTypes].join(',');

function formatIssueCount(count: number) {
  const remainder100 = count % 100;
  const remainder10 = count % 10;

  if (remainder100 >= 11 && remainder100 <= 14) {
    return `${count} вопросов`;
  }

  if (remainder10 === 1) {
    return `${count} вопрос`;
  }

  if (remainder10 >= 2 && remainder10 <= 4) {
    return `${count} вопроса`;
  }

  return `${count} вопросов`;
}

export function ProjectPresentationEditorPage({ draftId, navigate }: ProjectPresentationEditorPageProps) {
  if (!draftId) {
    return <NewProjectPresentationPage navigate={navigate} />;
  }

  return <ExistingProjectPresentationEditor draftId={draftId} navigate={navigate} />;
}

function NewProjectPresentationPage({ navigate }: Pick<ProjectPresentationEditorPageProps, 'navigate'>) {
  const { accessToken } = useAuth();
  const [title, setTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken || isSubmitting) {
      return;
    }

    if (!title.trim()) {
      setError('Введите название черновика');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await createProjectPresentationDraft(accessToken, title.trim());
      navigate(`/presentations/projects/${encodeURIComponent(response.draft.id)}`);
    } catch (caughtError) {
      setError(resolveError(caughtError, 'Не удалось создать черновик'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="project-presentations-page">
      <header className="page-header project-presentations-header">
        <div>
          <p className="eyebrow">Новая презентация</p>
          <h2>Создайте черновик презентации</h2>
          <p className="muted-text">Название можно изменить позже. Первым шагом станет выбор жилых комплексов.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => navigate('/presentations/projects')}>
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
          К списку
        </Button>
      </header>
      <Card className="project-presentation-new-card">
        <CardHeader>
          <CardTitle>Название черновика</CardTitle>
          <CardDescription>Его увидят авторизованные пользователи в общем списке.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="new-project-presentation-title">Название</FieldLabel>
              <Input
                autoFocus
                aria-invalid={Boolean(error)}
                id="new-project-presentation-title"
                maxLength={180}
                placeholder="Например, Семейные ЖК у воды"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <Button disabled={isSubmitting} size="lg" type="submit">
              <FilePlus2Icon data-icon="inline-start" aria-hidden="true" />
              {isSubmitting ? 'Создаём…' : 'Создать презентацию'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ExistingProjectPresentationEditor({
  draftId,
  navigate,
}: {
  draftId: string;
  navigate: (pathname: string) => void;
}) {
  const { accessToken, user } = useAuth();
  const [draft, setDraft] = useState<ProjectPresentationDraft | null>(null);
  const [form, setForm] = useState<ProjectPresentationDraftForm | null>(null);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeStep, setActiveStep] = useState<EditorStepId>('objects');
  const [expandedObjectId, setExpandedObjectId] = useState<string | null>(null);
  const [objectSearch, setObjectSearch] = useState('');
  const deferredObjectSearch = useDeferredValue(objectSearch);
  const [objectResults, setObjectResults] = useState<ProjectPresentationObject[]>([]);
  const [isObjectSearchLoading, setIsObjectSearchLoading] = useState(false);
  const [objectSearchError, setObjectSearchError] = useState<string | null>(null);
  const [imagePickerTarget, setImagePickerTarget] = useState<ImagePickerTarget | null>(null);
  const [isCoverUploading, setIsCoverUploading] = useState(false);
  const [coverUploadError, setCoverUploadError] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [document, setDocument] = useState<ProjectPresentationDocument | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const draftRef = useRef<ProjectPresentationDraft | null>(null);
  const formRef = useRef<ProjectPresentationDraftForm | null>(null);
  const revisionRef = useRef(0);
  const isDirtyRef = useRef(false);
  const isCoverUploadingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const savePromiseRef = useRef<Promise<ProjectPresentationDraft | null> | null>(null);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    let isCancelled = false;
    setIsLoading(true);
    setSaveError(null);

    void getProjectPresentationDraft(accessToken, draftId)
      .then((response) => {
        if (isCancelled) {
          return;
        }

        const nextForm = createProjectPresentationForm(response.draft);
        draftRef.current = response.draft;
        formRef.current = nextForm;
        setDraft(response.draft);
        setForm(nextForm);
        setExpandedObjectId(nextForm.objects[0]?.objectId ?? null);
        setSaveState('saved');
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setSaveError(resolveError(caughtError, 'Не удалось загрузить черновик'));
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [accessToken, draftId]);

  useEffect(() => {
    if (!form || !draft || !isDirtyRef.current || saveState === 'conflict' || isCoverUploading) {
      return;
    }

    const timerId = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistDraft().catch(() => undefined);
    }, 800);
    autosaveTimerRef.current = timerId;

    return () => {
      window.clearTimeout(timerId);
      if (autosaveTimerRef.current === timerId) autosaveTimerRef.current = null;
    };
  }, [draft, form, isCoverUploading, revision, saveState]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirtyRef.current && !isCoverUploadingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (!accessToken || activeStep !== 'objects') {
      return;
    }

    let isCancelled = false;
    setIsObjectSearchLoading(true);
    setObjectSearchError(null);

    void searchProjectPresentationObjects(accessToken, deferredObjectSearch)
      .then((response) => {
        if (!isCancelled) {
          setObjectResults(response.items);
        }
      })
      .catch((caughtError) => {
        if (!isCancelled) {
          setObjectSearchError(resolveError(caughtError, 'Не удалось найти жилые комплексы'));
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsObjectSearchLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [accessToken, activeStep, deferredObjectSearch]);

  useEffect(() => {
    if (!accessToken || !document || !activeDocumentStatuses.has(document.status)) {
      return;
    }

    const timerId = window.setInterval(() => {
      void getProjectPresentationDocument(accessToken, document.id)
        .then((response) => setDocument(response.document))
        .catch(() => undefined);
    }, 2000);

    return () => window.clearInterval(timerId);
  }, [accessToken, document]);

  function changeForm(updater: (currentForm: ProjectPresentationDraftForm) => ProjectPresentationDraftForm) {
    setForm((currentForm) => {
      if (!currentForm) {
        return currentForm;
      }

      const nextForm = updater(currentForm);
      formRef.current = nextForm;
      revisionRef.current += 1;
      isDirtyRef.current = true;
      setRevision(revisionRef.current);
      setSaveState('pending');
      setSaveError(null);
      return nextForm;
    });
  }

  async function persistDraft(): Promise<ProjectPresentationDraft | null> {
    if (!accessToken || !draftRef.current || !formRef.current) {
      return null;
    }

    if (savePromiseRef.current) {
      await savePromiseRef.current;
      return isDirtyRef.current ? persistDraft() : draftRef.current;
    }

    if (!isDirtyRef.current) {
      return draftRef.current;
    }

    const saveRevision = revisionRef.current;
    const snapshot = formRef.current;
    const currentDraft = draftRef.current;
    setSaveState('saving');
    setSaveError(null);

    const savePromise = (async () => {
      try {
        const headerResponse = await updateProjectPresentationDraft(accessToken, currentDraft.id, {
          version: currentDraft.version,
          title: snapshot.title,
          coverTitle: normalizeOptionalText(snapshot.coverTitle),
          coverSubtitle: normalizeOptionalText(snapshot.coverSubtitle),
          clientName: normalizeOptionalText(snapshot.clientName),
          issueLabel: normalizeOptionalText(snapshot.issueLabel),
          coverImageId: snapshot.coverImageId,
        });
        draftRef.current = headerResponse.draft;
        setDraft(headerResponse.draft);
        const objectsResponse = await replaceProjectPresentationObjects(
          accessToken,
          currentDraft.id,
          headerResponse.draft.version,
          toDraftObjectInputs(snapshot.objects),
        );
        const savedDraft = objectsResponse.draft;
        draftRef.current = savedDraft;
        setDraft(savedDraft);

        if (revisionRef.current === saveRevision) {
          const savedForm = createProjectPresentationForm(savedDraft);
          formRef.current = savedForm;
          isDirtyRef.current = false;
          setForm(savedForm);
          setSaveState('saved');
        } else {
          setSaveState('pending');
        }

        return savedDraft;
      } catch (caughtError) {
        const message = resolveError(caughtError, 'Не удалось сохранить изменения');
        const isConflict = /changed|conflict|version|измен/iu.test(message);
        setSaveError(isConflict
          ? 'Черновик уже изменён в другой вкладке. Перезагрузите актуальную версию.'
          : message);
        setSaveState(isConflict ? 'conflict' : 'error');
        throw caughtError;
      }
    })();

    savePromiseRef.current = savePromise;

    try {
      return await savePromise;
    } finally {
      savePromiseRef.current = null;
    }
  }

  async function handleCoverUpload(file: File) {
    if (!accessToken || isCoverUploadingRef.current) {
      return;
    }

    isCoverUploadingRef.current = true;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setIsCoverUploading(true);
    setCoverUploadError(null);

    try {
      const savedDraft = await persistDraft();

      if (!savedDraft) {
        throw new Error('Черновик не сохранён');
      }

      const uploadRevision = revisionRef.current;
      const hasPendingEditsAtUploadStart = isDirtyRef.current;
      const response = await uploadProjectPresentationCover(
        accessToken,
        savedDraft.id,
        savedDraft.version,
        file,
      );
      const serverForm = createProjectPresentationForm(response.draft);
      draftRef.current = response.draft;
      setDraft(response.draft);

      if (revisionRef.current === uploadRevision && !hasPendingEditsAtUploadStart) {
        formRef.current = serverForm;
        isDirtyRef.current = false;
        setForm(serverForm);
        setSaveState('saved');
      } else {
        setForm((currentForm) => {
          const nextForm = currentForm
            ? { ...currentForm, coverImageId: null, coverFile: response.draft.coverFile }
            : serverForm;
          formRef.current = nextForm;
          return nextForm;
        });
        isDirtyRef.current = true;
        setSaveState('pending');
      }
    } catch (caughtError) {
      const message = resolveCoverUploadError(caughtError);
      const isConflict = /changed|conflict|version|измен/iu.test(message);
      setCoverUploadError(message);

      if (isConflict) {
        setSaveError('Черновик уже изменён в другой вкладке. Перезагрузите актуальную версию.');
        setSaveState('conflict');
      }
    } finally {
      isCoverUploadingRef.current = false;
      setIsCoverUploading(false);
    }
  }

  async function reloadDraft() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setSaveError(null);

    try {
      const response = await getProjectPresentationDraft(accessToken, draftId);
      const nextForm = createProjectPresentationForm(response.draft);
      draftRef.current = response.draft;
      formRef.current = nextForm;
      isDirtyRef.current = false;
      setDraft(response.draft);
      setForm(nextForm);
      setExpandedObjectId(nextForm.objects[0]?.objectId ?? null);
      setSaveState('saved');
    } catch (caughtError) {
      setSaveError(resolveError(caughtError, 'Не удалось обновить черновик'));
    } finally {
      setIsLoading(false);
    }
  }

  function addObject(object: ProjectPresentationObject) {
    const shouldExpand = (formRef.current?.objects.length ?? 0) === 0;

    changeForm((currentForm) => {
      if (
        currentForm.objects.length >= projectPresentationMaxObjects ||
        currentForm.objects.some((item) => item.objectId === object.id)
      ) {
        return currentForm;
      }

      return {
        ...currentForm,
        objects: [...currentForm.objects, createDraftObject(object, currentForm.objects.length)],
      };
    });

    if (shouldExpand) {
      setExpandedObjectId(object.id);
    }
  }

  function removeObject(objectId: string) {
    changeForm((currentForm) => {
      const nextObjects = currentForm.objects
        .filter((item) => item.objectId !== objectId)
        .map((item, index) => ({ ...item, sortOrder: index }));
      const coverImageStillAvailable = currentForm.coverImageId
        ? Boolean(findProjectImage(nextObjects, currentForm.coverImageId))
        : true;

      return {
        ...currentForm,
        coverImageId: coverImageStillAvailable ? currentForm.coverImageId : null,
        objects: nextObjects,
      };
    });

    if (expandedObjectId === objectId) {
      const remainingObject = formRef.current?.objects.find((item) => item.objectId !== objectId) ?? null;
      setExpandedObjectId(remainingObject?.objectId ?? null);
    }
  }

  function updateObject(
    objectId: string,
    updates: Partial<ProjectPresentationDraftForm['objects'][number]>,
  ) {
    changeForm((currentForm) => ({
      ...currentForm,
      objects: currentForm.objects.map((item) => item.objectId === objectId ? { ...item, ...updates } : item),
    }));
  }

  function toggleProjectImage(objectId: string, imageId: string) {
    const item = formRef.current?.objects.find((candidate) => candidate.objectId === objectId);

    if (!item) {
      return;
    }

    const isSelected = item.imageIds.includes(imageId);

    if (!isSelected && item.imageIds.length >= projectPresentationMaxImages) {
      return;
    }

    updateObject(objectId, {
      imageIds: isSelected ? item.imageIds.filter((id) => id !== imageId) : [...item.imageIds, imageId],
    });
  }

  async function handleGenerate() {
    if (!accessToken || !formRef.current || isGenerating || isCoverUploading) {
      return;
    }

    const issues = validateProjectPresentationForm(formRef.current);
    setGenerationError(null);

    if (issues.length > 0) {
      openValidationIssue(issues[0]);
      return;
    }

    setIsGenerating(true);

    try {
      const savedDraft = await persistDraft();

      if (!savedDraft) {
        throw new Error('Черновик не сохранён');
      }

      const response = await createProjectPresentationDocument(accessToken, savedDraft);
      setDocument(response.document);
    } catch (caughtError) {
      setGenerationError(resolveError(caughtError, 'Не удалось запустить генерацию PDF'));
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSaveAndExit() {
    if (isExiting || isCoverUploading || saveState === 'conflict') {
      return;
    }

    setIsExiting(true);

    try {
      await persistDraft();
      navigate('/presentations/projects');
    } catch {
      // Ошибка уже показана через SaveIndicator и не должна закрывать редактор.
    } finally {
      setIsExiting(false);
    }
  }

  function activateStep(step: EditorStepId, focusContent = false) {
    setActiveStep(step);

    if (step === 'cards' && !expandedObjectId) {
      setExpandedObjectId(formRef.current?.objects[0]?.objectId ?? null);
    }

    if (focusContent) {
      window.setTimeout(() => {
        window.document.getElementById('project-presentation-step-content')?.focus();
      }, 0);
    }
  }

  function openValidationIssue(issue: ProjectPresentationValidationIssue | undefined) {
    if (!issue) {
      return;
    }

    const objectMatch = issue.path.match(/^objects\.([^.]+)\./u);
    const nextStep: EditorStepId = objectMatch
      ? 'cards'
      : issue.path === 'objects'
        ? 'objects'
        : 'cover';

    if (objectMatch?.[1]) {
      setExpandedObjectId(objectMatch[1]);
    }

    setActiveStep(nextStep);
    window.setTimeout(() => focusValidationIssue(issue), 220);
  }

  if (isLoading) {
    return <ProjectPresentationEditorSkeleton />;
  }

  if (!draft || !form) {
    return (
      <div className="project-presentations-page">
        <Button type="button" variant="outline" onClick={() => navigate('/presentations/projects')}>
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" /> К списку
        </Button>
        <p className="form-error" role="alert">{saveError || 'Черновик не найден'}</p>
      </div>
    );
  }

  const imagePickerItem = imagePickerTarget?.kind === 'project'
    ? form.objects.find((item) => item.objectId === imagePickerTarget.objectId) ?? null
    : null;
  const imagePickerImages = imagePickerTarget?.kind === 'cover'
    ? form.objects.flatMap((item) => item.object.images)
    : imagePickerItem?.object.images ?? [];
  const allValidationIssues = validateProjectPresentationForm(form);
  const cardValidationIssues = allValidationIssues.filter((issue) => issue.path.startsWith('objects.'));
  const coverValidationIssues = allValidationIssues.filter((issue) => (
    issue.path === 'title' || issue.path === 'coverTitle' || issue.path === 'coverImageId'
  ));
  const activeStepIndex = editorSteps.findIndex((step) => step.id === activeStep);
  const completedSteps = new Set<EditorStepId>();

  if (form.objects.length > 0) {
    completedSteps.add('objects');
  }

  if (form.objects.length > 0 && cardValidationIssues.length === 0) {
    completedSteps.add('cards');
  }

  if (coverValidationIssues.length === 0) {
    completedSteps.add('cover');
  }

  if (allValidationIssues.length === 0) {
    completedSteps.add('review');
  }

  const preferredPreviewPageKey = activeStep === 'cards'
    ? expandedObjectId ?? form.objects[0]?.objectId ?? 'contents'
    : activeStep === 'objects'
      ? 'contents'
      : 'cover';
  const previousStep = editorSteps[activeStepIndex - 1] ?? null;
  const nextStep = editorSteps[activeStepIndex + 1] ?? null;

  return (
    <div className="project-presentations-page project-presentation-editor">
      <header className="page-header project-presentation-editor-header">
        <div className="project-presentation-editor-title">
          <button className="project-presentation-back-link" disabled={isCoverUploading} type="button" onClick={() => navigate('/presentations/projects')}>
            <ArrowLeftIcon aria-hidden="true" /> К презентациям ЖК
          </button>
          <div className="project-presentation-title-line">
            <h2>{form.title || 'Без названия'}</h2>
            <Badge variant="outline">Черновик</Badge>
          </div>
          <SaveIndicator error={saveError} state={saveState} onReload={() => void reloadDraft()} />
        </div>
        <div className="header-actions">
          <Button type="button" variant="outline" onClick={() => setIsPreviewOpen(true)}>
            <EyeIcon data-icon="inline-start" aria-hidden="true" /> Предпросмотр
          </Button>
          <Button disabled={isExiting || isCoverUploading || saveState === 'conflict'} type="button" variant="outline" onClick={() => void handleSaveAndExit()}>
            {isExiting ? <LoaderCircleIcon className="project-presentation-spin" data-icon="inline-start" aria-hidden="true" /> : null}
            {isExiting ? 'Сохраняем…' : 'Сохранить и выйти'}
          </Button>
        </div>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {isCoverUploading ? 'Загружаем фото обложки' : ''}
      </p>
      {generationError ? <p className="form-error" role="alert">{generationError}</p> : null}
      {document ? (
        <GenerationStatus
          accessToken={accessToken || ''}
          document={document}
          onClose={() => setDocument(null)}
        />
      ) : null}

      <EditorStepper
        activeStep={activeStep}
        completedSteps={completedSteps}
        onStepChange={(step) => activateStep(step, true)}
      />

      <div className="project-presentation-editor-layout" aria-busy={isCoverUploading}>
        <main className="project-presentation-editor-form" id="project-presentation-step-content" inert={isCoverUploading} tabIndex={-1}>
          {activeStep === 'objects' ? (
            <ObjectSelectionStep
              accessToken={accessToken || ''}
              form={form}
              isLoading={isObjectSearchLoading}
              items={objectResults}
              search={objectSearch}
              searchError={objectSearchError}
              onAdd={addObject}
              onMove={(objectId, direction) => changeForm((current) => ({
                ...current,
                objects: reorderDraftObjects(current.objects, objectId, direction),
              }))}
              onRemove={removeObject}
              onSearchChange={setObjectSearch}
            />
          ) : null}

          {activeStep === 'cards' ? (
            <ProjectCardsStep
              accessToken={accessToken || ''}
              expandedObjectId={expandedObjectId}
              form={form}
              onAddObjects={() => activateStep('objects', true)}
              onExpandedChange={setExpandedObjectId}
              onImages={(objectId) => setImagePickerTarget({ kind: 'project', objectId })}
              onMove={(objectId, direction) => changeForm((current) => ({
                ...current,
                objects: reorderDraftObjects(current.objects, objectId, direction),
              }))}
              onRemove={removeObject}
              onUpdate={updateObject}
            />
          ) : null}

          {activeStep === 'cover' ? (
            <ProjectCoverStep
              accessToken={accessToken || ''}
              form={form}
              isUploading={isCoverUploading}
              issues={coverValidationIssues}
              uploadError={coverUploadError}
              onChange={changeForm}
              onChooseCover={() => {
                setCoverUploadError(null);
                setImagePickerTarget({ kind: 'cover' });
              }}
              onUploadCover={handleCoverUpload}
            />
          ) : null}

          {activeStep === 'review' ? (
            <ProjectReviewStep
              form={form}
              issues={allValidationIssues}
              onIssueClick={openValidationIssue}
              onPreview={() => setIsPreviewOpen(true)}
            />
          ) : null}
        </main>

        <aside className="project-presentation-preview-column" aria-label="Сводка и предпросмотр PDF">
          <div className="project-presentation-summary-heading">
            <div><span>ВАША ПРЕЗЕНТАЦИЯ</span><strong>{form.objects.length} ЖК · {form.objects.length + 4} страниц</strong></div>
            <Badge variant={allValidationIssues.length === 0 ? 'default' : 'outline'}>
              {allValidationIssues.length === 0 ? 'Готово' : formatIssueCount(allValidationIssues.length)}
            </Badge>
          </div>
          {user ? (
            <ProjectPresentationPreview
              accessToken={accessToken || ''}
              form={form}
              preferredPageKey={preferredPreviewPageKey}
              user={user}
              compact
            />
          ) : null}
          <EditorProgressSummary
            activeStep={activeStep}
            completedSteps={completedSteps}
            form={form}
            onStepChange={(step) => activateStep(step, true)}
          />
        </aside>
      </div>

      <footer className="project-presentation-editor-footer">
        <Button
          disabled={isCoverUploading}
          type="button"
          variant="outline"
          onClick={() => previousStep ? activateStep(previousStep.id, true) : navigate('/presentations/projects')}
        >
          <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
          {previousStep ? 'Назад' : 'К списку'}
        </Button>
        <div>
          <span className="project-presentation-footer-hint">
            {nextStep ? `Далее: ${nextStep.label.toLowerCase()}` : `${formatIssueCount(allValidationIssues.length)} перед генерацией`}
          </span>
          <Button className="project-presentation-footer-preview" type="button" variant="outline" onClick={() => setIsPreviewOpen(true)}>
            <EyeIcon data-icon="inline-start" aria-hidden="true" /> Preview
          </Button>
          {nextStep ? (
            <Button disabled={isCoverUploading} type="button" onClick={() => activateStep(nextStep.id, true)}>
              Продолжить <span aria-hidden="true">→</span>
            </Button>
          ) : (
            <Button disabled={isGenerating || isCoverUploading || saveState === 'conflict'} type="button" onClick={() => void handleGenerate()}>
              {isGenerating ? <LoaderCircleIcon className="project-presentation-spin" data-icon="inline-start" aria-hidden="true" /> : <FilePlus2Icon data-icon="inline-start" aria-hidden="true" />}
              {isGenerating ? 'Формируем…' : 'Сформировать PDF'}
            </Button>
          )}
        </div>
      </footer>

      <Dialog open={Boolean(imagePickerTarget)} onOpenChange={(open) => !open && setImagePickerTarget(null)}>
        <DialogContent className="project-presentation-image-dialog">
          <DialogHeader>
            <DialogTitle>{imagePickerTarget?.kind === 'cover' ? 'Фото обложки' : 'Фото жилого комплекса'}</DialogTitle>
            <DialogDescription>
              {imagePickerTarget?.kind === 'cover'
                ? 'Выберите одно фото из добавленных в презентацию ЖК.'
                : `Выберите до ${projectPresentationMaxImages} фото. Порядок выбора будет сохранён.`}
            </DialogDescription>
          </DialogHeader>
          {imagePickerImages.length ? (
            <div className="project-presentation-image-grid">
              {imagePickerImages.map((image) => {
                const isSelected = imagePickerTarget?.kind === 'cover'
                  ? form.coverImageId === image.id
                  : Boolean(imagePickerItem?.imageIds.includes(image.id));

                return (
                  <button
                    aria-pressed={isSelected}
                    className={isSelected ? 'is-selected' : ''}
                    key={image.id}
                    type="button"
                    onClick={() => {
                      if (imagePickerTarget?.kind === 'cover') {
                        setCoverUploadError(null);
                        changeForm((current) => ({ ...current, coverImageId: image.id, coverFile: null }));
                      } else if (imagePickerItem) {
                        toggleProjectImage(imagePickerItem.objectId, image.id);
                      }
                    }}
                  >
                    <SecureImage accessToken={accessToken || ''} alt={image.alt || 'Фото ЖК'} fileId={image.file.id} lazy variant="detail" />
                    {isSelected ? <CheckCircle2Icon aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ) : <p className="muted-text">У выбранных объектов нет доступных изображений.</p>}
          <DialogFooter>
            {imagePickerTarget?.kind === 'cover' && form.coverImageId ? (
              <Button type="button" variant="outline" onClick={() => changeForm((current) => ({ ...current, coverImageId: null }))}>
                Сбросить
              </Button>
            ) : null}
            <Button type="button" onClick={() => setImagePickerTarget(null)}>Готово</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="project-presentation-preview-dialog">
          <DialogHeader>
            <DialogTitle>Предпросмотр презентации</DialogTitle>
            <DialogDescription>{form.objects.length + 4} страниц в формате 3:4.</DialogDescription>
          </DialogHeader>
          {user ? <ProjectPresentationPreview accessToken={accessToken || ''} form={form} user={user} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditorStepper({
  activeStep,
  completedSteps,
  onStepChange,
}: {
  activeStep: EditorStepId;
  completedSteps: Set<EditorStepId>;
  onStepChange: (step: EditorStepId) => void;
}) {
  return (
    <nav className="project-presentation-stepper" aria-label="Этапы создания презентации">
      {editorSteps.map((step, index) => {
        const isActive = step.id === activeStep;
        const isCompleted = completedSteps.has(step.id);

        return (
          <div className="project-presentation-stepper-item" key={step.id}>
            <button
              aria-current={isActive ? 'step' : undefined}
              className={isActive ? 'is-active' : isCompleted ? 'is-completed' : ''}
              type="button"
              onClick={() => onStepChange(step.id)}
            >
              <span>{isCompleted && !isActive ? <CheckCircle2Icon aria-hidden="true" /> : index + 1}</span>
              <span><small>ШАГ {index + 1}</small><strong>{step.label}</strong></span>
            </button>
            {index < editorSteps.length - 1 ? <i aria-hidden="true" /> : null}
          </div>
        );
      })}
    </nav>
  );
}

function EditorProgressSummary({
  activeStep,
  completedSteps,
  form,
  onStepChange,
}: {
  activeStep: EditorStepId;
  completedSteps: Set<EditorStepId>;
  form: ProjectPresentationDraftForm;
  onStepChange: (step: EditorStepId) => void;
}) {
  const descriptions: Record<EditorStepId, string> = {
    objects: form.objects.length ? `${form.objects.length} из ${projectPresentationMaxObjects} выбрано` : 'Добавьте первый объект',
    cards: form.objects.length ? `${form.objects.length} карточек` : 'Появятся после выбора ЖК',
    cover: form.coverImageId || form.coverFile ? 'Фото и заголовок выбраны' : 'Нужно фото и заголовок',
    review: completedSteps.has('review') ? 'Можно формировать PDF' : 'Проверим обязательные поля',
  };

  return (
    <div className="project-presentation-progress-summary">
      {editorSteps.map((step, index) => (
        <button
          className={step.id === activeStep ? 'is-active' : ''}
          key={step.id}
          type="button"
          onClick={() => onStepChange(step.id)}
        >
          <span className={completedSteps.has(step.id) ? 'is-completed' : ''}>
            {completedSteps.has(step.id) ? <CheckCircle2Icon aria-hidden="true" /> : index + 1}
          </span>
          <span><strong>{step.label}</strong><small>{descriptions[step.id]}</small></span>
        </button>
      ))}
    </div>
  );
}

function ObjectSelectionStep({
  accessToken,
  form,
  isLoading,
  items,
  search,
  searchError,
  onAdd,
  onMove,
  onRemove,
  onSearchChange,
}: {
  accessToken: string;
  form: ProjectPresentationDraftForm;
  isLoading: boolean;
  items: ProjectPresentationObject[];
  search: string;
  searchError: string | null;
  onAdd: (object: ProjectPresentationObject) => void;
  onMove: (objectId: string, direction: -1 | 1) => void;
  onRemove: (objectId: string) => void;
  onSearchChange: (value: string) => void;
}) {
  const selectedIds = new Set(form.objects.map((item) => item.objectId));
  const isLimitReached = form.objects.length >= projectPresentationMaxObjects;

  return (
    <section className="project-presentation-step-panel project-presentation-selection-step">
      <div className="project-presentation-step-heading">
        <div className="project-presentation-step-number">01</div>
        <div><p className="eyebrow">Состав презентации</p><h3>Выберите жилые комплексы</h3><p>Добавьте от 1 до 12 ЖК. Их порядок станет порядком страниц в PDF.</p></div>
        <Badge variant="outline">{form.objects.length} / {projectPresentationMaxObjects}</Badge>
      </div>

      <label className="project-presentation-search project-presentation-search--inline">
        <SearchIcon aria-hidden="true" />
        <Input
          aria-label="Поиск жилого комплекса"
          placeholder="Название ЖК, адрес или девелопер"
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
      </label>
      {searchError ? <p className="form-error" role="alert">{searchError}</p> : null}

      <div className="project-presentation-group-heading">
        <span>В ПРЕЗЕНТАЦИИ</span>
        <small>{form.objects.length ? 'Используйте стрелки, чтобы изменить порядок' : 'Пока ничего не выбрано'}</small>
      </div>

      {form.objects.length ? (
        <div className="project-presentation-selected-list">
          {form.objects.map((item, index) => {
            const image = item.object.images[0] ?? null;
            return (
              <article key={item.objectId}>
                <span className="project-presentation-order">{String(index + 1).padStart(2, '0')}</span>
                <div className="project-presentation-selected-cover">
                  {image ? <SecureImage accessToken={accessToken} alt="" fileId={image.file.id} lazy variant="thumbnail" /> : <ImageIcon aria-hidden="true" />}
                </div>
                <div><strong>{item.object.title}</strong><small>{item.object.address || item.object.developer?.name || 'Адрес не указан'}</small></div>
                <span className="project-presentation-row-status"><CheckCircle2Icon aria-hidden="true" /> Добавлен</span>
                <div className="project-presentation-row-actions">
                  <Button aria-label={`Поднять ${item.object.title}`} disabled={index === 0} size="icon-sm" type="button" variant="outline" onClick={() => onMove(item.objectId, -1)}><ArrowUpIcon aria-hidden="true" /></Button>
                  <Button aria-label={`Опустить ${item.object.title}`} disabled={index === form.objects.length - 1} size="icon-sm" type="button" variant="outline" onClick={() => onMove(item.objectId, 1)}><ArrowDownIcon aria-hidden="true" /></Button>
                  <Button aria-label={`Удалить ${item.object.title}`} size="icon-sm" type="button" variant="ghost" onClick={() => onRemove(item.objectId)}><Trash2Icon aria-hidden="true" /></Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="project-presentation-selection-empty">
          <ListChecksIcon aria-hidden="true" />
          <div><strong>Начните с выбора ЖК</strong><span>Найдите объект в каталоге ниже и нажмите «Добавить».</span></div>
        </div>
      )}

      <div className="project-presentation-group-heading project-presentation-catalog-heading">
        <span>КАТАЛОГ ЖК</span><small>{search.trim() ? 'Результаты поиска' : 'Опубликованные жилые объекты'}</small>
      </div>
      <div className="project-presentation-catalog-grid" aria-busy={isLoading}>
        {isLoading ? [0, 1, 2, 3, 4, 5].map((item) => <Skeleton className="h-40 w-full" key={item} />) : null}
        {!isLoading && items.length === 0 ? <p className="muted-text">Ничего не найдено. Попробуйте изменить запрос.</p> : null}
        {!isLoading ? items.map((object) => {
          const image = object.images[0] ?? null;
          const isSelected = selectedIds.has(object.id);

          return (
            <article className={isSelected ? 'is-selected' : ''} key={object.id}>
              <div className="project-presentation-catalog-cover">
                {image ? <SecureImage accessToken={accessToken} alt="" fileId={image.file.id} lazy variant="thumbnail" /> : <ImageIcon aria-hidden="true" />}
                {isSelected ? <span><CheckCircle2Icon aria-hidden="true" /> В презентации</span> : null}
              </div>
              <div className="project-presentation-catalog-copy">
                <div><strong>{object.title}</strong><small>{object.address || object.developer?.name || 'Адрес не указан'}</small></div>
                <Button disabled={isSelected || isLimitReached} size="sm" type="button" variant={isSelected ? 'outline' : 'default'} onClick={() => onAdd(object)}>
                  {isSelected ? 'Добавлен' : <><PlusIcon data-icon="inline-start" aria-hidden="true" /> Добавить</>}
                </Button>
              </div>
            </article>
          );
        }) : null}
      </div>
    </section>
  );
}

function ProjectCardsStep({
  accessToken,
  expandedObjectId,
  form,
  onAddObjects,
  onExpandedChange,
  onImages,
  onMove,
  onRemove,
  onUpdate,
}: {
  accessToken: string;
  expandedObjectId: string | null;
  form: ProjectPresentationDraftForm;
  onAddObjects: () => void;
  onExpandedChange: (objectId: string | null) => void;
  onImages: (objectId: string) => void;
  onMove: (objectId: string, direction: -1 | 1) => void;
  onRemove: (objectId: string) => void;
  onUpdate: (objectId: string, updates: Partial<ProjectPresentationDraftForm['objects'][number]>) => void;
}) {
  return (
    <section className="project-presentation-step-panel project-presentation-cards-step">
      <div className="project-presentation-step-heading">
        <div className="project-presentation-step-number">02</div>
        <div><p className="eyebrow">Содержание страниц</p><h3>Настройте карточки ЖК</h3><p>Каталожные значения уже подставлены. Раскрывайте только то, что нужно изменить.</p></div>
        <Button disabled={form.objects.length >= projectPresentationMaxObjects} type="button" variant="outline" onClick={onAddObjects}><PlusIcon data-icon="inline-start" aria-hidden="true" /> Добавить ЖК</Button>
      </div>

      {form.objects.length ? (
        <>
          <div className="project-presentation-card-outline" aria-label="Карточки жилых комплексов">
            {form.objects.map((item, index) => {
              const issueCount = getProjectObjectValidationIssues(item).length;
              return (
                <button className={expandedObjectId === item.objectId ? 'is-active' : ''} key={item.objectId} type="button" onClick={() => onExpandedChange(item.objectId)}>
                  <span>{index + 1}</span><strong>{item.manualTitle || item.object.title}</strong><small className={issueCount ? 'has-issue' : ''}>{issueCount ? formatIssueCount(issueCount) : 'Готово'}</small>
                </button>
              );
            })}
          </div>
          <div className="project-presentation-object-list">
            {form.objects.map((item, index) => (
              <ProjectObjectEditor
                accessToken={accessToken}
                index={index}
                isExpanded={expandedObjectId === item.objectId}
                isFirst={index === 0}
                isLast={index === form.objects.length - 1}
                item={item}
                issueCount={getProjectObjectValidationIssues(item).length}
                key={item.objectId}
                onImages={() => onImages(item.objectId)}
                onMove={(direction) => onMove(item.objectId, direction)}
                onRemove={() => onRemove(item.objectId)}
                onToggle={() => onExpandedChange(expandedObjectId === item.objectId ? null : item.objectId)}
                onUpdate={(updates) => onUpdate(item.objectId, updates)}
              />
            ))}
          </div>
        </>
      ) : (
        <button className="project-presentation-add-empty project-presentation-add-empty--compact" type="button" onClick={onAddObjects}>
          <PlusIcon aria-hidden="true" /><strong>Сначала добавьте жилые комплексы</strong><span>После выбора здесь появятся карточки будущих страниц PDF.</span>
        </button>
      )}
    </section>
  );
}

function ProjectCoverStep({
  accessToken,
  form,
  isUploading,
  issues,
  uploadError,
  onChange,
  onChooseCover,
  onUploadCover,
}: {
  accessToken: string;
  form: ProjectPresentationDraftForm;
  isUploading: boolean;
  issues: ProjectPresentationValidationIssue[];
  uploadError: string | null;
  onChange: (updater: (currentForm: ProjectPresentationDraftForm) => ProjectPresentationDraftForm) => void;
  onChooseCover: () => void;
  onUploadCover: (file: File) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileValidationError, setFileValidationError] = useState<string | null>(null);
  const selectedCover = findProjectImage(form.objects, form.coverImageId);
  const suggestedCover = form.objects.flatMap((item) => item.object.images)[0] ?? null;
  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  async function handleFileChange(file: File | undefined) {
    if (!file) {
      return;
    }

    if (file.size > projectPresentationMaxCoverFileSizeBytes) {
      const sizeMegabytes = Math.ceil((file.size / (1024 * 1024)) * 10) / 10;
      setFileValidationError(
        `Размер файла — ${sizeMegabytes} МБ. Максимальный размер фото — 10 МБ. Выберите файл меньшего размера.`,
      );
      return;
    }

    if (!acceptedCoverImageMimeTypes.has(file.type)) {
      setFileValidationError('Поддерживаются только изображения JPEG, PNG и WebP.');
      return;
    }

    setFileValidationError(null);
    await onUploadCover(file);
  }

  function chooseProjectCover() {
    setFileValidationError(null);
    onChooseCover();
  }

  return (
    <section className="project-presentation-step-panel project-presentation-cover-step">
      <div className="project-presentation-step-heading">
        <div className="project-presentation-step-number">03</div>
        <div><p className="eyebrow">Персонализация</p><h3>Соберите обложку</h3><p>Заголовок, клиент и фотография первого экрана презентации.</p></div>
      </div>

      <Card className="project-presentation-section-card">
        <CardContent className="project-presentation-field-grid project-presentation-cover-fields">
          <ProjectTextField
            error={issueFor('title')}
            id="project-draft-title"
            label="Название черновика"
            maxLength={180}
            value={form.title}
            onChange={(value) => onChange((current) => ({ ...current, title: value }))}
          />
          <ProjectTextField
            error={issueFor('coverTitle')}
            id="project-cover-title"
            label="Заголовок обложки"
            maxLength={180}
            placeholder="Лучшие жилые комплексы Москвы"
            value={form.coverTitle}
            onChange={(value) => onChange((current) => ({ ...current, coverTitle: value }))}
          />
          <ProjectTextField id="project-client-name" label="Имя клиента" maxLength={180} placeholder="Александр" value={form.clientName} onChange={(value) => onChange((current) => ({ ...current, clientName: value }))} />
          <ProjectTextField id="project-issue-label" label="Метка выпуска" maxLength={180} placeholder="Персональная подборка · июль 2026" value={form.issueLabel} onChange={(value) => onChange((current) => ({ ...current, issueLabel: value }))} />
          <Field className="project-presentation-field-wide">
            <FieldLabel htmlFor="project-cover-subtitle">Подзаголовок</FieldLabel>
            <textarea
              id="project-cover-subtitle"
              maxLength={500}
              placeholder="Персональная подборка с ценами и преимуществами"
              rows={3}
              value={form.coverSubtitle}
              onChange={(event) => {
                const coverSubtitle = event.currentTarget.value;
                onChange((current) => ({ ...current, coverSubtitle }));
              }}
            />
            <FieldDescription>{form.coverSubtitle.length} / 500</FieldDescription>
          </Field>

          <Field
            className="project-presentation-cover-field"
            data-invalid={Boolean(issueFor('coverImageId') || fileValidationError || uploadError)}
          >
            <FieldLabel>Фото обложки</FieldLabel>
            <input
              ref={fileInputRef}
              accept={coverImageAccept}
              className="project-presentation-cover-file-input"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                void handleFileChange(file);
              }}
            />
            {form.coverFile ? (
              <button
                className="project-presentation-cover-picker is-selected"
                disabled={isUploading}
                id="project-cover-image"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <SecureImage accessToken={accessToken} alt="Загруженная обложка" fileId={form.coverFile.id} variant="detail" />
                <span>
                  <strong>{isUploading ? 'Загружаем фото…' : 'Своё фото загружено'}</strong>
                  <small>{isUploading ? 'Не закрывайте страницу' : 'Нажмите, чтобы заменить'}</small>
                </span>
                {isUploading
                  ? <LoaderCircleIcon className="project-presentation-spin" aria-hidden="true" />
                  : <CheckCircle2Icon aria-hidden="true" />}
              </button>
            ) : selectedCover ? (
              <button className="project-presentation-cover-picker is-selected" id="project-cover-image" type="button" onClick={chooseProjectCover}>
                <SecureImage accessToken={accessToken} alt="Выбранная обложка" fileId={selectedCover.file.id} variant="detail" />
                <span><strong>Фото выбрано</strong><small>Нажмите, чтобы заменить</small></span>
                <CheckCircle2Icon aria-hidden="true" />
              </button>
            ) : suggestedCover ? (
              <div className="project-presentation-cover-suggestion" id="project-cover-image" tabIndex={-1}>
                <SecureImage accessToken={accessToken} alt="Рекомендуемое фото обложки" fileId={suggestedCover.file.id} variant="detail" />
                <div><span>РЕКОМЕНДУЕМОЕ ФОТО</span><strong>Первое фото из выбранных ЖК</strong><small>Подтвердите его или откройте остальные варианты.</small></div>
                <div><Button type="button" onClick={() => { setFileValidationError(null); onChange((current) => ({ ...current, coverImageId: suggestedCover.id, coverFile: null })); }}>Использовать</Button><Button type="button" variant="outline" onClick={chooseProjectCover}>Все фото</Button></div>
              </div>
            ) : (
              <button className="project-presentation-cover-picker" id="project-cover-image" type="button" onClick={() => fileInputRef.current?.click()}>
                <UploadIcon aria-hidden="true" /><span><strong>Загрузите своё фото</strong><small>JPEG, PNG или WebP до 10 МБ</small></span>
              </button>
            )}
            <div className="project-presentation-cover-actions">
              <Button disabled={isUploading} type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                {isUploading
                  ? <LoaderCircleIcon className="project-presentation-spin" data-icon="inline-start" aria-hidden="true" />
                  : <UploadIcon data-icon="inline-start" aria-hidden="true" />}
                {form.coverFile ? 'Заменить своё фото' : 'Загрузить своё фото'}
              </Button>
              <Button disabled={isUploading || !suggestedCover} type="button" variant="outline" onClick={chooseProjectCover}>
                <ImageIcon data-icon="inline-start" aria-hidden="true" /> Выбрать из фото ЖК
              </Button>
            </div>
            <FieldDescription>Фото будет кадрировано под вертикальную обложку 3:4. Максимальный размер — 10 МБ.</FieldDescription>
            {fileValidationError || uploadError ? <FieldError>{fileValidationError || uploadError}</FieldError> : null}
            {!fileValidationError && !uploadError && issueFor('coverImageId') ? <FieldError>{issueFor('coverImageId')}</FieldError> : null}
          </Field>
        </CardContent>
      </Card>
    </section>
  );
}

function ProjectReviewStep({
  form,
  issues,
  onIssueClick,
  onPreview,
}: {
  form: ProjectPresentationDraftForm;
  issues: ProjectPresentationValidationIssue[];
  onIssueClick: (issue: ProjectPresentationValidationIssue) => void;
  onPreview: () => void;
}) {
  return (
    <section className="project-presentation-step-panel project-presentation-review-step">
      <div className="project-presentation-step-heading">
        <div className="project-presentation-step-number">04</div>
        <div><p className="eyebrow">Финальная проверка</p><h3>Проверьте презентацию</h3><p>После запуска будет создан неизменяемый PDF-снимок текущей версии.</p></div>
        <Button type="button" variant="outline" onClick={onPreview}><EyeIcon data-icon="inline-start" aria-hidden="true" /> Открыть preview</Button>
      </div>

      {issues.length ? (
        <div className="project-presentation-preflight project-presentation-preflight--issues" id="project-presentation-validation" role="alert">
          <TriangleAlertIcon aria-hidden="true" />
          <div><strong>Нужно исправить {issues.length}</strong><span>Нажмите на пункт — редактор откроет нужное поле.</span></div>
          <div className="project-presentation-issue-list">
            {issues.map((issue) => <button key={`${issue.path}-${issue.message}`} type="button" onClick={() => onIssueClick(issue)}><span>{issue.message}</span><span aria-hidden="true">→</span></button>)}
          </div>
        </div>
      ) : (
        <div className="project-presentation-preflight project-presentation-preflight--ready" role="status">
          <CheckCircle2Icon aria-hidden="true" /><div><strong>Презентация готова к генерации</strong><span>Все обязательные поля заполнены, изображения доступны.</span></div>
        </div>
      )}

      <div className="project-presentation-review-grid">
        <article><span>ЖИЛЫЕ КОМПЛЕКСЫ</span><strong>{form.objects.length}</strong><small>до {projectPresentationMaxObjects} объектов</small></article>
        <article><span>СТРАНИЦЫ PDF</span><strong>{form.objects.length + 4}</strong><small>формат 3:4</small></article>
        <article><span>ПЕРСОНАЛИЗАЦИЯ</span><strong>{form.clientName || 'Без имени'}</strong><small>{form.issueLabel || 'Стандартная метка'}</small></article>
      </div>

      <Card className="project-presentation-structure-card">
        <CardHeader><CardTitle>Структура документа</CardTitle><CardDescription>Служебные страницы добавляются автоматически.</CardDescription></CardHeader>
        <CardContent>
          <ol>
            <li><span>01</span><div><strong>Обложка</strong><small>{form.coverTitle || 'Заголовок не заполнен'}</small></div></li>
            <li><span>02</span><div><strong>География подборки</strong><small>Редакционная карта выбранных ЖК</small></div></li>
            {form.objects.map((item, index) => <li key={item.objectId}><span>{String(index + 3).padStart(2, '0')}</span><div><strong>{item.manualTitle || item.object.title}</strong><small>{item.object.address || 'Карточка жилого комплекса'}</small></div></li>)}
            <li><span>{String(form.objects.length + 3).padStart(2, '0')}</span><div><strong>О компании</strong><small>Принципы работы FluffyWhite</small></div></li>
            <li><span>{String(form.objects.length + 4).padStart(2, '0')}</span><div><strong>Финал</strong><small>Весь путь и контакты компании</small></div></li>
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}

type ProjectObjectEditorProps = {
  accessToken: string;
  index: number;
  isExpanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  item: ProjectPresentationDraftForm['objects'][number];
  issueCount: number;
  onImages: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onToggle: () => void;
  onUpdate: (updates: Partial<ProjectPresentationDraftForm['objects'][number]>) => void;
};

function ProjectObjectEditor({
  accessToken,
  index,
  isExpanded,
  isFirst,
  isLast,
  item,
  issueCount,
  onImages,
  onMove,
  onRemove,
  onToggle,
  onUpdate,
}: ProjectObjectEditorProps) {
  const coverImage = item.object.images.find((image) => image.id === item.imageIds[0]) ?? item.object.images[0] ?? null;
  const objectIssues = getProjectObjectValidationIssues(item);
  const titleError = objectIssues.find((issue) => issue.path.endsWith('.manualTitle'))?.message;
  const descriptionError = objectIssues.find((issue) => issue.path.endsWith('.manualDescription'))?.message;
  const resolvedDescription = item.manualDescription ?? item.object.description ?? '';

  return (
    <Card className={`project-presentation-object-card${isExpanded ? ' is-expanded' : ''}`}>
      <CardHeader>
        <div className="project-presentation-object-summary">
          <button
            aria-controls={`project-card-content-${item.objectId}`}
            aria-expanded={isExpanded}
            className="project-presentation-object-toggle"
            type="button"
            onClick={onToggle}
          >
            <span className="project-presentation-object-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="project-presentation-object-cover">
              {coverImage ? (
                <SecureImage accessToken={accessToken} alt="" fileId={coverImage.file.id} lazy variant="thumbnail" />
              ) : <ImageIcon aria-hidden="true" />}
            </span>
            <span className="project-presentation-object-copy">
              <small>СТРАНИЦА {index + 3}</small>
              <strong>{item.manualTitle || item.object.title}</strong>
              <span>{item.object.address || item.object.slug}</span>
            </span>
            <span className={`project-presentation-object-readiness${issueCount ? ' has-issue' : ''}`}>
              {issueCount ? <TriangleAlertIcon aria-hidden="true" /> : <CheckCircle2Icon aria-hidden="true" />}
              {issueCount ? 'Нужно заполнить' : 'Готово'}
            </span>
            {isExpanded ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
          </button>
          <div className="project-presentation-object-actions">
            <Button aria-label={`Поднять ${item.object.title}`} disabled={isFirst} size="icon-sm" title="Поднять выше" type="button" variant="outline" onClick={() => onMove(-1)}>
              <ArrowUpIcon aria-hidden="true" />
            </Button>
            <Button aria-label={`Опустить ${item.object.title}`} disabled={isLast} size="icon-sm" title="Опустить ниже" type="button" variant="outline" onClick={() => onMove(1)}>
              <ArrowDownIcon aria-hidden="true" />
            </Button>
            <Button aria-label={`Удалить ${item.object.title}`} size="icon-sm" title="Удалить из презентации" type="button" variant="destructive" onClick={onRemove}>
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded ? <CardContent id={`project-card-content-${item.objectId}`}>
        <div className="project-presentation-catalog-baseline">
          <CheckCircle2Icon aria-hidden="true" />
          <div><strong>Данные загружены из каталога</strong><span>Изменения применятся только к этой презентации.</span></div>
          <Button type="button" variant="ghost" onClick={() => onUpdate({ manualTitle: item.object.title, manualDescription: null })}>Вернуть заголовок и описание</Button>
        </div>
        <div className="project-presentation-field-grid">
          <ProjectTextField
            error={titleError}
            id={`project-${item.objectId}-title`}
            label="Название в презентации"
            maxLength={180}
            value={item.manualTitle ?? ''}
            onChange={(value) => onUpdate({ manualTitle: value })}
          />
          <Field className="project-presentation-field-wide" data-invalid={Boolean(descriptionError)}>
            <FieldLabel htmlFor={`project-${item.objectId}-description`}>Описание</FieldLabel>
            <textarea
              aria-invalid={Boolean(descriptionError)}
              id={`project-${item.objectId}-description`}
              maxLength={2000}
              placeholder="Коротко расскажите, кому подойдёт проект и чем он выделяется."
              rows={5}
              value={resolvedDescription}
              onChange={(event) => onUpdate({ manualDescription: event.currentTarget.value })}
            />
            <FieldDescription>{resolvedDescription.length} / 2000</FieldDescription>
            {descriptionError ? <FieldError>{descriptionError}</FieldError> : null}
          </Field>
        </div>

        <div className="project-presentation-subsection">
          <div>
            <strong>Преимущества</strong>
            <span>До трёх коротких тезисов.</span>
          </div>
          <div className="project-presentation-advantages-grid">
            {[0, 1, 2, 3].map((advantageIndex) => (
              <Input
                aria-label={`Преимущество ${advantageIndex + 1}`}
                key={advantageIndex}
                maxLength={240}
                placeholder={`${advantageIndex + 1}. Например, парк у дома`}
                value={item.advantages[advantageIndex] ?? ''}
                onChange={(event) => {
                  const advantages = [...item.advantages];
                  advantages[advantageIndex] = event.currentTarget.value;
                  onUpdate({ advantages });
                }}
              />
            ))}
          </div>
        </div>

        <div className="project-presentation-subsection">
          <div>
            <strong>Параметры</strong>
            <span>Значения можно переопределить только для этой презентации.</span>
          </div>
          <div className="project-presentation-overrides-grid">
            {([
              ['propertyClass', 'Класс'],
              ['completion', 'Срок сдачи'],
              ['price', 'Цена'],
              ['district', 'Район'],
              ['developer', 'Девелопер'],
              ['metro', 'Метро'],
            ] as const).map(([field, label]) => (
              <ProjectTextField
                id={`project-${item.objectId}-${field}`}
                key={field}
                label={label}
                maxLength={field === 'metro' ? 300 : 180}
                value={item[field] ?? ''}
                onChange={(value) => onUpdate({ [field]: value })}
              />
            ))}
          </div>
        </div>

        <div className="project-presentation-subsection project-presentation-images-row">
          <div>
            <strong>Фотографии</strong>
            <span>{item.imageIds.length} из {projectPresentationMaxImages} выбрано.</span>
          </div>
          <div className="project-presentation-selected-images">
            {item.imageIds.map((imageId) => {
              const image = item.object.images.find((candidate) => candidate.id === imageId);
              return image ? <SecureImage accessToken={accessToken} alt="" fileId={image.file.id} key={image.id} lazy variant="thumbnail" /> : null;
            })}
            <Button type="button" variant="outline" onClick={onImages}>
              <ImageIcon data-icon="inline-start" aria-hidden="true" /> Выбрать фото
            </Button>
          </div>
        </div>
      </CardContent> : null}
    </Card>
  );
}

function ProjectTextField({
  error,
  id,
  label,
  maxLength,
  placeholder,
  value,
  onChange,
}: {
  error?: string;
  id: string;
  label: string;
  maxLength: number;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input aria-invalid={Boolean(error)} id={id} maxLength={maxLength} placeholder={placeholder} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function getProjectObjectValidationIssues(item: ProjectPresentationDraftForm['objects'][number]) {
  const issues: ProjectPresentationValidationIssue[] = [];

  if (!(item.manualTitle ?? item.object.title).trim()) {
    issues.push({ path: `objects.${item.objectId}.manualTitle`, message: 'Укажите название ЖК' });
  }

  if (!(item.manualDescription ?? item.object.description ?? '').trim()) {
    issues.push({
      path: `objects.${item.objectId}.manualDescription`,
      message: `Добавьте описание для ${item.object.title}`,
    });
  }

  if (item.imageIds.length > projectPresentationMaxImages) {
    issues.push({
      path: `objects.${item.objectId}.imageIds`,
      message: `Для ${item.object.title} можно выбрать не больше ${projectPresentationMaxImages} фото`,
    });
  }

  return issues;
}

function SaveIndicator({ error, state, onReload }: { error: string | null; state: SaveState; onReload: () => void }) {
  if (state === 'conflict') {
    return (
      <div className="project-presentation-save project-presentation-save--error" role="alert">
        <TriangleAlertIcon aria-hidden="true" />
        <span>{error}</span>
        <Button size="sm" type="button" variant="outline" onClick={onReload}><RefreshCwIcon data-icon="inline-start" aria-hidden="true" />Перезагрузить</Button>
      </div>
    );
  }

  if (state === 'error') {
    return <div className="project-presentation-save project-presentation-save--error" role="alert"><TriangleAlertIcon aria-hidden="true" />{error}</div>;
  }

  if (state === 'saving') {
    return <div className="project-presentation-save"><LoaderCircleIcon className="project-presentation-spin" aria-hidden="true" />Сохраняем…</div>;
  }

  if (state === 'pending') {
    return <div className="project-presentation-save">Есть несохранённые изменения</div>;
  }

  return <div className="project-presentation-save"><CheckCircle2Icon aria-hidden="true" />Все изменения сохранены</div>;
}

function GenerationStatus({
  accessToken,
  document,
  onClose,
}: {
  accessToken: string;
  document: ProjectPresentationDocument;
  onClose: () => void;
}) {
  const labels: Record<ProjectPresentationDocument['status'], string> = {
    PENDING: 'PDF поставлен в очередь',
    RUNNING: `Формируем PDF · ${document.progress}%`,
    READY: 'PDF готов',
    FAILED: 'Не удалось сформировать PDF',
  };

  return (
    <div className={`project-presentation-generation project-presentation-generation--${document.status.toLowerCase()}`} role="status">
      {activeDocumentStatuses.has(document.status) ? <LoaderCircleIcon className="project-presentation-spin" aria-hidden="true" /> : document.status === 'READY' ? <CheckCircle2Icon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
      <div>
        <strong>{labels[document.status]}</strong>
        {document.errorMessage ? <span>{document.errorMessage}</span> : <span>{document.objectsCount} ЖК · документ сохранится в истории</span>}
      </div>
      {document.canDownload ? (
        <Button type="button" onClick={() => void downloadProjectPresentationDocument(accessToken, document)}>
          <DownloadIcon data-icon="inline-start" aria-hidden="true" /> Скачать PDF
        </Button>
      ) : null}
      {!activeDocumentStatuses.has(document.status) ? <Button aria-label="Закрыть статус" type="button" variant="ghost" onClick={onClose}>Закрыть</Button> : null}
    </div>
  );
}

function ProjectPresentationEditorSkeleton() {
  return (
    <div className="project-presentations-page project-presentation-editor">
      <Skeleton className="h-24 w-full" />
      <div className="project-presentation-editor-layout">
        <div><Skeleton className="h-[520px] w-full" /><Skeleton className="mt-6 h-[480px] w-full" /></div>
        <Skeleton className="h-[680px] w-full" />
      </div>
    </div>
  );
}

function normalizeOptionalText(value: string) {
  return value.trim() || null;
}

function focusValidationIssue(issue: ProjectPresentationValidationIssue | undefined) {
  if (!issue) {
    return;
  }

  const objectMatch = issue.path.match(/^objects\.([^.]+)\.([^.]+)$/u);
  const fieldId = issue.path === 'coverImageId'
    ? 'project-cover-image'
    : issue.path === 'coverTitle'
      ? 'project-cover-title'
      : issue.path === 'title'
        ? 'project-draft-title'
        : objectMatch
          ? `project-${objectMatch[1]}-${objectMatch[2] === 'manualTitle' ? 'title' : 'description'}`
          : 'project-presentation-validation';
  const element = window.document.getElementById(fieldId);

  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => element?.focus(), 350);
}

function resolveError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function resolveCoverUploadError(error: unknown) {
  const message = resolveError(error, 'Не удалось загрузить фото обложки');

  if (/file too large|size cannot exceed|слишком большой|размер файла/iu.test(message)) {
    return 'Фото не загружено: максимальный размер файла — 10 МБ. Выберите файл меньшего размера.';
  }

  if (/only jpeg|only.*png|only.*webp|mime|тип файла/iu.test(message)) {
    return 'Фото не загружено: поддерживаются только изображения JPEG, PNG и WebP.';
  }

  return message;
}
