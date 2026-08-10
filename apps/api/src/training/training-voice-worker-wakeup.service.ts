import { Injectable } from '@nestjs/common';

type TrainingVoiceWorkerWakeupListener = () => void;

@Injectable()
export class TrainingVoiceWorkerWakeupService {
  private readonly listeners = new Set<TrainingVoiceWorkerWakeupListener>();

  subscribe(listener: TrainingVoiceWorkerWakeupListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  kick() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Polling is the fallback; a local wake-up must never fail a committed request.
      }
    }
  }
}
