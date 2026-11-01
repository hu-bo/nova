import { createContext } from 'react';
import { LocalStore } from '@/lib/local-store';
import type { ModelProfileForm } from './schemas';

export type ModelProfileSource = 'local' | 'server';

export interface ModelProfile extends ModelProfileForm {
  id: string;
  source: ModelProfileSource;
  serverModelId?: string;
  editable?: boolean;
}

interface PersistedSettings {
  profiles: ModelProfile[];
  defaultProfileId: string;
  defaultRunnerId: string;
}

export interface ModelSettingsValue {
  profiles: ModelProfile[];
  defaultProfileId: string;
  defaultRunnerId: string;
  setDefaultProfileId: (id: string) => void;
  setDefaultRunnerId: (id: string) => void;
  saveProfile: (profile: ModelProfileForm, id?: string) => Promise<string>;
  deleteProfile: (id: string) => Promise<void>;
  resolveModelId: (id: string) => Promise<string | null>;
  saving: boolean;
  catalogLoading: boolean;
  catalogError: unknown;
}

export const ModelSettingsContext = createContext<ModelSettingsValue | null>(null);

const legacySettingsStore = new LocalStore<PersistedSettings | null>('nova_model_settings', null);

export function loadModelSettings(accountId?: string): {
  profiles: ModelProfile[];
  defaultProfileId: string;
  defaultRunnerId: string;
} {
  try {
    const accountStore = new LocalStore<PersistedSettings | null>(
      'nova_model_settings:' + (accountId ?? 'legacy'),
      null,
    );
    let parsed = accountId ? accountStore.get() : legacySettingsStore.get();
    if (accountId && !parsed) {
      parsed = legacySettingsStore.get();
      if (parsed) {
        accountStore.set(parsed);
        legacySettingsStore.clear();
      }
    }
    if (!parsed) throw new Error('empty');
    const profiles = parsed.profiles.map((profile) => ({ ...profile, source: 'local' as const }));
    return {
      profiles,
      defaultProfileId:
        parsed.defaultProfileId?.startsWith('server:') ||
        profiles.some((profile) => profile.id === parsed.defaultProfileId)
          ? parsed.defaultProfileId
          : (profiles[0]?.id ?? ''),
      defaultRunnerId: parsed.defaultRunnerId ?? '',
    };
  } catch {
    return { profiles: [], defaultProfileId: '', defaultRunnerId: '' };
  }
}

export function persistModelSettings(
  next: ReturnType<typeof loadModelSettings>,
  accountId?: string,
): typeof next {
  const settingsStore = accountId
    ? new LocalStore<PersistedSettings | null>('nova_model_settings:' + accountId, null)
    : legacySettingsStore;
  settingsStore.set({
    profiles: next.profiles,
    defaultProfileId: next.defaultProfileId,
    defaultRunnerId: next.defaultRunnerId,
  });
  return next;
}
