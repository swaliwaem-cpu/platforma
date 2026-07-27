import { spawn } from 'node:child_process';

import { Injectable } from '@nestjs/common';

import { TrainingAudioError } from './training-audio.error';

export const TRAINING_AUDIO_PROCESS_RUNNER = Symbol(
  'TRAINING_AUDIO_PROCESS_RUNNER',
);

const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;

export type TrainingAudioProcessInput = {
  command: 'ffmpeg' | 'ffprobe';
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
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      let timedOut = false;

      const finish = (
        operation: () => void,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        operation();
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        capturedBytes += chunk.length;
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(() =>
            reject(
              new TrainingAudioError(
                input.command === 'ffmpeg'
                  ? 'FFMPEG_FAILED'
                  : 'FFPROBE_FAILED',
                false,
              ),
            ),
          );
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
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
        finish(() => {
          if (timedOut) {
            reject(
              new TrainingAudioError(
                input.command === 'ffmpeg'
                  ? 'FFMPEG_TIMEOUT'
                  : 'FFPROBE_TIMEOUT',
                true,
              ),
            );
            return;
          }
          if (code !== 0) {
            reject(
              new TrainingAudioError(
                input.command === 'ffmpeg'
                  ? 'FFMPEG_FAILED'
                  : 'FFPROBE_FAILED',
                false,
              ),
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
        timedOut = true;
        child.kill('SIGKILL');
      }, input.timeoutMs);
      timeout.unref();
    });
  }
}
