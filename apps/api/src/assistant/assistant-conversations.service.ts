import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantConversationMessage,
  AssistantConversationResponse,
  AssistantConversationsResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

// The chat history of the assistant window: every answered turn is saved under the conversation
// the browser named, unmasked, and only its owner can list, open or delete it. The admin turn log
// is separate and keeps its masked copy whatever happens here.

const maxListedConversations = 200;
const maxStoredMessages = 100;
const maxTitleChars = 80;

type StoredMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; answer: AssistantAnswer };

@Injectable()
export class AssistantConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A conversation id is the owner's alone: another user's id is refused, a new one is fine. */
  async assertWritable(ownerId: string, conversationId: string) {
    const existing = await this.prisma.assistantConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    });
    if (existing && existing.userId !== ownerId) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
  }

  // One job runs per user at a time, so the read-then-write below never races for one conversation.
  async appendTurn(input: {
    ownerId: string;
    conversationId: string;
    question: string;
    answerId: string;
    answer: AssistantAnswer;
    now?: Date;
  }) {
    const existing = await this.prisma.assistantConversation.findUnique({
      where: { id: input.conversationId },
      select: { userId: true, messagesJson: true },
    });
    if (existing && existing.userId !== input.ownerId) return;
    const added: StoredMessage[] = [
      { id: `${input.answerId}:question`, role: 'user', content: input.question },
      { id: input.answerId, role: 'assistant', content: input.answer.text, answer: input.answer },
    ];
    const messages = [...readStoredMessages(existing?.messagesJson), ...added].slice(-maxStoredMessages);
    const messagesJson = messages as unknown as Prisma.InputJsonValue;
    const now = input.now ?? new Date();
    await this.prisma.assistantConversation.upsert({
      where: { id: input.conversationId },
      create: {
        id: input.conversationId,
        userId: input.ownerId,
        title: createTitle(input.question),
        messagesJson,
        createdAt: now,
        updatedAt: now,
      },
      update: { messagesJson, updatedAt: now },
    });
  }

  async list(actor: AuthenticatedUser): Promise<AssistantConversationsResponse> {
    const rows = await this.prisma.assistantConversation.findMany({
      where: { userId: actor.id },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: maxListedConversations,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async get(actor: AuthenticatedUser, conversationId: string): Promise<AssistantConversationResponse> {
    const row = await this.prisma.assistantConversation.findFirst({
      where: { id: conversationId, userId: actor.id },
    });
    if (!row) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
    const stored = readStoredMessages(row.messagesJson);

    // Ratings live in the turn log, so a thumbs up given after the save still shows.
    const turnIds = stored.flatMap((message) => (message.role === 'assistant' && message.answer.turnId ? [message.answer.turnId] : []));
    const turns = turnIds.length
      ? await this.prisma.assistantTurn.findMany({
          where: { id: { in: turnIds }, userId: actor.id },
          select: { id: true, rating: true, ratingComment: true },
        })
      : [];
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));

    const messages = stored.map((message): AssistantConversationMessage => {
      if (message.role === 'user') return message;
      const turn = message.answer.turnId ? turnById.get(message.answer.turnId) : undefined;
      return { ...message, rating: turn?.rating ?? null, ratingCommented: Boolean(turn?.ratingComment) };
    });
    return {
      conversation: {
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        messages,
      },
    };
  }

  async remove(actor: AuthenticatedUser, conversationId: string) {
    const { count } = await this.prisma.assistantConversation.deleteMany({
      where: { id: conversationId, userId: actor.id },
    });
    if (count === 0) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
  }
}

export function createTitle(question: string) {
  const text = question.replace(/\s+/gu, ' ').trim() || 'Без названия';
  if (text.length <= maxTitleChars) return text;
  const cut = text.slice(0, maxTitleChars);
  const boundary = cut.lastIndexOf(' ');
  return `${cut.slice(0, boundary > maxTitleChars * 0.6 ? boundary : maxTitleChars).trim()}…`;
}

function readStoredMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredMessage => {
    if (!item || typeof item !== 'object') return false;
    const message = item as Record<string, unknown>;
    if (typeof message.id !== 'string' || typeof message.content !== 'string') return false;
    if (message.role === 'user') return true;
    return message.role === 'assistant' && Boolean(message.answer) && typeof message.answer === 'object';
  });
}
