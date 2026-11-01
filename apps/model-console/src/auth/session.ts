import { DEV_MOCK_ACCESS_TOKEN } from "@nova/agent-ui-contracts/dev-auth";

export const developmentAuthEnabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === "dev";
type Session = { token(): string | null; refresh(): Promise<boolean>; logout(): void };
let session: Session | null = null;
export function configureSession(value: Session): () => void {
  session = value;
  return () => {
    if (session === value) session = null;
  };
}
export const getSessionToken = () => (developmentAuthEnabled ? DEV_MOCK_ACCESS_TOKEN : (session?.token() ?? null));
export const refreshSession = async () => session?.refresh() ?? false;
export const expireSession = () => session?.logout();
