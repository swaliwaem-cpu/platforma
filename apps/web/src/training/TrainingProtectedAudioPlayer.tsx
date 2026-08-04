import { useEffect, useRef, useState } from 'react';

import { AdminAlert, AdminButton } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { getTrainingAnswerAudio } from './trainingApi';

type TrainingProtectedAudioPlayerProps = {
  answerId: string;
  audioAvailable: boolean;
  canReadAudio: boolean;
};

export function TrainingProtectedAudioPlayer({
  answerId,
  audioAvailable,
  canReadAudio,
}: TrainingProtectedAudioPlayerProps) {
  const { accessToken } = useAuth();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  const clearAudio = () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setAudioUrl(null);
  };

  useEffect(() => () => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  if (!audioAvailable || !canReadAudio) return null;

  const loadAudio = async () => {
    if (!accessToken || isLoading) return;

    controllerRef.current?.abort();
    clearAudio();
    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    controllerRef.current = controller;
    setIsLoading(true);
    setError(null);

    try {
      const response = await getTrainingAnswerAudio(accessToken, answerId, controller.signal);
      const blob = await response.blob();

      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      const nextUrl = URL.createObjectURL(blob);
      audioUrlRef.current = nextUrl;
      setAudioUrl(nextUrl);
    } catch (loadError) {
      if (!controller.signal.aborted && requestIdRef.current === requestId) {
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить аудио');
      }
    } finally {
      if (!controller.signal.aborted && requestIdRef.current === requestId) setIsLoading(false);
    }
  };

  return (
    <div className="training-protected-audio">
      <div>
        <strong>Защищённая запись ответа</strong>
        <small>Загружается только по запросу и не сохраняется в браузере.</small>
      </div>
      {audioUrl ? (
        <>
          <audio controls preload="metadata" src={audioUrl}>Ваш браузер не поддерживает аудио.</audio>
          <AdminButton type="button" tone="text" onClick={clearAudio}>Закрыть запись</AdminButton>
        </>
      ) : (
        <AdminButton type="button" tone="text" disabled={isLoading} onClick={() => void loadAudio()}>
          {isLoading ? 'Загрузка…' : 'Прослушать запись'}
        </AdminButton>
      )}
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
    </div>
  );
}
