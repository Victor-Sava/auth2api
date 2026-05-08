import { v4 as uuidv4 } from "uuid";
import { formatResponsesUsage } from "./translator";

function textFromChatMessage(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

function finishReasonToStopReason(reason: string | null | undefined): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

export function openaiChatToAnthropicMessage(chat: any, model: string): any {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const content: any[] = [];
  const text = textFromChatMessage(message);
  if (text) content.push({ type: "text", text });
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.type !== "function") continue;
      let input: any = {};
      try {
        input = JSON.parse(call.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: call.id || `toolu_${uuidv4()}`,
        name: call.function?.name || "tool",
        input,
      });
    }
  }

  return {
    id: `msg_${uuidv4().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: finishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: chat?.usage?.prompt_tokens || 0,
      output_tokens: chat?.usage?.completion_tokens || 0,
    },
  };
}

export function openaiChatToResponses(chat: any, model: string): any {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const output: any[] = [];
  const text = textFromChatMessage(message);
  if (text) {
    output.push({
      type: "message",
      id: `msg_${uuidv4().replace(/-/g, "")}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.type !== "function") continue;
      output.push({
        type: "function_call",
        id: `fc_${uuidv4().replace(/-/g, "")}`,
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments || "{}",
        status: "completed",
      });
    }
  }
  return {
    id: `resp_${uuidv4().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    model,
    output,
    output_text: text || null,
    usage: formatResponsesUsage(
      chat?.usage?.prompt_tokens || 0,
      chat?.usage?.completion_tokens || 0,
      chat?.usage?.prompt_tokens_details?.cached_tokens || 0,
    ),
  };
}

export interface OpenAIChatToAnthropicSSEState {
  messageStarted: boolean;
  blockStarted: boolean;
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export function makeOpenAIChatToAnthropicSSEState(): OpenAIChatToAnthropicSSEState {
  return {
    messageStarted: false,
    blockStarted: false,
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "end_turn",
  };
}

export function openaiChatSSEToAnthropic(
  data: any,
  state: OpenAIChatToAnthropicSSEState,
  model: string,
): string[] {
  const out: string[] = [];
  const emit = (event: string, payload: any) => {
    out.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  if (!state.messageStarted) {
    state.messageStarted = true;
    emit("message_start", {
      type: "message_start",
      message: {
        id: `msg_${uuidv4().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  const choice = data?.choices?.[0];
  const delta = choice?.delta || {};
  if (typeof delta.content === "string" && delta.content.length > 0) {
    if (!state.blockStarted) {
      state.blockStarted = true;
      emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    }
    state.text += delta.content;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  if (choice?.finish_reason) {
    state.stopReason = finishReasonToStopReason(choice.finish_reason);
  }
  if (data?.usage) {
    state.inputTokens = data.usage.prompt_tokens || state.inputTokens;
    state.outputTokens = data.usage.completion_tokens || state.outputTokens;
  }
  return out;
}

export function finishOpenAIChatToAnthropicSSE(
  state: OpenAIChatToAnthropicSSEState,
): string[] {
  const out: string[] = [];
  const emit = (event: string, payload: any) => {
    out.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  if (!state.messageStarted) {
    state.messageStarted = true;
    emit("message_start", {
      type: "message_start",
      message: {
        id: `msg_${uuidv4().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  if (state.blockStarted) {
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: state.stopReason, stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  });
  emit("message_stop", { type: "message_stop" });
  return out;
}

