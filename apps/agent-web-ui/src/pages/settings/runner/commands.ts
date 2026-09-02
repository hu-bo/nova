
export const runCommand = import.meta.env.DEV
  ? "cargo run -p nova-runner --"
  : "npx --yes --package @nnova/runner nova-runner";

export function runnerCommand(endpoint: string, token: string, runnerId?: string) {
  return `${runCommand} --server "${endpoint}" --token "${token}"${runnerId ? ` --runner-id "${runnerId}"` : ""}`;
}
