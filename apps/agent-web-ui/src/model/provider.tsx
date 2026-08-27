import type { ModelConfig } from "@nova/protocol";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/provider.js";
import { LocalStore } from "../lib/storage.js";
import type { ModelProfileForm } from "./schemas.js";

export interface ModelProfile extends ModelProfileForm {
  id: string;
  source: "local" | "server";
  serverModelId?: string;
}

interface PersistedSettings {
  profiles: ModelProfile[];
  defaultProfileId: string;
  defaultRunnerId: string;
}

interface ModelSettingsValue {
  profiles: ModelProfile[];
  defaultProfileId: string;
  defaultRunnerId: string;
  setDefaultProfileId: (id: string) => void;
  setDefaultRunnerId: (id: string) => void;
  saveProfile: (profile: ModelProfileForm, id?: string) => string;
  deleteProfile: (id: string) => void;
  modelSelection: (profileId: string) => { modelConfig: ModelConfig } | { modelId: string } | null;
}

const settingsStore = new LocalStore<PersistedSettings | null>("nova_model_settings", null);

const ModelSettingsContext = createContext<ModelSettingsValue | null>(null);

function loadSettings(): { profiles: ModelProfile[]; defaultProfileId: string; defaultRunnerId: string } {
  try {
    const parsed = settingsStore.get();
    if (!parsed?.profiles.length) throw new Error("empty");
    // Older saved profiles did not include `source`. They are local profiles
    // by definition; normalise them so the edit/delete actions remain usable.
    const profiles = parsed.profiles.map((profile) => ({ ...profile, source: "local" as const }));
    return {
      profiles,
      defaultProfileId:
        parsed.defaultProfileId?.startsWith("server:") ||
        profiles.some((profile) => profile.id === parsed.defaultProfileId)
          ? parsed.defaultProfileId
          : profiles[0]!.id,
      defaultRunnerId: parsed.defaultRunnerId ?? "",
    };
  } catch {
    return { profiles: [], defaultProfileId: "", defaultRunnerId: "" };
  }
}

export function ModelSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings);
  const { api, userId } = useAuth();
  // The catalog is user-scoped: a private provider owned by one account must
  // never be reused from another account's query cache. Keep it fresh as the
  // admin catalog can change while the chat page is open.
  const catalog = useQuery({
    queryKey: ["model-catalog", userId],
    queryFn: () => api!.listAvailableModels(),
    enabled: Boolean(api && userId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const serverProfiles = useMemo<ModelProfile[]>(
    () =>
      (catalog.data ?? []).map((model) => ({
        id: `server:${model.id}`,
        source: "server",
        serverModelId: model.id,
        providerName: model.providerName,
        provider: model.protocol,
        endpoint: "https://server-managed.invalid",
        model: model.name,
        credential: "",
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        reasoningFormat: model.reasoningFormat,
        thinkingLevels: model.thinkingLevels,
        parallelToolCalls: model.parallelToolCalls,
        supportsImages: model.inputModalities.includes("image"),
      })),
    [catalog.data],
  );
  const profiles = useMemo(() => [...settings.profiles, ...serverProfiles], [settings.profiles, serverProfiles]);

  const persist = useCallback((next: typeof settings) => {
    settingsStore.set({
      profiles: next.profiles,
      defaultProfileId: next.defaultProfileId,
      defaultRunnerId: next.defaultRunnerId,
    });
    return next;
  }, []);

  const saveProfile = useCallback(
    (profile: ModelProfileForm, id: string = crypto.randomUUID()) => {
      setSettings((current) =>
        persist({
          ...current,
          profiles: current.profiles.some((item) => item.id === id)
            ? current.profiles.map((item) => (item.id === id ? { ...profile, id, source: "local" } : item))
            : [...current.profiles, { ...profile, id, source: "local" }],
        }),
      );
      return id;
    },
    [persist],
  );

  const deleteProfile = useCallback(
    (id: string) => {
      setSettings((current) => {
        const profiles = current.profiles.filter((profile) => profile.id !== id);
        const fallback = profiles[0]?.id ?? "";
        return persist({
          ...current,
          profiles,
          defaultProfileId: current.defaultProfileId === id ? fallback : current.defaultProfileId,
        });
      });
    },
    [persist],
  );

  const value = useMemo<ModelSettingsValue>(
    () => ({
      ...settings,
      profiles,
      setDefaultProfileId: (id) => setSettings((current) => persist({ ...current, defaultProfileId: id })),
      setDefaultRunnerId: (id) => setSettings((current) => persist({ ...current, defaultRunnerId: id.trim() })),
      saveProfile,
      deleteProfile,
      modelSelection: (profileId) => {
        const profile = profiles.find((item) => item.id === profileId);
        if (profile?.source === "server" && profile.serverModelId) return { modelId: profile.serverModelId };
        if (!profile?.credential) return null;
        return {
          modelConfig: {
            provider: profile.provider,
            endpoint: profile.endpoint,
            model: profile.model,
            credential: profile.credential,
            contextWindow: profile.contextWindow,
            maxOutput: profile.maxOutput,
            thinkingLevels: profile.thinkingLevels,
            parallelToolCalls: profile.parallelToolCalls,
            reasoningFormat: profile.reasoningFormat,
            inputModalities: profile.supportsImages ? ["text", "image"] : ["text"],
          },
        };
      },
    }),
    [settings, profiles, persist, saveProfile, deleteProfile],
  );

  return <ModelSettingsContext.Provider value={value}>{children}</ModelSettingsContext.Provider>;
}

export function useModelSettings() {
  const value = useContext(ModelSettingsContext);
  if (!value) throw new Error("useModelSettings must be used within ModelSettingsProvider");
  return value;
}
