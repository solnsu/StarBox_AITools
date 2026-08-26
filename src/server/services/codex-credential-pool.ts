import { ServiceError, type AuthService, type RuntimeCredential } from './auth-service.js';

const CREDENTIAL_COOLDOWN_MS = 60_000;
const RETRYABLE_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

type CredentialSource = Pick<AuthService, 'getRuntimeCredential' | 'getRuntimeCredentials' | 'moveToEnd'>;
type RoutedResponse = { response: Response; credential: RuntimeCredential };

export class CodexCredentialPool {
  private readonly cooldownUntil = new Map<string, number>();

  constructor(private readonly source: CredentialSource) {}

  async execute(
    request: (credential: RuntimeCredential) => Promise<Response>,
  ): Promise<RoutedResponse> {
    const candidates = await this.candidates();
    let lastFailure: unknown = null;
    for (const [index, initialCredential] of candidates.entries()) {
      let credential = initialCredential;
      let response: Response;
      try {
        response = await request(credential);
      } catch (error) {
        lastFailure = error;
        this.cooldown(credential.fileId);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        try {
          credential = await this.source.getRuntimeCredential(credential.fileId, true);
          response = await request(credential);
        } catch (error) {
          lastFailure = error;
          this.cooldown(credential.fileId);
          continue;
        }
      }
      if (RETRYABLE_STATUS.has(response.status)) {
        this.cooldown(credential.fileId);
        if (index < candidates.length - 1) {
          await response.body?.cancel();
          continue;
        }
      }
      return { response, credential };
    }
    if (lastFailure instanceof Error) throw lastFailure;
    throw new ServiceError('UPSTREAM_UNAVAILABLE', 502);
  }

  private async candidates(): Promise<RuntimeCredential[]> {
    const credentials = await this.source.getRuntimeCredentials();
    const now = Date.now();
    for (const [id, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(id);
    }
    return credentials.filter((credential) => !this.cooldownUntil.has(credential.fileId));
  }

  private cooldown(fileId: string): void {
    this.cooldownUntil.set(fileId, Date.now() + CREDENTIAL_COOLDOWN_MS);
    this.source.moveToEnd(fileId);
  }
}
