import {
  Check,
  CheckCircle2,
  Circle,
  CircleStop,
  FileCode,
  HelpCircle,
  LoaderCircle,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diffLines, type Change } from "diff";
import type { CodeChange, DecisionRequest, DecisionResponse } from "@nova/protocol";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./components/ui/card.js";
import { Checkbox } from "./components/ui/checkbox.js";

function CodeDiffView({ codeChanges }: { codeChanges: CodeChange[] }) {
  return (
    <div className="flex flex-col divide-y divide-slate-700/50">
      {codeChanges.map((change, index) => (
        <DiffFile key={index} change={change} />
      ))}
    </div>
  );
}

function DiffFile({ change }: { change: CodeChange }) {
  const diff = useMemo(() => diffLines(change.oldText, change.newText), [change.oldText, change.newText]);

  const addedCount = diff.filter((d) => d.added).reduce((sum, d) => sum + (d.count ?? 0), 0);
  const removedCount = diff.filter((d) => d.removed).reduce((sum, d) => sum + (d.count ?? 0), 0);

  return (
    <div className="py-2">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <FileCode className="size-3.5 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 break-all text-xs font-medium text-slate-300">{change.path}</span>
        {addedCount > 0 && (
          <Badge variant="success" className="bg-emerald-500/20 text-emerald-400">
            +{addedCount}
          </Badge>
        )}
        {removedCount > 0 && (
          <Badge variant="danger" className="bg-red-500/20 text-red-400">
            -{removedCount}
          </Badge>
        )}
      </div>
      <pre className="nova-scrollbar m-0 max-w-full overflow-x-hidden overflow-y-auto rounded-md bg-slate-950 px-2 py-1.5 font-mono text-xs leading-4 whitespace-pre-wrap break-words text-slate-200">
        {diff.map((part, i) => (
          <DiffLine key={i} part={part} />
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ part }: { part: Change }) {
  const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
  const className = part.added
    ? "text-emerald-400 bg-emerald-500/10"
    : part.removed
      ? "text-red-400 bg-red-500/10"
      : "text-slate-500";

  return (
    <div className={className}>
      <span className="select-none text-slate-600">{prefix}</span>
      {part.value}
    </div>
  );
}

export interface DecisionPromptProps {
  request: DecisionRequest;
  onResolve: (response: DecisionResponse) => void | Promise<void>;
  disabled?: boolean | undefined;
  resolved?: DecisionResponse | undefined;
  onAbort?: (() => void | Promise<void>) | undefined;
  isAborting?: boolean | undefined;
}

function approvalDetails(request: Extract<DecisionRequest, { kind: "approval" }>) {
  if (request.risk === "exec" && request.args && typeof request.args === "object" && "command" in request.args)
    return String(request.args.command);
  if (typeof request.args === "string") return request.args;
  return JSON.stringify(request.args, null, 2);
}

export function DecisionPrompt({
  request,
  onResolve,
  disabled = false,
  resolved,
  onAbort,
  isAborting = false,
}: DecisionPromptProps) {
  const [submitted, setSubmitted] = useState(false);
  const [answers, setAnswers] = useState<string[]>([]);

  useEffect(() => {
    setSubmitted(false);
    setAnswers([]);
  }, [request.decisionId]);

  const locked = disabled || submitted || resolved !== undefined || isAborting;

  async function resolve(response: DecisionResponse) {
    setSubmitted(true);
    try {
      await onResolve(response);
    } finally {
      setSubmitted(false);
    }
  }

  if (resolved) {
    const value =
      resolved.kind === "approval"
        ? { allow: "允许", allow_always: "总是允许", deny: "拒绝" }[resolved.decision]
        : resolved.answers.join("、");
    return (
      <Card
        className="nova-decision-resolved flex-row items-center gap-2.5 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 ring-emerald-200/80 dark:bg-emerald-950/30 dark:text-emerald-300 dark:ring-emerald-900"
        aria-label="已处理的决定"
      >
        <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-semibold">已处理</span>
          <span className="mx-2 text-emerald-500">/</span>
          {value}
        </span>
      </Card>
    );
  }

  if (request.kind === "approval") {
    return (
      <Card
        data-kind="approval"
        className="nova-decision-prompt nova-approval-prompt min-w-0 max-w-full overflow-hidden bg-indigo-50/80 text-indigo-950 ring-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-50 dark:ring-indigo-800"
        role="region"
        aria-labelledby={`${request.decisionId}-title`}
      >
        <CardHeader className="flex flex-row items-start gap-3 px-3 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-900/60 dark:text-indigo-300">
            <Zap className="size-5" strokeWidth={2.5} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle id={`${request.decisionId}-title`} className="text-base text-indigo-950 dark:text-indigo-100">
              需要授权
            </CardTitle>
            <p className="mt-1 text-xs leading-5 text-indigo-700/85 dark:text-indigo-200/80">
              {request.toolName} 请求执行一项{" "}
              {request.risk === "exec" ? "命令" : request.risk === "write" ? "写入操作" : "读取操作"}
            </p>
          </div>
        </CardHeader>
        {request.codeChanges && request.codeChanges.length > 0 ? (
          <div className="nova-scrollbar mx-3 max-h-80 overflow-auto rounded-md bg-slate-950 px-2.5 py-2">
            <CodeDiffView codeChanges={request.codeChanges} />
          </div>
        ) : (
          <pre className="nova-scrollbar mx-3 my-0 max-h-56 max-w-[calc(100%-1.5rem)] overflow-x-hidden overflow-y-auto break-words whitespace-pre-wrap rounded-md bg-slate-950 px-2.5 py-2 font-mono text-xs leading-5 text-slate-200">
            {approvalDetails(request)}
          </pre>
        )}
        <CardFooter className="flex-wrap gap-2 px-3 pb-3 pt-2.5">
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={locked}
            onClick={() => void resolve({ kind: "approval", decision: "allow" })}
          >
            {submitted ? (
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Check className="size-3.5" aria-hidden="true" />
            )}
            允许执行
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => void resolve({ kind: "approval", decision: "deny" })}
          >
            <X aria-hidden="true" />
            拒绝
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={locked}
            onClick={() => void resolve({ kind: "approval", decision: "allow_always" })}
          >
            <ShieldCheck aria-hidden="true" />
            总是允许
          </Button>
          {onAbort && (
            <Button type="button" variant="ghost" size="xs" disabled={locked} onClick={() => void onAbort()}>
              <CircleStop aria-hidden="true" />
              取消流程
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }

  const question = request;

  function toggle(option: string) {
    setAnswers((current) =>
      question.multiSelect
        ? current.includes(option)
          ? current.filter((value) => value !== option)
          : [...current, option]
        : [option],
    );
  }

  return (
    <Card
      data-kind="question"
      className="nova-decision-prompt"
      role="region"
      aria-labelledby={`${question.decisionId}-title`}
    >
      <CardHeader className="mb-2 flex flex-row items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:ring-indigo-900">
          <HelpCircle className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">需要你的选择</p>
          <h3
            id={`${question.decisionId}-title`}
            className="mb-0 mt-1 text-sm font-semibold leading-5 text-slate-900 dark:text-slate-100"
          >
            {question.question}
          </h3>
        </div>
      </CardHeader>
      <CardContent role={question.multiSelect ? "group" : "radiogroup"} className="grid gap-1.5 pb-2">
        {question.options.map((option) => {
          const selected = answers.includes(option);
          return (
            <label
              key={option}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ring-1 ring-inset transition-all ${selected ? "bg-indigo-50 text-indigo-950 ring-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-100 dark:ring-indigo-800" : "text-slate-600 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300 dark:text-slate-300 dark:ring-slate-800 dark:hover:bg-slate-900"} ${locked ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {question.multiSelect ? (
                <Checkbox checked={selected} disabled={locked} onCheckedChange={() => toggle(option)} />
              ) : (
                <>
                  <input
                    type="radio"
                    name={question.decisionId}
                    checked={selected}
                    disabled={locked}
                    onChange={() => toggle(option)}
                    className="sr-only"
                  />
                  <span
                    className={`grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-inset ${selected ? "bg-indigo-600 text-white ring-indigo-600" : "text-transparent ring-slate-300 dark:ring-slate-600"}`}
                  >
                    {selected ? (
                      <span className="size-1.5 rounded-full bg-white" />
                    ) : (
                      <Circle className="size-2" aria-hidden="true" />
                    )}
                  </span>
                </>
              )}
              <span>{option}</span>
            </label>
          );
        })}
      </CardContent>
      <CardFooter className="justify-end">
        {onAbort && (
          <Button type="button" variant="ghost" size="xs" disabled={locked} onClick={() => void onAbort()}>
            <CircleStop aria-hidden="true" />
            取消流程
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={locked || answers.length === 0}
          onClick={() => void resolve({ kind: "question", answers })}
        >
          {submitted && (
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          提交
        </Button>
      </CardFooter>
    </Card>
  );
}
