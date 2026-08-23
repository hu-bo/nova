// Core
export { CasdoorClient, createCasdoorClient, type AuthStateListener } from './core.js';

// Storage
export { TokenStorage } from './storage.js';

// Vue
export {
  initCasdoor,
  getCasdoorClient,
  useCasdoor,
  useCasdoorCallback,
  type UseCasdoorReturn,
} from './vue.js';

// React
export {
  CasdoorProvider,
  useCasdoorClient,
  useCasdoor as useCasdoorReact,
  useCasdoorCallback as useCasdoorCallbackReact,
  useRequireAuth,
  type CasdoorProviderProps,
  type UseCasdoorReturn as UseCasdoorReturnReact,
} from './react.js';

// Types
export * from '../types.js';
