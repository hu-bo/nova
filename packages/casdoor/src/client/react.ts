import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  createContext,
  useContext,
  createElement,
  type ReactNode,
} from 'react';
import type { ClientConfig, AuthState, CasdoorUser, TokenResponse } from '../types.js';
import { CasdoorClient } from './core.js';

/**
 * Casdoor Context
 */
const CasdoorContext = createContext<CasdoorClient | null>(null);

type ServerExchangeToken = (
  code: string,
  state: string,
  appName: string
) => Promise<{ token: TokenResponse; user: CasdoorUser }>;

export interface CasdoorCallbackOptions {
  onSuccess?: (user: CasdoorUser) => void;
  onError?: (error: Error) => void;
}

/**
 * Casdoor Provider Props
 */
export interface CasdoorProviderProps {
  config: ClientConfig;
  children: ReactNode;
}

/**
 * Casdoor Provider 组件
 */
export function CasdoorProvider({ config, children }: CasdoorProviderProps): ReactNode {
  const client = useMemo(() => new CasdoorClient(config), [
    config.appName,
    config.authApiBase,
    config.redirectUri,
    config.logoutRedirectUri,
    config.silentRefresh,
    config.refreshBeforeExpiry,
    config.storage?.type,
    config.storage?.prefix,
    config.storage?.accessTokenKey,
    config.storage?.refreshTokenKey,
    config.storage?.userKey,
  ]);

  useEffect(() => {
    return () => client.destroy();
  }, [client]);

  return createElement(CasdoorContext.Provider, { value: client }, children);
}

/**
 * 获取 Casdoor 客户端
 */
export function useCasdoorClient(): CasdoorClient {
  const client = useContext(CasdoorContext);
  if (!client) {
    throw new Error('useCasdoorClient must be used within a CasdoorProvider');
  }
  return client;
}

export interface UseCasdoorReturn {
  /** 是否已认证 */
  isAuthenticated: boolean;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 当前用户 */
  user: CasdoorUser | null;
  /** Access Token */
  accessToken: string | null;
  /** 错误信息 */
  error: Error | null;
  /** 跳转到登录页 */
  login: () => Promise<void>;
  /** 跳转到注册页 */
  signup: () => Promise<void>;
  /** 登出 */
  logout: () => void;
  /** 获取登录 URL（不跳转） */
  getLoginUrl: () => Promise<string>;
  /** 获取注册 URL（不跳转） */
  getSignupUrl: () => Promise<string>;
  /** 处理 OAuth 回调 */
  handleCallback: (serverExchangeToken?: ServerExchangeToken) => Promise<boolean>;
  /** 刷新 Token */
  refreshToken: (serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>) => Promise<boolean>;
}

/**
 * React Hook - Casdoor 认证
 */
export function useCasdoor(): UseCasdoorReturn {
  const client = useCasdoorClient();
  const [state, setState] = useState<AuthState>(client.getState());

  useEffect(() => {
    return client.subscribe(setState);
  }, [client]);

  const login = useCallback(() => client.login(), [client]);
  const signup = useCallback(() => client.signup(), [client]);
  const logout = useCallback(() => client.logout(), [client]);
  const getLoginUrl = useCallback(() => client.getLoginUrl(), [client]);
  const getSignupUrl = useCallback(() => client.getSignupUrl(), [client]);

  const handleCallback = useCallback((serverExchangeToken?: ServerExchangeToken) => client.handleCallback(serverExchangeToken), [
    client,
  ]);

  const refreshToken = useCallback(
    (serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>) =>
      client.refreshToken(serverRefreshToken),
    [client]
  );

  return {
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
    user: state.user,
    accessToken: state.accessToken,
    error: state.error,
    login,
    signup,
    logout,
    getLoginUrl,
    getSignupUrl,
    handleCallback,
    refreshToken,
  };
}

/**
 * React Hook - 仅用于回调页面
 */
export function useCasdoorCallback(options?: CasdoorCallbackOptions): {
  isLoading: boolean;
  success: boolean;
  error: Error | null;
};
export function useCasdoorCallback(
  serverExchangeToken?: ServerExchangeToken,
  options?: CasdoorCallbackOptions
): { isLoading: boolean; success: boolean; error: Error | null };
export function useCasdoorCallback(
  serverExchangeTokenOrOptions?: ServerExchangeToken | CasdoorCallbackOptions,
  options?: CasdoorCallbackOptions
): { isLoading: boolean; success: boolean; error: Error | null } {
  const serverExchangeToken = typeof serverExchangeTokenOrOptions === 'function' ? serverExchangeTokenOrOptions : undefined;
  const callbackOptions = typeof serverExchangeTokenOrOptions === 'function' ? options : serverExchangeTokenOrOptions;
  const client = useCasdoorClient();
  const [isLoading, setIsLoading] = useState(true);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    const handle = async () => {
      const result = await client.handleCallback(serverExchangeToken);
      if (!mounted) return;

      setIsLoading(false);
      setSuccess(result);

      if (result) {
        callbackOptions?.onSuccess?.(client.getUser()!);
      } else {
        const state = client.getState();
        if (state.error) {
          setError(state.error);
          callbackOptions?.onError?.(state.error);
        }
      }
    };

    handle();

    return () => {
      mounted = false;
    };
  }, [client, serverExchangeToken, callbackOptions?.onSuccess, callbackOptions?.onError]);

  return { isLoading, success, error };
}

/**
 * React Hook - 需要认证的路由保护
 */
export function useRequireAuth(options?: {
  redirectTo?: string;
  enabled?: boolean;
}): { isAuthenticated: boolean; isLoading: boolean } {
  const { isAuthenticated, isLoading, login } = useCasdoor();
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (enabled && !isLoading && !isAuthenticated) {
      if (options?.redirectTo) {
        window.location.href = options.redirectTo;
      } else {
        login();
      }
    }
  }, [enabled, isLoading, isAuthenticated, login, options?.redirectTo]);

  return { isAuthenticated, isLoading };
}
