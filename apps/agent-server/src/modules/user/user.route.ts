import { ApiErrorSchema, CurrentUserSchema, type CurrentUser } from "@nova/protocol";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { UserRow } from "../../store.js";

export function userRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get("/me", {
    schema: {
      operationId: "getCurrentUser",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      response: { 200: CurrentUserSchema, 401: ApiErrorSchema },
    },
  }, request => currentUserView(request.currentUser!));
}

function currentUserView(user: UserRow): CurrentUser {
  return {
    ...user,
    createdAt: user.createdAt.getTime(),
    updatedAt: user.updatedAt.getTime(),
  };
}
