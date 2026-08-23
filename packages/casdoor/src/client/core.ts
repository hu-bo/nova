import type {
  ClientConfig,
  CasdoorUser,
  AuthState,
  TokenResponse,
} from '../types.js';
import { TokenStorage } from './storage.js';

export type AuthStateListener = (state: AuthState) => void;

type TokenExchangeResult = {
  token: Pick<TokenResponse, 'access_token'> & Partial<TokenResponse>;
  user: CasdoorUser;
};

const OAUTH_LOGIN_PENDING_TTL_MS = 5 * 60 * 1000;
const callbackExchangeInFlight = new Map<string, Promise<TokenExchangeResult>>();
const callbackExchangeConsumed = new Set<string>();

export class CasdoorClient {
  private config: ClientConfig;
  private storage: TokenStorage;
  private listeners: Set<AuthStateListener> = new Set();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private loginRedirectInProgress = false;
  private apiBase: string;
  private state: AuthState = {
    isAuthenticated: false,
    isLoading: true,
    user: null,
    accessToken: null,
    error: null,
  };

  constructor(config: ClientConfig) {
    this.config = {
      ...config,
      redirectUri: config.redirectUri ?? this.defaultRedirectUri(),
    };
    this.apiBase = (config.authApiBase ?? '/api').replace(/\/+$/, '');
    this.storage = new TokenStorage({
      type: config.storage?.type ?? 'localStorage',
      ...config.storage,
      prefix: `${config.storage?.prefix ?? 'casdoor_'}${config.appName}_`,
    });
    this.initializeState();
  }

  private defaultRedirectUri(): string {
    if (typeof window === 'undefined') {
      return '/callback';
    }
    return `${window.location.origin}/callback`;
  }

  private initializeState(): void {
    const token = this.storage.getAccessToken();
    const user = this.storage.getUser();

    if (token && !this.storage.isTokenExpired()) {
      this.updateState({
        isAuthenticated: true,
        isLoading: false,
        user,
        accessToken: token,
        error: null,
      });
      if (this.config.silentRefresh) {
        this.setupRefreshTimer();
      }
      return;
    }

    this.updateState({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      accessToken: null,
      error: null,
    });
  }

  private updateState(newState: Partial<AuthState>): void {
    this.state = { ...this.state, ...newState };
    this.listeners.forEach((listener) => listener(this.state));
  }

  subscribe(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): AuthState {
    return this.state;
  }

  private generateState(): string {
    const array = new Uint8Array(16);
    if (typeof crypto !== 'undefined') {
      crypto.getRandomValues(array);
    } else {
      for (let i = 0; i < 16; i += 1) {
        array[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private getOAuthStateStorageKey(): string {
    return `casdoor_oauth_state_${this.config.appName}`;
  }

  private getOAuthLoginPendingStorageKey(): string {
    return `casdoor_oauth_login_pending_${this.config.appName}`;
  }

  private getCallbackExchangeKey(code: string, state: string): string {
    return `${this.config.appName}:${state}:${code}`;
  }

  private clearCallbackQueryParams(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['code', 'state', 'error', 'error_description']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }

    const search = url.searchParams.toString();
    window.history.replaceState({}, document.title, `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
  }

  private hasPendingLoginRedirect(): boolean {
    if (typeof sessionStorage === 'undefined') {
      return false;
    }

    const pendingAt = Number(sessionStorage.getItem(this.getOAuthLoginPendingStorageKey()));
    if (!Number.isFinite(pendingAt)) {
      return false;
    }

    if (Date.now() - pendingAt > OAUTH_LOGIN_PENDING_TTL_MS) {
      sessionStorage.removeItem(this.getOAuthLoginPendingStorageKey());
      return false;
    }

    return true;
  }

  private markLoginRedirectPending(): void {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(this.getOAuthLoginPendingStorageKey(), Date.now().toString());
    }
  }

  private clearLoginRedirectPending(): void {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(this.getOAuthLoginPendingStorageKey());
    }
  }

  private async postJSON<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `request failed: ${response.status}`;
      try {
        const data = (await response.json()) as { error?: string; message?: string };
        message = data.message || data.error || message;
      } catch {
        // Keep the status-only fallback when the server did not return JSON.
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }

  async getLoginUrl(): Promise<string> {
    const state = this.generateState();
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(this.getOAuthStateStorageKey(), state);
    }
    const result = await this.postJSON<{ url: string }>(
      `/apps/${encodeURIComponent(this.config.appName)}/oauth/authorize-url`,
      {
        redirect_uri: this.config.redirectUri,
        state,
      }
    );
    return result.url;
  }

  async getSignupUrl(enablePassword = true): Promise<string> {
    const state = this.generateState();
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(this.getOAuthStateStorageKey(), state);
    }
    const result = await this.postJSON<{ url: string }>(
      `/apps/${encodeURIComponent(this.config.appName)}/oauth/signup-url`,
      {
        redirect_uri: this.config.redirectUri,
        state,
        enable_password: enablePassword,
      }
    );
    return result.url;
  }

  async login(): Promise<void> {
    if (this.loginRedirectInProgress || this.hasPendingLoginRedirect()) {
      return;
    }
    this.loginRedirectInProgress = true;
    this.markLoginRedirectPending();

    try {
      const url = await this.getLoginUrl();
      window.location.href = url;
    } catch (err) {
      this.loginRedirectInProgress = false;
      this.clearLoginRedirectPending();
      throw err;
    }
  }

  async signup(): Promise<void> {
    const url = await this.getSignupUrl(true);
    window.location.href = url;
  }

  logout(): void {
    this.storage.clear();
    this.clearRefreshTimer();
    this.clearLoginRedirectPending();
    this.updateState({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      accessToken: null,
      error: null,
    });

    const logoutUri = this.config.logoutRedirectUri;
    if (logoutUri) {
      window.location.href = logoutUri;
    }
  }

  async handleCallback(
    serverExchangeToken?: (code: string, state: string, appName: string) => Promise<TokenExchangeResult>
  ): Promise<boolean> {
    this.updateState({ isLoading: true });

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');
      const error = urlParams.get('error');

      if (error) {
        throw new Error(urlParams.get('error_description') || error);
      }
      if (!code) {
        throw new Error('No authorization code found');
      }
      if (!state) {
        throw new Error('No state found');
      }

      if (typeof sessionStorage !== 'undefined') {
        const savedState = sessionStorage.getItem(this.getOAuthStateStorageKey());
        if (savedState && savedState !== state) {
          throw new Error('Invalid state parameter');
        }
        sessionStorage.removeItem(this.getOAuthStateStorageKey());
      }
      this.clearLoginRedirectPending();

      const exchangeKey = this.getCallbackExchangeKey(code, state);
      const exchange = serverExchangeToken ?? (async (authCode: string, authState: string, appName: string) => {
        return this.postJSON<TokenExchangeResult>(
          `/apps/${encodeURIComponent(appName)}/oauth/token`,
          {
            code: authCode,
            state: authState,
          }
        );
      });

      let exchangePromise = callbackExchangeInFlight.get(exchangeKey);
      if (!exchangePromise) {
        if (callbackExchangeConsumed.has(exchangeKey)) {
          throw new Error('Authorization code has already been processed');
        }
        callbackExchangeConsumed.add(exchangeKey);
        exchangePromise = exchange(code, state, this.config.appName).finally(() => {
          callbackExchangeInFlight.delete(exchangeKey);
        });
        callbackExchangeInFlight.set(exchangeKey, exchangePromise);
      }

      const { token, user } = await exchangePromise;
      this.storage.saveToken(token);
      this.storage.saveUser(user);
      this.updateState({
        isAuthenticated: true,
        isLoading: false,
        user,
        accessToken: token.access_token,
        error: null,
      });

      if (this.config.silentRefresh) {
        this.setupRefreshTimer();
      }
      this.clearCallbackQueryParams();
      return true;
    } catch (err) {
      this.clearLoginRedirectPending();
      this.clearCallbackQueryParams();
      this.updateState({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        accessToken: null,
        error: err instanceof Error ? err : new Error('Unknown error'),
      });
      return false;
    }
  }

  async refreshToken(
    serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>
  ): Promise<boolean> {
    const refreshToken = this.storage.getRefreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      const refresh = serverRefreshToken ?? (async (token: string, appName: string) => {
        return this.postJSON<TokenResponse>(
          `/apps/${encodeURIComponent(appName)}/oauth/token/refresh`,
          { refresh_token: token }
        );
      });

      const token = await refresh(refreshToken, this.config.appName);
      this.storage.saveToken(token);
      this.updateState({
        isAuthenticated: true,
        isLoading: false,
        accessToken: token.access_token,
        error: null,
      });
      if (this.config.silentRefresh) {
        this.setupRefreshTimer();
      }
      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  private setupRefreshTimer(): void {
    this.clearRefreshTimer();
    const expiresAt = this.storage.getExpiresAt();
    if (!expiresAt) return;

    const refreshBeforeExpiry = (this.config.refreshBeforeExpiry ?? 60) * 1000;
    const timeout = expiresAt - Date.now() - refreshBeforeExpiry;

    if (timeout > 0) {
      this.refreshTimer = setTimeout(async () => {
        this.updateState({ isLoading: true });
        const refreshed = await this.refreshToken();
        if (!refreshed) {
          this.updateState({ isLoading: false });
        }
      }, timeout);
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getAccessToken(): string | null {
    return this.storage.getAccessToken();
  }

  getUser(): CasdoorUser | null {
    return this.storage.getUser();
  }

  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  destroy(): void {
    this.clearRefreshTimer();
    this.listeners.clear();
  }
}

export function createCasdoorClient(config: ClientConfig): CasdoorClient {
  return new CasdoorClient(config);
}
