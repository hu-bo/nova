import { createContext } from "react";

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  userId?: string | null;
  displayName: string | null;
  error: Error | null;
  login: () => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
