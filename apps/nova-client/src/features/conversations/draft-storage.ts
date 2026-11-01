import { z } from 'zod';
const draftSchema = z.object({
  version: z.literal(1),
  text: z.string().max(32000),
  updatedAt: z.number(),
});
const key = (scope: string, conversation: string) =>
  `nova:draft:v1:${encodeURIComponent(scope)}:${encodeURIComponent(conversation)}`;
export function readDraft(scope: string, conversation: string): string {
  try {
    const parsed = draftSchema.safeParse(
      JSON.parse(localStorage.getItem(key(scope, conversation)) ?? 'null'),
    );
    return parsed.success ? parsed.data.text : '';
  } catch {
    return '';
  }
}
export function saveDraft(scope: string, conversation: string, text: string): void {
  try {
    if (text)
      localStorage.setItem(
        key(scope, conversation),
        JSON.stringify({ version: 1, text: text.slice(0, 32000), updatedAt: Date.now() }),
      );
    else localStorage.removeItem(key(scope, conversation));
  } catch {
    /* Editing continues when browser storage is unavailable. */
  }
}
