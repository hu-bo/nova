export const devAuthEnabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'dev';

export const authConfigured = !devAuthEnabled;
