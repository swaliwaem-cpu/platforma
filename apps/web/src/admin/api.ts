import type { AuthResponse } from '@platforma/shared';

export const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const apiAuthUpdatedEventName = 'platforma-auth-updated';
export const apiAuthClearedEventName = 'platforma-auth-cleared';

const apiConnectionErrorMessage = 'Не удалось связаться с сервером';

let currentAccessToken: string | null = null;
let refreshSessionPromise: Promise<AuthResponse> | null = null;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: string[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function setApiAccessToken(accessToken: string | null) {
  currentAccessToken = accessToken;
}

export async function apiRequest<T = unknown>(
  path: string,
  accessToken: string,
  options: RequestInit = {},
) {
  const initialToken = currentAccessToken ?? accessToken;
  let response: Response;

  try {
    response = await sendApiRequest(path, initialToken, options);
  } catch {
    throw new Error(apiConnectionErrorMessage);
  }

  if (response.status === 401) {
    const refreshedSession = await refreshApiSession();

    try {
      response = await sendApiRequest(path, refreshedSession.accessToken, options);
    } catch {
      throw new Error(apiConnectionErrorMessage);
    }
  }

  if (!response.ok) {
    const error = await resolveApiError(response);
    throw new ApiRequestError(error.message, response.status, error.errors);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

export async function apiDownload(
  path: string,
  accessToken: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const initialToken = currentAccessToken ?? accessToken;
  let response: Response;

  try {
    response = await sendApiRequest(path, initialToken, {
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(apiConnectionErrorMessage, 0);
  }

  if (response.status === 401) {
    const refreshedSession = await waitForAbortable(
      refreshApiSession(),
      options.signal,
    );
    try {
      response = await sendApiRequest(path, refreshedSession.accessToken, {
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiRequestError(apiConnectionErrorMessage, 0);
    }
  }

  if (!response.ok) {
    const error = await resolveApiError(response);
    throw new ApiRequestError(error.message, response.status, error.errors);
  }

  return {
    blob: await response.blob(),
    filename: getContentDispositionFilename(response.headers.get('Content-Disposition')),
  };
}

async function sendApiRequest(path: string, accessToken: string, options: RequestInit) {
  const isFormData = options.body instanceof FormData;

  return fetch(`${apiUrl}${path}`, {
    ...options,
    cache: options.cache ?? 'no-store',
    credentials: 'include',
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });
}

async function refreshApiSession() {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  refreshSessionPromise = fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await resolveErrorMessage(response));
      }

      return (await response.json()) as AuthResponse;
    })
    .then((session) => {
      currentAccessToken = session.accessToken;
      window.dispatchEvent(new CustomEvent<AuthResponse>(apiAuthUpdatedEventName, { detail: session }));

      return session;
    })
    .catch((error) => {
      currentAccessToken = null;
      window.dispatchEvent(new Event(apiAuthClearedEventName));

      throw error;
    })
    .finally(() => {
      refreshSessionPromise = null;
    });

  return refreshSessionPromise;
}

async function resolveErrorMessage(response: Response) {
  return (await resolveApiError(response)).message;
}

async function resolveApiError(response: Response) {
  if (response.status === 413) {
    return {
      message: 'Слишком большой запрос: уменьшите размер файлов или загрузите меньше изображений',
      errors: [] as string[],
    };
  }

  try {
    const data = (await response.json()) as {
      message?: string | string[];
      errors?: unknown;
    };
    const message = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    const errors = Array.isArray(data.errors)
      ? data.errors.filter((item): item is string => typeof item === 'string')
      : [];

    return { message: message || 'Запрос не выполнен', errors };
  } catch {
    return { message: 'Запрос не выполнен', errors: [] as string[] };
  }
}

function getContentDispositionFilename(value: string | null) {
  if (!value) return null;

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  return value.match(/filename="([^"]+)"/iu)?.[1] ?? null;
}

function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createAbortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
