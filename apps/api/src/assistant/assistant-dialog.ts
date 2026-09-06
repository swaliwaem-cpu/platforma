export type AssistantDialogMessage = {
  role: 'USER' | 'ASSISTANT';
  content: string;
};

export function normalizeAssistantDialog(
  dialog: AssistantDialogMessage[] | undefined,
  messages: string[],
) {
  if (dialog === undefined) return undefined;
  const normalized = dialog.flatMap((message) => {
    if (!message || (message.role !== 'USER' && message.role !== 'ASSISTANT')
      || typeof message.content !== 'string') return [];
    const content = message.content.trim();
    return content ? [{ role: message.role, content }] : [];
  });
  return normalized.length > 0
    ? normalized
    : messages.map((content) => ({ role: 'USER' as const, content }));
}
