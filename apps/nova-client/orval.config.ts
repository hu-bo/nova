import { defineConfig, defineTransformer } from 'orval';

type Json = Record<string, unknown>;

// openapi.json 如实描述后端统一信封 { code, message, data },
// 但 mutator(apiFetch)已负责解包 data、并把业务错误转成 ApiError 抛出,
// 因此生成前做两件事(openapi.json 与 Swagger 文档不受影响,仅作用于生成):
// 1. 把 2xx 成功响应的信封 schema 替换为内层 data schema,保证生成类型与运行时值一致;
// 2. 剥离非 2xx(如 500)响应的内联错误信封 schema —— 前端运行时统一抛 ApiError,
//    这些按接口重复生成的 Xxx500 类型无人消费,剥掉后 orval 不再产出对应模型。
const alignWithTransport = defineTransformer((spec) => {
  const paths = (spec as { paths?: Record<string, Json> }).paths ?? {};
  for (const [route, pathItem] of Object.entries(paths)) {
    for (const [verb, rawOperation] of Object.entries(pathItem)) {
      const operation = rawOperation as Json | undefined;
      const responses = operation?.responses as Record<string, Json> | undefined;
      for (const [status, response] of Object.entries(responses ?? {})) {
        if (!status.startsWith('2')) {
          delete response.content;
          continue;
        }
        const content = response?.content as Record<string, Json> | undefined;
        const media = content?.['application/json'];
        const schema = media?.schema as Json | undefined;
        if (!media || !schema) continue;
        if (schema.$ref) {
          // 当前 spec 全内联(components.schemas 为空);出现 $ref 说明导出方式变了,
          // 响亮失败优于静默漂移
          throw new Error(
            `Unexpected $ref in ${status} response of ${verb.toUpperCase()} ${route}: ${String(schema.$ref)}`,
          );
        }
        const properties = schema.properties as Record<string, Json> | undefined;
        const codeEnum =
          properties?.code?.enum ?? (properties?.code?.const === 200 ? [200] : undefined);
        const data = properties?.data;
        const isEnvelope =
          Array.isArray(codeEnum) &&
          codeEnum[0] === 200 &&
          properties?.message !== undefined &&
          data !== undefined;
        if (!isEnvelope) {
          console.warn(
            `[envelope-transformer] ${status} response is not a success envelope, left as-is: ${verb.toUpperCase()} ${route}`,
          );
          continue;
        }
        media.schema = data;
      }
    }
  }
  return spec;
});

export default defineConfig({
  projects: {
    input: {
      // 单一来源: 后端 nova-server 导出的 openapi.json (见 docs/nova-server.md §5.2).
      // 由 pnpm --filter @react-fastify-template/app-server openapi:export 更新服务端契约.
      target: '../nova-server/openapi.json',
      override: { transformer: alignWithTransport },
    },
    output: {
      // tags 模式:每个 tag 一个自包含文件(hooks + models 内联),如 projects.ts / health.ts
      target: './src/api/generated',
      mode: 'tags',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      tsconfig: './tsconfig.app.json',
      override: {
        mutator: { path: './src/api/transport.ts', name: 'apiFetch' },
        fetch: { includeHttpResponseReturnType: false },
        query: { useQuery: true, useMutation: false, signal: true },
        operations: {
          createProject: { query: { useQuery: false, useMutation: true } },
          updateProject: { query: { useQuery: false, useMutation: true } },
          deleteProject: { query: { useQuery: false, useMutation: true } },
          createConversation: { query: { useQuery: false, useMutation: true } },
          appendConversationInput: { query: { useQuery: false, useMutation: true } },
          removeConversationInput: { query: { useQuery: false, useMutation: true } },
          createAttachmentUpload: { query: { useQuery: false, useMutation: true } },
          completeAttachmentUpload: { query: { useQuery: false, useMutation: true } },
          createRunnerToken: { query: { useQuery: false, useMutation: true } },
          revokeRunnerToken: { query: { useQuery: false, useMutation: true } },
          rotateRunnerToken: { query: { useQuery: false, useMutation: true } },
        },
      },
    },
  },
});
