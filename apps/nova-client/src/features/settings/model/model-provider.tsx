import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  createUserModelProfile,
  deleteUserModelProfile,
  updateUserModelProfile,
} from '@/api/generated/models';
import { useIdentity } from '@/features/auth';
import { ApiError } from '@/api/api-error';
import { useClientConfig } from '@/features/models';
import {
  ModelSettingsContext,
  loadModelSettings,
  persistModelSettings,
  type ModelProfile,
  type ModelSettingsValue,
} from './model-context';
import type { ModelProfileForm } from './schemas';

export function ModelSettingsProvider({ children }: { children: ReactNode }) {
  const { identity } = useIdentity();
  const accountId = identity!.identityId;
  const [settings, setSettings] = useState(() => loadModelSettings(accountId));
  const [saving, setSaving] = useState(false);
  const config = useClientConfig();
  const serverProfiles = useMemo<ModelProfile[]>(
    () =>
      (config.data?.models ?? []).map((model) => ({
        id: 'server:' + model.id,
        source: 'server',
        serverModelId: model.id,
        editable: model.editable,
        providerName: model.providerName,
        provider: model.provider,
        endpoint: model.endpoint ?? 'https://server-managed.invalid',
        model: model.name,
        credential: '',
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        reasoningFormat: model.reasoningFormat,
        thinkingLevels: model.thinkingLevels,
        parallelToolCalls: model.parallelToolCalls,
        supportsImages: model.supportsImages,
      })),
    [config.data],
  );
  const profiles = useMemo(
    () => [...settings.profiles, ...serverProfiles],
    [settings.profiles, serverProfiles],
  );
  const persist = useCallback(
    (next: typeof settings) => persistModelSettings(next, accountId),
    [accountId],
  );

  const saveProfile = useCallback(
    async (profile: ModelProfileForm, id?: string) => {
      setSaving(true);
      try {
        const { credential, ...fields } = profile;
        const result = id?.startsWith('server:')
          ? await updateUserModelProfile(id.slice(7), {
              ...fields,
              ...(credential.trim() ? { credential: credential.trim() } : {}),
            })
          : await createUserModelProfile({ ...fields, credential: credential.trim() });
        const savedId = 'server:' + result.id;
        setSettings((current) =>
          persist({
            ...current,
            profiles: current.profiles.filter((entry) => entry.id !== id),
            defaultProfileId:
              !current.defaultProfileId || current.defaultProfileId === id
                ? savedId
                : current.defaultProfileId,
          }),
        );
        await config.refetch();
        return savedId;
      } finally {
        setSaving(false);
      }
    },
    [config, persist],
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        if (id.startsWith('server:')) await deleteUserModelProfile(id.slice(7));
        setSettings((current) =>
          persist({
            ...current,
            profiles: current.profiles.filter((entry) => entry.id !== id),
            defaultProfileId: current.defaultProfileId === id ? '' : current.defaultProfileId,
          }),
        );
        await config.refetch();
      } finally {
        setSaving(false);
      }
    },
    [config, persist],
  );

  const resolveModelId = useCallback(
    async (id: string): Promise<string | null> => {
      const profile = profiles.find((entry) => entry.id === id);
      if (!profile) return null;
      if (profile.serverModelId) return profile.serverModelId;
      if (!profile.credential.trim())
        throw new ApiError(400, 'MODEL_CREDENTIAL_REQUIRED', '请先为所选模型配置 API Key。');
      return (await saveProfile(profile, profile.id)).slice(7);
    },
    [profiles, saveProfile],
  );

  const value = useMemo<ModelSettingsValue>(
    () => ({
      ...settings,
      profiles,
      saving,
      catalogLoading: config.isPending,
      catalogError: config.error,
      setDefaultProfileId: (id) =>
        setSettings((current) => persist({ ...current, defaultProfileId: id })),
      setDefaultRunnerId: (id) =>
        setSettings((current) => persist({ ...current, defaultRunnerId: id.trim() })),
      saveProfile,
      deleteProfile,
      resolveModelId,
    }),
    [
      settings,
      profiles,
      saving,
      config.isPending,
      config.error,
      persist,
      saveProfile,
      deleteProfile,
      resolveModelId,
    ],
  );
  return <ModelSettingsContext.Provider value={value}>{children}</ModelSettingsContext.Provider>;
}
