import type { AssistantConversationSummary } from '@platforma/shared';
import { PanelLeftCloseIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';

// The list of the user's assistant chats: a column beside the chat in a wide window,
// a panel over it in a narrow one or on a phone.

type AssistantHistoryProps = {
  conversations: AssistantConversationSummary[] | null;
  activeId: string;
  error: string | null;
  mode: 'docked' | 'drawer';
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onDelete: (conversationId: string) => Promise<void>;
  onRetry: () => void;
  onHide: () => void;
};

export function AssistantHistory({
  conversations,
  activeId,
  error,
  mode,
  onSelect,
  onNew,
  onDelete,
  onRetry,
  onHide,
}: AssistantHistoryProps) {
  const [query, setQuery] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const groups = useMemo(() => {
    const words = normalize(query).split(' ').filter(Boolean);
    const matching = (conversations ?? []).filter((item) => words.every((word) => normalize(item.title).includes(word)));
    return groupByDay(matching, new Date());
  }, [conversations, query]);

  const remove = async (conversationId: string) => {
    setDeletingId(conversationId);
    try {
      await onDelete(conversationId);
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  return (
    <aside aria-label="История бесед" className={`assistant-history assistant-history--${mode}`}>
      <div className="assistant-history-actions">
        <button className="assistant-history-new" type="button" onClick={onNew}>
          <PlusIcon aria-hidden="true" />
          Новый разговор
        </button>
        <button
          aria-label={mode === 'docked' ? 'Свернуть историю' : 'Закрыть историю'}
          className="assistant-history-hide"
          type="button"
          onClick={onHide}
        >
          <PanelLeftCloseIcon aria-hidden="true" />
        </button>
      </div>
      <label className="assistant-history-search">
        <SearchIcon aria-hidden="true" />
        <input
          aria-label="Поиск по беседам"
          placeholder="Поиск"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="assistant-history-list">
        {conversations === null ? (
          error ? (
            <div className="assistant-history-note" role="alert">
              <p>{error}</p>
              <button type="button" onClick={onRetry}>Повторить</button>
            </div>
          ) : (
            <p className="assistant-history-note">Загружаю беседы…</p>
          )
        ) : groups.length === 0 ? (
          <p className="assistant-history-note">{query.trim() ? 'Ничего не нашлось' : 'Здесь появятся ваши беседы'}</p>
        ) : groups.map((group) => (
          <section key={group.label} className="assistant-history-group">
            <h3>{group.label}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item.id} className="assistant-history-item" data-active={item.id === activeId || undefined}>
                  {confirmingId === item.id ? (
                    <div className="assistant-history-confirm">
                      <span>Удалить беседу?</span>
                      <button disabled={deletingId === item.id} type="button" onClick={() => void remove(item.id)}>Да</button>
                      <button disabled={deletingId === item.id} type="button" onClick={() => setConfirmingId(null)}>Нет</button>
                    </div>
                  ) : (
                    <>
                      <button
                        aria-current={item.id === activeId ? 'true' : undefined}
                        className="assistant-history-open"
                        title={item.title}
                        type="button"
                        onClick={() => onSelect(item.id)}
                      >
                        {item.title}
                      </button>
                      <button
                        aria-label={`Удалить беседу «${item.title}»`}
                        className="assistant-history-delete"
                        type="button"
                        onClick={() => setConfirmingId(item.id)}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

function groupByDay(items: AssistantConversationSummary[], now: Date) {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1000;
  const labelOf = (value: string) => {
    const time = new Date(value).getTime();
    if (time >= today) return 'Сегодня';
    if (time >= today - day) return 'Вчера';
    if (time >= today - 6 * day) return 'На этой неделе';
    return 'Ранее';
  };
  const groups: Array<{ label: string; items: AssistantConversationSummary[] }> = [];
  for (const item of items) {
    const label = labelOf(item.updatedAt);
    const group = groups.at(-1);
    if (group?.label === label) group.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function normalize(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').trim();
}
