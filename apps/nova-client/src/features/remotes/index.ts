export {
  useRemoteConnectionsQuery,
  loadRemoteDirectory,
  resolveRemotePath,
  relativeRemotePath,
  type RemoteConnection,
} from './remote.queries';
import { lazy } from 'react';
export const RemoteConnectionsPage = lazy(() =>
  import('./remote.page').then((module) => ({ default: module.RemoteConnectionsPage })),
);
