import { RunnerManager } from './runner-manager-dialog';
import { useModelSettings } from '../model/provider';

/** Select the default Runner for new projects. */
export function RunnersTab() {
  const settings = useModelSettings();
  return (
    <RunnerManager
      selectedRunnerId={settings.defaultRunnerId}
      onSelect={(runnerId) => settings.setDefaultRunnerId(runnerId)}
    />
  );
}
