export class TrainingAudioObjectUrl {
  constructor(urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>);
  replace(blob: Blob): string;
  revoke(): void;
}
