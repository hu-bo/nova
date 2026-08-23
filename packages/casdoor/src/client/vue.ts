import { ref, readonly, onMounted, onUnmounted, type Ref, type DeepReadonly } from 'vue';
import type { ClientConfig, AuthState, CasdoorUser, TokenResponse } from '../types.js';
import { CasdoorClient } from './core.js';

let globalClient: CasdoorClient | null = null;

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
 * 初始化 Casdoor 客户端 (应在应用入口调用一次)
 */
export function initCasdoor(config: ClientConfig): CasdoorClient {
  globalClient = new CasdoorClient(config);
  return globalClient;
}

/**
 * 获取全局客户端实例
 */
export function getCasdoorClient(): CasdoorClient {
  if (!globalClient) {
    throw new Error('Casdoor client not initialized. Call initCasdoor() first.');
  }
  return globalClient;
}

export interface UseCasdoorReturn {
  /** 是否已认证 */
  isAuthenticated: DeepReadonly<Ref<boolean>>;
  /** 是否正在加载 */
  isLoading: DeepReadonly<Ref<boolean>>;
  /** 当前用户 */
  user: DeepReadonly<Ref<CasdoorUser | null>>;
  /** Access Token */
  accessToken: DeepReadonly<Ref<string | null>>;
  /** 错误信息 */
  error: DeepReadonly<Ref<Error | null>>;
  /** 跳转到登录页 */
  login: () => Promise<void>;
  /** 跳转到注册页 */
  signup: () => Promise<void>;
  /** 登出 */
  logout: () => void;
  /** 处理 OAuth 回调 */
  handleCallback: (serverExchangeToken?: ServerExchangeToken) => Promise<boolean>;
  /** 刷新 Token */
  refreshToken: (serverRefreshToken?: (refreshToken: string, appName: string) => Promise<TokenResponse>) => Promise<boolean>;
  /** 获取客户端实例 */
  getClient: () => CasdoorClient;
}

/**
 * Vue Composable - Casdoor 认证
 */
export function useCasdoor(): UseCasdoorReturn {
  const client = getCasdoorClient();

  const isAuthenticated = ref(false);
  const isLoading = ref(true);
  const user = ref<CasdoorUser | null>(null);
  const accessToken = ref<string | null>(null);
  const error = ref<Error | null>(null);

  let unsubscribe: (() => void) | null = null;

  const updateFromState = (state: AuthState) => {
    isAuthenticated.value = state.isAuthenticated;
    isLoading.value = state.isLoading;
    user.value = state.user;
    accessToken.value = state.accessToken;
    error.value = state.error;
  };

  onMounted(() => {
    unsubscribe = client.subscribe(updateFromState);
  });

  onUnmounted(() => {
    unsubscribe?.();
  });

  // 立即获取当前状态
  updateFromState(client.getState());

  return {
    isAuthenticated: readonly(isAuthenticated),
    isLoading: readonly(isLoading),
    user: readonly(user) as DeepReadonly<Ref<CasdoorUser | null>>,
    accessToken: readonly(accessToken),
    error: readonly(error) as DeepReadonly<Ref<Error | null>>,
    login: () => client.login(),
    signup: () => client.signup(),
    logout: () => client.logout(),
    handleCallback: (serverExchangeToken) => client.handleCallback(serverExchangeToken),
    refreshToken: (serverRefreshToken) => client.refreshToken(serverRefreshToken),
    getClient: () => client,
  };
}

/**
 * Vue Composable - 仅用于回调页面
 */
export function useCasdoorCallback(options?: CasdoorCallbackOptions): {
  isLoading: DeepReadonly<Ref<boolean>>;
  success: DeepReadonly<Ref<boolean>>;
  error: DeepReadonly<Ref<Error | null>>;
};
export function useCasdoorCallback(
  serverExchangeToken?: ServerExchangeToken,
  options?: CasdoorCallbackOptions
): {
  isLoading: DeepReadonly<Ref<boolean>>;
  success: DeepReadonly<Ref<boolean>>;
  error: DeepReadonly<Ref<Error | null>>;
};
export function useCasdoorCallback(
  serverExchangeTokenOrOptions?: ServerExchangeToken | CasdoorCallbackOptions,
  options?: CasdoorCallbackOptions
) {
  const serverExchangeToken = typeof serverExchangeTokenOrOptions === 'function' ? serverExchangeTokenOrOptions : undefined;
  const callbackOptions = typeof serverExchangeTokenOrOptions === 'function' ? options : serverExchangeTokenOrOptions;
  const { isLoading, error, handleCallback } = useCasdoor();
  const success = ref(false);

  onMounted(async () => {
    const result = await handleCallback(serverExchangeToken);
    success.value = result;
    if (result) {
      callbackOptions?.onSuccess?.(getCasdoorClient().getUser()!);
    } else if (error.value) {
      callbackOptions?.onError?.(error.value);
    }
  });

  return {
    isLoading: readonly(isLoading),
    success: readonly(success),
    error: readonly(error),
  };
}
