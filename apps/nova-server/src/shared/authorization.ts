import type { FastifyRequest } from "fastify";
import { DomainError } from "./domain-error.js";
import type { Principal } from "../modules/identity/index.js";

/**
 * 取得请求 principal; 缺失时抛 UNAUTHORIZED。
 *
 * 路由层在 handler 顶部调用, 把"必须登录"这一约束与路由配置解耦, 避免每个路由
 * 重复声明 preHandler。作用域 owner predicate 仍由 use case 层注入 owner_user_id,
 * 见 projects/project.service.ts。
 */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new DomainError("UNAUTHORIZED", "需要登录后才能继续");
  }
  return request.principal;
}

/**
 * 轻量角色校验: 仅用于极少数 admin-style 路由。绝大多数资源权限走
 * `(owner_user_id, resource_id)` 复合唯一键 + 应用层 owner predicate, 不要
 * 把 RBAC 提升为通用 authz 层。
 */
export function requireRole(request: FastifyRequest, role: string): Principal {
  const principal = requirePrincipal(request);
  if (!principal.roles.includes(role)) {
    throw new DomainError("FORBIDDEN", "权限不足");
  }
  return principal;
}

/**
 * 取原始 Bearer token。
 *
 * 传输层凭据信封用它派生 wrap key: 客户端与服务端各自从同一个 token 独立算出,
 * 密钥本身不上线。调用前必须先 requirePrincipal(request) 校验 token 有效性。
 */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer "))
    throw new DomainError("UNAUTHORIZED", "需要登录后才能继续");
  const token = header.slice("bearer ".length).trim();
  if (!token) throw new DomainError("UNAUTHORIZED", "需要登录后才能继续");
  return token;
}
