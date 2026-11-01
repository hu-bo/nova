import { createContext } from 'react';
import type { RunStreamManager } from './run-stream-manager';

export const RunStreamContext = createContext<RunStreamManager | null>(null);
