import { spawn } from 'node:child_process';

import { Injectable } from '@nestjs/common';

import { TrainingAudioError } from './training-audio.error';

export const TRAINING_AUDIO_PROCESS_RUNNER = Symbol(
  'TRAINING_AUDIO_PROCESS_RUNNER',
);

const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_KILL_WAIT_MS = 2_000;
const PROCESS_EXIT_POLL_MS = 10;

export type TrainingAudioProcessInput = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

export type TrainingAudioProcessResult = {
  stdout: string;
  stderr: string;
};

export interface TrainingAudioProcessRunner {
  run(input: TrainingAudioProcessInput): Promise<TrainingAudioProcessResult>;
}

@Injectable()
export class NodeTrainingAudioProcessRunner
  implements TrainingAudioProcessRunner
{
  run(input: TrainingAudioProcessInput) {
    return new Promise<TrainingAudioProcessResult>((resolve, reject) => {
      const usesProcessGroup = process.platform !== 'win32';
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        shell: false,
        detached: usesProcessGroup,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      let timedOut = false;
      let terminationStarted = false;
      let closeObserved = false;
      let resolveClose: (() => void) | null = null;
      const closePromise = new Promise<void>((resolvePromise) => {
        resolveClose = resolvePromise;
      });

      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        operation();
      };
      const processErrorCode = () =>
        input.command === 'ffmpeg'
          ? 'FFMPEG_FAILED'
          : 'FFPROBE_FAILED';
      const timeoutErrorCode = () =>
        input.command === 'ffmpeg'
          ? 'FFMPEG_TIMEOUT'
          : 'FFPROBE_TIMEOUT';
      const terminateForFailure = async (
        error: TrainingAudioError,
      ) => {
        if (terminationStarted || settled) return;
        terminationStarted = true;
        await terminateProcessTree({
          child,
          signal: 'SIGKILL',
          usesProcessGroup,
          closePromise,
        });
        finish(() => reject(error));
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        capturedBytes += chunk.length;
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          void terminateForFailure(
            new TrainingAudioError(processErrorCode(), false),
          );
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        closeObserved = true;
        resolveClose?.();
        finish(() =>
          reject(
            new TrainingAudioError(
              error.code === 'ENOENT'
                ? 'FFMPEG_NOT_AVAILABLE'
                : input.command === 'ffmpeg'
                  ? 'FFMPEG_FAILED'
                  : 'FFPROBE_FAILED',
              false,
            ),
          ),
        );
      });
      child.once('close', (code) => {
        closeObserved = true;
        resolveClose?.();
        if (timedOut || terminationStarted) return;
        finish(() => {
          if (code !== 0) {
            reject(
              new TrainingAudioError(processErrorCode(), false),
            );
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
      });

      const timeout = setTimeout(() => {
        if (settled || closeObserved) return;
        timedOut = true;
        terminationStarted = true;
        void (async () => {
          await terminateProcessTree({
            child,
            signal: 'SIGTERM',
            usesProcessGroup,
            closePromise,
            graceMs: PROCESS_TERMINATION_GRACE_MS,
          });
          finish(() =>
            reject(
              new TrainingAudioError(timeoutErrorCode(), true),
            ),
          );
        })();
      }, input.timeoutMs);
      timeout.unref();
    });
  }
}

async function terminateProcessTree(input: {
  child: ReturnType<typeof spawn>;
  signal: NodeJS.Signals;
  usesProcessGroup: boolean;
  closePromise: Promise<void>;
  graceMs?: number;
}) {
  const pid = input.child.pid;
  if (!pid) {
    await waitBounded(input.closePromise, PROCESS_KILL_WAIT_MS);
    return;
  }
  if (input.usesProcessGroup) {
    signalProcessGroup(pid, input.signal);
    if (input.signal === 'SIGTERM') {
      const exitedDuringGrace = await waitForProcessGroupExit(
        pid,
        input.graceMs ?? PROCESS_TERMINATION_GRACE_MS,
      );
      if (!exitedDuringGrace) {
        signalProcessGroup(pid, 'SIGKILL');
      }
    }
    await waitForProcessGroupExit(pid, PROCESS_KILL_WAIT_MS);
    await waitBounded(input.closePromise, PROCESS_KILL_WAIT_MS);
    return;
  }

  if (input.child.exitCode === null && input.child.signalCode === null) {
    input.child.kill(input.signal);
  }
  if (input.signal === 'SIGTERM') {
    const closed = await waitBounded(
      input.closePromise,
      input.graceMs ?? PROCESS_TERMINATION_GRACE_MS,
    );
    if (
      !closed &&
      input.child.exitCode === null &&
      input.child.signalCode === null
    ) {
      input.child.kill('SIGKILL');
    }
  }
  await waitBounded(input.closePromise, PROCESS_KILL_WAIT_MS);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  if (!processGroupExists(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXIT_POLL_MS);
  }
  return true;
}

function processGroupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ESRCH'
  );
}

async function waitBounded(promise: Promise<void>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | null = null;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
