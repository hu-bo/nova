import { Select } from "../components/ui/form.js";
import { useRunnerCatalog } from "./use-runners.js";

export function RunnerSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const catalog = useRunnerCatalog();
  return (
    <Select value={value} disabled={disabled || catalog.isLoading} onChange={event => onChange(event.currentTarget.value)}>
      <option value="">{catalog.isLoading ? "正在加载 Runner…" : "选择 Runner"}</option>
      {catalog.runners.map(runner => (
        <option key={runner.id} value={runner.id}>
          {runner.id} · {stateLabel(runner.state)} · {runner.rootWorkspace}
        </option>
      ))}
    </Select>
  );
}

function stateLabel(state: string) {
  if (state === "ready") return "在线";
  if (state === "busy") return "忙碌";
  if (state === "draining") return "排空中";
  return "离线";
}
