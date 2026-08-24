import { AlertTriangle, Check, CheckCircle2, Circle, HelpCircle, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DecisionRequest, DecisionResponse } from "@nova/protocol";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./components/ui/card.js";
import { Checkbox } from "./components/ui/checkbox.js";

export interface DecisionPromptProps {
  request: DecisionRequest;
  onResolve: (response: DecisionResponse) => void | Promise<void>;
  disabled?: boolean | undefined;
  resolved?: DecisionResponse | undefined;
}

function approvalDetails(request: Extract<DecisionRequest, { kind: "approval" }>) {
  if (request.risk === "exec" && request.args && typeof request.args === "object" && "command" in request.args)
    return String(request.args.command);
  if (typeof request.args === "string") return request.args;
  return JSON.stringify(request.args, null, 2);
}

export function DecisionPrompt({ request, onResolve, disabled = false, resolved }: DecisionPromptProps) {
  const [submitted, setSubmitted] = useState(false);
  const [answers, setAnswers] = useState<string[]>([]);

  useEffect(() => {
    setSubmitted(false);
    setAnswers([]);
  }, [request.decisionId]);

  const locked = disabled || submitted || resolved !== undefined;

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
        className="nova-decision-prompt overflow-hidden bg-amber-50/70 ring-amber-300/80 dark:bg-amber-950/20 dark:ring-amber-800/80"
        role="region"
        aria-labelledby={`${request.decisionId}-title`}
      >
        <CardHeader className="flex flex-row items-start gap-2.5 pb-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:ring-amber-800">
            <AlertTriangle className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle id={`${request.decisionId}-title`} className="text-sm text-amber-950 dark:text-amber-100">
              需要确认
            </CardTitle>
            <p className="mt-1 text-xs leading-5 text-amber-800/80 dark:text-amber-300/70">
              {request.toolName} 请求执行一项{" "}
              {request.risk === "exec" ? "命令" : request.risk === "write" ? "写入操作" : "读取操作"}
            </p>
          </div>
          <Badge variant="warning" className="bg-white/70 font-mono dark:bg-amber-950">
            {request.risk}
          </Badge>
        </CardHeader>
        <pre className="m-0 max-h-56 overflow-auto border-y border-amber-200/70 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-200 dark:border-amber-900">
          {approvalDetails(request)}
        </pre>
        <CardFooter className="flex-wrap justify-end gap-2 pt-2">
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
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => void resolve({ kind: "approval", decision: "allow_always" })}
          >
            <ShieldCheck aria-hidden="true" />
            总是允许
          </Button>
          <Button
            type="button"
            variant="warning"
            size="sm"
            disabled={locked}
            onClick={() => void resolve({ kind: "approval", decision: "allow" })}
          >
            {submitted ? (
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Check className="size-3.5" aria-hidden="true" />
            )}
            允许
          </Button>
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
