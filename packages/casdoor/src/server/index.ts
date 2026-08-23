import { SDK as CasdoorSDK } from 'casdoor-nodejs-sdk';
import type {
  CasdoorConfig,
  CasdoorUser,
  AuthResult,
  JwtClaims,
  TokenResponse,
} from '../types.js';

export * from '../types.js';

/**
 * Casdoor 服务端 SDK
 */
export class CasdoorServer {
  private sdk: CasdoorSDK;
  private config: CasdoorConfig;

  constructor(config: CasdoorConfig) {
    if (!config.clientSecret) {
      throw new Error('clientSecret is required for server-side SDK');
    }
    if (!config.certificate) {
      throw new Error('certificate is required for server-side SDK');
    }

    this.config = config;
    this.sdk = new CasdoorSDK({
      endpoint: config.endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      certificate: config.certificate,
      orgName: config.orgName,
      appName: config.appName,
    });
  }

  /**
   * 获取登录 URL
   * @param redirectUri 回调地址
   */
  getSigninUrl(redirectUri: string): string {
    return this.sdk.getSignInUrl(redirectUri);
  }

  /**
   * 获取注册 URL
   * @param redirectUri 回调地址
   * @param enablePassword 是否启用密码注册
   */
  getSignupUrl(redirectUri: string, enablePassword = true): string {
    return this.sdk.getSignUpUrl(enablePassword, redirectUri);
  }

  /**
   * 使用授权码获取 Token
   * @param code 授权码
   */
  async getToken(code: string): Promise<TokenResponse> {
    const token = await this.sdk.getAuthToken(code);
    return token as unknown as TokenResponse;
  }

  /**
   * 刷新 Token
   * @param refreshToken 刷新令牌
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    const token = await this.sdk.refreshToken(refreshToken);
    return token as unknown as TokenResponse;
  }

  /**
   * 解析并验证 JWT Token
   * @param token JWT Token
   */
  parseJwtToken(token: string): JwtClaims {
    return this.sdk.parseJwtToken(token) as unknown as JwtClaims;
  }

  /**
   * 验证 Token 并返回用户信息
   * @param token JWT Token
   */
  async verifyToken(token: string): Promise<AuthResult> {
    try {
      const claims = this.parseJwtToken(token);
      const now = Math.floor(Date.now() / 1000);
      if (!claims.exp || claims.exp <= now) return { valid: false, error: 'Token has expired' };
      if (claims.nbf !== undefined && claims.nbf > now) return { valid: false, error: 'Token is not active' };
      if (normalizeIssuer(claims.iss) !== normalizeIssuer(this.config.endpoint)) {
        return { valid: false, error: 'Token issuer does not match' };
      }
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(this.config.clientId)) return { valid: false, error: 'Token audience does not match' };

      const identity = typeof claims.name === 'string' && claims.name ? claims.name : claims.sub;
      if (!identity) return { valid: false, error: 'Token subject is missing' };
      const user = await this.getUser(identity);

      return {
        valid: true,
        user,
        claims,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Token verification failed',
      };
    }
  }

  /**
   * 获取用户信息
   * @param name 用户名
   */
  async getUser(name: string): Promise<CasdoorUser> {
    const response = await this.sdk.getUser(name);
    // SDK 返回 AxiosResponse，需要从 data 中获取
    const user = (response as any as { data?: {
      data:  CasdoorUser;
    } }).data?.data ?? response.data;
    return user as CasdoorUser;
  }

  /**
   * 获取用户列表
   */
  async getUsers(): Promise<CasdoorUser[]> {
    const response = await this.sdk.getUsers();
    const users = (response as { data?: unknown }).data ?? response;
    return users as CasdoorUser[];
  }

  /**
   * 更新用户信息
   * @param user 用户信息
   */
  async updateUser(user: Partial<CasdoorUser> & { name: string }): Promise<boolean> {
    const result = await this.sdk.updateUser(user as Parameters<typeof this.sdk.updateUser>[0]);
    const data = (result as { data?: { status?: string } }).data ?? result;
    return (data as { status?: string }).status === 'ok';
  }

  /**
   * 删除用户
   * @param name 用户名
   */
  async deleteUser(name: string): Promise<boolean> {
    const result = await this.sdk.deleteUser({ name, owner: this.config.orgName } as Parameters<typeof this.sdk.deleteUser>[0]);
    const data = (result as { data?: { status?: string } }).data ?? result;
    return (data as { status?: string }).status === 'ok';
  }

  /**
   * 获取底层 SDK 实例 (用于高级操作)
   */
  getRawSdk(): CasdoorSDK {
    return this.sdk;
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Express 中间件 - 验证 Token
 */
export function createExpressAuthMiddleware(
  server: CasdoorServer,
  options?: {
    /** 从请求中获取 Token 的函数，默认从 Authorization header 获取 */
    getToken?: (req: { headers: Record<string, string | string[] | undefined> }) => string | null;
    /** 验证失败时的处理函数 */
    onUnauthorized?: (res: { status: (code: number) => { json: (data: unknown) => void } }, error: string) => void;
  }
) {
  const getToken = options?.getToken ?? ((req) => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return null;
  });

  const onUnauthorized = options?.onUnauthorized ?? ((res, error) => {
    res.status(401).json({ error: 'Unauthorized', message: error });
  });

  return async (
    req: { headers: Record<string, string | string[] | undefined>; user?: CasdoorUser; claims?: JwtClaims },
    res: { status: (code: number) => { json: (data: unknown) => void } },
    next: () => void
  ) => {
    const token = getToken(req);
    if (!token) {
      onUnauthorized(res, 'No token provided');
      return;
    }

    const result = await server.verifyToken(token);
    if (!result.valid) {
      onUnauthorized(res, result.error ?? 'Invalid token');
      return;
    }

    req.user = result.user;
    req.claims = result.claims;
    next();
  };
}

/**
 * Koa 中间件 - 验证 Token
 */
export function createKoaAuthMiddleware(
  server: CasdoorServer,
  options?: {
    /** 从请求中获取 Token 的函数 */
    getToken?: (ctx: { headers: Record<string, string | string[] | undefined> }) => string | null;
    /** 验证失败时的处理函数 */
    onUnauthorized?: (ctx: { status: number; body: unknown }, error: string) => void;
  }
) {
  const getToken = options?.getToken ?? ((ctx) => {
    const auth = ctx.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return null;
  });

  const onUnauthorized = options?.onUnauthorized ?? ((ctx, error) => {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized', message: error };
  });

  return async (
    ctx: {
      headers: Record<string, string | string[] | undefined>;
      status: number;
      body: unknown;
      state: { user?: CasdoorUser; claims?: JwtClaims };
    },
    next: () => Promise<void>
  ) => {
    const token = getToken(ctx);
    if (!token) {
      onUnauthorized(ctx, 'No token provided');
      return;
    }

    const result = await server.verifyToken(token);
    if (!result.valid) {
      onUnauthorized(ctx, result.error ?? 'Invalid token');
      return;
    }

    ctx.state.user = result.user;
    ctx.state.claims = result.claims;
    await next();
  };
}

/**
 * 创建通用的 Token 验证函数 (用于其他框架)
 */
export function createTokenVerifier(server: CasdoorServer) {
  return async (token: string): Promise<AuthResult> => {
    return server.verifyToken(token);
  };
}

/**
 * 创建服务端 SDK 实例
 */
export function createCasdoorServer(config: CasdoorConfig): CasdoorServer {
  return new CasdoorServer(config);
}

export default CasdoorServer;
