## Fastify Use Case Design

### Core Rule

One business action = one Use Case.

Routes only validate input, read request context, call a Use Case, and map its result to HTTP/SSE. Do not place business logic, database queries, Agent Loop logic, or Runner orchestration in route handlers.

### Structure

```text
src/
├── app/                    # Bootstrap, config, global error handling
├── plugins/                # Fastify infrastructure plugins
│   ├── auth.plugin.ts
│   ├── db.plugin.ts
│   ├── logger.plugin.ts
│   └── grpc.plugin.ts
├── modules/                # Business domains
│   └── <domain>/
│       ├── <domain>.routes.ts
│       ├── <domain>.schema.ts
│       ├── create-<resource>.ts
│       ├── update-<resource>.ts
│       ├── get-<resource>.ts
│       └── list-<resources>.ts
└── shared/                 # Shared errors, IDs, pagination, utilities
```

### Route Rules

* Keep routes thin and declarative.
* Validate request and response with runtime schemas.
* Read auth/context from `request`.
* Call exactly one primary Use Case.
* Return transport-safe DTOs only.
* Never expose DB models, ORM types, internal errors, or gRPC/proto types directly.

```ts
fastify.post('/resources', { schema }, async (request, reply) => {
  const result = await createResource({
    actor: request.user,
    input: request.body,
  });

  return reply.code(201).send(result);
});
```

### Use Case Rules

* One file, one explicit business action.
* Use Cases own authorization, transaction boundaries, orchestration, and domain decisions.
* Prefer explicit dependencies passed as arguments or constructed by a module factory.
* Return domain-safe results or typed errors.
* Do not depend on Fastify `request`, `reply`, or HTTP-specific types.
* Do not create database, Redis, gRPC, or logger clients inside a Use Case.

### Plugin Rules

Use Fastify plugins only for shared infrastructure and lifecycle-managed dependencies:

* Authentication and request identity
* Database / ORM connection
* Logger and request ID
* Redis / cache / event bus
* gRPC clients
* Configuration
* SSE helpers

Do not put domain actions or business workflows in plugins.

### Dependency Direction

```text
Fastify Route → Use Case → Domain / Application Packages → Infrastructure Ports
```

Forbidden dependencies:

```text
Domain / Use Case → Fastify
Domain / Use Case → HTTP request/reply
Domain / Use Case → ORM model leakage
Core packages → app-specific route modules
```

### Naming

* Commands: `create-resource.ts`, `update-resource.ts`, `delete-resource.ts`, `cancel-run.ts`
* Queries: `get-resource.ts`, `list-resources.ts`
* Routes: `<domain>.routes.ts`
* Schemas: `<domain>.schema.ts`
* Repositories: `<resource>.repository.ts`
* DTOs: `<resource>.dto.ts`

Avoid generic files such as `service.ts`, `manager.ts`, `utils.ts`, or oversized `controller.ts` unless their responsibility is genuinely narrow and explicit.

### Error Handling

* Throw or return typed domain/application errors from Use Cases.
* Convert them to HTTP responses only in a centralized Fastify error handler.
* Never couple business code to HTTP status codes.

### Testing

* Unit test Use Cases without starting Fastify.
* Integration test routes with `fastify.inject()`.
* Mock infrastructure ports at unit-test boundaries, not internal helper functions.
* Test each command and query independently.
