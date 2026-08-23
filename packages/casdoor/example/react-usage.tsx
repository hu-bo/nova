/**
 * React usage example
 */

import React from 'react';
import {
  CasdoorProvider,
  useCasdoor as useCasdoorReact,
  useCasdoorCallback,
  useRequireAuth,
} from '@hquant/casdoor/client/react';

// ============ App.tsx - Provider ============
export function App() {
  return (
    <CasdoorProvider
      config={{
        appName: 'trader',
        silentRefresh: true,
      }}
    >
      <Router />
    </CasdoorProvider>
  );
}

// ============ Login button ============
export function LoginButton() {
  const { isAuthenticated, isLoading, user, login, logout } = useCasdoorReact();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (isAuthenticated) {
    return (
      <div>
        <span>Welcome, {user?.displayName}</span>
        <button onClick={logout}>Logout</button>
      </div>
    );
  }

  return <button onClick={login}>Login</button>;
}

// ============ Callback page ============
export function CallbackPage() {
  const handleSuccess = React.useCallback((user) => {
    console.log('Login successful:', user.name);
    window.location.href = '/dashboard';
  }, []);

  const handleError = React.useCallback((err) => {
    console.error('Login failed:', err);
    window.location.href = '/login?error=' + encodeURIComponent(err.message);
  }, []);

  const { isLoading, success, error } = useCasdoorCallback({
    // Uses the built-in auth-service token exchange.
    onSuccess: handleSuccess,
    onError: handleError,
  });

  if (isLoading) {
    return <div>Processing login...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  if (success) {
    return <div>Login successful! Redirecting...</div>;
  }

  return null;
}

// ============ Protected page ============
export function ProtectedPage() {
  const { isAuthenticated, isLoading } = useRequireAuth();
  const { user } = useCasdoorReact();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <div>Redirecting to login...</div>;
  }

  return (
    <div>
      <h1>Dashboard</h1>
      <p>Hello, {user?.displayName}</p>
    </div>
  );
}

// ============ Authenticated fetch helper ============
export function useAuthFetch() {
  const { accessToken } = useCasdoorReact();

  return React.useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);

    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }

    return fetch(url, { ...options, headers });
  }, [accessToken]);
}

// ============ Usage example ============
export function DataComponent() {
  const authFetch = useAuthFetch();
  const [data, setData] = React.useState(null);

  React.useEffect(() => {
    authFetch('/api/me')
      .then((res) => res.json())
      .then(setData);
  }, [authFetch]);

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}

function Router() {
  return <div>Router placeholder</div>;
}
