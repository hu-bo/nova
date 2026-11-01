// One key per user intent, including manual retries after an ambiguous network response.
export class CommandIntent {
  private payload: string | null = null;
  private key: string | null = null;
  prepare(payload: unknown): string {
    const encoded = JSON.stringify(payload);
    if (this.payload !== encoded || !this.key) {
      this.payload = encoded;
      this.key = crypto.randomUUID();
    }
    return this.key;
  }
  accepted(): void {
    this.payload = null;
    this.key = null;
  }
}
