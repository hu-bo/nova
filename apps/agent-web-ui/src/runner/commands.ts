export const installCommand = import.meta.env.DEV ? "cargo install nova-runner" : "npm install @nnova/runner";

export const runCommand = import.meta.env.DEV ? "cargo run -p nova-runner --" : "npx nova-runner";

export function runnerCommand(endpoint: string, token: string, runnerId?: string) {
  return `${runCommand} --server "${endpoint}" --token "${token}"${runnerId ? ` --runner-id "${runnerId}"` : ""}`;
}
