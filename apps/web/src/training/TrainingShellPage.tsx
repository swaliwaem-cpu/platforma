import type {
  TrainingEmployeeAttemptDetail,
  TrainingEmployeeAttemptListItem,
  TrainingEmployeeProjectSummary,
  TrainingModuleConfigResponse,
  TrainingPolicyResponse,
  TrainingTelegramAccountResponse,
} from '@platforma/shared';
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  Clock3Icon,
  LinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UnlinkIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AdminAlert,
  AdminButton,
  AdminEmptyState,
  AdminPanel,
  AdminStatusBadge,
} from '../admin/AdminUi';
import { apiRequest } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import {
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  acceptTrainingPolicy,
  createTrainingProjectStartLink,
  createTrainingTelegramLink,
  getTrainingAttempt,
  getTrainingAttempts,
  getTrainingProjects,
  getTrainingPolicy,
  getTrainingTelegramAccount,
  revokeTrainingTelegramAccount,
} from './trainingResultsApi';
import {
  attemptStatusLabels,
  employeeBreakdownStatusLabels,
  eligibilityLabels,
  formatTrainingDuration,
  formatTrainingScore,
  passStatusLabels,
  readTrainingError as readError,
  reviewStatusLabels,
} from './trainingViewModel.mjs';
import './trainingResults.css';

type TrainingShellPageProps = {
  onBack?: () => void;
};

type TelegramLinkState = {
  deepLink: string;
  expiresAt: string;
};

export function TrainingShellPage({ onBack }: TrainingShellPageProps) {
  const { accessToken } = useAuth();
  const [config, setConfig] =
    useState<TrainingModuleConfigResponse | null>(null);
  const [projects, setProjects] = useState<
    TrainingEmployeeProjectSummary[]
  >([]);
  const [account, setAccount] =
    useState<TrainingTelegramAccountResponse | null>(null);
  const [policy, setPolicy] = useState<TrainingPolicyResponse | null>(null);
  const [isPolicyOpen, setIsPolicyOpen] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [telegramLink, setTelegramLink] =
    useState<TelegramLinkState | null>(null);
  const [attempts, setAttempts] = useState<
    TrainingEmployeeAttemptListItem[]
  >([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [detail, setDetail] =
    useState<TrainingEmployeeAttemptDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Сессия не найдена');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const nextConfig = await apiRequest<TrainingModuleConfigResponse>(
        '/training/config',
        accessToken,
      );
      setConfig(nextConfig);
      if (nextConfig.status === 'disabled') {
        setProjects([]);
        setAccount(null);
        setAttempts([]);
        setPolicy(null);
        return;
      }
      const [
        projectResponse,
        accountResponse,
        attemptResponse,
        policyResponse,
      ] = await Promise.all([
          getTrainingProjects(accessToken),
          getTrainingTelegramAccount(accessToken),
          getTrainingAttempts(accessToken, { pageSize: 100 }),
          getTrainingPolicy(accessToken),
        ]);
      setProjects(projectResponse.items);
      setAccount(accountResponse);
      setAttempts(attemptResponse.items);
      setPolicy(policyResponse);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось загрузить обучение'));
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleAttempts = useMemo(
    () =>
      selectedProjectId
        ? attempts.filter(
            (attempt) => attempt.project.id === selectedProjectId,
          )
        : attempts,
    [attempts, selectedProjectId],
  );

  async function openTelegramLink(projectId?: string) {
    if (!accessToken) return;
    setPendingAction(projectId ? `project:${projectId}` : 'telegram');
    setError(null);
    setNotice(null);
    try {
      const link = projectId
        ? await createTrainingProjectStartLink(accessToken, projectId)
        : await createTrainingTelegramLink(accessToken);
      if (!projectId) {
        setTelegramLink({
          deepLink: link.deepLink,
          expiresAt: link.expiresAt,
        });
      }
      window.open(link.deepLink, '_blank', 'noopener,noreferrer');
      setNotice(
        projectId
          ? 'Ссылка на запуск открыта в Telegram.'
          : 'Одноразовая ссылка открыта в Telegram.',
      );
    } catch (caughtError) {
      setError(
        readError(caughtError, 'Не удалось создать ссылку Telegram'),
      );
    } finally {
      setPendingAction(null);
    }
  }

  function requestProjectStart(projectId: string) {
    if (!policy?.accepted) {
      setPendingProjectId(projectId);
      setIsPolicyOpen(true);
      return;
    }
    void openTelegramLink(projectId);
  }

  async function acceptPolicy() {
    if (!accessToken) return;
    setPendingAction('policy');
    setError(null);
    try {
      const acceptedPolicy = await acceptTrainingPolicy(accessToken);
      setPolicy(acceptedPolicy);
      setNotice(
        `Правила версии ${acceptedPolicy.policy.version} подтверждены.`,
      );
      const projectId = pendingProjectId;
      setPendingProjectId(null);
      setIsPolicyOpen(false);
      if (projectId) {
        await openTelegramLink(projectId);
      }
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось сохранить подтверждение'));
    } finally {
      setPendingAction(null);
    }
  }

  async function disconnectTelegram() {
    if (!accessToken) return;
    setPendingAction('revoke');
    setError(null);
    setNotice(null);
    try {
      await revokeTrainingTelegramAccount(accessToken);
      setTelegramLink(null);
      await load();
      setNotice('Связь с Telegram отключена.');
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось отключить Telegram'));
    } finally {
      setPendingAction(null);
    }
  }

  async function openAttempt(attemptId: string) {
    if (!accessToken) return;
    setPendingAction(`attempt:${attemptId}`);
    setError(null);
    try {
      const response = await getTrainingAttempt(accessToken, attemptId);
      setDetail(response.attempt);
    } catch (caughtError) {
      setError(readError(caughtError, 'Не удалось открыть результат'));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="training-results training-results--employee">
      <header className="training-results-header">
        <div>
          {onBack ? (
            <button
              className="training-results-back"
              type="button"
              onClick={onBack}
            >
              Назад
            </button>
          ) : null}
          <p className="eyebrow">Обучение</p>
          <h2>Моя аттестация</h2>
          <p>
            Доступные проекты, прогресс и подтверждённые результаты в одном
            месте.
          </p>
        </div>
        <AdminButton
          aria-label="Обновить данные обучения"
          disabled={isLoading}
          onClick={() => void load()}
        >
          <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
          Обновить
        </AdminButton>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {isLoading ? (
        <div className="training-results-loading" role="status">
          <LoaderCircleIcon aria-hidden="true" />
          Загрузка данных обучения
        </div>
      ) : null}
      {!isLoading && config?.status === 'disabled' ? (
        <AdminAlert tone="notice">
          Модуль обучения сейчас отключён.
        </AdminAlert>
      ) : null}

      {!isLoading && config?.status === 'enabled' ? (
        <>
          {policy ? (
            <PolicyCard
              policy={policy}
              onOpen={() => {
                setPendingProjectId(null);
                setIsPolicyOpen(true);
              }}
            />
          ) : null}

          <TelegramConnectionCard
            account={account}
            isPending={Boolean(pendingAction)}
            link={telegramLink}
            onConnect={() => void openTelegramLink()}
            onDisconnect={() => void disconnectTelegram()}
          />

          <section aria-labelledby="training-projects-title">
            <div className="training-results-section-heading">
              <div>
                <p className="eyebrow">Проекты</p>
                <h3 id="training-projects-title">Доступно сейчас</h3>
              </div>
              <span>{projects.length}</span>
            </div>
            {projects.length ? (
              <div className="training-project-grid">
                {projects.map((project) => (
                  <EmployeeProjectCard
                    key={project.id}
                    project={project}
                    isPending={pendingAction === `project:${project.id}`}
                    onStart={() => requestProjectStart(project.id)}
                  />
                ))}
              </div>
            ) : (
              <AdminEmptyState
                title="Нет доступных проектов"
                description="Открытые проекты появятся здесь после публикации."
              />
            )}
          </section>

          <section aria-labelledby="training-history-title">
            <div className="training-results-section-heading">
              <div>
                <p className="eyebrow">Прогресс</p>
                <h3 id="training-history-title">История попыток</h3>
              </div>
              <label className="training-results-filter">
                <span>Проект</span>
                <select
                  value={selectedProjectId}
                  onChange={(event) =>
                    setSelectedProjectId(event.target.value)
                  }
                >
                  <option value="">Все проекты</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <AttemptHistory
              attempts={visibleAttempts}
              pendingAction={pendingAction}
              onOpen={openAttempt}
            />
          </section>

          {detail ? (
            <EmployeeAttemptDetail
              attempt={detail}
              onClose={() => setDetail(null)}
            />
          ) : null}

          {policy ? (
            <PolicyDialog
              isOpen={isPolicyOpen}
              isPending={pendingAction === 'policy'}
              policy={policy}
              onAccept={() => void acceptPolicy()}
              onOpenChange={(open) => {
                setIsPolicyOpen(open);
                if (!open) setPendingProjectId(null);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PolicyCard({
  policy,
  onOpen,
}: {
  policy: TrainingPolicyResponse;
  onOpen: () => void;
}) {
  return (
    <AdminPanel className="training-policy-card">
      <CardHeader>
        <div>
          <p className="eyebrow">Правила</p>
          <CardTitle>{policy.policy.title}</CardTitle>
        </div>
        <AdminStatusBadge
          className={
            policy.accepted
              ? 'training-status--success'
              : 'training-status--warning'
          }
        >
          {policy.accepted ? 'Подтверждены' : 'Требуют подтверждения'}
        </AdminStatusBadge>
      </CardHeader>
      <CardContent>
        <p>
          Версия {policy.policy.version} · действует с{' '}
          {formatPolicyDate(policy.policy.effectiveAt)}
        </p>
        <p>
          {policy.acceptance
            ? `Вы подтвердили правила ${formatDateTime(policy.acceptance.acceptedAt)} через ${
                policy.acceptance.source === 'TELEGRAM'
                  ? 'Telegram'
                  : 'Platforma'
              }.`
            : 'Ознакомьтесь с правилами до перехода к первой попытке.'}
        </p>
        <AdminButton onClick={onOpen}>
          {policy.accepted ? 'Открыть правила' : 'Ознакомиться с правилами'}
        </AdminButton>
      </CardContent>
    </AdminPanel>
  );
}

function PolicyDialog({
  isOpen,
  isPending,
  policy,
  onAccept,
  onOpenChange,
}: {
  isOpen: boolean;
  isPending: boolean;
  policy: TrainingPolicyResponse;
  onAccept: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="training-policy-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <p className="eyebrow">Версия {policy.policy.version}</p>
          <DialogTitle>{policy.policy.title}</DialogTitle>
          <DialogDescription>
            Действует с {formatPolicyDate(policy.policy.effectiveAt)}.
          </DialogDescription>
        </DialogHeader>
        <div className="training-policy-body">{policy.policy.body}</div>
        <DialogFooter>
          <AdminButton
            disabled={isPending}
            tone="text"
            onClick={() => onOpenChange(false)}
          >
            Закрыть
          </AdminButton>
          {!policy.accepted ? (
            <AdminButton
              disabled={isPending}
              tone="primary"
              onClick={onAccept}
            >
              {isPending
                ? 'Сохраняем подтверждение…'
                : 'Ознакомлен и согласен продолжить'}
            </AdminButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramConnectionCard({
  account,
  isPending,
  link,
  onConnect,
  onDisconnect,
}: {
  account: TrainingTelegramAccountResponse | null;
  isPending: boolean;
  link: TelegramLinkState | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <AdminPanel className="training-telegram-card">
      <CardHeader>
        <div>
          <p className="eyebrow">Telegram</p>
          <CardTitle>
            {account?.connected
              ? 'Аккаунт подключён'
              : 'Подключите Telegram'}
          </CardTitle>
        </div>
        <AdminStatusBadge
          className={
            account?.connected
              ? 'training-status--success'
              : 'training-status--warning'
          }
        >
          {account?.connected ? 'Связь активна' : 'Не подключён'}
        </AdminStatusBadge>
      </CardHeader>
      <CardContent>
        <p>
          {account?.connected
            ? `Ответы принимаются через ${account.account?.displayName ?? 'подключённый аккаунт'}.`
            : 'Одноразовая ссылка безопасно свяжет Telegram с вашим профилем Platforma.'}
        </p>
        {link && !account?.connected ? (
          <div className="training-telegram-link">
            <a href={link.deepLink} rel="noreferrer" target="_blank">
              Открыть одноразовую ссылку
            </a>
            <span>
              {Date.parse(link.expiresAt) <= Date.now()
                ? 'Срок ссылки истёк — создайте новую.'
                : `Действует до ${formatDateTime(link.expiresAt)}.`}
            </span>
          </div>
        ) : null}
        <div className="training-results-actions">
          {account?.connected ? (
            <AdminButton
              disabled={isPending}
              tone="text"
              onClick={onDisconnect}
            >
              <UnlinkIcon data-icon="inline-start" aria-hidden="true" />
              Отключить
            </AdminButton>
          ) : (
            <AdminButton disabled={isPending} onClick={onConnect}>
              <LinkIcon data-icon="inline-start" aria-hidden="true" />
              {link ? 'Создать новую ссылку' : 'Подключить Telegram'}
            </AdminButton>
          )}
        </div>
      </CardContent>
    </AdminPanel>
  );
}

function EmployeeProjectCard({
  project,
  isPending,
  onStart,
}: {
  project: TrainingEmployeeProjectSummary;
  isPending: boolean;
  onStart: () => void;
}) {
  return (
    <AdminPanel className="training-project-card">
      <CardHeader>
        <CardTitle>{project.title}</CardTitle>
        <AdminStatusBadge
          className={
            project.eligibility.canStart
              ? 'training-status--success'
              : 'training-status--neutral'
          }
        >
          {eligibilityLabels[project.eligibility.reason]}
        </AdminStatusBadge>
      </CardHeader>
      <CardContent>
        <p className="training-project-description">
          {project.description ?? 'Описание проекта не указано.'}
        </p>
        {project.object ? (
          <p className="training-project-note">
            Объект каталога: {project.object.title}
            {project.object.summary ? ` · ${project.object.summary}` : ''}
          </p>
        ) : null}
        <dl className="training-metric-grid">
          <div>
            <dt>Лучший балл</dt>
            <dd>{formatTrainingScore(project.bestScore)}</dd>
          </div>
          <div>
            <dt>Последний</dt>
            <dd>{formatTrainingScore(project.lastScore)}</dd>
          </div>
          <div>
            <dt>Проходной балл</dt>
            <dd>{project.passScore}</dd>
          </div>
          <div>
            <dt>Использовано попыток</dt>
            <dd>{project.attemptsUsed}</dd>
          </div>
          <div>
            <dt>Осталось попыток</dt>
            <dd>
              {project.attemptsLeft} из {project.attemptLimit}
            </dd>
          </div>
          <div>
            <dt>Лимит времени</dt>
            <dd>{formatTrainingDuration(project.totalTimeLimitSeconds)}</dd>
          </div>
          <div>
            <dt>Перерыв</dt>
            <dd>{formatTrainingDuration(project.cooldownMinutes * 60)}</dd>
          </div>
          <div>
            <dt>Пересдача после прохода</dt>
            <dd>{project.allowRetakeAfterPass ? 'Разрешена' : 'Запрещена'}</dd>
          </div>
          <div>
            <dt>Последний статус</dt>
            <dd>
              {project.lastAttemptStatus
                ? attemptStatusLabels[project.lastAttemptStatus]
                : 'Попыток не было'}
            </dd>
          </div>
          <div>
            <dt>Telegram</dt>
            <dd>{project.telegramConnected ? 'Подключён' : 'Не подключён'}</dd>
          </div>
        </dl>
        <p className="training-project-note">
          Окно: {formatDateTime(project.availableFrom) ?? 'без даты начала'} —{' '}
          {formatDateTime(project.deadlineAt) ?? 'без дедлайна'}
        </p>
        {project.activeAttempt ? (
          <p className="training-project-note">
            Активная попытка: {attemptStatusLabels[project.activeAttempt.status]}
            , завершить до {formatDateTime(project.activeAttempt.expiresAt)}
          </p>
        ) : null}
        {project.eligibility.retryAt ? (
          <p className="training-project-note">
            Доступно с{' '}
            {new Date(project.eligibility.retryAt).toLocaleString('ru-RU')}
          </p>
        ) : null}
        <AdminButton
          disabled={!project.eligibility.canStart || isPending}
          onClick={onStart}
        >
          {project.eligibility.reason === 'TELEGRAM_NOT_CONNECTED'
            ? 'Сначала подключите Telegram'
            : 'Перейти в Telegram'}
          <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
        </AdminButton>
      </CardContent>
    </AdminPanel>
  );
}

function AttemptHistory({
  attempts,
  pendingAction,
  onOpen,
}: {
  attempts: TrainingEmployeeAttemptListItem[];
  pendingAction: string | null;
  onOpen: (attemptId: string) => void;
}) {
  if (!attempts.length) {
    return (
      <AdminEmptyState
        title="Попыток пока нет"
        description="После начала аттестации здесь появится её состояние."
      />
    );
  }

  return (
    <div className="training-attempt-list">
      {attempts.map((attempt) => (
        <article className="training-attempt-row" key={attempt.id}>
          <div className="training-attempt-status-icon" aria-hidden="true">
            {attempt.passStatus === 'PASSED' ? (
              <CheckCircle2Icon />
            ) : (
              <Clock3Icon />
            )}
          </div>
          <div className="training-attempt-main">
            <strong>{attempt.project.title}</strong>
            <span>
              Попытка {attempt.attemptNumber} ·{' '}
              {new Date(attempt.startedAt).toLocaleString('ru-RU')}
            </span>
            <span>
              {formatTrainingDuration(attempt.totalDurationSeconds)} ·{' '}
              {attempt.isConsumed
                ? 'попытка использована'
                : 'попытка возвращена'}{' '}
              · {reviewStatusLabels[attempt.reviewStatus]}
            </span>
          </div>
          <div className="training-attempt-score">
            <strong>{formatTrainingScore(attempt.finalScore)}</strong>
            <span>{passStatusLabels[attempt.passStatus]}</span>
          </div>
          <AdminStatusBadge>
            {attemptStatusLabels[attempt.status]}
          </AdminStatusBadge>
          <AdminButton
            aria-label={`Открыть попытку ${attempt.attemptNumber}`}
            disabled={pendingAction === `attempt:${attempt.id}`}
            tone="text"
            onClick={() => onOpen(attempt.id)}
          >
            Разбор
          </AdminButton>
        </article>
      ))}
    </div>
  );
}

function EmployeeAttemptDetail({
  attempt,
  onClose,
}: {
  attempt: TrainingEmployeeAttemptDetail;
  onClose: () => void;
}) {
  return (
    <AdminPanel
      className="training-attempt-detail"
      aria-labelledby="employee-attempt-detail-title"
    >
      <CardHeader>
        <div>
          <p className="eyebrow">Собственный результат</p>
          <CardTitle id="employee-attempt-detail-title">
            {attempt.project.title} · попытка {attempt.attemptNumber}
          </CardTitle>
        </div>
        <AdminButton tone="text" onClick={onClose}>
          Закрыть
        </AdminButton>
      </CardHeader>
      <CardContent>
        <div className="training-detail-summary">
          <div>
            <span>Итог</span>
            <strong>{formatTrainingScore(attempt.finalScore)}</strong>
          </div>
          <div>
            <span>Статус</span>
            <strong>{passStatusLabels[attempt.passStatus]}</strong>
          </div>
          <div>
            <span>Проверка</span>
            <strong>{reviewStatusLabels[attempt.reviewStatus]}</strong>
          </div>
          <div>
            <span>Осталось попыток</span>
            <strong>{attempt.attemptsLeft}</strong>
          </div>
          <div>
            <span>Лучший результат</span>
            <strong>{formatTrainingScore(attempt.bestScore)}</strong>
          </div>
          <div>
            <span>Дата</span>
            <strong>
              {new Date(attempt.startedAt).toLocaleDateString('ru-RU')}
            </strong>
          </div>
          <div>
            <span>Продолжительность</span>
            <strong>
              {formatTrainingDuration(attempt.totalDurationSeconds)}
            </strong>
          </div>
          <div>
            <span>Учёт попытки</span>
            <strong>
              {attempt.isConsumed ? 'Использована' : 'Возвращена'}
            </strong>
          </div>
        </div>
        {attempt.breakdown ? (
          <div className="training-question-breakdown">
            {attempt.breakdown.map((question) => (
              <article key={question.id}>
                <header>
                  <div>
                    <span>Вопрос {question.sequence}</span>
                    <h4>{question.text}</h4>
                  </div>
                  <strong>{formatTrainingScore(question.score)}</strong>
                </header>
                {question.components.length ? (
                  <dl>
                    {question.components.map((component) => (
                      <div key={component.key}>
                        <dt>{component.title}</dt>
                        <dd>
                          {formatTrainingScore(component.awardedPoints)} /{' '}
                          {formatTrainingScore(component.maxPoints)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="training-breakdown-unavailable" role="status">
            {employeeBreakdownStatusLabels[attempt.breakdownStatus]}
          </p>
        )}
        <div className="training-privacy-note">
          <ShieldCheckIcon aria-hidden="true" />
          Здесь отображается только разрешённая разбивка. Аудио, transcript и
          технические ошибки доступны только проверяющим.
        </div>
      </CardContent>
    </AdminPanel>
  );
}


function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('ru-RU') : null;
}

function formatPolicyDate(value: string) {
  return new Date(value).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
