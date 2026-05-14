import { useCallback, useEffect, useMemo, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import type { FileVariant } from '@platforma/shared';

import { apiUrl } from '../admin/api';

export type SecureImageVariant = 'original' | Lowercase<FileVariant>;
export type SecureImageStatus = 'idle' | 'loading' | 'loaded' | 'error';

type UseSecureImageObjectUrlOptions = {
  accessToken: string;
  fileId: string | null;
  lazy?: boolean;
  rootMargin?: string;
  variant?: SecureImageVariant;
};

type UseSecureImageObjectUrlResult = {
  src: string | null;
  status: SecureImageStatus;
  visibilityRef: (node: HTMLElement | null) => void;
};

type SecureImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  accessToken: string;
  errorFallback?: ReactNode;
  fileId: string | null;
  lazy?: boolean;
  loadingFallback?: ReactNode;
  placeholderClassName?: string;
  renderError?: (options: { visibilityRef: (node: HTMLElement | null) => void }) => ReactNode;
  renderFallback?: (options: { status: SecureImageStatus; visibilityRef: (node: HTMLElement | null) => void }) => ReactNode;
  rootMargin?: string;
  variant?: SecureImageVariant;
};

const defaultRootMargin = '240px';

export function SecureImage({
  accessToken,
  alt,
  errorFallback = 'Изображение недоступно',
  fileId,
  lazy = false,
  loadingFallback = 'Загрузка изображения',
  placeholderClassName,
  renderError,
  renderFallback,
  rootMargin = defaultRootMargin,
  variant = 'original',
  ...imageProps
}: SecureImageProps) {
  const { src, status, visibilityRef } = useSecureImageObjectUrl({
    accessToken,
    fileId,
    lazy,
    rootMargin,
    variant,
  });
  const [hasRenderError, setHasRenderError] = useState(false);

  useEffect(() => {
    setHasRenderError(false);
  }, [src]);

  if (status === 'error' || hasRenderError) {
    if (renderError) {
      return renderError({ visibilityRef });
    }

    return (
      <span ref={visibilityRef} className={placeholderClassName}>
        {errorFallback}
      </span>
    );
  }

  if (!src) {
    if (renderFallback) {
      return renderFallback({ status, visibilityRef });
    }

    return (
      <span ref={visibilityRef} className={placeholderClassName}>
        {loadingFallback}
      </span>
    );
  }

  return (
    <img
      {...imageProps}
      alt={alt}
      src={src}
      onError={(event) => {
        setHasRenderError(true);
        imageProps.onError?.(event);
      }}
    />
  );
}

export function useSecureImageObjectUrl({
  accessToken,
  fileId,
  lazy = false,
  rootMargin = defaultRootMargin,
  variant = 'original',
}: UseSecureImageObjectUrlOptions): UseSecureImageObjectUrlResult {
  const normalizedVariant = useMemo(() => normalizeVariant(variant), [variant]);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<SecureImageStatus>('idle');
  const [shouldLoad, setShouldLoad] = useState(!lazy);
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);
  const visibilityRef = useCallback((node: HTMLElement | null) => {
    setTargetElement(node);
  }, []);

  useEffect(() => {
    setSrc(null);
    setStatus('idle');
    setShouldLoad(!lazy);
  }, [accessToken, fileId, lazy, normalizedVariant]);

  useEffect(() => {
    if (!fileId || !lazy || shouldLoad) {
      return;
    }

    if (!targetElement || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(targetElement);

    return () => observer.disconnect();
  }, [fileId, lazy, rootMargin, shouldLoad, targetElement]);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isCancelled = false;
    const abortController = new AbortController();

    if (!accessToken || !fileId || !shouldLoad) {
      return () => undefined;
    }

    setStatus('loading');

    async function loadImage() {
      try {
        const nextObjectUrl = await fetchSecureImageObjectUrl({
          accessToken,
          fileId: fileId ?? '',
          signal: abortController.signal,
          variant: normalizedVariant,
        });

        if (isCancelled) {
          URL.revokeObjectURL(nextObjectUrl);
          return;
        }

        objectUrl = nextObjectUrl;
        setSrc(nextObjectUrl);
        setStatus('loaded');
      } catch (caughtError) {
        if (!isCancelled && !isAbortError(caughtError)) {
          setStatus('error');
        }
      }
    }

    void loadImage();

    return () => {
      isCancelled = true;
      abortController.abort();

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, fileId, normalizedVariant, shouldLoad]);

  return {
    src,
    status,
    visibilityRef,
  };
}

function normalizeVariant(variant: SecureImageVariant): SecureImageVariant {
  return variant === 'original' ? 'original' : variant.toLowerCase() as SecureImageVariant;
}

async function fetchSecureImageObjectUrl({
  accessToken,
  fileId,
  signal,
  variant,
}: {
  accessToken: string;
  fileId: string;
  signal: AbortSignal;
  variant: SecureImageVariant;
}) {
  const params = new URLSearchParams();

  if (variant !== 'original') {
    params.set('variant', variant);
  }
  const queryString = params.toString();
  const url = `${apiUrl}/files/${fileId}/content${queryString ? `?${queryString}` : ''}`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error('Image request failed');
  }

  return URL.createObjectURL(await response.blob());
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
