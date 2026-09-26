import type {
  AssistantAnswer,
  AssistantChatTurn,
  AssistantJob,
  AssistantLot,
  AssistantPlatformLot,
  AssistantTurnRating,
  AssistantWebLot,
} from '@platforma/shared';
import {
  MessageCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from 'lucide-react';
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { getAssistantConfig, getAssistantJob, rateAssistantTurn, startAssistantJob } from './assistantApi';
import './assistant.css';

type AssistantChatProps = {
  accessToken: string;
  logoUrl: string;
  pathname: string;
  userId: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: AssistantAnswer;
  rating?: AssistantTurnRating;
  ratingCommentSent?: boolean;
};

type AssistantGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type DragState = {
  pointerId: number;
  originX: number;
  originY: number;
  startLeft: number;
  startTop: number;
};

const mobileMediaQuery = '(max-width: 760px)';
const pollIntervalMs = 1_000;
const examplePrompts = [
  'Однушка до 20 млн в ЖК Веер 2',
  'Двушки у метро Шаболовская до 40 млн',
  'Что сейчас продаётся в Lion Gate?',
];

export function AssistantChat({ accessToken, logoUrl, pathname, userId }: AssistantChatProps) {
  const [enabled, setEnabled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => readMessages(userId));
  const [conversationId, setConversationId] = useState(() => readConversationId(userId));
  const [draft, setDraft] = useState('');
  const [runningSteps, setRunningSteps] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<AssistantGeometry>(() => readGeometry(userId));
  const chatRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const skipGeometryWriteRef = useRef(false);
  const isRunning = runningSteps !== null;

  useEffect(() => {
    const controller = new AbortController();
    void getAssistantConfig(accessToken, controller.signal)
      .then((config) => setEnabled(config.enabled === true))
      .catch(() => setEnabled(false));
    return () => controller.abort();
  }, [accessToken]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    writeMessages(userId, messages);
  }, [messages, userId]);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, runningSteps, error, isOpen]);

  useEffect(() => {
    if (!isOpen || isMobileViewport() || !chatRef.current) return;
    const chat = chatRef.current;
    const observer = new ResizeObserver(() => {
      const bounds = chat.getBoundingClientRect();
      setGeometry((current) => {
        const next = clampGeometry({ ...current, width: Math.round(bounds.width), height: Math.round(bounds.height) });
        return next.width === current.width && next.height === current.height ? current : next;
      });
    });
    observer.observe(chat);
    return () => observer.disconnect();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || isMobileViewport()) return;
    if (skipGeometryWriteRef.current) {
      skipGeometryWriteRef.current = false;
      return;
    }
    writeGeometry(userId, geometry);
  }, [geometry, isOpen, userId]);

  useEffect(() => {
    const handleResize = () => setGeometry((current) => clampGeometry(current));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (isOpen) window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [isOpen]);

  const ask = useCallback(async (history: ChatMessage[]) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    setRunningSteps(['Понимаю запрос']);
    try {
      let { job } = await startAssistantJob(accessToken, {
        messages: history.map(toChatTurn),
        pageObjectSlug: readPageObjectSlug(pathname),
        conversationId,
      }, controller.signal);
      while (job.status === 'RUNNING') {
        setRunningSteps(job.steps);
        await waitForPoll(controller.signal);
        job = (await getAssistantJob(accessToken, job.id, controller.signal)).job;
      }
      finishJob(job);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(readErrorMessage(requestError));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setRunningSteps(null);
      }
    }

    function finishJob(job: AssistantJob) {
      if (job.status === 'COMPLETED' && job.answer) {
        const answer = job.answer;
        setMessages((current) => [
          ...current,
          { id: job.id, role: 'assistant', content: answer.text, answer },
        ]);
        return;
      }
      setError(job.error ?? 'Не получилось выполнить поиск. Попробуйте ещё раз.');
    }
  }, [accessToken, conversationId, pathname]);

  const updateMessage = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    setMessages((current) => current.map((message) => (message.id === messageId ? { ...message, ...patch } : message)));
  }, []);

  const submit = (content: string) => {
    const text = content.trim();
    if (!text || isRunning) return;
    const next = [...messages, { id: createId(), role: 'user' as const, content: text }];
    setMessages(next);
    setDraft('');
    void ask(next);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(draft);
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(draft);
    }
  };

  const retry = () => {
    if (messages.at(-1)?.role === 'user') void ask(messages);
  };

  const startNewConversation = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setRunningSteps(null);
    setError(null);
    setMessages([]);
    setConversationId(writeNewConversationId(userId));
    composerRef.current?.focus();
  };

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (isMobileViewport() || event.button !== 0 || (event.target as Element).closest('button')) return;
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: geometry.left,
      startTop: geometry.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setGeometry(clampGeometry({
      ...geometry,
      left: drag.startLeft + event.clientX - drag.originX,
      top: drag.startTop + event.clientY - drag.originY,
    }));
  };

  const handleDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resetGeometry = () => {
    removeGeometry(userId);
    skipGeometryWriteRef.current = true;
    setGeometry(defaultGeometry());
  };

  if (!enabled) return null;

  if (!isOpen) {
    return (
      <button
        aria-label="Открыть ИИ-помощника"
        className="assistant-launcher"
        type="button"
        onClick={() => setIsOpen(true)}
      >
        <img src={logoUrl} alt="" aria-hidden="true" />
        <MessageCircleIcon aria-hidden="true" />
      </button>
    );
  }

  return (
    <section
      ref={chatRef}
      aria-label="ИИ-помощник по недвижимости"
      className="assistant-chat"
      data-assistant-chat
      role="dialog"
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
    >
      <header
        className="assistant-chat-header"
        data-assistant-drag-handle
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        <div className="assistant-chat-heading">
          <img src={logoUrl} alt="" aria-hidden="true" />
          <div>
            <strong>Помощник по недвижимости</strong>
            <span>Лоты в Platforma и на сайтах застройщиков</span>
          </div>
        </div>
        <div className="assistant-chat-controls">
          <button aria-label="Новый разговор" type="button" onClick={startNewConversation}>
            <PlusIcon aria-hidden="true" />
          </button>
          <button aria-label="Сбросить размер и положение" type="button" onClick={resetGeometry}>
            <RotateCcwIcon aria-hidden="true" />
          </button>
          <button aria-label="Закрыть помощника" type="button" onClick={() => setIsOpen(false)}>
            <XIcon aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="assistant-chat-layout">
        <div className="assistant-conversation">
          <div ref={messagesRef} className="assistant-messages" aria-live="polite">
            {messages.length === 0 && !isRunning ? (
              <div className="assistant-empty">
                <MessageCircleIcon aria-hidden="true" />
                <strong>Какой лот ищем?</strong>
                <p>Напишите ЖК, бюджет, комнатность, метро или район. Если в Platforma лотов нет, помощник поищет на сайтах застройщиков.</p>
                <div className="assistant-result-list">
                  {examplePrompts.map((prompt) => (
                    <button className="assistant-example" key={prompt} type="button" onClick={() => submit(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {messages.map((message) => (
              <AssistantMessageView
                key={message.id}
                accessToken={accessToken}
                message={message}
                onUpdate={updateMessage}
              />
            ))}
            {runningSteps ? (
              <div className="assistant-progress" role="status">
                <span aria-hidden="true" />
                {runningSteps.at(-1) ?? 'Понимаю запрос'}
              </div>
            ) : null}
          </div>

          <div className="assistant-composer-area">
            {error ? (
              <div className="assistant-error" role="alert">
                <p>{error}</p>
                {messages.at(-1)?.role === 'user' ? (
                  <button type="button" onClick={retry} disabled={isRunning}>Повторить</button>
                ) : null}
              </div>
            ) : null}
            <form className="assistant-composer" onSubmit={handleSubmit}>
              <label htmlFor="assistant-composer-input">Сообщение помощнику</label>
              <textarea
                ref={composerRef}
                id="assistant-composer-input"
                maxLength={2000}
                placeholder="Например: двушка до 30 млн в Сити Бэй"
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
              />
              <button aria-label="Отправить" disabled={isRunning || !draft.trim()} type="submit">
                <SendIcon aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}

function AssistantMessageView({
  accessToken,
  message,
  onUpdate,
}: {
  accessToken: string;
  message: ChatMessage;
  onUpdate: (messageId: string, patch: Partial<ChatMessage>) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="assistant-message assistant-message--user">
        <span>Вы</span>
        <p>{message.content}</p>
      </div>
    );
  }
  const answer = message.answer;
  // Answers saved in the session before sources existed have none.
  const sources = answer?.sources ?? [];
  return (
    <div className="assistant-message assistant-message--results">
      <span>Помощник</span>
      <p>{message.content}</p>
      {answer && answer.lots.length > 0 ? (
        <div className="assistant-results">
          <div className="assistant-result-list">
            {answer.lots.map((lot) => (lot.source === 'PLATFORMA'
              ? <PlatformLotCard key={lot.unitId} lot={lot} />
              : <WebLotCard key={`${lot.url}:${lot.projectTitle}:${lot.priceRub}:${lot.areaM2}:${lot.floor}`} lot={lot} />))}
          </div>
        </div>
      ) : null}
      {sources.length > 0 ? (
        <ul className="assistant-sources" aria-label="Источники">
          {sources.map((source) => (
            <li key={`${source.kind}:${source.url}`}>
              <a
                className="assistant-source"
                href={source.url}
                title={source.title}
                {...(source.kind === 'WEB' ? { rel: 'noopener noreferrer', target: '_blank' } : {})}
              >
                <span className="assistant-source-label">
                  {source.kind === 'WEB' ? hostOf(source.url) : `Platforma · ${shortProjectTitle(source.title)}`}
                </span>
                <span className="assistant-source-date">{formatShortDate(source.date)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {answer?.turnId ? (
        <AnswerFeedback accessToken={accessToken} message={message} turnId={answer.turnId} onUpdate={onUpdate} />
      ) : null}
    </div>
  );
}

function AnswerFeedback({
  accessToken,
  message,
  turnId,
  onUpdate,
}: {
  accessToken: string;
  message: ChatMessage;
  turnId: string;
  onUpdate: (messageId: string, patch: Partial<ChatMessage>) => void;
}) {
  const [comment, setComment] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (rating: AssistantTurnRating, text: string | null) => {
    if (isSending) return;
    setIsSending(true);
    setError(null);
    try {
      await rateAssistantTurn(accessToken, turnId, { rating, comment: text });
      onUpdate(message.id, { rating, ratingCommentSent: Boolean(text) });
    } catch {
      setError('Не удалось отправить оценку');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="assistant-feedback">
      <div className="assistant-feedback-buttons" role="group" aria-label="Оценка ответа">
        <button
          aria-label="Хороший ответ"
          aria-pressed={message.rating === 'UP'}
          disabled={isSending}
          type="button"
          onClick={() => void send('UP', null)}
        >
          <ThumbsUpIcon aria-hidden="true" />
        </button>
        <button
          aria-label="Плохой ответ"
          aria-pressed={message.rating === 'DOWN'}
          disabled={isSending}
          type="button"
          onClick={() => void send('DOWN', null)}
        >
          <ThumbsDownIcon aria-hidden="true" />
        </button>
        {message.ratingCommentSent ? <span>Спасибо, передали</span> : null}
      </div>
      {message.rating === 'DOWN' && !message.ratingCommentSent ? (
        <form
          className="assistant-feedback-comment"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) void send('DOWN', comment.trim());
          }}
        >
          <label htmlFor={`assistant-feedback-${message.id}`}>Что не так? (необязательно)</label>
          <textarea
            id={`assistant-feedback-${message.id}`}
            maxLength={1000}
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button disabled={isSending || !comment.trim()} type="submit">Отправить</button>
        </form>
      ) : null}
      {error ? <p className="assistant-feedback-error" role="alert">{error}</p> : null}
    </div>
  );
}

function PlatformLotCard({ lot }: { lot: AssistantPlatformLot }) {
  const facts = [
    lot.propertyClass,
    lot.finishing,
    lot.pricePerM2Rub ? `${formatRub(lot.pricePerM2Rub)}/м²` : null,
    lot.completion ? `сдача ${lot.completion}` : null,
    lot.developer,
  ].filter(Boolean);
  return (
    <section className="assistant-result-card" aria-label={`${lot.projectTitle}, ${formatRub(lot.priceRub)}`}>
      <a className="assistant-result-title" href={lot.href}>{lot.projectTitle}</a>
      <p className="assistant-result-subtitle">{describeLot(lot)}</p>
      <strong className="assistant-result-price">{formatRub(lot.priceRub)}</strong>
      <div className="assistant-result-status">
        <span>В Platforma</span>
        <span className="assistant-result-freshness">обновлено {formatUpdatedAt(lot.updatedAt)}</span>
      </div>
      {facts.length > 0 ? (
        <ul className="assistant-result-facts">
          {facts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

function WebLotCard({ lot }: { lot: AssistantWebLot }) {
  return (
    <section className="assistant-result-card" aria-label={`${lot.projectTitle}, ${lot.siteName}`}>
      <a className="assistant-result-title" href={lot.url} rel="noopener noreferrer" target="_blank">
        {lot.projectTitle}
      </a>
      <p className="assistant-result-subtitle">{describeLot(lot)}</p>
      <strong className="assistant-result-price">
        {lot.priceRub === null ? 'Цену уточните на сайте' : formatRub(lot.priceRub)}
      </strong>
      <div className="assistant-result-status">
        <span className="assistant-result-source">С сайта {lot.siteName}</span>
        <span className="assistant-result-freshness">данные не из Platforma, проверьте у застройщика</span>
      </div>
    </section>
  );
}

function describeLot(lot: AssistantLot) {
  const parts = [
    lot.rooms === null ? null : lot.rooms === 0 ? 'студия' : `${lot.rooms}-комн.`,
    lot.areaM2 === null ? null : `${formatNumber(lot.areaM2)} м²`,
    lot.floor === null ? null : `${lot.floor} этаж`,
    lot.source === 'PLATFORMA' ? (lot.building ? `корпус ${lot.building}` : null) : lot.description,
  ].filter(Boolean);
  return parts.join(' · ') || 'Параметры уточните по ссылке';
}

function toChatTurn(message: ChatMessage): AssistantChatTurn {
  return {
    role: message.role,
    content: message.role === 'assistant' ? message.answer?.historyNote ?? message.content : message.content,
  };
}

function readPageObjectSlug(pathname: string) {
  const match = pathname.match(/^\/objects\/([^/]+)/u);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function formatRub(value: number) {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function formatNumber(value: number) {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function formatShortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function shortProjectTitle(title: string) {
  return title.replace(/^Жилой комплекс\s+/u, 'ЖК ');
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url;
  }
}

function formatUpdatedAt(value: string) {
  const hours = (Date.now() - new Date(value).getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return 'недавно';
  if (hours < 1) return 'менее часа назад';
  if (hours < 24) return `${Math.floor(hours)} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

function readErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('ASSISTANT_JOB_ALREADY_RUNNING')) return 'Предыдущий запрос ещё выполняется. Дождитесь ответа.';
  if (message.includes('ASSISTANT_LLM_NOT_CONFIGURED')) return 'Нейросеть не настроена на сервере.';
  if (message.includes('ASSISTANT_JOB_NOT_FOUND')) return 'Сервер перезапустился во время поиска. Повторите запрос.';
  return message || 'Не удалось выполнить запрос';
}

function createId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function messagesKey(userId: string) {
  return `platforma-assistant-messages:${userId}`;
}

function readMessages(userId: string): ChatMessage[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(messagesKey(userId)) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is ChatMessage => Boolean(item)
        && typeof item === 'object'
        && typeof (item as ChatMessage).id === 'string'
        && ((item as ChatMessage).role === 'user' || (item as ChatMessage).role === 'assistant')
        && typeof (item as ChatMessage).content === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeMessages(userId: string, messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(messagesKey(userId), JSON.stringify(messages.slice(-40)));
  } catch {
    // The conversation stays in memory when browser storage is unavailable.
  }
}

function conversationKey(userId: string) {
  return `platforma-assistant-conversation:${userId}`;
}

// The id groups this tab's turns in the admin log; it lives as long as the chat history does.
function readConversationId(userId: string) {
  try {
    return sessionStorage.getItem(conversationKey(userId)) ?? writeNewConversationId(userId);
  } catch {
    return createId();
  }
}

function writeNewConversationId(userId: string) {
  const id = createId();
  try {
    sessionStorage.setItem(conversationKey(userId), id);
  } catch {
    // Without storage every reload starts a new conversation id.
  }
  return id;
}

function geometryKey(userId: string) {
  return `platforma-assistant-geometry:${userId}`;
}

function readGeometry(userId: string) {
  try {
    const raw = localStorage.getItem(geometryKey(userId));
    if (!raw) return defaultGeometry();
    const value = JSON.parse(raw) as Partial<AssistantGeometry>;
    if (
      !Number.isFinite(value.left) ||
      !Number.isFinite(value.top) ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height)
    ) return defaultGeometry();
    return clampGeometry(value as AssistantGeometry);
  } catch {
    return defaultGeometry();
  }
}

function writeGeometry(userId: string, geometry: AssistantGeometry) {
  try {
    localStorage.setItem(geometryKey(userId), JSON.stringify(geometry));
  } catch {
    // The chat remains usable when browser storage is unavailable.
  }
}

function removeGeometry(userId: string) {
  try {
    localStorage.removeItem(geometryKey(userId));
  } catch {
    // The reset still applies to the current session.
  }
}

function defaultGeometry(): AssistantGeometry {
  const width = Math.min(460, Math.max(360, window.innerWidth - 32));
  const height = Math.min(680, Math.max(480, window.innerHeight - 48));
  return clampGeometry({
    left: window.innerWidth - width - 24,
    top: window.innerHeight - height - 24,
    width,
    height,
  });
}

function clampGeometry(value: AssistantGeometry): AssistantGeometry {
  const margin = 12;
  const width = Math.min(Math.max(360, value.width), Math.max(360, window.innerWidth - margin * 2));
  const height = Math.min(Math.max(480, value.height), Math.max(480, window.innerHeight - margin * 2));
  return {
    left: Math.min(Math.max(margin, value.left), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(margin, value.top), Math.max(margin, window.innerHeight - height - margin)),
    width,
    height,
  };
}

function isMobileViewport() {
  return window.matchMedia(mobileMediaQuery).matches;
}

function waitForPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, pollIntervalMs);
    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}
