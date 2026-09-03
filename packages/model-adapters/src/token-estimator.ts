import type { Block, ModelRef, ModelRequest, TokenEstimate, TokenEstimateConfidence, TokenEstimator } from "./types.js";

const IMAGE_TOKEN_RESERVE = 1_024;

export function createTokenEstimator(_ref: ModelRef): TokenEstimator {
  return {
    estimateText,
    estimateRequest(request) {
      let tokens = 8 + estimateText(request.system).tokens;
      let confidence: TokenEstimateConfidence = "high";

      for (const message of request.messages) {
        tokens += 4;
        for (const block of message.blocks) {
          const estimate = estimateBlock(block);
          tokens += estimate.tokens;
          confidence = lowerConfidence(confidence, estimate.confidence);
        }
      }
      for (const tool of request.tools) {
        tokens += 12;
        tokens += estimateText(tool.name).tokens;
        tokens += estimateText(tool.description).tokens;
        tokens += estimateText(stableJson(tool.parameters)).tokens;
      }
      if (request.thinking && request.thinking !== "off") tokens += 8;
      return result(tokens, confidence);
    },
  };
}

export function estimateText(text: string): TokenEstimate {
  let tokens = 0;
  let asciiWord = 0;
  let whitespace = 0;
  let punctuation = 0;

  const flush = () => {
    tokens += Math.ceil(asciiWord / 4);
    tokens += Math.ceil(whitespace / 8);
    tokens += Math.ceil(punctuation / 2);
    asciiWord = 0;
    whitespace = 0;
    punctuation = 0;
  };

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (isCjk(code)) {
      flush();
      tokens += 1;
    } else if (/\s/u.test(char)) {
      if (asciiWord || punctuation) flush();
      whitespace += 1;
    } else if (code <= 0x7f && /[A-Za-z0-9_]/u.test(char)) {
      if (whitespace || punctuation) flush();
      asciiWord += 1;
    } else if (code <= 0x7f) {
      if (asciiWord || whitespace) flush();
      punctuation += 1;
    } else {
      flush();
      tokens += Math.max(1, Math.ceil(new TextEncoder().encode(char).length / 3));
    }
  }
  flush();
  return result(tokens, "high");
}

function estimateBlock(block: Block): TokenEstimate {
  switch (block.type) {
    case "text":
    case "thinking":
      return estimateText(block.text);
    case "tool_call":
      return result(8 + estimateText(block.name).tokens + estimateText(stableJson(block.args)).tokens, "high");
    case "tool_result": {
      let tokens = 8;
      let confidence: TokenEstimateConfidence = "high";
      for (const part of block.content) {
        if (part.type === "text") tokens += estimateText(part.text).tokens;
        else {
          tokens += IMAGE_TOKEN_RESERVE;
          confidence = "low";
        }
      }
      return result(tokens, confidence);
    }
    case "image":
      return result(IMAGE_TOKEN_RESERVE, "low");
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function result(tokens: number, confidence: TokenEstimateConfidence): TokenEstimate {
  return { tokens: Math.max(0, Math.ceil(tokens)), estimated: true, confidence };
}

function lowerConfidence(a: TokenEstimateConfidence, b: TokenEstimateConfidence): TokenEstimateConfidence {
  return a === "low" || b === "low" ? "low" : "high";
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}
