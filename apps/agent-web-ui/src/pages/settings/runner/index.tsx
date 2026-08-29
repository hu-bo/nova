import { useModelSettings } from "../model/provider.js";
import { RunnerManager } from "./runner-manager-dialog.js";

export function RunnerManagementPage() {
  const settings = useModelSettings();
  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6 lg:p-8">
      <RunnerManager
        selectedRunnerId={settings.defaultRunnerId}
        onSelect={(runnerId) => settings.setDefaultRunnerId(runnerId)}
      />
    </div>
  );
}
