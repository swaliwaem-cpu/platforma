export class TrainingAudioObjectUrl {
  #current = null;
  #urlApi;

  constructor(urlApi = URL) {
    this.#urlApi = urlApi;
  }

  replace(blob) {
    this.revoke();
    this.#current = this.#urlApi.createObjectURL(blob);
    return this.#current;
  }

  revoke() {
    if (!this.#current) return;
    this.#urlApi.revokeObjectURL(this.#current);
    this.#current = null;
  }
}
