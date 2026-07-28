import { createHash } from 'node:crypto';

import { hashTrainingLinkToken } from './training-telegram-link.service';

export type SanitizedTelegramUser = {
  telegramUserId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
};

export type SanitizedTelegramMessageUpdate = {
  type: 'MESSAGE';
  correlationId: string;
  updateId: string;
  receivedAt: string;
  chatId: string;
  messageId: string;
  user: SanitizedTelegramUser;
  content:
    | {
        kind: 'COMMAND';
        command:
          | 'START'
          | 'CONNECT'
          | 'PROJECTS'
          | 'RESULTS'
          | 'RULES'
          | 'OPEN_PLATFORM'
          | 'CANCEL';
        startTokenHash?: string;
        invalidStartToken?: true;
      }
    | {
        kind: 'VOICE';
        fileId: string;
        fileUniqueId: string;
        durationSeconds: number;
        sizeBytes?: string;
        recordingStartedAt: string;
      }
    | {
        kind: 'REJECTED';
        rejectedType: string;
      };
};

export type SanitizedTelegramCallbackUpdate = {
  type: 'CALLBACK';
  correlationId: string;
  updateId: string;
  receivedAt: string;
  chatId: string;
  messageId: string;
  callbackQueryId: string;
  callbackData: string;
  user: SanitizedTelegramUser;
};

export type SanitizedTelegramUpdate =
  | SanitizedTelegramMessageUpdate
  | SanitizedTelegramCallbackUpdate;

export type TelegramUpdateIngress = {
  updateId: bigint;
  payloadHash: string;
  updateType: string;
  jobIdempotencyKey?: string;
  payload?: SanitizedTelegramUpdate;
  rejectionCode?: string;
};

export function sanitizeTelegramUpdate(
  rawValue: unknown,
  receivedAt = new Date(),
): TelegramUpdateIngress {
  const raw = asRecord(rawValue);
  const updateId = readBigInt(raw.update_id, 'update_id', true);
  const payloadHash = createHash('sha256')
    .update(JSON.stringify(rawValue), 'utf8')
    .digest('hex');

  try {
    const callback = asOptionalRecord(raw.callback_query);
    if (callback) {
      if (!callback.message) {
        return rejectedIngress(
          updateId,
          payloadHash,
          'callback_query',
          callback.inline_message_id
            ? 'INLINE_CALLBACK_UNSUPPORTED'
            : 'CALLBACK_MESSAGE_REQUIRED',
        );
      }
      return sanitizeCallback(updateId, payloadHash, callback, receivedAt);
    }

    if (raw.edited_message !== undefined) {
      return rejectedIngress(
        updateId,
        payloadHash,
        'edited_message',
        'EDITED_MESSAGE_UNSUPPORTED',
      );
    }
    if (raw.channel_post !== undefined) {
      return rejectedIngress(
        updateId,
        payloadHash,
        'channel_post',
        'PRIVATE_CHAT_REQUIRED',
      );
    }
    const message = asOptionalRecord(raw.message);
    if (message) {
      if (message.sender_chat !== undefined && message.from === undefined) {
        return rejectedIngress(
          updateId,
          payloadHash,
          'message',
          'SENDER_CHAT_UNSUPPORTED',
        );
      }
      if (isTelegramServiceMessage(message)) {
        return rejectedIngress(
          updateId,
          payloadHash,
          'message',
          'SERVICE_MESSAGE_UNSUPPORTED',
        );
      }
      return sanitizeMessage(updateId, payloadHash, message, receivedAt);
    }
  } catch {
    return rejectedIngress(
      updateId,
      payloadHash,
      detectTopLevelUpdateType(raw),
      'MALFORMED_TELEGRAM_UPDATE',
    );
  }

  return rejectedIngress(
    updateId,
    payloadHash,
    'unsupported',
    'UNSUPPORTED_UPDATE',
  );
}

function sanitizeCallback(
  updateId: bigint,
  payloadHash: string,
  callback: Record<string, unknown>,
  receivedAt: Date,
): TelegramUpdateIngress {
  const callbackQueryId = readString(callback.id, 'callback_query.id', 128);
  const message = asRecord(callback.message);
  const chat = asRecord(message.chat);
  if (chat.type !== 'private') {
    return {
      updateId,
      payloadHash,
      updateType: 'callback_query',
      rejectionCode: 'PRIVATE_CHAT_REQUIRED',
    };
  }
  const chatId = readBigInt(chat.id, 'callback_query.message.chat.id');
  const messageId = readBigInt(
    message.message_id,
    'callback_query.message.message_id',
  );
  const user = sanitizeUser(asRecord(callback.from));
  const callbackData = readString(
    callback.data,
    'callback_query.data',
    64,
  );
  const sourceHash = createHash('sha256')
    .update(callbackQueryId, 'utf8')
    .digest('hex');

  return {
    updateId,
    payloadHash,
    updateType: 'callback_query',
    jobIdempotencyKey: `telegram:callback:${sourceHash}`,
    payload: {
      type: 'CALLBACK',
      correlationId: `telegram-update:${updateId.toString()}`,
      updateId: updateId.toString(),
      receivedAt: receivedAt.toISOString(),
      chatId: chatId.toString(),
      messageId: messageId.toString(),
      callbackQueryId,
      callbackData,
      user,
    },
  };
}

function sanitizeMessage(
  updateId: bigint,
  payloadHash: string,
  message: Record<string, unknown>,
  receivedAt: Date,
): TelegramUpdateIngress {
  const chat = asRecord(message.chat);
  if (chat.type !== 'private') {
    return {
      updateId,
      payloadHash,
      updateType: 'message',
      rejectionCode: 'PRIVATE_CHAT_REQUIRED',
    };
  }
  const chatId = readBigInt(chat.id, 'message.chat.id');
  const messageId = readBigInt(message.message_id, 'message.message_id');
  const user = sanitizeUser(asRecord(message.from));
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const voice = asOptionalRecord(message.voice);
  const content = voice
    ? sanitizeVoice(message, voice)
    : text
      ? sanitizeText(text)
      : {
          kind: 'REJECTED' as const,
          rejectedType: detectRejectedMessageType(message),
        };

  return {
    updateId,
    payloadHash,
    updateType: voice ? 'voice' : content.kind.toLowerCase(),
    jobIdempotencyKey: `telegram:message:${chatId.toString()}:${messageId.toString()}`,
    payload: {
      type: 'MESSAGE',
      correlationId: `telegram-update:${updateId.toString()}`,
      updateId: updateId.toString(),
      receivedAt: receivedAt.toISOString(),
      chatId: chatId.toString(),
      messageId: messageId.toString(),
      user,
      content,
    },
  };
}

function sanitizeVoice(
  message: Record<string, unknown>,
  voice: Record<string, unknown>,
): SanitizedTelegramMessageUpdate['content'] {
  const durationSeconds = readSafeInteger(
    voice.duration,
    'message.voice.duration',
    0,
  );
  const messageDateSeconds = readSafeInteger(
    message.date,
    'message.date',
    0,
  );
  const recordingStartedAt = new Date(
    Math.max(0, messageDateSeconds - durationSeconds) * 1_000,
  );
  const sizeBytes =
    voice.file_size === undefined
      ? undefined
      : readBigInt(voice.file_size, 'message.voice.file_size', true).toString();
  return {
    kind: 'VOICE',
    fileId: readString(voice.file_id, 'message.voice.file_id', 256),
    fileUniqueId: readString(
      voice.file_unique_id,
      'message.voice.file_unique_id',
      256,
    ),
    durationSeconds,
    ...(sizeBytes ? { sizeBytes } : {}),
    recordingStartedAt: recordingStartedAt.toISOString(),
  };
}

function sanitizeText(
  text: string,
): SanitizedTelegramMessageUpdate['content'] {
  const startMatch = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/u.exec(text);
  if (startMatch) {
    const token = startMatch[1];
    if (!token) return { kind: 'COMMAND', command: 'START' };
    try {
      return {
        kind: 'COMMAND',
        command: 'START',
        startTokenHash: hashTrainingLinkToken(token),
      };
    } catch {
      return {
        kind: 'COMMAND',
        command: 'START',
        invalidStartToken: true,
      };
    }
  }
  if (/^\/cancel(?:@[A-Za-z0-9_]+)?$/u.test(text)) {
    return { kind: 'COMMAND', command: 'CANCEL' };
  }

  const commands = new Map<string, SanitizedTelegramMessageUpdate['content']>([
    ['Подключение аккаунта', { kind: 'COMMAND', command: 'CONNECT' }],
    ['Выбор проекта', { kind: 'COMMAND', command: 'PROJECTS' }],
    ['Начать аттестацию', { kind: 'COMMAND', command: 'PROJECTS' }],
    ['Мои результаты', { kind: 'COMMAND', command: 'RESULTS' }],
    ['Правила', { kind: 'COMMAND', command: 'RULES' }],
    ['Открыть платформу', { kind: 'COMMAND', command: 'OPEN_PLATFORM' }],
  ]);
  return (
    commands.get(text) ?? {
      kind: 'REJECTED',
      rejectedType: 'text',
    }
  );
}

function detectRejectedMessageType(message: Record<string, unknown>) {
  for (const key of [
    'audio',
    'document',
    'video',
    'video_note',
    'photo',
    'animation',
    'sticker',
    'contact',
    'location',
    'venue',
    'poll',
    'dice',
  ]) {
    if (message[key] !== undefined) return key;
  }
  return 'unsupported';
}

function sanitizeUser(value: Record<string, unknown>): SanitizedTelegramUser {
  const telegramUserId = readBigInt(value.id, 'from.id');
  return {
    telegramUserId: telegramUserId.toString(),
    ...readOptionalString(value.username, 'from.username', 64, 'username'),
    ...readOptionalString(value.first_name, 'from.first_name', 128, 'firstName'),
    ...readOptionalString(value.last_name, 'from.last_name', 128, 'lastName'),
  };
}

function readOptionalString(
  value: unknown,
  label: string,
  maximum: number,
  key: 'username' | 'firstName' | 'lastName',
) {
  if (value === undefined || value === null || value === '') return {};
  return { [key]: readString(value, label, maximum) };
}

function readString(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function readBigInt(value: unknown, label: string, allowZero = false) {
  let parsed: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} is invalid`);
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^\d+$/u.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${label} is invalid`);
  }
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function readSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram update payload is invalid');
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown) {
  return value === undefined || value === null ? null : asRecord(value);
}

function rejectedIngress(
  updateId: bigint,
  payloadHash: string,
  updateType: string,
  rejectionCode: string,
): TelegramUpdateIngress {
  return {
    updateId,
    payloadHash,
    updateType,
    rejectionCode,
  };
}

function detectTopLevelUpdateType(value: Record<string, unknown>) {
  for (const key of [
    'callback_query',
    'message',
    'edited_message',
    'channel_post',
  ]) {
    if (value[key] !== undefined) return key;
  }
  return 'unsupported';
}

function isTelegramServiceMessage(value: Record<string, unknown>) {
  return [
    'new_chat_members',
    'left_chat_member',
    'new_chat_title',
    'new_chat_photo',
    'delete_chat_photo',
    'group_chat_created',
    'supergroup_chat_created',
    'channel_chat_created',
    'message_auto_delete_timer_changed',
    'migrate_to_chat_id',
    'migrate_from_chat_id',
    'pinned_message',
    'forum_topic_created',
    'forum_topic_closed',
    'forum_topic_reopened',
    'general_forum_topic_hidden',
    'general_forum_topic_unhidden',
    'write_access_allowed',
    'users_shared',
    'chat_shared',
  ].some((key) => value[key] !== undefined);
}
