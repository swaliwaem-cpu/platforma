import { FormEvent, useEffect, useState } from 'react';
import type {
  TrainingAdminProject,
  TrainingCriterionDraft,
  TrainingFactDraft,
  TrainingFactSource,
  TrainingProjectAccessMode,
  TrainingQuestionType,
  UpdateTrainingProjectRequest,
} from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  deleteTrainingAdminProject,
  getTrainingAdminProject,
  publishTrainingAdminProject,
  updateTrainingAdminProject,
} from './trainingApi';
import {
  formatTrainingFactSourceBadge,
  getTrainingStatusClass,
  trainingProjectStatusLabels,
} from './trainingView';
import { TrainingMaterialsPanel } from './TrainingMaterialsPanel';
import { TrainingProjectAccessPanel } from './TrainingProjectAccessPanel';

type EditorFact = TrainingFactDraft & Partial<TrainingFactSource>;

type EditorForm = {
  title: string;
  description: string;
  realEstateObjectId: string;
  sortOrder: string;
  attemptLimit: string;
  timeLimitMinutes: string;
  passScore: string;
  allowRetakeAfterPass: boolean;
  accessMode: TrainingProjectAccessMode;
  mainQuestion: string;
  followUpQuestions: string[];
  facts: EditorFact[];
  criteria: TrainingCriterionDraft[];
};

type TrainingAdminProjectEditorPageProps = {
  projectId: string;
  navigate: (pathname: string) => void;
};

type EditorTab = 'materials' | 'questions' | 'assignments';

type QuestionSection = 'params' | 'questions' | 'criteria';

const editorTabLabels: Record<EditorTab, string> = {
  materials: 'Материалы',
  questions: 'Вопросы',
  assignments: 'Назначения',
};

const TRAINING_FACT_ALIAS_LIMIT = 20;
const TRAINING_FACT_ALIAS_MAX_LENGTH = 80;
const TRAINING_FACT_ALIAS_MAX_WORDS = 15;

export function TrainingAdminProjectEditorPage({
  projectId,
  navigate,
}: TrainingAdminProjectEditorPageProps) {
  const { accessToken } = useAuth();
  const [project, setProject] = useState<TrainingAdminProject | null>(null);
  const [form, setForm] = useState<EditorForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<EditorTab>('materials');
  const [questionSection, setQuestionSection] = useState<QuestionSection>('questions');
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [materialsCount, setMaterialsCount] = useState(0);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAdminProject(accessToken, projectId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setProject(response);
        setForm(toEditorForm(response));
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить проект');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, projectId, reloadKey]);

  const saveProject = async () => {
    if (!accessToken || !form || !project || pendingAction) return;

    const nextErrors = validateEditorForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length) {
      const target = locateEditorError(Object.keys(nextErrors)[0] ?? '', form);
      setError('Исправьте отмеченные поля перед сохранением');
      setActiveTab('questions');
      setQuestionSection(target.section);
      if (target.question !== null) setActiveQuestion(target.question);
      window.setTimeout(() => {
        document.getElementById(target.focusId)?.focus();
      }, 0);
      return;
    }

    setPendingAction('save');
    setError(null);
    setNotice(null);

    try {
      const updated = await updateTrainingAdminProject(
        accessToken,
        project.id,
        toUpdateRequest(form),
      );
      setProject(updated);
      setForm(toEditorForm(updated));
      setNotice('Черновик сохранён. Для новых попыток потребуется публикация.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить проект');
    } finally {
      setPendingAction(null);
    }
  };

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    void saveProject();
  };

  const runProjectAction = async (action: 'publish' | 'open' | 'close') => {
    if (!accessToken || !project || pendingAction) return;

    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      const updated = action === 'publish'
        ? await publishTrainingAdminProject(accessToken, project.id)
        : await updateTrainingAdminProject(accessToken, project.id, { isOpen: action === 'open' });
      setProject(updated);
      setForm(toEditorForm(updated));
      setNotice(action === 'publish' ? 'Проект опубликован.' : action === 'open' ? 'Проект открыт для новых попыток.' : 'Проект закрыт; активные попытки продолжаются по сохранённому снимку данных.');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Действие не выполнено');
    } finally {
      setPendingAction(null);
    }
  };

  const refreshProjectContent = async () => {
    if (!accessToken) return;
    try {
      const refreshed = await getTrainingAdminProject(accessToken, projectId);
      setProject(refreshed);
      setForm(toEditorForm(refreshed));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Не удалось обновить проект');
    }
  };

  const handleDelete = async () => {
    if (!accessToken || !project || pendingAction) return;

    setPendingAction('delete');
    setDeleteError(null);
    setError(null);
    setNotice(null);

    try {
      await deleteTrainingAdminProject(accessToken, project.id);
      setIsDeleteDialogOpen(false);
      navigate('/admin/training');
    } catch (caughtError) {
      setDeleteError(
        caughtError instanceof Error ? caughtError.message : 'Не удалось удалить проект',
      );
    } finally {
      setPendingAction(null);
    }
  };

  if (isLoading) return <div className="training-page"><Skeleton className="training-editor-skeleton" /></div>;

  if (!project || !form) {
    return (
      <div className="training-page">
        <AdminAlert tone="error">
          <span>{error ?? 'Проект не найден'}</span>
          <AdminButton
            type="button"
            tone="text"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Повторить
          </AdminButton>
        </AdminAlert>
        <AdminButton type="button" onClick={() => navigate('/admin/training')}>К списку</AdminButton>
      </div>
    );
  }

  const isReadOnly = project.isOpen;
  const isDeleting = pendingAction === 'delete';
  const questionsCount = Number(Boolean(form.mainQuestion.trim())) +
    form.followUpQuestions.filter((question) => Boolean(question.trim())).length;
  const hasCompleteQuestionSet = questionsCount === 11;
  const hasAssignmentAccess = project.accessMode === 'ALL_PARTICIPANTS' || project.activeAssignments > 0;
  const readinessPercent = Math.round(
    ([materialsCount > 0, hasCompleteQuestionSet, hasAssignmentAccess].filter(Boolean).length / 3) * 100,
  );
  const nextTab: EditorTab | null = activeTab === 'materials'
    ? 'questions'
    : activeTab === 'questions'
      ? 'assignments'
      : null;
  const previousTab: EditorTab | null = activeTab === 'assignments'
    ? 'questions'
    : activeTab === 'questions'
      ? 'materials'
      : null;

  const questionErrorIndexes = new Set(
    Object.keys(errors)
      .map((key) => locateEditorError(key, form).question)
      .filter((index): index is number => index !== null),
  );
  const activeQuestionType: TrainingQuestionType = activeQuestion === 0 ? 'MAIN' : 'FOLLOW_UP';
  const activeQuestionPosition = activeQuestion === 0 ? 1 : activeQuestion;
  const activeFollowUpId = `training-follow-up-${activeQuestion}`;
  const mainCriteriaTotal = sumCriteria(form.criteria, 'MAIN');
  const followUpCriteriaTotal = sumCriteria(form.criteria, 'FOLLOW_UP');

  return (
    <div className="training-page training-admin-page training-project-editor-page">
      <header className="training-project-editor-header">
        <div className="training-project-editor-heading">
          <p className="training-editor-breadcrumb">Обучение <span>/</span> Проекты</p>
          <div className="training-project-editor-title-row">
            <h2>{project.title}</h2>
            <AdminStatusBadge className={getTrainingStatusClass(project.status)}>{trainingProjectStatusLabels[project.status]}{project.isOpen ? ' · открыт' : ' · закрыт'}</AdminStatusBadge>
          </div>
          <p className="muted-text">Подготовьте материалы, проверьте вопросы и назначьте сотрудников.</p>
        </div>
        <div className="training-project-editor-actions">
          <AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>
            <ChevronLeftIcon data-icon="inline-start" />
            К списку
          </AdminButton>
        {project.isOpen ? (
          <AdminButton type="button" tone="secondary" disabled={Boolean(pendingAction)} onClick={() => void runProjectAction('close')}>Закрыть проект</AdminButton>
        ) : project.status === 'DRAFT' ? (
          <AdminButton type="button" tone="secondary" disabled={Boolean(pendingAction)} onClick={() => void runProjectAction('publish')}>Опубликовать</AdminButton>
        ) : project.status === 'PUBLISHED' ? (
          <AdminButton type="button" tone="secondary" disabled={Boolean(pendingAction)} onClick={() => void runProjectAction('open')}>Открыть проект</AdminButton>
        ) : null}
        <AdminButton
          type="button"
          tone="danger"
          className="training-editor-delete-action"
          disabled={Boolean(pendingAction)}
          onClick={() => {
            setDeleteError(null);
            setIsDeleteDialogOpen(true);
          }}
        >
          <Trash2Icon data-icon="inline-start" />
          Удалить проект
        </AdminButton>
        </div>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {isReadOnly && activeTab !== 'assignments' ? <AdminAlert tone="notice">Закройте проект перед редактированием. Уже начатые попытки не изменятся.</AdminAlert> : null}
      {Object.keys(errors).length ? (
        <AdminAlert tone="error">
          <div>
            <strong>Проверьте черновик:</strong>
            <ul>{[...new Set(Object.values(errors))].map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </AdminAlert>
      ) : null}
      {project.publicationErrors.length ? (
        <AdminAlert tone="notice">
          <div><strong>До публикации:</strong><ul>{project.publicationErrors.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </AdminAlert>
      ) : null}

      <Tabs
        className="training-editor-workspace"
        orientation="horizontal"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as EditorTab)}
      >
        <TabsList className="training-editor-stepper" variant="line" aria-label="Разделы редактора проекта">
          <EditorStageTrigger value="materials" step="1" label="Материалы" meta={`${materialsCount} ${pluralizeMaterials(materialsCount)}`} done={materialsCount > 0} />
          <EditorStageTrigger value="questions" step="2" label="Вопросы" meta={`${questionsCount} из 11`} done={hasCompleteQuestionSet} />
          <EditorStageTrigger value="assignments" step="3" label="Назначения" meta={project.accessMode === 'ALL_PARTICIPANTS' ? 'Все участники' : `${project.activeAssignments} ${pluralizeEmployees(project.activeAssignments)}`} done={hasAssignmentAccess} />
        </TabsList>

        <TabsContent value="materials">
          <TrainingMaterialsPanel
            accessToken={accessToken ?? ''}
            disabled={isReadOnly}
            hasQuestions={Boolean(project.mainQuestion.trim()) || project.followUpQuestions.some((question) => Boolean(question.trim()))}
            linkedObjectId={project.realEstateObjectId}
            projectId={project.id}
            onMaterialsCountChange={setMaterialsCount}
            onProjectContentChanged={refreshProjectContent}
          />
        </TabsContent>
        <TabsContent value="questions">
      <form id="training-project-editor-form" className="training-editor-form" onSubmit={handleSave}>
        <Tabs
          className="training-question-workspace"
          value={questionSection}
          onValueChange={(value) => setQuestionSection(value as QuestionSection)}
        >
          <TabsList className="training-editor-subtabs" aria-label="Разделы вопросов">
            <TabsTrigger value="params">Параметры</TabsTrigger>
            <TabsTrigger value="questions">Вопросы <small>{questionsCount}</small></TabsTrigger>
            <TabsTrigger value="criteria">Оценивание <small>{mainCriteriaTotal} + {followUpCriteriaTotal}</small></TabsTrigger>
          </TabsList>

          <TabsContent value="params">
        <AdminPanel className="training-editor-section">
          <div className="training-editor-section-heading"><h3>Параметры</h3><p className="muted-text">Название, лимиты и порог прохождения.</p></div>
          <FieldGroup className="training-form-grid">
            <EditorTextField id="training-title" label="Название" value={form.title} error={errors['training-title']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, title: value })} />
            <Field>
              <FieldLabel htmlFor="training-description">Описание</FieldLabel>
              <textarea id="training-description" className="training-textarea" rows={2} value={form.description} disabled={isReadOnly} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
          </FieldGroup>
          <FieldGroup className="training-form-grid training-form-grid--numbers">
            <EditorNumberField id="training-attempt-limit" label="Лимит попыток" value={form.attemptLimit} error={errors['training-attempt-limit']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, attemptLimit: value })} />
            <EditorNumberField id="training-time-limit" label="Таймер, минуты" value={form.timeLimitMinutes} error={errors['training-time-limit']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, timeLimitMinutes: value })} />
            <EditorNumberField id="training-pass-score" label="Проходной балл" value={form.passScore} error={errors['training-pass-score']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, passScore: value })} />
            <EditorNumberField id="training-sort-order" label="Порядок в списке" value={form.sortOrder} error={errors['training-sort-order']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, sortOrder: value })} />
          </FieldGroup>
          <label className="training-option-toggle" htmlFor="training-retake" data-disabled={isReadOnly || undefined}>
            <span className="training-option-toggle-copy">
              <span className="training-option-toggle-title">Пересдача после успешного результата</span>
              <span className="training-option-toggle-hint">Общий лимит попыток сохраняется.</span>
            </span>
            <input id="training-retake" className="training-switch" type="checkbox" role="switch" checked={form.allowRetakeAfterPass} disabled={isReadOnly} onChange={(event) => setForm({ ...form, allowRetakeAfterPass: event.target.checked })} />
          </label>
        </AdminPanel>
          </TabsContent>

          <TabsContent value="questions">
        <div className="training-question-layout">
          <AdminPanel className="training-question-index">
            <div className="training-editor-section-heading">
              <h3>1 главный и 10 дополнительных вопросов</h3>
              <p className="muted-text">Система выберет три разных дополнительных вопроса после ответа на главный.</p>
            </div>
            <ol className="training-question-index-list">
              {[form.mainQuestion, ...form.followUpQuestions].map((question, index) => {
                const factsCount = factsFor(form.facts, index === 0 ? 'MAIN' : 'FOLLOW_UP', index === 0 ? 1 : index).length;
                return (
                  <li key={index}>
                    <button
                      type="button"
                      className="training-question-index-item"
                      data-active={activeQuestion === index || undefined}
                      data-invalid={questionErrorIndexes.has(index) || undefined}
                      aria-current={activeQuestion === index ? 'true' : undefined}
                      onClick={() => setActiveQuestion(index)}
                    >
                      <span className="training-question-index-number">{index + 1}</span>
                      <span className="training-question-index-copy">
                        <span className="training-question-index-title">{index === 0 ? 'Главный вопрос' : question.trim() || 'Вопрос не заполнен'}</span>
                        <small>{index === 0 ? 55 : 15} баллов · {factsCount} {pluralizeFacts(factsCount)}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </AdminPanel>

          <AdminPanel className="training-editor-section training-question-editor">
            <div className="training-editor-section-heading">
              <p className="eyebrow">{activeQuestion === 0 ? 'Вопрос 1 · главный' : `Вопрос ${activeQuestion + 1} · дополнительный`}</p>
              <h3>{activeQuestion === 0 ? 55 : 15} баллов</h3>
            </div>
            {activeQuestion === 0 ? (
              <Field data-invalid={Boolean(errors['training-main-question'])}>
                <FieldLabel htmlFor="training-main-question">Текст главного вопроса</FieldLabel>
                <textarea id="training-main-question" className="training-textarea" rows={3} value={form.mainQuestion} disabled={isReadOnly} aria-invalid={Boolean(errors['training-main-question'])} onChange={(event) => setForm({ ...form, mainQuestion: event.target.value })} />
                {errors['training-main-question'] ? <FieldError>{errors['training-main-question']}</FieldError> : null}
              </Field>
            ) : (
              <Field data-invalid={Boolean(errors[activeFollowUpId])}>
                <FieldLabel htmlFor={activeFollowUpId}>Текст вопроса</FieldLabel>
                <textarea id={activeFollowUpId} className="training-textarea" rows={2} value={form.followUpQuestions[activeQuestion - 1]} disabled={isReadOnly} aria-invalid={Boolean(errors[activeFollowUpId])} onChange={(event) => setForm({ ...form, followUpQuestions: form.followUpQuestions.map((item, itemIndex) => itemIndex === activeQuestion - 1 ? event.target.value : item) })} />
                {errors[activeFollowUpId] ? <FieldError>{errors[activeFollowUpId]}</FieldError> : null}
              </Field>
            )}
            <QuestionFactsEditor
              key={`${activeQuestionType}-${activeQuestionPosition}`}
              disabled={isReadOnly}
              facts={factsFor(form.facts, activeQuestionType, activeQuestionPosition)}
              label={activeQuestion === 0 ? 'Эталонный ответ · проверяемые факты' : `Эталонный ответ вопроса ${activeQuestion + 1}`}
              onChange={(facts) => setForm({ ...form, facts: replaceQuestionFacts(form.facts, activeQuestionType, activeQuestionPosition, facts) })}
              questionPosition={activeQuestionPosition}
              questionType={activeQuestionType}
            />
          </AdminPanel>
        </div>
          </TabsContent>

          <TabsContent value="criteria">
        <AdminPanel className="training-editor-section">
          <div className="training-editor-section-heading"><h3>Оценивание</h3><p className="muted-text">Критерии главного вопроса применяются к главному ответу, а критерии дополнительных — к каждому из трёх дополнительных.</p></div>
          <CriteriaEditor disabled={isReadOnly} criteria={form.criteria} onChange={(criteria) => setForm({ ...form, criteria })} type="MAIN" expectedTotal={55} />
          <CriteriaEditor disabled={isReadOnly} criteria={form.criteria} onChange={(criteria) => setForm({ ...form, criteria })} type="FOLLOW_UP" expectedTotal={15} />
        </AdminPanel>
          </TabsContent>
        </Tabs>
      </form>
        </TabsContent>
        <TabsContent value="assignments">
          <TrainingProjectAccessPanel
            accessToken={accessToken ?? ''}
            project={project}
            onProjectChanged={(updated) => {
              setProject(updated);
              setForm(toEditorForm(updated));
            }}
          />
        </TabsContent>
      </Tabs>

      <div className="training-editor-bottombar">
        <div className="training-editor-readiness">
          <div><span>Готовность</span><strong>{readinessPercent}%</strong></div>
          <progress aria-label={`Готовность проекта ${readinessPercent}%`} max={100} value={readinessPercent} />
        </div>
        <div className="training-editor-bottombar-actions">
          {previousTab ? (
            <AdminButton type="button" tone="text" onClick={() => setActiveTab(previousTab)}>
              <ChevronLeftIcon data-icon="inline-start" />
              {editorTabLabels[previousTab]}
            </AdminButton>
          ) : null}
          <AdminButton type="button" tone="secondary" disabled={isReadOnly || Boolean(pendingAction)} onClick={() => void saveProject()}>
            {pendingAction === 'save' ? 'Сохранение…' : 'Сохранить черновик'}
          </AdminButton>
          {nextTab ? (
            <AdminButton className="training-editor-next-step" type="button" tone="primary" onClick={() => setActiveTab(nextTab)}>
              Далее: {editorTabLabels[nextTab].toLowerCase()}
              <ChevronRightIcon data-icon="inline-end" />
            </AdminButton>
          ) : null}
        </div>
      </div>

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (isDeleting) return;
          setIsDeleteDialogOpen(open);
          if (!open) setDeleteError(null);
        }}
      >
        <DialogContent showCloseButton={!isDeleting}>
          <DialogHeader>
            <DialogTitle>Безвозвратно удалить проект «{project.title}»?</DialogTitle>
            <DialogDescription>
              Будут удалены сам проект, все попытки и результаты сотрудников, ответы,
              материалы, назначения и связанные файлы материалов. Аудиозаписи останутся
              в общем хранилище и удаляются отдельно вручную.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <AdminAlert tone="error">{deleteError}</AdminAlert> : null}
          <DialogFooter>
            <AdminButton
              type="button"
              tone="secondary"
              disabled={isDeleting}
              onClick={() => setIsDeleteDialogOpen(false)}
            >
              Отмена
            </AdminButton>
            <AdminButton
              type="button"
              tone="danger"
              disabled={isDeleting}
              onClick={() => void handleDelete()}
            >
              {isDeleting ? 'Удаляем…' : 'Удалить проект и данные'}
            </AdminButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditorStageTrigger({
  done,
  label,
  meta,
  step,
  value,
}: {
  done: boolean;
  label: string;
  meta: string;
  step: string;
  value: EditorTab;
}) {
  return (
    <TabsTrigger className="training-editor-stage-trigger" value={value} data-done={done || undefined}>
      <span className="training-editor-stage-number" aria-hidden="true">{done ? <CheckIcon /> : step}</span>
      <span className="training-editor-stage-copy">
        <strong>{label}</strong>
        <small>{meta}</small>
      </span>
    </TabsTrigger>
  );
}

function pluralizeMaterials(value: number) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'источников';
  if (mod10 === 1) return 'источник';
  if (mod10 >= 2 && mod10 <= 4) return 'источника';
  return 'источников';
}

function pluralizeEmployees(value: number) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'сотрудников';
  if (mod10 === 1) return 'сотрудник';
  if (mod10 >= 2 && mod10 <= 4) return 'сотрудника';
  return 'сотрудников';
}

function pluralizeFacts(value: number) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'фактов';
  if (mod10 === 1) return 'факт';
  if (mod10 >= 2 && mod10 <= 4) return 'факта';
  return 'фактов';
}

function sumCriteria(criteria: TrainingCriterionDraft[], type: TrainingQuestionType) {
  return criteria
    .filter((criterion) => criterion.questionType === type)
    .reduce((sum, criterion) => sum + Number(criterion.maxPoints || 0), 0);
}

// Maps a validation key to the sub-tab, question and field that show it, so a hidden field can be revealed and focused.
function locateEditorError(key: string, form: EditorForm): { section: QuestionSection; question: number | null; focusId: string } {
  if (key === 'training-main-question') return { section: 'questions', question: 0, focusId: key };
  const followUp = key.match(/^training-follow-up-(\d+)$/u);
  if (followUp) return { section: 'questions', question: Number(followUp[1]), focusId: key };
  const fact = key.match(/^training-fact-(alias-)?(\d+)$/u);
  if (fact) {
    const target = form.facts[Number(fact[2])];
    if (!target) return { section: 'questions', question: null, focusId: key };
    const index = factsFor(form.facts, target.questionType, target.questionPosition).indexOf(target);
    return {
      section: 'questions',
      question: target.questionType === 'MAIN' ? 0 : target.questionPosition,
      focusId: `${fact[1] ? 'aliases' : 'fact'}-${target.questionType}-${target.questionPosition}-${index}`,
    };
  }
  const criterion = key.match(/^training-criteri(?:a|on)-(MAIN|FOLLOW_UP)(?:-(\d+))?$/u);
  if (criterion) return { section: 'criteria', question: null, focusId: `criterion-code-${criterion[1]}-${criterion[2] ?? 0}` };
  return { section: 'params', question: null, focusId: key };
}

function EditorTextField({ id, label, value, error, disabled, hideLabel = false, onChange }: { id: string; label: string; value: string; error?: string; disabled: boolean; hideLabel?: boolean; onChange: (value: string) => void }) {
  return <Field data-invalid={Boolean(error)} data-disabled={disabled}><FieldLabel className={hideLabel ? 'sr-only' : undefined} htmlFor={id}>{label}</FieldLabel><Input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error ? <FieldError>{error}</FieldError> : null}</Field>;
}

function EditorNumberField(props: Parameters<typeof EditorTextField>[0]) {
  return <EditorTextField {...props} />;
}

function QuestionFactsEditor({ disabled, facts, label, onChange, questionPosition, questionType }: { disabled: boolean; facts: EditorFact[]; label: string; onChange: (facts: EditorFact[]) => void; questionPosition: number; questionType: TrainingQuestionType }) {
  return (
    <fieldset className="training-facts-editor" disabled={disabled}>
      <div className="training-subsection-heading"><legend>{label}</legend><span>{facts.length} {pluralizeFacts(facts.length)}</span></div>
      {facts.length ? facts.map((fact, index) => (
        <div className="training-fact-row" key={fact.id ?? `${questionType}-${questionPosition}-${index}`}>
          <div className="training-fact-source">
            <Badge variant={fact.sourceType === 'MATERIAL' ? 'secondary' : 'outline'}>
              {formatTrainingFactSourceBadge(fact)}
            </Badge>
            {fact.sourceType === 'MATERIAL' ? <small>{fact.sourceLabel}{fact.sourceExcerpt ? ` · «${fact.sourceExcerpt}»` : ''}</small> : null}
          </div>
          <Field>
            <FieldLabel htmlFor={`fact-${questionType}-${questionPosition}-${index}`}>Утверждённый факт {index + 1}</FieldLabel>
            <textarea id={`fact-${questionType}-${questionPosition}-${index}`} className="training-textarea" rows={2} value={fact.statement} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, statement: event.target.value } : item))} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`aliases-${questionType}-${questionPosition}-${index}`}>Варианты ответа через запятую</FieldLabel>
            <Input id={`aliases-${questionType}-${questionPosition}-${index}`} value={fact.aliases.join(', ')} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value.split(',').map((alias) => alias.trim()).filter(Boolean) } : item))} />
            <FieldDescription>Только краткие имена и термины, не полный эталонный ответ.</FieldDescription>
          </Field>
          <div className="training-fact-actions">
            <label className="training-inline-check"><input type="checkbox" checked={fact.isRequired} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, isRequired: event.target.checked } : item))} /> <span>Обязательный факт</span></label>
            <AdminButton className="training-fact-delete-action" type="button" tone="text" onClick={() => onChange(facts.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, position: itemIndex + 1 })))}><Trash2Icon data-icon="inline-start" /> Удалить факт</AdminButton>
          </div>
        </div>
      )) : <p className="training-validation-note">Нет фактов: проект нельзя будет опубликовать.</p>}
      <AdminButton className="training-add-row-action" type="button" tone="secondary" onClick={() => onChange([...facts, { id: null, questionType, questionPosition, statement: '', aliases: [], isRequired: true, position: facts.length + 1 }])}><PlusIcon data-icon="inline-start" />Добавить факт ответа</AdminButton>
    </fieldset>
  );
}

function CriteriaEditor({ criteria, disabled, expectedTotal, onChange, type }: { criteria: TrainingCriterionDraft[]; disabled: boolean; expectedTotal: number; onChange: (criteria: TrainingCriterionDraft[]) => void; type: TrainingQuestionType }) {
  const scoped = criteria.filter((criterion) => criterion.questionType === type);
  const total = scoped.reduce((sum, criterion) => sum + Number(criterion.maxPoints || 0), 0);
  const replace = (next: TrainingCriterionDraft[]) => onChange([
    ...criteria.filter((criterion) => criterion.questionType !== type),
    ...next.map((criterion, index) => ({ ...criterion, position: index + 1 })),
  ]);

  return (
    <fieldset className="training-criteria-editor" disabled={disabled}>
      <div className="training-subsection-heading"><legend>{type === 'MAIN' ? 'Критерии главного вопроса' : 'Критерии дополнительных вопросов'}</legend><strong className={total === expectedTotal ? 'training-total--valid' : 'training-total--invalid'}>{total} / {expectedTotal}</strong></div>
      {scoped.length ? (
        <div className="training-criterion-head" aria-hidden="true"><span>Код</span><span>Название</span><span>Баллы</span><span /></div>
      ) : null}
      {scoped.map((criterion, index) => (
        <div className="training-criterion-row" key={criterion.id ?? `${type}-${index}`}>
          <EditorTextField id={`criterion-code-${type}-${index}`} label="Код" hideLabel value={criterion.code} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, code: value } : item))} />
          <EditorTextField id={`criterion-title-${type}-${index}`} label="Название" hideLabel value={criterion.title} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, title: value } : item))} />
          <EditorNumberField id={`criterion-points-${type}-${index}`} label="Баллы" hideLabel value={String(criterion.maxPoints)} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, maxPoints: Number(value) } : item))} />
          <AdminButton className="training-criterion-delete-action" type="button" tone="text" size="icon" aria-label="Удалить критерий" title="Удалить критерий" onClick={() => replace(scoped.filter((_, itemIndex) => itemIndex !== index))}><Trash2Icon /></AdminButton>
          <Field className="training-criterion-guidance"><FieldLabel htmlFor={`criterion-guidance-${type}-${index}`}>Инструкция для проверки</FieldLabel><textarea id={`criterion-guidance-${type}-${index}`} className="training-textarea" rows={2} placeholder="Не задана — используется стандартная" value={criterion.guidance} onChange={(event) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, guidance: event.target.value } : item))} /></Field>
        </div>
      ))}
      <AdminButton className="training-add-row-action" type="button" tone="secondary" onClick={() => replace([...scoped, { id: null, questionType: type, code: '', title: '', guidance: '', maxPoints: 1, position: scoped.length + 1 }])}><PlusIcon data-icon="inline-start" />Добавить критерий</AdminButton>
    </fieldset>
  );
}

function toEditorForm(project: TrainingAdminProject): EditorForm {
  return { title: project.title, description: project.description ?? '', realEstateObjectId: project.realEstateObjectId ?? '', sortOrder: String(project.sortOrder), attemptLimit: String(project.attemptLimit), timeLimitMinutes: String(project.timeLimitSeconds / 60), passScore: String(project.passScore), allowRetakeAfterPass: project.allowRetakeAfterPass, accessMode: project.accessMode, mainQuestion: project.mainQuestion, followUpQuestions: Array.from({ length: 10 }, (_, index) => project.followUpQuestions[index] ?? ''), facts: project.facts.map((fact) => ({ ...fact, aliases: [...fact.aliases] })), criteria: project.criteria.map((criterion) => ({ ...criterion })) };
}

function validateEditorForm(form: EditorForm) {
  const errors: Record<string, string> = {};
  if (!form.title.trim()) errors['training-title'] = 'Введите название';
  validateInteger(form.sortOrder, 'training-sort-order', errors, 0);
  validateInteger(form.attemptLimit, 'training-attempt-limit', errors, 1);
  validateInteger(form.timeLimitMinutes, 'training-time-limit', errors, 1);
  validateInteger(form.passScore, 'training-pass-score', errors, 0, 100);
  if (!form.mainQuestion.trim()) errors['training-main-question'] = 'Введите главный вопрос';
  form.followUpQuestions.forEach((question, index) => { if (!question.trim()) errors[`training-follow-up-${index + 1}`] = 'Введите дополнительный вопрос'; });
  form.facts.forEach((fact, index) => {
    if (!fact.statement.trim()) errors[`training-fact-${index}`] = 'Заполните утверждённый факт';
    if (
      fact.aliases.length > TRAINING_FACT_ALIAS_LIMIT ||
      fact.aliases.some((alias) =>
        alias.length > TRAINING_FACT_ALIAS_MAX_LENGTH ||
        alias.split(/\s+/u).length > TRAINING_FACT_ALIAS_MAX_WORDS ||
        /[\r\n]/u.test(alias)
      )
    ) errors[`training-fact-alias-${index}`] = 'Проверьте краткие варианты ответа';
    const canonical = fact.aliases.map((alias) => alias.normalize('NFC').toLocaleLowerCase('ru-RU'));
    if (new Set(canonical).size !== canonical.length) errors[`training-fact-alias-${index}`] = 'Варианты ответа не должны повторяться';
  });
  for (const type of ['MAIN', 'FOLLOW_UP'] as const) {
    const scoped = form.criteria.filter((criterion) => criterion.questionType === type);
    const codes = scoped.map((criterion) => criterion.code.trim().toLocaleLowerCase('en-US'));
    if (new Set(codes).size !== codes.length) errors[`training-criteria-${type}`] = `Коды критериев ${type === 'MAIN' ? 'главного вопроса' : 'дополнительных вопросов'} не должны повторяться`;
    scoped.forEach((criterion, index) => {
      if (!/^[a-z][a-z0-9_]*$/u.test(criterion.code) || !criterion.title.trim() || !Number.isInteger(criterion.maxPoints) || criterion.maxPoints < 1) errors[`training-criterion-${type}-${index}`] = `Проверьте критерий ${index + 1}`;
    });
  }
  return errors;
}

function validateInteger(value: string, id: string, errors: Record<string, string>, minimum: number, maximum?: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || (maximum !== undefined && number > maximum)) errors[id] = maximum === undefined ? `Введите целое число не меньше ${minimum}` : `Введите целое число от ${minimum} до ${maximum}`;
}

function toUpdateRequest(form: EditorForm): UpdateTrainingProjectRequest {
  return { title: form.title.trim(), description: form.description.trim() || null, realEstateObjectId: form.realEstateObjectId.trim() || null, sortOrder: Number(form.sortOrder), attemptLimit: Number(form.attemptLimit), timeLimitMinutes: Number(form.timeLimitMinutes), passScore: Number(form.passScore), allowRetakeAfterPass: form.allowRetakeAfterPass, accessMode: form.accessMode, mainQuestion: form.mainQuestion.trim(), followUpQuestions: form.followUpQuestions.map((question) => question.trim()), facts: form.facts.map((fact) => ({ id: fact.id, questionType: fact.questionType, questionPosition: fact.questionPosition, statement: fact.statement.trim(), aliases: fact.aliases.map((alias) => alias.trim()), isRequired: fact.isRequired, position: fact.position })), criteria: form.criteria.map((criterion) => ({ ...criterion, code: criterion.code.trim(), title: criterion.title.trim(), guidance: criterion.guidance.trim() })) };
}

function factsFor(facts: EditorFact[], type: TrainingQuestionType, position: number) {
  return facts.filter((fact) => fact.questionType === type && fact.questionPosition === position).sort((left, right) => left.position - right.position);
}

function replaceQuestionFacts(facts: EditorFact[], type: TrainingQuestionType, position: number, replacement: EditorFact[]) {
  return [...facts.filter((fact) => fact.questionType !== type || fact.questionPosition !== position), ...replacement.map((fact, index) => ({ ...fact, questionType: type, questionPosition: position, position: index + 1 }))];
}
