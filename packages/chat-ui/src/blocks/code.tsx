import { FileCode2 } from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { CopyButton } from "../components/copy-button.js";

export interface CodeBlockProps {
  language: string;
  code: string;
  path?: string | undefined;
  startLine?: number | undefined;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
}

export function CodeBlock({ language, code, path, startLine = 1, onOpenPath }: CodeBlockProps) {
  return (
    <section className="nova-code-block min-w-0 overflow-hidden rounded-xl bg-slate-950 shadow-sm ring-1 ring-slate-800">
      <header className="flex min-h-9 items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-3">
        {path ? (
          <button
            type="button"
            onClick={() => onOpenPath?.(path, startLine)}
            disabled={!onOpenPath}
            className="inline-flex min-w-0 items-center gap-2 rounded-md py-1 font-mono text-[11px] text-slate-400 transition-colors hover:text-white disabled:cursor-default"
          >
            <FileCode2 className="size-3.5 shrink-0 text-indigo-400" aria-hidden="true" />
            <span className="truncate">
              {path}:{startLine}
            </span>
          </button>
        ) : (
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {language || "text"}
          </span>
        )}
        <CopyButton text={code} label="复制代码" className="text-slate-400 hover:bg-white/5 hover:text-white" />
      </header>
      <Highlight theme={themes.nightOwl} code={code} language={(language || "plain") as Language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} nova-scrollbar m-0 overflow-x-auto p-3 font-mono text-xs leading-5`}
            style={{ ...style, background: "transparent" }}
          >
            {tokens.map((line, lineIndex) => (
              <div {...getLineProps({ line })} key={lineIndex}>
                <span aria-hidden="true" className="mr-3 inline-block w-[3ch] select-none text-right text-slate-600">
                  {startLine + lineIndex}
                </span>
                {line.map((token, tokenIndex) => (
                  <span {...getTokenProps({ token })} key={tokenIndex} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </section>
  );
}
