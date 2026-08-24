import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function TextBlock({ text }: { text: string }) {
  return (
    <div className="nova-text-block min-w-0 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-300 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:font-medium [&_a]:text-indigo-600 [&_a]:underline [&_a]:decoration-indigo-300 [&_a]:underline-offset-4 hover:[&_a]:decoration-indigo-600 dark:[&_a]:text-indigo-400 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_code]:rounded-md [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[.875em] [&_code]:text-slate-800 dark:[&_code]:bg-slate-800 dark:[&_code]:text-slate-200 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:pl-5 [&_p]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-slate-100 [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-xl bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-200">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
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
