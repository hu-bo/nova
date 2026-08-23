/** Casdoor server-side SDK configuration. */
export interface CasdoorConfig {
  /** Casdoor server URL, for example https://auth.example.com. */
  endpoint: string;
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. Server-side only. */
  clientSecret?: string;
  /** Casdoor organization name. */
  orgName: string;
  /** Casdoor application name. */
  appName: string;
  /** Certificate used to verify JWTs. Server-side only. */
  certificate?: string;
}

/** Casdoor user profile. */
export interface CasdoorUser {
  id: string;
  owner: string;
  name: string;
  displayName: string;
  avatar: string;
  email: string;
  phone: string;
  type: string;
  createdTime: string;
  updatedTime: string;
  isAdmin: boolean;
  isGlobalAdmin: boolean;
  isForbidden: boolean;
  isDeleted: boolean;
  signupApplication: string;
  score: number;
  ranking: number;
  properties: Record<string, string>;
  roles: CasdoorRole[];
  permissions: CasdoorPermission[];
}

/** Casdoor role. */
export interface CasdoorRole {
  owner: string;
  name: string;
  displayName: string;
  description: string;
  users: string[];
  roles: string[];
  isEnabled: boolean;
}

/** Casdoor permission. */
export interface CasdoorPermission {
  owner: string;
  name: string;
  displayName: string;
  description: string;
  users: string[];
  roles: string[];
  domains: string[];
  model: string;
  adapter: string;
  resourceType: string;
  resources: string[];
  actions: string[];
  effect: string;
  isEnabled: boolean;
}

/** OAuth token response. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

/** JWT claims. */
export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  name?: string;
  owner?: string;
  [key: string]: unknown;
}

/** Browser token storage configuration. */
export interface StorageConfig {
  /** Storage type. Defaults to localStorage. */
  type: 'localStorage' | 'sessionStorage' | 'memory';
  /** Storage key prefix. */
  prefix?: string;
  /** Access token storage key. */
  accessTokenKey?: string;
  /** Refresh token storage key. */
  refreshTokenKey?: string;
  /** User profile storage key. */
  userKey?: string;
}

/** Browser SDK configuration. Secrets and Casdoor server details stay in auth-service. */
export interface ClientConfig {
  /** Application name configured in auth-service. */
  appName: string;
  /** Auth service API base path. Defaults to /api. */
  authApiBase?: string;
  /** OAuth callback URL. Defaults to `${window.location.origin}/callback`. */
  redirectUri?: string;
  /** Optional post-logout redirect URL. */
  logoutRedirectUri?: string;
  /** Storage configuration. Defaults to localStorage with token expiry tracking. */
  storage?: StorageConfig;
  /** Automatically refresh tokens before expiry. Defaults to false. */
  silentRefresh?: boolean;
  /** Seconds before expiry to refresh. Defaults to 60. */
  refreshBeforeExpiry?: number;
}

/** Authentication state. */
export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: CasdoorUser | null;
  accessToken: string | null;
  error: Error | null;
}

/** Server-side auth result. */
export interface AuthResult {
  valid: boolean;
  user?: CasdoorUser;
  claims?: JwtClaims;
  error?: string;
}
