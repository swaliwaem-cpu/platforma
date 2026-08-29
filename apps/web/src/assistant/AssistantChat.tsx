import type {
  AssistantAnswer,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantFeedback,
  AssistantFeedbackRating,
  AssistantFeedbackReason,
  AssistantExternalLotCard,
  AssistantGeoCandidate,
  AssistantGeoBrowserConstraint,
  AssistantGeoBrowserInput,
  AssistantGeoResolution,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
  AssistantKnowledgeFactCard,
  AssistantMessage,
  AssistantPageContext,
  AssistantRun,
  AssistantSearchResultCard,
  AssistantSendMessageInput,
} from '@platforma/shared';
import { mapAssistantProductSubmission } from '@platforma/shared/assistant-product-submission';
import {
  Clock3Icon,
  MessageCircleIcon,
  MapPinIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from 'lucide-react';
import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';

import {
  createAssistantConversation,
  getAssistantConfig,
  getAssistantConversation,
  getAssistantRun,
  listAssistantConversations,
  resolveAssistantGeo,
  saveAssistantFeedback,
  sendAssistantMessage,
} from './assistantApi';
import { AssistantGeoPicker } from './AssistantGeoPicker';
import { AssistantGeoResultMap, formatDistance } from './AssistantGeoResultMap';
import { appLocationChangeEventName } from '../navigation/appLocation';
import './assistant.css';

type AssistantChatProps = {
  accessToken: string;
  logoUrl: string;
  pathname: string;
  search: string;
  userId: string;
};

type AssistantGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PendingSubmission = {
  content: string;
  context: AssistantPageContext | null;
  geo: AssistantGeoBrowserInput | null;
  conversationId: string | null;
  idempotencyKey: string;
};

type PendingGeoSubmission = {
  content: string;
};

type GeoPickerTarget =
  | { kind: 'NEW' }
  | { kind: 'PENDING_SINGLE' }
  | { kind: 'PENDING_SLOT'; slotId: string }
  | { kind: 'ACTIVE_CONSTRAINT'; index: number };

type DragState = {
  pointerId: number;
  originX: number;
  originY: number;
  startLeft: number;
  startTop: number;
};

const mobileMediaQuery = '(max-width: 760px)';
const pollIntervalMs = 180;
const duplicateGeoConstraintError = 'Выберите разные ориентиры или разные радиусы для одинаковой точки.';

export function AssistantChat({ accessToken, logoUrl, pathname, search, userId }: AssistantChatProps) {
  const [enabled, setEnabled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AssistantConversationSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AssistantConversation | null>(null);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [failedConversationId, setFailedConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pageContext, setPageContext] = useState<AssistantPageContext | null>(null);
  const [activeGeo, setActiveGeo] = useState<AssistantGeoSearchSelection | null>(null);
  const [geoPickerTarget, setGeoPickerTarget] = useState<GeoPickerTarget | null>(null);
  const [geoResolution, setGeoResolution] = useState<AssistantGeoResolution | null>(null);
  const [pendingGeoSelections, setPendingGeoSelections] = useState<Record<string, AssistantGeoSearchContext>>({});
  const [pendingGeoSubmission, setPendingGeoSubmission] = useState<PendingGeoSubmission | null>(null);
  const [isResolvingGeo, setIsResolvingGeo] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AssistantRun | null>(null);
  const [optimisticContent, setOptimisticContent] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<AssistantGeometry>(() => readGeometry(userId));
  const isGeoPickerOpen = geoPickerTarget !== null;
  const chatRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const conversationRequestRef = useRef<AbortController | null>(null);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyRequestVersionRef = useRef(0);
  const sendRequestRef = useRef<AbortController | null>(null);
  const geoResolveRequestRef = useRef<AbortController | null>(null);
  const completionRequestRef = useRef<AbortController | null>(null);
  const activeOperationVersionRef = useRef(0);
  const skipGeometryWriteRef = useRef(false);

  const invalidateActiveOperation = useCallback(() => {
    activeOperationVersionRef.current += 1;
    sendRequestRef.current?.abort();
    geoResolveRequestRef.current?.abort();
    completionRequestRef.current?.abort();
    conversationRequestRef.current?.abort();
    historyRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void getAssistantConfig(accessToken, controller.signal)
      .then((config) => setEnabled(config.enabled === true))
      .catch(() => setEnabled(false));

    return () => controller.abort();
  }, [accessToken]);

  const loadHistory = useCallback(async (cursor: string | null, signal?: AbortSignal) => {
    historyRequestRef.current?.abort();
    historyRequestVersionRef.current += 1;
    const requestVersion = historyRequestVersionRef.current;
    const controller = new AbortController();
    const handleParentAbort = () => controller.abort();
    historyRequestRef.current = controller;
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', handleParentAbort, { once: true });
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await listAssistantConversations(accessToken, cursor, controller.signal);
      if (historyRequestVersionRef.current !== requestVersion) return;
      setConversations((current) => cursor
        ? mergeConversationHistory(current, response.items)
        : response.items);
      setHistoryCursor(response.nextCursor);
    } catch (loadError) {
      if (!controller.signal.aborted && historyRequestVersionRef.current === requestVersion) {
        setHistoryError(readErrorMessage(loadError));
      }
    } finally {
      signal?.removeEventListener('abort', handleParentAbort);
      if (historyRequestVersionRef.current === requestVersion) {
        historyRequestRef.current = null;
        setIsHistoryLoading(false);
      }
    }
  }, [accessToken]);

  const refreshHistory = useCallback(
    (signal?: AbortSignal) => loadHistory(null, signal),
    [loadHistory],
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refreshHistory(controller.signal);
    return () => controller.abort();
  }, [enabled, refreshHistory]);

  useEffect(() => {
    setGeometry(readGeometry(userId));
  }, [userId]);

  useEffect(() => {
    if (!isOpen) return;
    const updateContext = () => {
      setPageContext(resolvePageContext(window.location.pathname, window.location.search));
    };
    updateContext();
    window.addEventListener(appLocationChangeEventName, updateContext);
    return () => window.removeEventListener(appLocationChangeEventName, updateContext);
  }, [isOpen, pathname, search]);

  useEffect(() => {
    if (!isOpen) return;
    const frameId = window.requestAnimationFrame(() => composerRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isGeoPickerOpen) {
        if (geoPickerTarget?.kind !== 'PENDING_SLOT'
          && (geoPickerTarget?.kind === 'ACTIVE_CONSTRAINT' || draft.trim().length > 0)) {
          setPendingGeoSubmission(null);
        }
        setGeoPickerTarget(null);
        return;
      }
      setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [draft, geoPickerTarget, isGeoPickerOpen, isOpen]);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [activeRun, conversation?.messages, optimisticContent]);

  useEffect(() => {
    if (!isOpen || isMobileViewport() || !chatRef.current) return;
    const chat = chatRef.current;
    const observer = new ResizeObserver(() => {
      const bounds = chat.getBoundingClientRect();
      setGeometry((current) => {
        const next = clampGeometry({
          ...current,
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        });
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

  useEffect(() => () => invalidateActiveOperation(), [invalidateActiveOperation]);

  const finishRun = useCallback(async (run: AssistantRun, operationVersion: number) => {
    if (activeOperationVersionRef.current !== operationVersion) return;
    setActiveRun(run);
    if (run.status === 'FAILED') {
      setError(run.errorCode ?? 'Не удалось сформировать ответ');
      setIsSending(false);
      return;
    }
    if (run.status !== 'COMPLETED') return;

    completionRequestRef.current?.abort();
    const controller = new AbortController();
    completionRequestRef.current = controller;
    const detail = await getAssistantConversation(accessToken, run.conversationId, controller.signal);
    if (activeOperationVersionRef.current !== operationVersion) return;
    setConversation(detail.conversation);
    setOptimisticContent(null);
    setIsSending(false);
    setGeoResolution(null);
    setPendingGeoSubmission(null);
    setPendingGeoSelections({});
    setGeoPickerTarget(null);
    setGeoError(null);
    pendingSubmissionRef.current = null;
    await refreshHistory(controller.signal);
  }, [accessToken, refreshHistory]);

  useEffect(() => {
    if (!activeRun || activeRun.status === 'COMPLETED' || activeRun.status === 'FAILED') return;
    const controller = new AbortController();
    const operationVersion = activeOperationVersionRef.current;

    void (async () => {
      try {
        while (!controller.signal.aborted) {
          await waitForPoll(controller.signal);
          const response = await getAssistantRun(accessToken, activeRun.id, controller.signal);
          if (response.run.status === 'COMPLETED' || response.run.status === 'FAILED') {
            await finishRun(response.run, operationVersion);
            return;
          }
          if (activeOperationVersionRef.current !== operationVersion) return;
          setActiveRun(response.run);
        }
      } catch (pollError) {
        if (controller.signal.aborted || activeOperationVersionRef.current !== operationVersion) return;
        setError(readErrorMessage(pollError));
        setIsSending(false);
      }
    })();

    return () => controller.abort();
  }, [accessToken, activeRun?.id, activeRun?.status, finishRun]);

  const loadConversation = useCallback(async (conversationId: string) => {
    invalidateActiveOperation();
    const operationVersion = activeOperationVersionRef.current;
    const controller = new AbortController();
    conversationRequestRef.current = controller;
    setError(null);
    setFailedConversationId(null);
    setIsConversationLoading(true);
    setConversation(null);
    setActiveRun(null);
    setActiveGeo(null);
    setOptimisticContent(null);
    setIsSending(false);
    setIsResolvingGeo(false);
    setGeoResolution(null);
    setPendingGeoSubmission(null);
    setPendingGeoSelections({});
    setGeoPickerTarget(null);
    setGeoError(null);
    pendingSubmissionRef.current = null;

    try {
      const response = await getAssistantConversation(accessToken, conversationId, controller.signal);
      if (activeOperationVersionRef.current !== operationVersion) return;
      setConversation(response.conversation);
      setActiveGeo(readLatestGeoContext(response.conversation.messages));
      setIsHistoryOpen(false);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(readErrorMessage(loadError));
        setFailedConversationId(conversationId);
      }
    } finally {
      if (!controller.signal.aborted && activeOperationVersionRef.current === operationVersion) {
        setIsConversationLoading(false);
      }
    }
  }, [accessToken, invalidateActiveOperation]);

  const sendPendingSubmission = useCallback(async (submission: PendingSubmission) => {
    sendRequestRef.current?.abort();
    activeOperationVersionRef.current += 1;
    const operationVersion = activeOperationVersionRef.current;
    const controller = new AbortController();
    sendRequestRef.current = controller;
    setError(null);
    setIsSending(true);
    setOptimisticContent(submission.content);

    try {
      let conversationId = submission.conversationId;
      if (!conversationId) {
        const created = await createAssistantConversation(
          accessToken,
          submission.idempotencyKey,
          controller.signal,
        );
        if (activeOperationVersionRef.current !== operationVersion) return;
        conversationId = created.conversation.id;
        setConversation(created.conversation);
        submission = { ...submission, conversationId };
        pendingSubmissionRef.current = submission;
      }

      const response = await sendAssistantMessage({
        accessToken,
        conversationId,
        idempotencyKey: submission.idempotencyKey,
        message: {
          content: submission.content,
          context: submission.context,
          geo: submission.geo,
        },
        signal: controller.signal,
      });
      if (activeOperationVersionRef.current !== operationVersion) return;
      setActiveRun(response.run);
      if (response.run.status === 'COMPLETED' || response.run.status === 'FAILED') {
        await finishRun(response.run, operationVersion);
      }
    } catch (sendError) {
      if (controller.signal.aborted || activeOperationVersionRef.current !== operationVersion) return;
      setError(readErrorMessage(sendError));
      setIsSending(false);
    }
  }, [accessToken, finishRun]);

  const beginSubmission = useCallback((body: AssistantSendMessageInput) => {
    const submission: PendingSubmission = {
      content: body.content,
      context: pageContext,
      geo: body.geo ?? null,
      conversationId: conversation?.id ?? null,
      idempotencyKey: crypto.randomUUID(),
    };
    pendingSubmissionRef.current = submission;
    setDraft('');
    setGeoResolution(null);
    setPendingGeoSubmission(null);
    setPendingGeoSelections({});
    setGeoError(null);
    void sendPendingSubmission(submission);
  }, [conversation?.id, pageContext, sendPendingSubmission]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSending || isResolvingGeo || isConversationLoading) return;
    geoResolveRequestRef.current?.abort();
    const controller = new AbortController();
    geoResolveRequestRef.current = controller;
    setIsResolvingGeo(true);
    setGeoError(null);
    setGeoResolution(null);
    setPendingGeoSubmission({ content });
    void resolveAssistantGeo(accessToken, { content, locale: 'ru', country: null }, controller.signal)
      .then((resolution) => {
        if (controller.signal.aborted) return;
        const productDecision = mapAssistantProductSubmission(
          content,
          resolution,
          activeGeo ? geoToBrowserInput(activeGeo) : null,
        );
        if (resolution.status === 'NOT_APPLICABLE' && productDecision.status === 'READY') {
          beginSubmission(productDecision.body);
          return;
        }
        if (resolution.status === 'RESOLVED' && productDecision.status === 'READY') {
          const candidate = resolution.candidates[0];
          if (candidate) {
            const geo = candidateToGeo(candidate, resolution);
            setActiveGeo(geo);
            beginSubmission(productDecision.body);
            return;
          }
        }
        if (resolution.status === 'COMPOSITE') {
          const selections = Object.fromEntries(resolution.constraints.flatMap((constraint) => {
            const candidate = constraint.status === 'RESOLVED' ? constraint.candidates[0] : null;
            return candidate ? [[constraint.slotId, candidateToGeo(candidate, constraint)]] : [];
          }));
          if (hasDuplicateGeoConstraints(Object.values(selections))) {
            setPendingGeoSelections(selections);
            setGeoError(duplicateGeoConstraintError);
            setDraft('');
            setGeoResolution(resolution);
            return;
          }
          const geo = completeCompositeGeo(resolution, selections);
          if (geo && productDecision.status === 'READY') {
            setActiveGeo(geo);
            beginSubmission(productDecision.body);
            return;
          }
          setPendingGeoSelections(selections);
        }
        setDraft('');
        setGeoResolution(resolution);
      })
      .catch((resolveError) => {
        if (controller.signal.aborted) return;
        setDraft('');
        setGeoError(readErrorMessage(resolveError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsResolvingGeo(false);
      });
  };

  const handleCandidateSelect = (candidate: AssistantGeoCandidate, slotId?: string) => {
    if (!pendingGeoSubmission || !geoResolution || geoResolution.status === 'NOT_APPLICABLE') return;
    const metadata = geoResolution.status === 'COMPOSITE'
      ? geoResolution.constraints.find((constraint) => constraint.slotId === slotId)
      : geoResolution;
    const geo = candidateToGeo(candidate, metadata ?? undefined);
    if (geoResolution.status === 'COMPOSITE') {
      if (!slotId || !geoResolution.constraints.some((constraint) => constraint.slotId === slotId)) return;
      const selections = { ...pendingGeoSelections, [slotId]: geo };
      if (hasDuplicateGeoConstraints(Object.values(selections))) {
        setGeoError(duplicateGeoConstraintError);
        return;
      }
      const complete = completeCompositeGeo(geoResolution, selections);
      setGeoError(null);
      setPendingGeoSelections(selections);
      if (complete) {
        setActiveGeo(complete);
        beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, complete));
      }
      return;
    }
    if (geoResolution.status !== 'AMBIGUOUS' && geoResolution.status !== 'RESOLVED') return;
    setActiveGeo(geo);
    beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, geo));
  };

  const handleGeoPickerConfirm = (geo: AssistantGeoSearchContext) => {
    const target = geoPickerTarget;
    setGeoPickerTarget(null);
    if (target?.kind === 'PENDING_SLOT' && geoResolution?.status === 'COMPOSITE') {
      const slot = geoResolution.constraints.find(({ slotId }) => slotId === target.slotId);
      if (!slot || slot.mode !== 'NEAR') return;
      const labelledGeo = withGeoSlotMetadata(labelManualGeoConstraint(geo, slot.sourceText), slot);
      const selections = { ...pendingGeoSelections, [target.slotId]: labelledGeo };
      if (hasDuplicateGeoConstraints(Object.values(selections))) {
        setGeoError(duplicateGeoConstraintError);
        return;
      }
      const complete = completeCompositeGeo(geoResolution, selections);
      setGeoError(null);
      setPendingGeoSelections(selections);
      if (complete && pendingGeoSubmission) {
        setActiveGeo(complete);
        beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, complete));
      }
      return;
    }
    if (target?.kind === 'PENDING_SINGLE' && geoResolution && geoResolution.status !== 'COMPOSITE'
      && geoResolution.status !== 'NOT_APPLICABLE' && pendingGeoSubmission) {
      if (geoResolution.mode !== 'NEAR') return;
      const confirmed = withGeoSlotMetadata(
        labelManualGeoConstraint(geo, geoResolution.sourceText ?? geoResolution.placeQuery),
        geoResolution,
      );
      setActiveGeo(confirmed);
      beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, confirmed));
      return;
    }
    if (target?.kind === 'ACTIVE_CONSTRAINT' && activeGeo) {
      const current = geoConstraints(activeGeo)[target.index];
      if (!current || current.mode !== 'NEAR') return;
      const replacement = withGeoSlotMetadata(
        'operator' in activeGeo ? labelManualGeoConstraint(geo, current.label) : geo,
        current,
      );
      const next = replaceGeoConstraint(activeGeo, target.index, replacement);
      if (hasDuplicateGeoConstraints(geoConstraints(next))) {
        setGeoError(duplicateGeoConstraintError);
        setPendingGeoSubmission(null);
        return;
      }
      setGeoError(null);
      setActiveGeo(next);
      if (pendingGeoSubmission) {
        beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, next));
      }
      return;
    }
    setActiveGeo(geo);
    if (pendingGeoSubmission) {
      beginSubmission(confirmedGeoSubmission(pendingGeoSubmission.content, geo));
    }
  };

  const handleGeoPickerCancel = () => {
    if (geoPickerTarget?.kind !== 'PENDING_SLOT'
      && (geoPickerTarget?.kind === 'ACTIVE_CONSTRAINT' || draft.trim().length > 0)) {
      setPendingGeoSubmission(null);
    }
    setGeoPickerTarget(null);
  };

  const handleGeoRefine = () => {
    if (pendingGeoSubmission) setDraft(pendingGeoSubmission.content);
    setGeoResolution(null);
    setPendingGeoSubmission(null);
    setPendingGeoSelections({});
    setGeoError(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleGeoSelectionClear = (slotId: string) => {
    const selections = Object.fromEntries(
      Object.entries(pendingGeoSelections).filter(([currentSlotId]) => currentSlotId !== slotId),
    );
    setPendingGeoSelections(selections);
    setGeoError(hasDuplicateGeoConstraints(Object.values(selections))
      ? duplicateGeoConstraintError
      : null);
  };

  const handleRetry = () => {
    const submission = pendingSubmissionRef.current;
    if (submission && !isSending) void sendPendingSubmission(submission);
  };

  const handleNewConversation = () => {
    invalidateActiveOperation();
    setConversation(null);
    setActiveRun(null);
    setOptimisticContent(null);
    setError(null);
    setFailedConversationId(null);
    setIsConversationLoading(false);
    setIsResolvingGeo(false);
    setIsSending(false);
    setIsHistoryOpen(false);
    setActiveGeo(null);
    setGeoResolution(null);
    setPendingGeoSubmission(null);
    setPendingGeoSelections({});
    setGeoError(null);
    setGeoPickerTarget(null);
    pendingSubmissionRef.current = null;
    window.requestAnimationFrame(() => composerRef.current?.focus());
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

  const openGeoPicker = (slotId?: string) => {
    if (slotId && geoResolution?.status === 'COMPOSITE'
      && geoResolution.constraints.find((constraint) => constraint.slotId === slotId)?.mode !== 'NEAR') return;
    if (!slotId && pendingGeoSubmission && geoResolution && geoResolution.status !== 'COMPOSITE'
      && geoResolution.status !== 'NOT_APPLICABLE' && geoResolution.mode !== 'NEAR') return;
    if (!slotId) {
      const content = draft.trim();
      if (content) setPendingGeoSubmission({ content });
    }
    if (!isMobileViewport()) {
      setGeometry((current) => clampGeometry({
        ...current,
        width: Math.max(current.width, Math.min(760, window.innerWidth - 48)),
        height: Math.max(current.height, Math.min(760, window.innerHeight - 48)),
      }));
    }
    setGeoPickerTarget(slotId
      ? { kind: 'PENDING_SLOT', slotId }
      : pendingGeoSubmission && geoResolution && geoResolution.status !== 'COMPOSITE'
        && geoResolution.status !== 'NOT_APPLICABLE'
        ? { kind: 'PENDING_SINGLE' }
        : { kind: 'NEW' });
  };

  const editGeoPicker = (index: number) => {
    if (activeGeo && geoConstraints(activeGeo)[index]?.mode !== 'NEAR') return;
    const content = draft.trim() || readLatestUserContent(conversation?.messages ?? []);
    if (content) setPendingGeoSubmission({ content });
    if (!isMobileViewport()) {
      setGeometry((current) => clampGeometry({
        ...current,
        width: Math.max(current.width, Math.min(760, window.innerWidth - 48)),
        height: Math.max(current.height, Math.min(760, window.innerHeight - 48)),
      }));
    }
    setGeoPickerTarget({ kind: 'ACTIVE_CONSTRAINT', index });
  };

  const latestProgress = activeRun?.status === 'RUNNING' || activeRun?.status === 'PENDING'
    ? activeRun.progressEvents.at(-1) ?? null
    : null;
  const progressLabel = latestProgress?.label
    ?? (isSending && activeRun?.status === 'PENDING' ? 'Понимаю запрос' : null);
  const renderedMessages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const handleFeedbackSaved = useCallback((messageId: string, feedback: AssistantFeedback) => {
    setConversation((current) => current ? {
      ...current,
      messages: current.messages.map((message) => message.id === messageId
        ? { ...message, feedback }
        : message),
    } : current);
  }, []);

  if (!enabled) return null;

  return (
    <>
      {!isOpen ? (
        <button
          aria-label="Открыть ИИ-помощника"
          className="assistant-launcher"
          type="button"
          onClick={() => setIsOpen(true)}
        >
          <img src={logoUrl} alt="" aria-hidden="true" />
          <MessageCircleIcon aria-hidden="true" />
        </button>
      ) : (
        <section
          ref={chatRef}
          aria-label="ИИ-помощник по недвижимости"
          className="assistant-chat"
          data-assistant-chat
          role="dialog"
          style={{
            left: geometry.left,
            top: geometry.top,
            width: geometry.width,
            height: geometry.height,
          }}
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
                <span>Тестовый поиск Platforma</span>
              </div>
            </div>
            <div className="assistant-chat-controls">
              <button
                aria-label="История разговоров"
                aria-pressed={isHistoryOpen}
                type="button"
                onClick={() => setIsHistoryOpen((current) => !current)}
              >
                <Clock3Icon aria-hidden="true" />
              </button>
              <button aria-label="Сбросить размер и положение" type="button" onClick={resetGeometry}>
                <RotateCcwIcon aria-hidden="true" />
              </button>
              <button aria-label="Закрыть помощника" type="button" onClick={() => setIsOpen(false)}>
                <XIcon aria-hidden="true" />
              </button>
            </div>
          </header>

          {isGeoPickerOpen ? (
            <AssistantGeoPicker
              initialGeo={geoPickerTarget?.kind === 'ACTIVE_CONSTRAINT' && activeGeo
                ? geoConstraints(activeGeo)[geoPickerTarget.index] ?? null
                : geoPickerTarget?.kind === 'PENDING_SLOT'
                  ? pendingGeoSelections[geoPickerTarget.slotId] ?? null
                  : null}
              initialDistanceMeters={readPendingGeoDistance(geoPickerTarget, geoResolution)}
              onCancel={handleGeoPickerCancel}
              onConfirm={handleGeoPickerConfirm}
            />
          ) : (
          <div className={isHistoryOpen ? 'assistant-chat-layout assistant-chat-layout--history' : 'assistant-chat-layout'}>
            {isHistoryOpen ? (
              <aside className="assistant-history" aria-label="История разговоров">
                <button className="assistant-history-new" type="button" onClick={handleNewConversation}>
                  <PlusIcon aria-hidden="true" />
                  Новый разговор
                </button>
                <div className="assistant-history-list">
                  {isHistoryLoading && conversations.length === 0 ? (
                    <p role="status">Загружаю историю</p>
                  ) : historyError && conversations.length === 0 ? (
                    <div className="assistant-history-error" role="alert">
                      <p>{historyError}</p>
                      <button type="button" onClick={() => void refreshHistory()}>
                        Повторить загрузку истории
                      </button>
                    </div>
                  ) : conversations.length === 0 ? (
                    <p>За последние 30 дней разговоров нет.</p>
                  ) : conversations.map((item) => (
                    <button
                      className={item.id === conversation?.id ? 'assistant-history-item assistant-history-item--active' : 'assistant-history-item'}
                      key={item.id}
                      type="button"
                      onClick={() => void loadConversation(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>{formatConversationDate(item.updatedAt)}</span>
                    </button>
                  ))}
                  {historyError && conversations.length > 0 ? (
                    <div className="assistant-history-error" role="alert">
                      <p>{historyError}</p>
                      <button type="button" onClick={() => void loadHistory(historyCursor)}>
                        Повторить
                      </button>
                    </div>
                  ) : null}
                  {historyCursor && !historyError ? (
                    <button
                      className="assistant-history-more"
                      disabled={isHistoryLoading}
                      type="button"
                      onClick={() => void loadHistory(historyCursor)}
                    >
                      {isHistoryLoading ? 'Загружаю историю' : 'Показать ещё'}
                    </button>
                  ) : null}
                </div>
              </aside>
            ) : null}

            <div className="assistant-conversation">
              <div ref={messagesRef} className="assistant-messages" aria-live="polite">
                {isConversationLoading ? (
                  <div className="assistant-progress" role="status">
                    <span aria-hidden="true" />
                    Загружаю разговор
                  </div>
                ) : renderedMessages.length === 0 && !optimisticContent ? (
                  <div className="assistant-empty">
                    <MessageCircleIcon aria-hidden="true" />
                    <strong>С чего начнём?</strong>
                    <p>Напишите вопрос по недвижимости или условия поиска.</p>
                  </div>
                ) : null}
                {renderedMessages.map((message) => (
                  <article
                    className={[
                      'assistant-message',
                      `assistant-message--${message.role.toLocaleLowerCase('en-US')}`,
                      message.answer?.kind === 'SEARCH_RESULTS' || message.answer?.kind === 'KNOWLEDGE_RESULTS'
                        ? 'assistant-message--results'
                        : '',
                    ].filter(Boolean).join(' ')}
                    key={message.id}
                  >
                    <span>{message.role === 'USER' ? 'Вы' : 'Помощник'}</span>
                    <AssistantMessageContent message={message} />
                    {message.role === 'ASSISTANT' ? (
                      <AssistantFeedbackForm
                        accessToken={accessToken}
                        feedback={message.feedback}
                        messageId={message.id}
                        onSaved={handleFeedbackSaved}
                      />
                    ) : null}
                  </article>
                ))}
                {optimisticContent && !renderedMessages.some((message) => message.content === optimisticContent) ? (
                  <article className="assistant-message assistant-message--user assistant-message--pending">
                    <span>Вы</span>
                    <p>{optimisticContent}</p>
                  </article>
                ) : null}
                {progressLabel ? (
                  <div className="assistant-progress" role="status">
                    <span aria-hidden="true" />
                    {progressLabel}
                  </div>
                ) : null}
              </div>

              <div className="assistant-composer-area">
                <div className="assistant-context-chips">
                {pageContext ? (
                  <div className="assistant-context-chip">
                    <span>{pageContext.label}</span>
                    <button
                      aria-label={`Убрать контекст «${pageContext.label}»`}
                      type="button"
                      onClick={() => setPageContext(null)}
                    >
                      <XIcon aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
                {activeGeo ? geoConstraints(activeGeo).map((constraint, index) => (
                  <div
                    className="assistant-context-chip assistant-context-chip--geo"
                    data-assistant-geo-chip
                    key={`${constraint.landmarkId ?? constraint.label}-${index}`}
                  >
                    <MapPinIcon aria-hidden="true" />
                    <span>{formatGeoChip(constraint)}</span>
                    {constraint.mode === 'NEAR' ? (
                      <button
                        aria-label={'operator' in activeGeo
                          ? constraint.kind === 'POINT'
                            ? `Изменить точку и расстояние для «${constraint.label}»`
                            : `Заменить ориентир «${constraint.label}» ручной точкой`
                          : constraint.kind === 'POINT'
                            ? 'Изменить точку и расстояние'
                            : 'Заменить ориентир ручной точкой'}
                        disabled={isSending || isConversationLoading || isResolvingGeo}
                        type="button"
                        onClick={() => editGeoPicker(index)}
                      >
                        <PencilIcon aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      aria-label={'operator' in activeGeo
                        ? `Убрать ориентир «${constraint.label}»`
                        : 'Убрать геопоиск'}
                      disabled={isSending || isConversationLoading || isResolvingGeo}
                      type="button"
                      onClick={() => setActiveGeo(removeGeoConstraint(activeGeo, index))}
                    >
                      <XIcon aria-hidden="true" />
                    </button>
                  </div>
                )) : null}
                </div>
                {isResolvingGeo ? (
                  <div className="assistant-geo-resolution" role="status">Уточняю место…</div>
                ) : null}
                {geoResolution && geoResolution.status !== 'NOT_APPLICABLE' ? (
                  <AssistantGeoResolutionPanel
                    resolution={geoResolution}
                    selections={pendingGeoSelections}
                    onCandidateSelect={handleCandidateSelect}
                    onManual={openGeoPicker}
                    onRefine={handleGeoRefine}
                    onSelectionClear={handleGeoSelectionClear}
                  />
                ) : null}
                {geoError ? (
                  <div className="assistant-geo-resolution assistant-geo-resolution--error" role="alert">
                    <p>{geoError === duplicateGeoConstraintError
                      ? geoError
                      : 'Не удалось проверить географическое условие. Верните запрос и попробуйте ещё раз.'}</p>
                    {geoError !== duplicateGeoConstraintError ? (
                      <button type="button" onClick={handleGeoRefine}>Уточнить запрос</button>
                    ) : null}
                  </div>
                ) : null}
                {error ? (
                  <div className="assistant-error" role="alert">
                    <p>{error}</p>
                    {pendingSubmissionRef.current ? (
                      <button type="button" onClick={handleRetry} disabled={isSending}>
                        Повторить отправку
                      </button>
                    ) : failedConversationId ? (
                      <button type="button" onClick={() => void loadConversation(failedConversationId)}>
                        Повторить загрузку разговора
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <form className="assistant-composer" onSubmit={handleSubmit}>
                  <label htmlFor="assistant-message-input">Сообщение помощнику</label>
                  <textarea
                    ref={composerRef}
                    id="assistant-message-input"
                    maxLength={4_000}
                    placeholder="Например: найди квартиру рядом с Павелецкой"
                    rows={2}
                    value={draft}
                    aria-busy={isConversationLoading}
                    disabled={isConversationLoading || isResolvingGeo || geoResolution !== null || geoError !== null}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <button
                    aria-label="Выбрать точку на карте"
                    className="assistant-map-button"
                    disabled={isSending || isConversationLoading || isResolvingGeo || geoResolution !== null || geoError !== null}
                    type="button"
                    onClick={() => openGeoPicker()}
                  >
                    <MapPinIcon aria-hidden="true" />
                  </button>
                  <button
                    aria-label="Отправить"
                    disabled={isSending || isConversationLoading || isResolvingGeo || geoResolution !== null || geoError !== null || draft.trim().length === 0}
                    type="submit"
                  >
                    <SendIcon aria-hidden="true" />
                  </button>
                </form>
              </div>
            </div>
          </div>
          )}
        </section>
      )}
    </>
  );
}

function AssistantMessageContent({ message }: { message: AssistantMessage }) {
  return (
    <>
      <p>{message.content}</p>
      {message.answer?.kind === 'SEARCH_RESULTS' ? (
        <AssistantSearchResults answer={message.answer} messageId={message.id} />
      ) : null}
      {message.answer?.kind === 'KNOWLEDGE_RESULTS' ? (
        <div className="assistant-results">
          {message.answer.facts.length > 0 ? (
            <section aria-labelledby={`assistant-knowledge-${message.id}`}>
              <h3 id={`assistant-knowledge-${message.id}`}>Подтверждённые факты</h3>
              <div className="assistant-result-list">
                {message.answer.facts.map((fact) => (
                  <AssistantKnowledgeFact key={fact.id} fact={fact} />
                ))}
              </div>
            </section>
          ) : null}
          {message.answer.externalLots.length > 0 ? (
            <section aria-labelledby={`assistant-external-lots-${message.id}`}>
              <h3 id={`assistant-external-lots-${message.id}`}>На официальном сайте застройщика</h3>
              <div className="assistant-result-list">
                {message.answer.externalLots.map((lot) => (
                  <AssistantExternalLot key={lot.id} lot={lot} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function AssistantSearchResults({
  answer,
  messageId,
}: {
  answer: Extract<AssistantAnswer, { kind: 'SEARCH_RESULTS' }>;
  messageId: string;
}) {
  const [showAdditional, setShowAdditional] = useState(false);
  const firstAdditionalResultRef = useRef<HTMLAnchorElement>(null);
  const additionalExactResults = answer.additionalExactResults ?? [];
  const visibleExactResults = showAdditional
    ? [...answer.exactResults, ...additionalExactResults]
    : answer.exactResults;
  const exactResultsId = `assistant-exact-results-${messageId}`;

  useEffect(() => {
    if (showAdditional) firstAdditionalResultRef.current?.focus();
  }, [showAdditional]);

  return (
    <div className="assistant-results">
      {answer.totalExactResults !== undefined ? (
        <p className="assistant-results-total">
          Всего найдено: {answer.totalExactResults.toLocaleString('ru-RU')}
        </p>
      ) : null}
      <section aria-labelledby={`assistant-exact-${messageId}`}>
        <h3 id={`assistant-exact-${messageId}`}>Лучшие по этим критериям</h3>
        {visibleExactResults.length > 0 ? (
          <div className="assistant-result-list" id={exactResultsId}>
            {visibleExactResults.map((result, index) => (
              <AssistantResultCard
                key={result.unitId}
                result={result}
                titleRef={index === answer.exactResults.length ? firstAdditionalResultRef : undefined}
              />
            ))}
          </div>
        ) : (
          <p className="assistant-results-empty">Точных совпадений нет.</p>
        )}
        {additionalExactResults.length > 0 && !showAdditional ? (
          <Button
            aria-controls={exactResultsId}
            className="min-h-11 w-full justify-start"
            type="button"
            variant="ghost"
            onClick={() => setShowAdditional(true)}
          >
            Показать далее
          </Button>
        ) : null}
        <span aria-live="polite" className="sr-only" role="status">
          {showAdditional ? `Показано ${visibleExactResults.length} вариантов` : ''}
        </span>
      </section>
      {answer.geo ? <AssistantGeoResultMap geo={answer.geo} /> : null}
      {answer.alternatives.length > 0 ? (
        <section aria-labelledby={`assistant-alternatives-${messageId}`}>
          <h3 id={`assistant-alternatives-${messageId}`}>Альтернативы</h3>
          <div className="assistant-result-list">
            {answer.alternatives.map((result) => (
              <AssistantResultCard key={result.unitId} result={result} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const feedbackReasonOptions: Array<{ value: AssistantFeedbackReason; label: string }> = [
  { value: 'WRONG_FACT', label: 'Неверный факт' },
  { value: 'MISSING_RESULT', label: 'Не хватает результата' },
  { value: 'IRRELEVANT', label: 'Ответ не по теме' },
  { value: 'STALE_DATA', label: 'Устаревшие данные' },
  { value: 'BROKEN_LINK', label: 'Не работает ссылка' },
  { value: 'SLOW_RESPONSE', label: 'Слишком медленно' },
  { value: 'OTHER', label: 'Другое' },
];

function AssistantFeedbackForm({
  accessToken,
  feedback,
  messageId,
  onSaved,
}: {
  accessToken: string;
  feedback: AssistantFeedback | null;
  messageId: string;
  onSaved: (messageId: string, feedback: AssistantFeedback) => void;
}) {
  const [rating, setRating] = useState<AssistantFeedbackRating | null>(feedback?.rating ?? null);
  const [reason, setReason] = useState<AssistantFeedbackReason | ''>(feedback?.reason ?? '');
  const [comment, setComment] = useState(feedback?.comment ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(Boolean(feedback));
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  useEffect(() => {
    setRating(feedback?.rating ?? null);
    setReason(feedback?.reason ?? '');
    setComment(feedback?.comment ?? '');
    setSaved(Boolean(feedback));
  }, [feedback]);

  const selectRating = (nextRating: AssistantFeedbackRating) => {
    setRating(nextRating);
    setSaved(false);
    setFeedbackError(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rating) return;
    setIsSaving(true);
    setFeedbackError(null);
    try {
      const response = await saveAssistantFeedback(accessToken, messageId, {
        rating,
        reason: reason || null,
        comment: comment.trim() || null,
      });
      onSaved(messageId, response.feedback);
      setSaved(true);
    } catch (saveError) {
      setFeedbackError(readErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="assistant-feedback" onSubmit={handleSave}>
      <fieldset>
        <legend>Был ли ответ полезен?</legend>
        <button
          aria-label="Ответ полезен"
          aria-pressed={rating === 'LIKE'}
          className={rating === 'LIKE' ? 'assistant-feedback-rating assistant-feedback-rating--selected' : 'assistant-feedback-rating'}
          disabled={isSaving}
          type="button"
          onClick={() => selectRating('LIKE')}
        >
          <ThumbsUpIcon aria-hidden="true" />
        </button>
        <button
          aria-label="Ответ не помог"
          aria-pressed={rating === 'DISLIKE'}
          className={rating === 'DISLIKE' ? 'assistant-feedback-rating assistant-feedback-rating--selected' : 'assistant-feedback-rating'}
          disabled={isSaving}
          type="button"
          onClick={() => selectRating('DISLIKE')}
        >
          <ThumbsDownIcon aria-hidden="true" />
        </button>
      </fieldset>
      {rating ? (
        <div className="assistant-feedback-details">
          <label>
            Причина <span>необязательно</span>
            <select
              disabled={isSaving}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value as AssistantFeedbackReason | '');
                setSaved(false);
              }}
            >
              <option value="">Не выбрана</option>
              {feedbackReasonOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Комментарий <span>до 500 символов</span>
            <textarea
              disabled={isSaving}
              maxLength={500}
              rows={2}
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <div className="assistant-feedback-actions">
            <button disabled={isSaving || saved} type="submit">
              {isSaving ? 'Сохраняю…' : saved ? 'Сохранено' : 'Сохранить оценку'}
            </button>
            {saved ? <span role="status">Спасибо, оценка попадёт на проверку.</span> : null}
          </div>
        </div>
      ) : null}
      {feedbackError ? <p className="assistant-feedback-error" role="alert">{feedbackError}</p> : null}
    </form>
  );
}

function AssistantKnowledgeFact({ fact }: { fact: AssistantKnowledgeFactCard }) {
  return (
    <section className="assistant-result-card" aria-label={fact.label}>
      <strong className="assistant-knowledge-label">{fact.label}</strong>
      <p className="assistant-knowledge-value">{fact.value}</p>
      <span className={fact.isStale ? 'assistant-result-freshness assistant-result-freshness--stale' : 'assistant-result-freshness'}>
        {fact.freshnessLabel}
      </span>
    </section>
  );
}

function AssistantExternalLot({ lot }: { lot: AssistantExternalLotCard }) {
  return (
    <section className="assistant-result-card" aria-label={`${lot.title}, ${formatRub(lot.priceRub)}`}>
      <a
        className="assistant-result-title"
        href={lot.href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {lot.title}
      </a>
      <p className="assistant-result-subtitle">{lot.subtitle}</p>
      <strong className="assistant-result-price">{formatRub(lot.priceRub)}</strong>
      <div className="assistant-result-status">
        <span>{lot.availabilityLabel}</span>
        <span className={lot.isStale ? 'assistant-result-freshness assistant-result-freshness--stale' : 'assistant-result-freshness'}>
          {lot.freshnessLabel}
        </span>
      </div>
    </section>
  );
}

function AssistantResultCard({
  result,
  titleRef,
}: {
  result: AssistantSearchResultCard;
  titleRef?: Ref<HTMLAnchorElement>;
}) {
  return (
    <section className="assistant-result-card" aria-label={`${result.title}, ${formatRub(result.priceRub)}`}>
      {result.deviations.length > 0 ? (
        <div className="assistant-result-deviations" aria-label="Отклонения от запроса">
          {result.deviations.map((deviation) => (
            <span key={`${deviation.type}-${deviation.label}`}>{deviation.label}</span>
          ))}
        </div>
      ) : null}
      <a className="assistant-result-title" href={result.href} ref={titleRef}>{result.title}</a>
      <p className="assistant-result-subtitle">{result.subtitle}</p>
      <strong className="assistant-result-price">{formatRub(result.priceRub)}</strong>
      {result.distanceMeters !== undefined ? (
        <span className="assistant-result-distance">{formatDistance(result.distanceMeters)} по прямой</span>
      ) : null}
      <div className="assistant-result-status">
        <span>{result.availabilityLabel}</span>
        <span className={result.isStale ? 'assistant-result-freshness assistant-result-freshness--stale' : 'assistant-result-freshness'}>
          {result.freshnessLabel}
        </span>
      </div>
      {result.facts.length > 0 ? (
        <ul className="assistant-result-facts">
          {result.facts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      ) : null}
      {result.pdfs.length > 0 ? (
        <div className="assistant-result-pdfs" aria-label="Доступные PDF">
          {result.pdfs.map((pdf) => (
            <a href={pdf.href} key={pdf.href} rel="noopener noreferrer" target="_blank">
              {pdf.title}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AssistantGeoResolutionPanel({
  onCandidateSelect,
  onManual,
  onRefine,
  onSelectionClear,
  resolution,
  selections,
}: {
  onCandidateSelect: (candidate: AssistantGeoCandidate, slotId?: string) => void;
  onManual: (slotId?: string) => void;
  onRefine: () => void;
  onSelectionClear: (slotId: string) => void;
  resolution: Exclude<AssistantGeoResolution, { status: 'NOT_APPLICABLE' }>;
  selections: Record<string, AssistantGeoSearchContext>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resolvedCount = resolution.status === 'COMPOSITE'
    ? resolution.constraints.filter((constraint) => Boolean(selections[constraint.slotId])).length
    : 0;
  const previousResolvedCountRef = useRef<number | null>(null);

  useEffect(() => {
    const previousResolvedCount = previousResolvedCountRef.current;
    previousResolvedCountRef.current = resolvedCount;
    if (resolution.status !== 'COMPOSITE'
      || (previousResolvedCount !== null && resolvedCount === previousResolvedCount)
      || resolvedCount >= resolution.constraints.length) return;
    const frameId = window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('[data-assistant-geo-unresolved] button')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [resolution, resolvedCount]);

  if (resolution.status === 'COMPOSITE') {
    return (
      <div className="assistant-geo-resolution" data-assistant-geo-candidates ref={panelRef}>
        <p aria-live="polite" role="status">
          <strong>Уточните ориентиры: {resolvedCount} из {resolution.constraints.length}</strong>
          {' '}Все выбранные условия применяются одновременно.
        </p>
        <div className="assistant-geo-constraint-list">
          {resolution.constraints.map((constraint) => {
            const selected = selections[constraint.slotId];
            const headingId = `assistant-geo-constraint-${constraint.slotId}`;
            return (
              <section
                aria-labelledby={headingId}
                data-assistant-geo-constraint
                data-assistant-geo-unresolved={selected ? undefined : true}
                key={constraint.slotId}
              >
                <strong id={headingId}>{constraint.sourceText}</strong>
                {selected ? (
                  <>
                    <p>Выбрано: {selected.label}</p>
                    <div className="assistant-geo-selected-actions">
                      {selected.mode === 'NEAR' ? (
                        <button
                          aria-label={`Изменить ориентир «${constraint.sourceText}» на карте`}
                          type="button"
                          onClick={() => onManual(constraint.slotId)}
                        >
                          Изменить на карте
                        </button>
                      ) : null}
                      <button
                        aria-label={`Сбросить ориентир «${constraint.sourceText}»`}
                        type="button"
                        onClick={() => onSelectionClear(constraint.slotId)}
                      >
                        Сбросить
                      </button>
                    </div>
                  </>
                ) : constraint.status === 'AMBIGUOUS' || constraint.status === 'RESOLVED' ? (
                  <div className="assistant-geo-candidates">
                    {constraint.candidates.slice(0, 3).map((candidate) => (
                      <button
                        key={`${constraint.slotId}:${candidate.id}`}
                        type="button"
                        onClick={() => onCandidateSelect(candidate, constraint.slotId)}
                      >
                        <span>{candidate.label}</span>
                        {candidate.city ? <small>{candidate.city}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <p>{constraint.mode === 'INSIDE'
                      ? 'Не удалось определить границы области. Уточните её название.'
                      : constraint.status === 'UNAVAILABLE'
                        ? 'Сервис определения места сейчас недоступен.'
                        : 'Нужно уточнить конкретное место или указать точку.'}</p>
                    {constraint.mode === 'NEAR' ? (
                      <button
                        aria-label={`Указать ориентир «${constraint.sourceText}» на карте`}
                        type="button"
                        onClick={() => onManual(constraint.slotId)}
                      >
                        Указать на карте
                      </button>
                    ) : null}
                  </>
                )}
              </section>
            );
          })}
        </div>
        <button className="assistant-geo-refine" type="button" onClick={onRefine}>Уточнить названия</button>
      </div>
    );
  }
  if (resolution.status === 'AMBIGUOUS' || resolution.status === 'RESOLVED') {
    return (
      <div className="assistant-geo-resolution" data-assistant-geo-candidates>
        <strong>Какое место вы имели в виду?</strong>
        <div className="assistant-geo-candidates">
          {resolution.candidates.slice(0, 3).map((candidate) => (
            <button key={candidate.id} type="button" onClick={() => onCandidateSelect(candidate)}>
              <span>{candidate.label}</span>
              {candidate.city ? <small>{candidate.city}</small> : null}
            </button>
          ))}
        </div>
        <button className="assistant-geo-refine" type="button" onClick={onRefine}>Уточнить название</button>
      </div>
    );
  }
  const allowsManualPoint = resolution.mode === 'NEAR';
  return (
    <div className="assistant-geo-resolution" role="alert">
      <p>{resolution.mode === 'INSIDE'
        ? 'Не удалось определить область. Уточните её название, чтобы сохранить поиск внутри границ.'
        : resolution.status === 'REFINE_REQUIRED'
          ? 'Назовите конкретный объект — например, реку, набережную, парк или школу.'
          : resolution.status === 'UNAVAILABLE'
            ? 'Геокодер сейчас недоступен. Поиск по ручной точке продолжает работать.'
            : 'Место не найдено. Укажите точку вручную или уточните название.'}</p>
      <div>
        {allowsManualPoint ? (
          <button type="button" onClick={() => onManual()}>Указать на карте</button>
        ) : null}
        <button type="button" onClick={onRefine}>Уточнить название</button>
      </div>
    </div>
  );
}

function candidateToGeo(
  candidate: AssistantGeoCandidate,
  metadata?: { slotId?: string; sourceSpan?: { start: number; end: number } },
): AssistantGeoSearchContext {
  if (candidate.kind === 'POINT') {
    const point = candidate.point ?? (typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number'
      ? { latitude: candidate.latitude, longitude: candidate.longitude }
      : null);
    if (!point || candidate.mode !== 'NEAR' || typeof candidate.distanceMeters !== 'number') {
      throw new Error('ASSISTANT_GEO_CANDIDATE_INVALID');
    }
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: candidate.label,
      landmarkId: candidate.id,
      point,
      distanceMeters: candidate.distanceMeters,
      source: 'LANDMARK',
      ...(metadata?.slotId ? { slotId: metadata.slotId, sourceSpan: metadata.sourceSpan } : {}),
    };
  }
  if (candidate.kind === 'LINE') {
    if (candidate.mode !== 'NEAR' || typeof candidate.distanceMeters !== 'number') {
      throw new Error('ASSISTANT_GEO_CANDIDATE_INVALID');
    }
    return {
      kind: 'LINE',
      mode: 'NEAR',
      label: candidate.label,
      landmarkId: candidate.id,
      distanceMeters: candidate.distanceMeters,
      source: 'LANDMARK',
      ...(metadata?.slotId ? { slotId: metadata.slotId, sourceSpan: metadata.sourceSpan } : {}),
    };
  }
  if (candidate.mode === 'INSIDE') {
    return {
      kind: 'AREA',
      mode: 'INSIDE',
      label: candidate.label,
      landmarkId: candidate.id,
      source: 'LANDMARK',
      ...(metadata?.slotId ? { slotId: metadata.slotId, sourceSpan: metadata.sourceSpan } : {}),
    };
  }
  if (typeof candidate.distanceMeters !== 'number') {
    throw new Error('ASSISTANT_GEO_CANDIDATE_INVALID');
  }
  return {
    kind: 'AREA',
    mode: 'NEAR',
    label: candidate.label,
    landmarkId: candidate.id,
    distanceMeters: candidate.distanceMeters,
    source: 'LANDMARK',
    ...(metadata?.slotId ? { slotId: metadata.slotId, sourceSpan: metadata.sourceSpan } : {}),
  };
}

function geoToBrowserInput(geo: AssistantGeoSearchSelection): AssistantGeoBrowserInput {
  if ('operator' in geo) {
    return {
      operator: 'ALL',
      constraints: geo.constraints.map(geoConstraintToBrowserInput),
    };
  }
  return geoConstraintToBrowserInput(geo);
}

function confirmedGeoSubmission(
  content: string,
  geo: AssistantGeoSearchSelection,
): AssistantSendMessageInput {
  return { content, geo: geoToBrowserInput(geo) };
}

function geoConstraintToBrowserInput(geo: AssistantGeoSearchContext): AssistantGeoBrowserConstraint {
  if (geo.source === 'LANDMARK' && geo.landmarkId) {
    return {
      referenceType: 'LANDMARK',
      landmarkId: geo.landmarkId,
      mode: geo.mode,
      ...(geo.mode === 'NEAR' ? { distanceMeters: geo.distanceMeters } : {}),
      ...(geo.slotId ? { slotId: geo.slotId, sourceSpan: geo.sourceSpan } : {}),
    };
  }
  if (geo.kind !== 'POINT') throw new Error('ASSISTANT_GEO_LANDMARK_ID_REQUIRED');
  return {
    referenceType: 'MANUAL_POINT',
    point: { ...geo.point, label: geo.label },
    mode: 'NEAR',
    distanceMeters: geo.distanceMeters,
    ...(geo.slotId ? { slotId: geo.slotId, sourceSpan: geo.sourceSpan } : {}),
  };
}

function geoConstraints(geo: AssistantGeoSearchSelection): AssistantGeoSearchContext[] {
  return 'operator' in geo ? geo.constraints : [geo];
}

function completeCompositeGeo(
  resolution: Extract<AssistantGeoResolution, { status: 'COMPOSITE' }>,
  selections: Record<string, AssistantGeoSearchContext>,
): AssistantGeoSearchSelection | null {
  const constraints = resolution.constraints.map(({ slotId }) => selections[slotId] ?? null);
  if (!constraints.every((constraint): constraint is AssistantGeoSearchContext => constraint !== null)
    || hasDuplicateGeoConstraints(constraints)) return null;
  return { operator: 'ALL', constraints };
}

function labelManualGeoConstraint(geo: AssistantGeoSearchContext, sourceText: string) {
  if (geo.source !== 'MANUAL' || geo.kind !== 'POINT') return geo;
  const sourceLabel = sourceText.replace(/^Ориентир:\s*/iu, '');
  return {
    ...geo,
    label: `Ориентир: ${sourceLabel}`.slice(0, 160),
  };
}

function withGeoSlotMetadata(
  geo: AssistantGeoSearchContext,
  metadata: { slotId?: string; sourceSpan?: { start: number; end: number } },
): AssistantGeoSearchContext {
  return metadata.slotId
    ? { ...geo, slotId: metadata.slotId, sourceSpan: metadata.sourceSpan }
    : geo;
}

function readPendingGeoDistance(
  target: GeoPickerTarget | null,
  resolution: AssistantGeoResolution | null,
) {
  if (!target || !resolution || resolution.status === 'NOT_APPLICABLE') return null;
  if (target.kind === 'PENDING_SINGLE' && resolution.status !== 'COMPOSITE') {
    return resolution.distanceMeters ?? null;
  }
  if (target.kind === 'PENDING_SLOT' && resolution.status === 'COMPOSITE') {
    return resolution.constraints.find(({ slotId }) => slotId === target.slotId)?.distanceMeters ?? null;
  }
  return null;
}

function hasDuplicateGeoConstraints(constraints: AssistantGeoSearchContext[]) {
  const keys = constraints.map((constraint) => constraint.source === 'LANDMARK' && constraint.landmarkId
    ? `LANDMARK:${constraint.landmarkId}:${constraint.mode}:${constraint.mode === 'NEAR' ? constraint.distanceMeters : ''}`
    : constraint.kind === 'POINT'
      ? `MANUAL:${constraint.point.latitude}:${constraint.point.longitude}:${constraint.distanceMeters}`
      : `${constraint.kind}:${constraint.label}:${constraint.mode}`);
  return new Set(keys).size !== keys.length;
}

function replaceGeoConstraint(
  selection: AssistantGeoSearchSelection,
  index: number,
  replacement: AssistantGeoSearchContext,
): AssistantGeoSearchSelection {
  const constraints = geoConstraints(selection);
  if (!constraints[index]) return selection;
  const next = constraints.map((constraint, constraintIndex) =>
    constraintIndex === index ? replacement : constraint);
  return next.length === 1 ? next[0]! : { operator: 'ALL', constraints: next };
}

function removeGeoConstraint(selection: AssistantGeoSearchSelection, index: number) {
  const next = geoConstraints(selection).filter((_, constraintIndex) => constraintIndex !== index);
  if (next.length === 0) return null;
  return next.length === 1 ? next[0]! : { operator: 'ALL' as const, constraints: next };
}

function formatGeoChip(geo: AssistantGeoSearchContext) {
  if (geo.mode === 'INSIDE') {
    const areaLabel = /^район\s+/iu.test(geo.label)
      ? geo.label.replace(/^район\s+/iu, 'района ')
      : /^района\s+/iu.test(geo.label)
        ? geo.label
        : `района ${geo.label}`;
    return `внутри ${areaLabel}`;
  }
  if (geo.kind === 'LINE') return `${geo.label} · до ${formatDistance(geo.distanceMeters)} от всей дороги`;
  if (geo.kind === 'AREA') return `${geo.label} · до ${formatDistance(geo.distanceMeters)} от всей границы`;
  return `${geo.label} · до ${formatDistance(geo.distanceMeters)}`;
}

function readLatestGeoContext(messages: AssistantMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'USER')?.geo ?? null;
}

function readLatestUserContent(messages: AssistantMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'USER')?.content ?? null;
}

function formatRub(value: number) {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function resolvePageContext(pathname: string, search: string): AssistantPageContext | null {
  const lotMatch = pathname.match(/^\/objects\/([^/]+)\/lots\/([^/]+)\/?$/u);
  if (lotMatch?.[2]) {
    return { kind: 'LOT', key: decodePathValue(lotMatch[2]), label: 'Текущий лот' };
  }
  const objectMatch = pathname.match(/^\/objects\/([^/]+)\/?$/u);
  if (objectMatch?.[1]) {
    return { kind: 'OBJECT', key: decodePathValue(objectMatch[1]), label: 'Текущий ЖК' };
  }
  if (pathname.startsWith('/catalog')) {
    const params = new URLSearchParams(search);
    if (pathname === '/catalog/life') params.set('type', 'RESIDENTIAL');
    if (pathname === '/catalog/comm') params.set('type', 'COMMERCIAL');
    const developerId = params.get('developerId');
    if ([...params.keys()].length > 0) {
      return {
        kind: 'CATALOG_FILTERS',
        key: params.toString(),
        label: developerId ? 'Застройщик из фильтра' : 'Фильтры каталога',
      };
    }
  }
  return null;
}

function mergeConversationHistory(
  current: AssistantConversationSummary[],
  nextPage: AssistantConversationSummary[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  nextPage.forEach((item) => byId.set(item.id, item));
  return [...byId.values()];
}

function decodePathValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(date);
}
