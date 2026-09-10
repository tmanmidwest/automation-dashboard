import type { LlmChatParams, LlmDelta } from './llm-provider';

/**
 * Low-level client for the OpenAI-compatible `/chat/completions` streaming endpoint,
 * shared by every provider. Parses the `text/event-stream` response into {@link LlmDelta}s.
 */

interface StreamChoice {
  delta?: {
    content?: string | null;
    tool_calls?: {
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

/** POST a streaming chat completion and yield deltas as they arrive. */
export async function* streamChatCompletions(
  chatUrl: string,
  apiKey: string | undefined,
  params: LlmChatParams,
): AsyncIterable<LlmDelta> {
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: params.model,
      temperature: params.temperature,
      messages: params.messages,
      tools: params.tools?.length ? params.tools : undefined,
      stream: true,
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500) || res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  // res.body is a web ReadableStream, async-iterable in Node 18+.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE frames are separated by blank lines; process complete lines.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json: { choices?: StreamChoice[] };
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore keep-alives / partial frames
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const content = choice.delta?.content;
      if (content) yield { kind: 'content', text: content };
      for (const tc of choice.delta?.tool_calls ?? []) {
        yield {
          kind: 'tool_call',
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          argsFragment: tc.function?.arguments,
        };
      }
      if (choice.finish_reason) yield { kind: 'finish', reason: choice.finish_reason };
    }
  }
}

/** GET a JSON document, returning undefined on any failure (model listing is best-effort). */
export async function getJson<T>(url: string, apiKey?: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
