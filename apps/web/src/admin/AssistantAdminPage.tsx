import type {
  AssistantAdminTurn,
  AssistantAdminTurnSummary,
  AssistantUsageResponse,
} from '@platforma/shared';
import { ArrowLeftIcon, FileTextIcon, RefreshCwIcon, ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useAuth } from '../auth/AuthProvider';
import { getAssistantAdminTurn, getAssistantAdminTurns, getAssistantUsage } from '../assistant/assistantApi';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import './assistantAdmin.css';

// Admin view of the assistant: what it cost over the last 30 days and every logged turn,
// with the question, the answer, the lots, the tool trace and the price of the turn.

const usageDays = 30;

type AssistantAdminPageProps = {
  onBack: () => void;
};

export function AssistantAdminPage({ onBack }: AssistantAdminPageProps) {
  const { accessToken } = useAuth();
  const [usage, setUsage] = useState<AssistantUsageResponse | null>(null);
  const [turns, setTurns] = useState<AssistantAdminTurnSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [onlyDown, setOnlyDown] = useState(false);
  const [selected, setSelected] = useState<AssistantAdminTurn | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const detailRequestRef = useRef<AbortController | null>(null);
  const moreRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    // A page still loading for the previous filter must not land in the new list.
    moreRequestRef.current?.abort();
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    void Promise.all([
      getAssistantUsage(accessToken, usageDays, controller.signal),
      getAssistantAdminTurns(accessToken, { rating: onlyDown ? 'DOWN' : undefined }, controller.signal),
    ])
      .then(([usageResponse, turnsResponse]) => {
        setUsage(usageResponse);
        setTurns(turnsResponse.items);
        setNextCursor(turnsResponse.nextCursor);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Не удалось загрузить журнал');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, onlyDown, reloadKey]);

  useEffect(() => () => {
    detailRequestRef.current?.abort();
    moreRequestRef.current?.abort();
  }, []);

  async function loadMore() {
    if (!accessToken || !nextCursor || isLoadingMore) return;
    const controller = new AbortController();
    moreRequestRef.current = controller;
    setIsLoadingMore(true);
    try {
      const response = await getAssistantAdminTurns(
        accessToken,
        { rating: onlyDown ? 'DOWN' : undefined, cursor: nextCursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setTurns((current) => [...current, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Не удалось загрузить журнал');
    } finally {
      if (moreRequestRef.current === controller) moreRequestRef.current = null;
      setIsLoadingMore(false);
    }
  }

  async function openTurn(turnId: string) {
    if (!accessToken) return;
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    try {
      const { turn } = await getAssistantAdminTurn(accessToken, turnId, controller.signal);
      if (!controller.signal.aborted) setSelected(turn);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Не удалось открыть ход');
    }
  }

  const activeDays = usage?.days.filter((day) => day.turns > 0).reverse() ?? [];

  return (
    <div className="admin-assistant">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>ИИ-помощник</h2>
        </div>
        <div className="header-actions">
          <AdminButton disabled={isLoading} tone="secondary" type="button" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCwIcon data-icon="inline-start" />
            Обновить
          </AdminButton>
          <AdminButton tone="secondary" type="button" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Назад
          </AdminButton>
        </div>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}

      <AdminPanel className="table-panel assistant-admin-usage" role="region" aria-label={`Расход за ${usageDays} дней`}>
        <h3>Расход за {usageDays} дней</h3>
        {usage ? (
          <>
            <dl className="assistant-admin-totals">
              <div><dt>Вопросов</dt><dd>{formatInteger(usage.totals.turns)}</dd></div>
              <div><dt>Брокеров</dt><dd>{formatInteger(usage.totals.users)}</dd></div>
              <div><dt>Ошибок</dt><dd>{formatInteger(usage.totals.failed)}</dd></div>
              <div><dt>👍 / 👎</dt><dd>{usage.totals.ratedUp} / {usage.totals.ratedDown}</dd></div>
              <div><dt>Токены</dt><dd>{formatTokens(usage.totals.inputTokens + usage.totals.outputTokens)}</dd></div>
              <div><dt>Стоимость</dt><dd>{formatUsd(usage.totals.costUsd)}</dd></div>
            </dl>
            {activeDays.length ? (
              <Table className="admin-table assistant-admin-days">
                <TableHeader>
                  <TableRow>
                    <TableHead>День</TableHead>
                    <TableHead className="assistant-admin-number">Вопросов</TableHead>
                    <TableHead className="assistant-admin-number">Ошибок</TableHead>
                    <TableHead className="assistant-admin-number">👍</TableHead>
                    <TableHead className="assistant-admin-number">👎</TableHead>
                    <TableHead className="assistant-admin-number">Вход (кэш)</TableHead>
                    <TableHead className="assistant-admin-number">Выход</TableHead>
                    <TableHead className="assistant-admin-number">$</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeDays.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>{formatDay(day.date)}</TableCell>
                      <TableCell className="assistant-admin-number">{day.turns}</TableCell>
                      <TableCell className="assistant-admin-number">{day.failed}</TableCell>
                      <TableCell className="assistant-admin-number">{day.ratedUp}</TableCell>
                      <TableCell className="assistant-admin-number">{day.ratedDown}</TableCell>
                      <TableCell className="assistant-admin-number">
                        {formatTokens(day.inputTokens)} ({formatTokens(day.cachedTokens)})
                      </TableCell>
                      <TableCell className="assistant-admin-number">{formatTokens(day.outputTokens)}</TableCell>
                      <TableCell className="assistant-admin-number">{formatUsd(day.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="muted-text">За {usageDays} дней вопросов не было.</p>
            )}
          </>
        ) : (
          <p className="muted-text">{isLoading ? 'Загрузка' : 'Нет данных'}</p>
        )}
      </AdminPanel>

      <div className="assistant-admin-layout">
        <AdminPanel className="table-panel" role="region" aria-label="Журнал вопросов">
          <div className="table-meta">
            <label className="assistant-admin-filter">
              <input checked={onlyDown} type="checkbox" onChange={(event) => setOnlyDown(event.target.checked)} />
              Только 👎
            </label>
            <span>{isLoading ? 'Загрузка' : `Показано: ${turns.length}`}</span>
          </div>
          <Table className="admin-table assistant-admin-turns">
            <TableHeader>
              <TableRow>
                <TableHead>Когда</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead>Вопрос</TableHead>
                <TableHead>Итог</TableHead>
                <TableHead className="assistant-admin-number">$</TableHead>
                <TableHead><span className="sr-only">Действия</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {turns.map((turn) => (
                <TableRow
                  key={turn.id}
                  aria-selected={selected?.id === turn.id}
                  className={selected?.id === turn.id ? 'is-selected' : undefined}
                  data-state={selected?.id === turn.id ? 'selected' : undefined}
                >
                  <TableCell className="assistant-admin-when">{formatDateTime(turn.createdAt)}</TableCell>
                  <TableCell>{turn.user.name || turn.user.email}</TableCell>
                  <TableCell className="assistant-admin-question">{turn.question}</TableCell>
                  <TableCell>
                    <TurnOutcome turn={turn} />
                  </TableCell>
                  <TableCell className="assistant-admin-number">{formatUsd(turn.estimatedCostUsd)}</TableCell>
                  <TableCell>
                    <AdminButton tone="text" type="button" onClick={() => void openTurn(turn.id)}>
                      <FileTextIcon data-icon="inline-start" />
                      Открыть
                    </AdminButton>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && turns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <AdminEmptyState
                      title={onlyDown ? 'Нет ответов с 👎' : 'Журнал пуст'}
                      description="Вопросы хранятся 90 дней."
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          {nextCursor ? (
            <div className="pagination">
              <AdminButton disabled={isLoadingMore} tone="secondary" type="button" onClick={() => void loadMore()}>
                {isLoadingMore ? 'Загрузка…' : 'Показать ещё'}
              </AdminButton>
            </div>
          ) : null}
        </AdminPanel>

        <AdminPanel className="editor-panel assistant-admin-turn" role="region" aria-label="Карточка вопроса">
          {selected ? <TurnDetails turn={selected} /> : (
            <AdminEmptyState title="Выберите вопрос" description="Здесь будут ответ, лоты, вызовы инструментов и стоимость." />
          )}
        </AdminPanel>
      </div>
    </div>
  );
}

function TurnOutcome({ turn }: { turn: AssistantAdminTurnSummary }) {
  return (
    <div className="assistant-admin-outcome">
      {turn.status === 'FAILED' ? (
        <AdminStatusBadge className="status-pill--blocked">Ошибка</AdminStatusBadge>
      ) : (
        <span>{turn.lotsCount ? `${turn.lotsCount} лот.` : 'без лотов'}</span>
      )}
      {turn.rating === 'UP' ? <ThumbsUpIcon aria-label="👍" /> : null}
      {turn.rating === 'DOWN' ? <ThumbsDownIcon aria-label="👎" className="assistant-admin-down" /> : null}
    </div>
  );
}

function TurnDetails({ turn }: { turn: AssistantAdminTurn }) {
  return (
    <div className="assistant-admin-details">
      <div>
        <p className="eyebrow">{formatDateTime(turn.createdAt)} · {turn.user.name || turn.user.email}</p>
        <h3>{turn.question}</h3>
      </div>

      {turn.rating ? (
        <p className={turn.rating === 'DOWN' ? 'assistant-admin-rating assistant-admin-rating--down' : 'assistant-admin-rating'}>
          {turn.rating === 'DOWN' ? '👎' : '👍'} {turn.ratingComment ?? 'без комментария'}
        </p>
      ) : null}

      <section>
        <h4>Ответ</h4>
        <p className="assistant-admin-answer">
          {turn.status === 'FAILED' ? `Ошибка: ${turn.errorCode ?? 'неизвестно'}` : turn.answerText}
        </p>
      </section>

      {turn.lots.length ? (
        <section>
          <h4>Лоты ({turn.lots.length})</h4>
          <ul className="assistant-admin-list">
            {turn.lots.map((lot) => (
              <li key={lot.source === 'PLATFORMA' ? lot.unitId : `${lot.url}:${lot.priceRub}:${lot.areaM2}`}>
                <a href={lot.source === 'PLATFORMA' ? lot.href : lot.url} rel="noopener noreferrer" target="_blank">
                  {lot.projectTitle}
                </a>
                {' · '}
                {[
                  lot.rooms === null ? null : lot.rooms === 0 ? 'студия' : `${lot.rooms}-комн.`,
                  lot.areaM2 === null ? null : `${lot.areaM2} м²`,
                  lot.priceRub === null ? 'цена не подтверждена' : formatRub(lot.priceRub),
                  lot.source === 'WEB' ? lot.siteName : null,
                ].filter(Boolean).join(' · ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {turn.sources.length ? (
        <section>
          <h4>Источники</h4>
          <ul className="assistant-admin-list">
            {turn.sources.map((source) => (
              <li key={`${source.kind}:${source.url}`}>
                <a href={source.url} rel="noopener noreferrer" target="_blank">{source.title}</a> · {formatDateTime(source.date)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4>Инструменты</h4>
        {turn.trace.length ? (
          <ol className="assistant-admin-trace">
            {turn.trace.map((step, index) => (
              <li key={index}>
                <strong>{step.tool}</strong> <span className="table-subtext">{step.durationMs} мс</span>
                <code>{JSON.stringify(step.args)}</code>
                <span className={step.result.error ? 'assistant-admin-down' : undefined}>
                  {step.result.error
                    ? `ошибка: ${step.result.error}`
                    : [
                        step.result.found !== undefined ? `найдено ${step.result.found}` : null,
                        step.result.ids?.length ? `id: ${step.result.ids.slice(0, 5).join(', ')}${step.result.ids.length > 5 ? '…' : ''}` : null,
                      ].filter(Boolean).join(' · ') || 'без результата'}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted-text">Инструменты не вызывались.</p>
        )}
      </section>

      <dl className="details-list assistant-admin-meta">
        <div><dt>Модель</dt><dd>{turn.model}, вызовов {turn.modelCalls}</dd></div>
        <div>
          <dt>Токены</dt>
          <dd>вход {formatInteger(turn.inputTokens)} (из кэша {formatInteger(turn.cachedTokens)}), выход {formatInteger(turn.outputTokens)}</dd>
        </div>
        <div><dt>Стоимость</dt><dd>{formatUsd(turn.estimatedCostUsd)}{turn.pricingVersion ? ` · ${turn.pricingVersion}` : ''}</dd></div>
        <div><dt>Время</dt><dd>{(turn.durationMs / 1000).toFixed(1)} с</dd></div>
        <div><dt>Разговор</dt><dd>{turn.conversationId ?? '—'}</dd></div>
      </dl>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDay(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', weekday: 'short' });
}

function formatInteger(value: number) {
  return value.toLocaleString('ru-RU');
}

function formatTokens(value: number) {
  return value >= 10_000 ? `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс.` : formatInteger(value);
}

function formatUsd(value: number | string | null) {
  if (value === null) return '—';
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount < 1 ? amount.toFixed(4) : amount.toFixed(2)}` : '—';
}

function formatRub(value: number) {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
