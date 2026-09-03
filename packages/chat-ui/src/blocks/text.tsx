import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "../components/copy-button.js";

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

function MarkdownCode({ children }: { children?: ReactNode }) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : undefined;
  const className = child?.props.className;
  const language = className?.startsWith("language-") ? className.slice("language-".length) : "text";
  const code = textContent(child?.props.children ?? children).replace(/\n$/, "");

  return (
    <section className="nova-code-block my-3 min-w-0 overflow-hidden rounded-xl bg-slate-950 shadow-sm ring-1 ring-slate-800">
      <header className="flex min-h-9 items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-3">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">{language}</span>
        <CopyButton text={code} label="复制代码" className="text-slate-400 hover:bg-white/5 hover:text-white" />
      </header>
      <pre className="nova-scrollbar m-0 overflow-x-auto p-3 font-mono text-xs leading-5 text-slate-200">
        {children}
      </pre>
    </section>
  );
}

export function TextBlock({ text }: { text: string }) {
  return (
    <div className="nova-text-block min-w-0 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-300 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:font-medium [&_a]:text-indigo-600 [&_a]:underline [&_a]:decoration-indigo-300 [&_a]:underline-offset-4 hover:[&_a]:decoration-indigo-600 dark:[&_a]:text-indigo-400 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_code]:rounded-md [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[.875em] [&_code]:text-slate-800 dark:[&_code]:bg-slate-800 dark:[&_code]:text-slate-200 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:pl-5 [&_p]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-slate-200 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-slate-100 [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          pre: MarkdownCode,
          table: ({ children }) => (
            <div className="nova-scrollbar my-3 overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
              <table className="w-full border-collapse text-left text-sm [&_td]:border-t [&_td]:border-slate-200 [&_td]:px-3 [&_td]:py-1.5 [&_th]:bg-slate-50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:font-semibold dark:[&_td]:border-slate-800 dark:[&_th]:bg-slate-900">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
