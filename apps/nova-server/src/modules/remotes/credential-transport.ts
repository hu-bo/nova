import { DomainError } from "../../shared/domain-error.js";
import { deriveTransportSecret, openCredential, wrapTransportSecret } from "../../shared/credential-transport.js";

/** 明文凭据长度上限: 与 remote.schema.ts 的信封上限对应。 */
export const CREDENTIAL_MAX_LENGTH = 65_536;
export const PASSPHRASE_MAX_LENGTH = 1_000;

/**
 * SSH 凭据的传输层信封:
 * - 下发传输密钥 (用 Bearer token 派生的 wrap key 加密, 响应体不含明文密钥);
 * - 打开请求体里的凭据信封, 得到明文后交给 service 按原有逻辑加密落库。
 *
 * 服务端只接受信封格式, 明文凭据一律拒绝, 避免密码出现在请求体里。
 */
export class RemoteCredentialTransport {
  constructor(private readonly masterKeyHex: string | undefined) {}

  /** 供客户端解包传输密钥的密文信封。 */
  issueKey(token: string): string {
    return wrapTransportSecret(deriveTransportSecret(this.masterKeyHex), token);
  }

  open(token: string, envelope: string, maxLength: number): string {
    const plaintext = openCredential(envelope, deriveTransportSecret(this.masterKeyHex));
    if (plaintext.length > maxLength)
      throw new DomainError("VALIDATION_ERROR", "凭据长度超出限制", { reason: "CREDENTIAL_ENVELOPE_INVALID" });
    return plaintext;
  }

  /** 口令: undefined 表示保持不变, 空串表示清除, 其余按信封解开。 */
  openOptional(token: string, envelope: string | undefined, maxLength: number): string | undefined {
    if (envelope === undefined || envelope === "") return envelope;
    return this.open(token, envelope, maxLength);
  }
}
