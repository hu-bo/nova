// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateModel,
  CreateProvider,
  Model,
  Provider,
  ProviderAdapter,
  UpdateProvider,
} from "../src/api/client.js";

// Keep these tests on form state and request payloads; the UI library owns its own interaction tests.
vi.mock("@heroui/react", async () => {
  const { Children, isValidElement } = await import("react");
  const Content = ({ children }: { children?: ReactNode }) => children;
  const Empty = () => null;
  const Select = Object.assign(
    (props: {
      children?: ReactNode;
      selectedKey?: string | null;
      onSelectionChange?: (key: string) => void;
      isDisabled?: boolean;
      "aria-label"?: string;
    }) => {
      const options: { value: string; label: string }[] = [];
      function collect(children: ReactNode) {
        Children.forEach(children, (child) => {
          if (!isValidElement<{ children?: ReactNode; id?: string; textValue?: string }>(child)) return;
          if (child.props.id && child.props.textValue) {
            options.push({ value: child.props.id, label: child.props.textValue });
          } else collect(child.props.children);
        });
      }
      collect(props.children);
      return (
        <select
          aria-label={props["aria-label"]}
          value={props.selectedKey ?? ""}
          disabled={props.isDisabled}
          onChange={(event) => props.onSelectionChange?.(event.target.value)}
        >
          <option value="">请选择</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    },
    { Trigger: Content, Value: Content, Indicator: Empty, Popover: Content },
  );
  return {
    Select,
    ListBox: Object.assign(Content, { Item: Object.assign(Content, { Indicator: Empty }), ItemIndicator: Empty }),
  };
});
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type,
    isDisabled,
    onPress,
  }: {
    children: ReactNode;
    type?: ComponentProps<"button">["type"];
    isDisabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type={type} disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/form", () => ({
  FieldLabel: ({ label, error, children }: { label: string; error?: string; children: ReactNode }) => (
    <label>
      {label}
      {children}
      {error && <span role="alert">{error}</span>}
    </label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  fieldInputClass: "",
}));
vi.mock("@/components/ui/feedback", () => ({ ErrorState: () => <div role="alert">目录加载失败</div> }));
vi.mock("../src/api/api-notify.js", () => ({ notifyApiFailure: vi.fn() }));

import { ModelForm } from "../src/features/models/components/model-form.js";
import { ProviderForm } from "../src/features/providers/components/provider-form.js";

const adapters: ProviderAdapter[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    reasoningFormat: "deepseek",
    defaultBaseURL: "https://api.deepseek.com/v1",
    thinkingLevels: ["off", "high"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    reasoningFormat: "anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    thinkingLevels: ["off", "low", "high"],
  },
];
const provider: Provider = {
  id: "00000000-0000-4000-8000-000000000001",
  adapterId: "deepseek",
  protocol: "openai",
  name: "DeepSeek gateway",
  baseUrl: "https://gateway.example/v1",
  credentialMasked: "****",
  enabled: true,
  isPublic: true,
  ownerId: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
};
const legacyProvider: Provider = {
  ...provider,
  id: "00000000-0000-4000-8000-000000000002",
  adapterId: null,
  name: "Legacy gateway",
};
const model: Model = {
  id: "00000000-0000-4000-8000-000000000003",
  publicName: "reasoning-model",
  providerId: provider.id,
  providerName: provider.name,
  upstreamName: "deepseek-reasoner",
  contextWindow: 128000,
  maxOutput: 8192,
  thinkingLevels: ["high"],
  reasoningFormat: "deepseek",
  parallelToolCalls: true,
  inputModalities: ["text"],
  enabled: true,
  priceIn: "0",
  priceOut: "0",
  priceCacheRead: "0",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function mount(element: ReactNode) {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
}
async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function select(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function enter(name: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("model capability submissions", () => {
  it("lets the adapter derive reasoning format when editing a standard provider model", async () => {
    const save = vi.fn<(input: CreateModel) => Promise<void>>(async () => {});
    await mount(
      <ModelForm
        open
        model={model}
        providers={[provider]}
        adapters={adapters}
        pending={false}
        onClose={() => {}}
        onSubmit={save}
      />,
    );
    await submit();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0]).toMatchObject({ providerId: provider.id, thinkingLevels: ["high"] });
    expect(save.mock.calls[0]![0]).not.toHaveProperty("reasoningFormat");
  });

  it("preserves an existing legacy model's continuation format", async () => {
    const save = vi.fn<(input: CreateModel) => Promise<void>>(async () => {});
    await mount(
      <ModelForm
        open
        model={{ ...model, providerId: legacyProvider.id }}
        providers={[legacyProvider]}
        adapters={adapters}
        pending={false}
        onClose={() => {}}
        onSubmit={save}
      />,
    );
    await submit();
    expect(save.mock.calls[0]![0]).toMatchObject({
      providerId: legacyProvider.id,
      thinkingLevels: ["high"],
      reasoningFormat: "deepseek",
    });
  });

  it("clears the previous format when switching a reasoning model to another legacy provider", async () => {
    const save = vi.fn<(input: CreateModel) => Promise<void>>(async () => {});
    await mount(
      <ModelForm
        open
        model={model}
        providers={[provider, legacyProvider]}
        adapters={adapters}
        pending={false}
        onClose={() => {}}
        onSubmit={save}
      />,
    );
    await select("Provider", legacyProvider.id);
    await submit();
    expect(save.mock.calls[0]![0]).toMatchObject({
      providerId: legacyProvider.id,
      thinkingLevels: [],
      reasoningFormat: "none",
    });
  });
});

describe("provider catalog defaults", () => {
  it("keeps typed credentials and a custom endpoint when the catalog arrives and the provider changes", async () => {
    const save = vi.fn<(input: CreateProvider | UpdateProvider) => Promise<void>>(async () => {});
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await mount(<ProviderForm open provider={null} pending={false} onClose={() => {}} onSubmit={save} />);
    await enter("name", "My gateway");
    await enter("credential", "private-key");
    await enter("baseUrl", "https://custom.example/models/v1");
    await act(async () => {
      complete(new Response(JSON.stringify({ code: 200, data: adapters })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('select[aria-label="供应商"] option[value="anthropic"]')).not.toBeNull();
    await select("供应商", "anthropic");
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe("My gateway");
    expect(container.querySelector<HTMLInputElement>('input[name="credential"]')!.value).toBe("private-key");
    expect(container.querySelector<HTMLInputElement>('input[name="baseUrl"]')!.value).toBe(
      "https://custom.example/models/v1",
    );
    await submit();
    expect(save.mock.calls[0]![0]).toMatchObject({
      adapterId: "anthropic",
      name: "My gateway",
      credential: "private-key",
      baseUrl: "https://custom.example/models/v1",
    });
    expect(save.mock.calls[0]![0]).not.toHaveProperty("protocol");
  });

  it("changes an untouched default endpoint with the selected provider", async () => {
    client.setQueryData(["model-config", "provider-adapters"], adapters);
    await mount(<ProviderForm open provider={null} pending={false} onClose={() => {}} onSubmit={async () => {}} />);
    expect(container.querySelector<HTMLInputElement>('input[name="baseUrl"]')!.value).toBe(adapters[0]!.defaultBaseURL);
    await select("供应商", "anthropic");
    expect(container.querySelector<HTMLInputElement>('input[name="baseUrl"]')!.value).toBe(adapters[1]!.defaultBaseURL);
  });
});
