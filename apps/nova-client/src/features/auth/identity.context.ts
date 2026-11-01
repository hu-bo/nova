import { createContext, useContext } from 'react';
export type Identity = {
  identityId: string;
  // Only dev identities know a local UUID; production resource ownership is resolved by the API.
  localUserId?: string;
  roles: readonly string[];
  displayName: string;
};
export type IdentityState = {
  identity: Identity | null;
  refreshing: boolean;
  authConfigured: boolean;
  login(): Promise<void>;
  refresh(): Promise<boolean>;
  signOut(): void;
  handleCallback(): Promise<boolean>;
  devLogin?: ((token: string) => void) | undefined;
};
export const IdentityContext = createContext<IdentityState | null>(null);
export function useIdentity(): IdentityState {
  const value = useContext(IdentityContext);
  if (!value) throw new Error('IdentityContext missing');
  return value;
}
