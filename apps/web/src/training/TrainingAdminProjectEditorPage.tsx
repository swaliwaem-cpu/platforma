import { FormEvent, useEffect, useState } from 'react';
import type {
  TrainingAdminProject,
  TrainingCriterionDraft,
  TrainingFactDraft,
  TrainingFactSource,
  TrainingQuestionType,
  UpdateTrainingProjectRequest,
} from '@platforma/shared';

import { AdminAlert, AdminButton, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
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
  mainQuestion: string;
  followUpQuestions: string[];
  facts: EditorFact[];
  criteria: TrainingCriterionDraft[];
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
  const [activeTab, setActiveTab] = useState('content');

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
      {Object.keys(errors).length ? (
        <AdminAlert tone="error">
          <div>
            <strong>Проверьте draft:</strong>
            <ul>{[...new Set(Object.values(errors))].map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </AdminAlert>
      ) : null}
      {project.publicationErrors.length ? (
        <AdminAlert tone="notice">
          <div><strong>До публикации:</strong><ul>{project.publicationErrors.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </AdminAlert>
      ) : null}

      <Tabs className="training-editor-tabs" value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line" aria-label="Разделы редактора проекта">
          <TabsTrigger value="content">Контент и оценивание</TabsTrigger>
          <TabsTrigger value="materials">Материалы</TabsTrigger>
        </TabsList>
        <TabsContent value="content">
      <form className="training-editor-form" onSubmit={(event) => void handleSave(event)}>
        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Настройки</p><h3>Основные параметры</h3></div>
          <FieldGroup className="training-form-grid">
            <EditorTextField id="training-title" label="Название" value={form.title} error={errors['training-title']} disabled={isReadOnly} onChange={(value) => setForm({ ...form, title: value })} />
            <Field>
              <FieldLabel htmlFor="training-description">Описание</FieldLabel>
              <textarea id="training-description" className="training-textarea" rows={4} value={form.description} disabled={isReadOnly} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
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
          <QuestionFactsEditor
            disabled={isReadOnly}
            facts={factsFor(form.facts, 'MAIN', 1)}
            label="Факты главного вопроса"
            onChange={(facts) => setForm({ ...form, facts: replaceQuestionFacts(form.facts, 'MAIN', 1, facts) })}
            questionPosition={1}
            questionType="MAIN"
          />
        </AdminPanel>

        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Вопросы 2–11</p><h3>Дополнительные вопросы · по 15 баллов</h3><p className="muted-text">Backend выберет три разных вопроса после ответа на главный.</p></div>
          <FieldGroup>
            {form.followUpQuestions.map((question, index) => {
              const id = `training-follow-up-${index + 1}`;
              return (
                <div className="training-question-draft" key={id}>
                  <EditorTextField id={id} label={`Дополнительный вопрос ${index + 1}`} value={question} error={errors[id]} disabled={isReadOnly} onChange={(value) => setForm({ ...form, followUpQuestions: form.followUpQuestions.map((item, itemIndex) => itemIndex === index ? value : item) })} />
                  <QuestionFactsEditor
                    disabled={isReadOnly}
                    facts={factsFor(form.facts, 'FOLLOW_UP', index + 1)}
                    label={`Факты вопроса ${index + 1}`}
                    onChange={(facts) => setForm({ ...form, facts: replaceQuestionFacts(form.facts, 'FOLLOW_UP', index + 1, facts) })}
                    questionPosition={index + 1}
                    questionType="FOLLOW_UP"
                  />
                </div>
              );
            })}
          </FieldGroup>
        </AdminPanel>

        <AdminPanel className="training-editor-section">
          <div><p className="eyebrow">Оценивание</p><h3>Настраиваемые критерии</h3><p className="muted-text">MAIN применяется к главному ответу, FOLLOW_UP — к каждому из трёх дополнительных.</p></div>
          <CriteriaEditor disabled={isReadOnly} criteria={form.criteria} onChange={(criteria) => setForm({ ...form, criteria })} type="MAIN" expectedTotal={55} />
          <CriteriaEditor disabled={isReadOnly} criteria={form.criteria} onChange={(criteria) => setForm({ ...form, criteria })} type="FOLLOW_UP" expectedTotal={15} />
        </AdminPanel>

        <AdminButton type="submit" tone="primary" disabled={isReadOnly || Boolean(pendingAction)}>{pendingAction === 'save' ? 'Сохранение…' : 'Сохранить черновик'}</AdminButton>
      </form>
        </TabsContent>
        <TabsContent value="materials">
          <TrainingMaterialsPanel
            accessToken={accessToken ?? ''}
            disabled={isReadOnly}
            linkedObjectId={project.realEstateObjectId}
            projectId={project.id}
            onFactsChanged={() => void refreshProjectContent()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EditorTextField({ id, label, value, error, disabled, onChange }: { id: string; label: string; value: string; error?: string; disabled: boolean; onChange: (value: string) => void }) {
  return <Field data-invalid={Boolean(error)} data-disabled={disabled}><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />{error ? <FieldError>{error}</FieldError> : null}</Field>;
}

function EditorNumberField(props: Parameters<typeof EditorTextField>[0]) {
  return <EditorTextField {...props} />;
}

function QuestionFactsEditor({ disabled, facts, label, onChange, questionPosition, questionType }: { disabled: boolean; facts: EditorFact[]; label: string; onChange: (facts: EditorFact[]) => void; questionPosition: number; questionType: TrainingQuestionType }) {
  return (
    <fieldset className="training-facts-editor" disabled={disabled}>
      <div className="training-subsection-heading"><legend>{label}</legend><span>{facts.length} факт.</span></div>
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
            <textarea id={`fact-${questionType}-${questionPosition}-${index}`} className="training-textarea" rows={3} value={fact.statement} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, statement: event.target.value } : item))} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`aliases-${questionType}-${questionPosition}-${index}`}>Aliases через запятую</FieldLabel>
            <Input id={`aliases-${questionType}-${questionPosition}-${index}`} value={fact.aliases.join(', ')} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value.split(',').map((alias) => alias.trim()).filter(Boolean) } : item))} />
            <FieldDescription>Только краткие имена и термины, не полный эталонный ответ.</FieldDescription>
          </Field>
          <label className="training-inline-check"><input type="checkbox" checked={fact.isRequired} onChange={(event) => onChange(facts.map((item, itemIndex) => itemIndex === index ? { ...item, isRequired: event.target.checked } : item))} /> Обязательный факт</label>
          <AdminButton type="button" tone="text" onClick={() => onChange(facts.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, position: itemIndex + 1 })))}>Удалить факт</AdminButton>
        </div>
      )) : <p className="training-validation-note">Нет фактов: проект нельзя будет опубликовать.</p>}
      <AdminButton type="button" tone="secondary" onClick={() => onChange([...facts, { id: null, questionType, questionPosition, statement: '', aliases: [], isRequired: true, position: facts.length + 1 }])}>Добавить факт</AdminButton>
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
      <div className="training-subsection-heading"><legend>{type} criteria</legend><strong className={total === expectedTotal ? 'training-total--valid' : 'training-total--invalid'}>{total} / {expectedTotal}</strong></div>
      {scoped.map((criterion, index) => (
        <div className="training-criterion-row" key={criterion.id ?? `${type}-${index}`}>
          <EditorTextField id={`criterion-code-${type}-${index}`} label="Code" value={criterion.code} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, code: value } : item))} />
          <EditorTextField id={`criterion-title-${type}-${index}`} label="Название" value={criterion.title} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, title: value } : item))} />
          <EditorNumberField id={`criterion-points-${type}-${index}`} label="Баллы" value={String(criterion.maxPoints)} disabled={disabled} onChange={(value) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, maxPoints: Number(value) } : item))} />
          <Field><FieldLabel htmlFor={`criterion-guidance-${type}-${index}`}>Инструкция</FieldLabel><textarea id={`criterion-guidance-${type}-${index}`} className="training-textarea" rows={3} value={criterion.guidance} onChange={(event) => replace(scoped.map((item, itemIndex) => itemIndex === index ? { ...item, guidance: event.target.value } : item))} /></Field>
          <AdminButton type="button" tone="text" onClick={() => replace(scoped.filter((_, itemIndex) => itemIndex !== index))}>Удалить criterion</AdminButton>
        </div>
      ))}
      <AdminButton type="button" tone="secondary" onClick={() => replace([...scoped, { id: null, questionType: type, code: '', title: '', guidance: '', maxPoints: 1, position: scoped.length + 1 }])}>Добавить criterion</AdminButton>
    </fieldset>
  );
}

function toEditorForm(project: TrainingAdminProject): EditorForm {
  return { title: project.title, description: project.description ?? '', realEstateObjectId: project.realEstateObjectId ?? '', sortOrder: String(project.sortOrder), attemptLimit: String(project.attemptLimit), timeLimitMinutes: String(project.timeLimitSeconds / 60), passScore: String(project.passScore), allowRetakeAfterPass: project.allowRetakeAfterPass, mainQuestion: project.mainQuestion, followUpQuestions: Array.from({ length: 10 }, (_, index) => project.followUpQuestions[index] ?? ''), facts: project.facts.map((fact) => ({ ...fact, aliases: [...fact.aliases] })), criteria: project.criteria.map((criterion) => ({ ...criterion })) };
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
    if (fact.aliases.length > 20 || fact.aliases.some((alias) => alias.length > 80 || alias.split(/\s+/u).length > 8 || /[\r\n]/u.test(alias))) errors[`training-fact-alias-${index}`] = 'Проверьте краткие aliases';
    const canonical = fact.aliases.map((alias) => alias.normalize('NFC').toLocaleLowerCase('ru-RU'));
    if (new Set(canonical).size !== canonical.length) errors[`training-fact-alias-${index}`] = 'Aliases не должны повторяться';
  });
  for (const type of ['MAIN', 'FOLLOW_UP'] as const) {
    const scoped = form.criteria.filter((criterion) => criterion.questionType === type);
    const codes = scoped.map((criterion) => criterion.code.trim().toLocaleLowerCase('en-US'));
    if (new Set(codes).size !== codes.length) errors[`training-criteria-${type}`] = `Codes ${type} не должны повторяться`;
    scoped.forEach((criterion, index) => {
      if (!/^[a-z][a-z0-9_]*$/u.test(criterion.code) || !criterion.title.trim() || !Number.isInteger(criterion.maxPoints) || criterion.maxPoints < 1) errors[`training-criterion-${type}-${index}`] = `Проверьте criterion ${index + 1}`;
    });
  }
  return errors;
}

function validateInteger(value: string, id: string, errors: Record<string, string>, minimum: number, maximum?: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || (maximum !== undefined && number > maximum)) errors[id] = maximum === undefined ? `Введите целое число не меньше ${minimum}` : `Введите целое число от ${minimum} до ${maximum}`;
}

function toUpdateRequest(form: EditorForm): UpdateTrainingProjectRequest {
  return { title: form.title.trim(), description: form.description.trim() || null, realEstateObjectId: form.realEstateObjectId.trim() || null, sortOrder: Number(form.sortOrder), attemptLimit: Number(form.attemptLimit), timeLimitMinutes: Number(form.timeLimitMinutes), passScore: Number(form.passScore), allowRetakeAfterPass: form.allowRetakeAfterPass, mainQuestion: form.mainQuestion.trim(), followUpQuestions: form.followUpQuestions.map((question) => question.trim()), facts: form.facts.map((fact) => ({ id: fact.id, questionType: fact.questionType, questionPosition: fact.questionPosition, statement: fact.statement.trim(), aliases: fact.aliases.map((alias) => alias.trim()), isRequired: fact.isRequired, position: fact.position })), criteria: form.criteria.map((criterion) => ({ ...criterion, code: criterion.code.trim(), title: criterion.title.trim(), guidance: criterion.guidance.trim() })) };
}

function factsFor(facts: EditorFact[], type: TrainingQuestionType, position: number) {
  return facts.filter((fact) => fact.questionType === type && fact.questionPosition === position).sort((left, right) => left.position - right.position);
}

function replaceQuestionFacts(facts: EditorFact[], type: TrainingQuestionType, position: number, replacement: EditorFact[]) {
  return [...facts.filter((fact) => fact.questionType !== type || fact.questionPosition !== position), ...replacement.map((fact, index) => ({ ...fact, questionType: type, questionPosition: position, position: index + 1 }))];
}
