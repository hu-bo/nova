import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { CredentialRef, CredentialInfo, CredentialRecord } from "@deepseek-ai/dsh-credentials";

/** This private provider cannot fall back to another tenant's environment. */
export class SessionCredentials extends CredentialProvider {
  key: string | undefined;
  async resolve(ref: CredentialRef) {
    return ref === "SESSION_KEY" && this.key ? { value: this.key, source: "memory" } : undefined;
  }
  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: !!(await this.resolve(ref)), writable: false };
  }
  async set(): Promise<void> {
    throw new Error("Read-only credentials");
  }
  async unset(): Promise<void> {
    throw new Error("Read-only credentials");
  }
  async readRecord(): Promise<CredentialRecord | undefined> {
    return undefined;
  }
  async describeRecord() {
    return { configured: false, writable: false };
  }
  async listRecords() {
    return [];
  }
  async modifyRecord(): Promise<CredentialRecord | undefined> {
    throw new Error("Read-only credentials");
  }
  async deleteRecord(): Promise<void> {
    throw new Error("Read-only credentials");
  }
}
