export async function waitForTrainingWorkerPromise(
  promise: Promise<void>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([
    promise.then(() => true as const),
    timedOut,
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}
