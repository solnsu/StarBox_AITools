import { ServiceError, type AuthService, type RuntimeCredential } from './auth-service.js';

const TRANSIENT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 5 * 60_000;
const RETRYABLE_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

type CredentialSource = Pick<AuthService, 'getRuntimeCredential' | 'getRuntimeCredentials' | 'moveToEnd'>;
type RoutedResponse = { response: Response; credential: RuntimeCredential };

export class CodexCredentialPool {
  private nextCredentialIndex = 0;
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
        this.cooldown(credential.fileId, TRANSIENT_COOLDOWN_MS);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        try {
          credential = await this.source.getRuntimeCredential(credential.fileId, true);
          response = await request(credential);
        } catch (error) {
          lastFailure = error;
          this.cooldown(credential.fileId, AUTH_COOLDOWN_MS);
          continue;
        }
      }
      if (RETRYABLE_STATUS.has(response.status)) {
        this.cooldown(
          credential.fileId,
          response.status === 401 || response.status === 403 ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS,
        );
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
    const ordered = this.roundRobin(credentials);
    const now = Date.now();
    for (const [id, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(id);
    }
    const available = ordered.filter((credential) => !this.cooldownUntil.has(credential.fileId));
    return available.length ? available : ordered;
  }

  private roundRobin(credentials: RuntimeCredential[]): RuntimeCredential[] {
    if (!credentials.length) return [];
    const start = this.nextCredentialIndex % credentials.length;
    this.nextCredentialIndex = (start + 1) % credentials.length;
    return [...credentials.slice(start), ...credentials.slice(0, start)];
  }

  private cooldown(fileId: string, durationMs: number): void {
    this.cooldownUntil.set(fileId, Date.now() + durationMs);
    if (durationMs === TRANSIENT_COOLDOWN_MS) this.source.moveToEnd(fileId);
  }
}
