import type { ClientConfig, CasdoorUser, AuthState, TokenResponse } from "../types.js";
import { TokenStorage } from "./storage.js";

export type AuthStateListener = (state: AuthState) => void;

type TokenExchangeResult = {
  token: Pick<TokenResponse, "access_token"> & Partial<TokenResponse>;
  user: CasdoorUser;
};

export class CasdoorClient {
  private config: ClientConfig;
  private storage: TokenStorage;
  private listeners: Set<AuthStateListener> = new Set();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private loginRedirectInProgress = false;
  private callbackInFlight: Promise<boolean> | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private sessionVersion = 0;
  private destroyed = false;
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
    this.apiBase = (config.authApiBase ?? "/api").replace(/\/+$/, "");
    this.storage = new TokenStorage({
      type: config.storage?.type ?? "localStorage",
      ...config.storage,
      prefix: `${config.storage?.prefix ?? "casdoor_"}${config.appName}_`,
    });
    this.initializeState();
  }

  private defaultRedirectUri(): string {
    if (typeof window === "undefined") {
      return "/callback";
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

  /** Start background work from a framework effect, keeping construction side-effect free. */
  start(): void {
    this.destroyed = false;
    if (!this.config.silentRefresh) return;
    if (this.storage.getRefreshToken() && this.storage.isTokenExpiringSoon(this.config.refreshBeforeExpiry ?? 60)) {
      if (!this.state.isAuthenticated) this.updateState({ isLoading: true });
      void this.refreshToken();
    } else if (this.state.isAuthenticated) this.setupRefreshTimer();
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
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private getOAuthStateStorageKey(): string {
    return `casdoor_oauth_state_${this.config.appName}`;
  }

  private getOAuthLoginPendingStorageKey(): string {
    return `casdoor_oauth_login_pending_${this.config.appName}`;
  }

  private clearCallbackQueryParams(): void {
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ["code", "state", "error", "error_description"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }

    const search = url.searchParams.toString();
    window.history.replaceState(
      window.history.state,
      document.title,
      `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
    );
  }

  private markLoginRedirectPending(): void {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(this.getOAuthLoginPendingStorageKey(), Date.now().toString());
    }
  }

  private clearLoginRedirectPending(): void {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(this.getOAuthLoginPendingStorageKey());
    }
  }

  private async postJSON<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Authentication request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  async getLoginUrl(): Promise<string> {
    const state = this.generateState();
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(this.getOAuthStateStorageKey(), state);
    }
    const result = await this.postJSON<{ url: string }>(
      `/apps/${encodeURIComponent(this.config.appName)}/oauth/authorize-url`,
      {
        redirect_uri: this.config.redirectUri,
        state,
      },
    );
    return result.url;
  }

  async getSignupUrl(enablePassword = true): Promise<string> {
    const state = this.generateState();
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(this.getOAuthStateStorageKey(), state);
    }
    const result = await this.postJSON<{ url: string }>(
      `/apps/${encodeURIComponent(this.config.appName)}/oauth/signup-url`,
      {
        redirect_uri: this.config.redirectUri,
        state,
        enable_password: enablePassword,
      },
    );
    return result.url;
  }

  async login(): Promise<void> {
    if (this.loginRedirectInProgress) {
      return;
    }
    // A persisted pending marker cannot resume a navigation after a reload or
    // interrupted request. Let a new explicit login attempt replace it.
    this.clearLoginRedirectPending();
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
    this.sessionVersion += 1;
    this.loginRedirectInProgress = false;
    this.storage.clear();
    this.clearRefreshTimer();
    this.clearLoginRedirectPending();
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(this.getOAuthStateStorageKey());
    }
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

  handleCallback(
    serverExchangeToken?: (code: string, state: string, appName: string) => Promise<TokenExchangeResult>,
  ): Promise<boolean> {
    if (this.callbackInFlight) return this.callbackInFlight;
    const pending = this.completeCallback(serverExchangeToken).finally(() => {
      if (this.callbackInFlight === pending) this.callbackInFlight = null;
    });
    this.callbackInFlight = pending;
    return pending;
  }

  private async completeCallback(
    serverExchangeToken?: (code: string, state: string, appName: string) => Promise<TokenExchangeResult>,
  ): Promise<boolean> {
    const version = this.sessionVersion;
    this.updateState({ isLoading: true });

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const state = urlParams.get("state");
      const error = urlParams.get("error");

      if (error) {
        throw new Error(urlParams.get("error_description") || error);
      }
      if (!code) {
        throw new Error("No authorization code found");
      }
      if (!state) {
        throw new Error("No state found");
      }

      const savedState =
        typeof sessionStorage !== "undefined" ? sessionStorage.getItem(this.getOAuthStateStorageKey()) : null;
      if (!savedState || savedState !== state) {
        throw new Error("Invalid or missing OAuth state");
      }
      sessionStorage.removeItem(this.getOAuthStateStorageKey());
      this.clearLoginRedirectPending();

      const exchange =
        serverExchangeToken ??
        (async (authCode: string, authState: string, appName: string) => {
          return this.postJSON<TokenExchangeResult>(`/apps/${encodeURIComponent(appName)}/oauth/token`, {
            code: authCode,
            state: authState,
          });
        });

      const { token, user } = await exchange(code, state, this.config.appName);
      if (this.destroyed || version !== this.sessionVersion) return false;
      if (!token?.access_token || !user?.id || user.isDeleted || user.isForbidden)
        throw new Error("Invalid authentication response");
      this.storage.clear();
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
      if (this.destroyed || version !== this.sessionVersion) return false;
      this.storage.clear();
      this.clearRefreshTimer();
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(this.getOAuthStateStorageKey());
      this.clearLoginRedirectPending();
      this.clearCallbackQueryParams();
      this.updateState({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        accessToken: null,
        error: err instanceof Error ? err : new Error("Authentication failed"),
      });
      return false;
    }
  }

  refreshToken(
    serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>,
  ): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.completeRefresh(serverRefreshToken).finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  private async completeRefresh(
    serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>,
  ): Promise<boolean> {
    const version = this.sessionVersion;
    const refreshToken = this.storage.getRefreshToken();
    if (!refreshToken) {
      this.logout();
      return false;
    }

    try {
      const refresh =
        serverRefreshToken ??
        (async (token: string, appName: string) => {
          return this.postJSON<TokenResponse>(`/apps/${encodeURIComponent(appName)}/oauth/token/refresh`, {
            refresh_token: token,
          });
        });

      const token = await refresh(refreshToken, this.config.appName);
      if (this.destroyed || version !== this.sessionVersion) return false;
      if (!token?.access_token) throw new Error("Invalid refresh response");
      this.storage.saveToken(token);
      this.updateState({
        isAuthenticated: true,
        isLoading: false,
        user: this.storage.getUser(),
        accessToken: token.access_token,
        error: null,
      });
      if (this.config.silentRefresh) {
        this.setupRefreshTimer();
      }
      return true;
    } catch {
      if (!this.destroyed && version === this.sessionVersion) this.logout();
      return false;
    }
  }

  private setupRefreshTimer(): void {
    this.clearRefreshTimer();
    const expiresAt = this.storage.getExpiresAt();
    if (!expiresAt || this.destroyed) return;

    const refreshBeforeExpiry = (this.config.refreshBeforeExpiry ?? 60) * 1000;
    const timeout = expiresAt - Date.now() - refreshBeforeExpiry;

    // Short-lived tokens still need a timer; avoid a tight loop when TTL < refresh window.
    const delay = timeout > 0 ? timeout : Math.max(1000, (expiresAt - Date.now()) / 2);
    this.refreshTimer = setTimeout(
      () => {
        void this.refreshToken();
      },
      Math.min(delay, 2_147_483_647),
    );
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
    this.destroyed = true;
    this.clearRefreshTimer();
    this.listeners.clear();
  }
}

export function createCasdoorClient(config: ClientConfig): CasdoorClient {
  const client = new CasdoorClient(config);
  client.start();
  return client;
}
