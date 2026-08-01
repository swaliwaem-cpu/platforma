import { FormEvent, useEffect, useState } from 'react';
import type { TrainingAdminProject, UpdateTrainingProjectRequest } from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getTrainingAdminProject,
  publishTrainingAdminProject,
  updateTrainingAdminProject,
} from './trainingApi';
import { getTrainingStatusClass, trainingProjectStatusLabels } from './trainingView';

type EditorForm = {
  title: string;
  description: string;
  realEstateObjectId: string;
  sortOrder: string;
  attemptLimit: string;
  timeLimitMinutes: string;
  passScore: string;
  allowRetakeAfterPass: boolean;
  mainQuestion: string;
  followUpQuestions: string[];
};

type TrainingAdminProjectEditorPageProps = {
  projectId: string;
  navigate: (pathname: string) => void;
};

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

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessToken || !form || !project || pendingAction) return;

    const nextErrors = validateEditorForm(form);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length) {
      setError('Исправьте отмеченные поля перед сохранением');
      document.getElementById(Object.keys(nextErrors)[0] ?? '')?.focus();
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
      setNotice(action === 'publish' ? 'Проект опубликован.' : action === 'open' ? 'Проект открыт для новых попыток.' : 'Проект закрыт; активные попытки продолжаются по snapshot.');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Действие не выполнено');
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

  return (
    <div className="training-page training-admin-page">
      <header className="training-page-header">
        <div><p className="eyebrow">Админка · Обучение</p><h2>{project.title}</h2><p className="muted-text">Настройки, 1 главный и 10 дополнительных вопросов.</p></div>
        <AdminStatusBadge className={getTrainingStatusClass(project.status)}>{trainingProjectStatusLabels[project.status]}{project.isOpen ? ' · открыт' : ' · закрыт'}</AdminStatusBadge>
      </header>

      <div className="training-toolbar">
        <AdminButton type="button" tone="text" onClick={() => navigate('/admin/training')}>К списку</AdminButton>
        {project.isOpen ? (
          <AdminButton type="button" tone="secondary" disabled={Boolean(pendingAction)} onClick={() => void runProjectAction('close')}>Закрыть проект</AdminButton>
        ) : (
          <>
            <AdminButton type="button" tone="secondary" disabled={project.status !== 'DRAFT' || Boolean(pendingAction)} onClick={() => void runProjectAction('publish')}>Опубликовать</AdminButton>
            <AdminButton type="button" tone="primary" disabled={project.status !== 'PUBLISHED' || Boolean(pendingAction)} onClick={() => void runProjectAction('open')}>Открыть проект</AdminButton>
          </>
        )}
      </div>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {isReadOnly ? <AdminAlert tone="notice">Закройте проект перед редактированием. Уже начатые попытки не изменятся.</AdminAlert> : null}

      <form className="training-editor-form" onSubmit={(event) => void handleSave(event)}>
        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Настройки</p><h3>Основные параметры</h3></div>
          <FieldGroup className="training-form-grid">
            <EditorTextField id="training-title" label="Название" value={form.title} error={errors['training-title']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, title: value })} />
            <Field>
              <FieldLabel htmlFor="training-description">Описание</FieldLabel>
              <textarea id="training-description" className="training-textarea" rows={4} value={form.description} disabled={isReadOnly} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
            <EditorTextField id="training-object-id" label="ID ЖК (необязательно)" value={form.realEstateObjectId} error={errors['training-object-id']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, realEstateObjectId: value })} />
            <EditorNumberField id="training-sort-order" label="Порядок" value={form.sortOrder} error={errors['training-sort-order']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, sortOrder: value })} />
            <EditorNumberField id="training-attempt-limit" label="Лимит попыток" value={form.attemptLimit} error={errors['training-attempt-limit']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, attemptLimit: value })} />
            <EditorNumberField id="training-time-limit" label="Таймер, минуты" value={form.timeLimitMinutes} error={errors['training-time-limit']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, timeLimitMinutes: value })} />
            <EditorNumberField id="training-pass-score" label="Проходной балл" value={form.passScore} error={errors['training-pass-score']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, passScore: value })} />
            <Field orientation="horizontal" data-disabled={isReadOnly}>
              <input id="training-retake" type="checkbox" checked={form.allowRetakeAfterPass} disabled={isReadOnly} onChange={(event) => setForm({ ...form, allowRetakeAfterPass: event.target.checked })} />
              <div><FieldLabel htmlFor="training-retake">Разрешить пересдачу после успешного результата</FieldLabel><FieldDescription>Общий лимит попыток сохраняется.</FieldDescription></div>
            </Field>
          </FieldGroup>
        </AdminPanel>

        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Вопрос 1</p><h3>Главный вопрос · 55 баллов</h3></div>
          <Field data-invalid={Boolean(errors['training-main-question'])}>
            <FieldLabel htmlFor="training-main-question">Текст главного вопроса</FieldLabel>
            <textarea id="training-main-question" className="training-textarea" rows={5} value={form.mainQuestion} disabled={isReadOnly} aria-invalid={Boolean(errors['training-main-question'])} onChange={(event) => setForm({ ...form, mainQuestion: event.target.value })} />
            {errors['training-main-question'] ? <FieldError>{errors['training-main-question']}</FieldError> : null}
          </Field>
        </AdminPanel>

        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Вопросы 2–11</p><h3>Дополнительные вопросы · по 15 баллов</h3><p className="muted-text">Backend выберет три разных вопроса после ответа на главный.</p></div>
          <FieldGroup>
            {form.followUpQuestions.map((question, index) => {
              const id = `training-follow-up-${index + 1}`;
              return <EditorTextField key={id} id={id} label={`Дополнительный вопрос ${index + 1}`} value={question} error={errors[id]} disabled={isReadOnly} onChange={(value) => setForm({ ...form, followUpQuestions: form.followUpQuestions.map((item, itemIndex) => itemIndex === index ? value : item) })} />;
            })}
          </FieldGroup>
        </AdminPanel>

        <AdminButton type="submit" tone="primary" disabled={isReadOnly || Boolean(pendingAction)}>{pendingAction === 'save' ? 'Сохранение…' : 'Сохранить черновик'}</AdminButton>
      </form>
    </div>
  );
}

function EditorTextField({ id, label, value, error, disabled, onChange }: { id: string; label: string; value: string; error?: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field data-invalid={Boolean(error)} data-disabled={disabled}><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error ? <FieldError>{error}</FieldError> : null}</Field>;
}

function EditorNumberField(props: Parameters<typeof EditorTextField>[0]) {
  return <EditorTextField {...props} />;
}

function toEditorForm(project: TrainingAdminProject): EditorForm {
  return { title: project.title, description: project.description ?? '', realEstateObjectId: project.realEstateObjectId ?? '', sortOrder: String(project.sortOrder), attemptLimit: String(project.attemptLimit), timeLimitMinutes: String(project.timeLimitSeconds / 60), passScore: String(project.passScore), allowRetakeAfterPass: project.allowRetakeAfterPass, mainQuestion: project.mainQuestion, followUpQuestions: Array.from({ length: 10 }, (_, index) => project.followUpQuestions[index] ?? '') };
}

function validateEditorForm(form: EditorForm) {
  const errors: Record<string, string> = {};
  if (!form.title.trim()) errors['training-title'] = 'Введите название';
  if (form.realEstateObjectId && !/^[0-9a-f-]{36}$/iu.test(form.realEstateObjectId)) errors['training-object-id'] = 'Введите UUID ЖК';
  validateInteger(form.sortOrder, 'training-sort-order', errors, 0);
  validateInteger(form.attemptLimit, 'training-attempt-limit', errors, 1);
  validateInteger(form.timeLimitMinutes, 'training-time-limit', errors, 1);
  validateInteger(form.passScore, 'training-pass-score', errors, 0, 100);
  if (!form.mainQuestion.trim()) errors['training-main-question'] = 'Введите главный вопрос';
  form.followUpQuestions.forEach((question, index) => { if (!question.trim()) errors[`training-follow-up-${index + 1}`] = 'Введите дополнительный вопрос'; });
  return errors;
}

function validateInteger(value: string, id: string, errors: Record<string, string>, minimum: number, maximum?: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || (maximum !== undefined && number > maximum)) errors[id] = maximum === undefined ? `Введите целое число не меньше ${minimum}` : `Введите целое число от ${minimum} до ${maximum}`;
}

function toUpdateRequest(form: EditorForm): UpdateTrainingProjectRequest {
  return { title: form.title.trim(), description: form.description.trim() || null, realEstateObjectId: form.realEstateObjectId.trim() || null, sortOrder: Number(form.sortOrder), attemptLimit: Number(form.attemptLimit), timeLimitMinutes: Number(form.timeLimitMinutes), passScore: Number(form.passScore), allowRetakeAfterPass: form.allowRetakeAfterPass, mainQuestion: form.mainQuestion.trim(), followUpQuestions: form.followUpQuestions.map((question) => question.trim()) };
}
