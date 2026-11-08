import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { parseAcceptanceCriteria } from './spec-workbench-model';

const acceptanceHighlights = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.mark(view);
    }
    mark(view: EditorView) {
      return Decoration.set(
        parseAcceptanceCriteria(view.state.doc.toString()).map((criterion) =>
          Decoration.line({ class: 'cm-ac-heading' }).range(criterion.from),
        ),
      );
    }
    update(update: { docChanged: boolean; view: EditorView }) {
      if (update.docChanged) this.decorations = this.mark(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const editorTheme = EditorView.theme({
  '&': { minHeight: '320px', color: 'var(--foreground)', backgroundColor: 'var(--surface)' },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '13px',
    padding: '16px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    border: 'none',
    color: 'var(--muted-foreground)',
  },
  '.cm-ac-heading': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 8%, transparent)',
    color: 'var(--accent)',
    fontWeight: '600',
    borderLeft: '3px solid var(--accent)',
  },
  '&.cm-focused': {
    outline: '2px solid color-mix(in oklab, var(--accent) 30%, transparent)',
    outlineOffset: '-2px',
  },
});

export function MarkdownEditor({
  value,
  onChange,
  label,
  resetKey,
  readonly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  resetKey: string;
  readonly?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!parent.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        markdown(),
        acceptanceHighlights,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readonly),
        editorTheme,
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: parent.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // resetKey changes only when loading another version or stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, readonly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value, resetKey]);

  return <div ref={parent} className="overflow-hidden rounded-xl border bg-surface" />;
}
