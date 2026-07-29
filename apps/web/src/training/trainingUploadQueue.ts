export type TrainingUploadQueueItem = {
  id: string;
  file: File;
  status: 'QUEUED' | 'UPLOADING' | 'SUCCEEDED' | 'FAILED';
  error: string | null;
};

export async function runTrainingUploadQueue(
  items: TrainingUploadQueueItem[],
  upload: (file: File) => Promise<unknown>,
  onChange: (items: TrainingUploadQueueItem[]) => void,
  concurrency = 2,
) {
  const nextItems = items.map((item) => ({ ...item }));
  let cursor = 0;

  const publish = () => onChange(nextItems.map((item) => ({ ...item })));
  const worker = async () => {
    while (cursor < nextItems.length) {
      const index = cursor;
      cursor += 1;
      const item = nextItems[index];
      if (!item) continue;

      item.status = 'UPLOADING';
      publish();
      try {
        await upload(item.file);
        item.status = 'SUCCEEDED';
      } catch (error) {
        item.status = 'FAILED';
        item.error = error instanceof Error ? error.message : 'Файл не загружен';
      }
      publish();
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), nextItems.length) },
      () => worker(),
    ),
  );

  return nextItems;
}
