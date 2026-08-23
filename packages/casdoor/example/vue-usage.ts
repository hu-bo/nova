/**
 * Vue usage example
 */

// ============ main.ts ============
import { initCasdoor } from '@hquant/casdoor/client/vue';

initCasdoor({
  appName: 'trader',
  silentRefresh: true,
});

// ============ LoginButton.vue ============
/*
<script setup lang="ts">
import { useCasdoor } from '@hquant/casdoor/client/vue';

const { isAuthenticated, isLoading, user, login, logout } = useCasdoor();
</script>

<template>
  <div v-if="isLoading">Loading...</div>
  <div v-else-if="isAuthenticated">
    <span>Welcome, {{ user?.displayName }}</span>
    <button @click="logout">Logout</button>
  </div>
  <button v-else @click="login">Login</button>
</template>
*/

// ============ Callback.vue ============
/*
<script setup lang="ts">
import { useCasdoorCallback } from '@hquant/casdoor/client/vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const { isLoading, success, error } = useCasdoorCallback({
  // Uses the built-in auth-service token exchange.
  onSuccess: (user) => {
    console.log('Login successful:', user.name);
    router.push('/dashboard');
  },
  onError: (err) => {
    console.error('Login failed:', err);
    router.push('/login?error=' + encodeURIComponent(err.message));
  },
});
</script>

<template>
  <div v-if="isLoading">Processing login...</div>
  <div v-else-if="error">Error: {{ error.message }}</div>
  <div v-else-if="success">Login successful! Redirecting...</div>
</template>
*/

// ============ router/index.ts ============
/*
import { getCasdoorClient } from '@hquant/casdoor/client/vue';

router.beforeEach((to, from, next) => {
  const client = getCasdoorClient();

  if (to.meta.requiresAuth && !client.isAuthenticated()) {
    client.login();
    return;
  }

  next();
});
*/

// ============ api/index.ts ============
/*
import { getCasdoorClient } from '@hquant/casdoor/client/vue';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const client = getCasdoorClient();
  const token = client.getAccessToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});
*/

export {};
