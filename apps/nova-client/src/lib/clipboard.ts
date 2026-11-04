/** Keep HTTP pages and browsers without Clipboard API support able to copy from a user action. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission policies can reject the modern API while allowing a selection-based copy.
    }
  }

  const activeElement = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  // A modal's focus trap/inert backdrop can prevent selecting a node attached to the body.
  const container =
    activeElement?.closest('[role="dialog"], [role="alertdialog"], dialog') ?? document.body;
  container.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed');
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
