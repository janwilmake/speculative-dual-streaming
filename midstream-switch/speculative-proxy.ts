import OpenAI from "openai";

export interface DecisionConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
  prompt: string;
}

export interface FallbackConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
  switchStatement: string;
}

export interface SpeculativeDualStreamConfig {
  decision: DecisionConfig;
  fallback: FallbackConfig;
}

interface StreamController {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  canceled: boolean;
}

export const createSpeculativeDualStreamProxy = (
  config: SpeculativeDualStreamConfig,
): typeof fetch => {
  const { decision, fallback } = config;

  return async function fetchProxy(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = input.toString();

    // Only intercept chat completions requests
    if (!url.endsWith("/chat/completions") || init?.method !== "POST") {
      return fetch(input, init);
    }

    const requestBody = JSON.parse(init.body as string);
    const isStreaming = requestBody.stream === true;

    // Create decision client
    const decisionClient = new OpenAI({
      apiKey: decision.apiKey,
      baseURL: decision.baseURL,
    });

    // Create fallback client
    const fallbackClient = new OpenAI({
      apiKey: fallback.apiKey,
      baseURL: fallback.baseURL,
    });

    // Prepare fallback request
    const fallbackRequest = {
      model: fallback.model,
      messages: requestBody.messages,
      stream: true as const,
      ...(requestBody.response_format && {
        response_format: requestBody.response_format,
      }),
    };

    // Prepare decision request
    const decisionMessages = [
      ...requestBody.messages,
      { role: "user" as const, content: decision.prompt },
    ];

    // Start primary request immediately - don't wait for decision
    const primaryFetchPromise = fetch(input, init);

    // Start decision and fallback in parallel (but don't await yet)
    const decisionPromise = decisionClient.chat.completions.create({
      model: decision.model,
      messages: decisionMessages,
      stream: false,
      max_tokens: 10,
      temperature: 0,
    });

    const fallbackStreamPromise =
      fallbackClient.chat.completions.create(fallbackRequest);

    if (!isStreaming) {
      // Non-streaming mode - must wait for decision
      const [primaryResponse, decisionResult] = await Promise.all([
        primaryFetchPromise,
        decisionPromise,
      ]);

      const decisionContent =
        decisionResult.choices?.[0]?.message?.content?.toLowerCase().trim() ?? "";
      const needsFallback = decisionContent === "true";

      if (needsFallback) {
        const fallbackStream = await fallbackStreamPromise;
        let fullContent = "";
        for await (const chunk of fallbackStream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          fullContent += chunk.choices?.[0]?.delta?.content ?? "";
        }

        const response = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: fallback.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: fallback.switchStatement + fullContent,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        return new Response(JSON.stringify(response), {
          headers: {
            "Content-Type": "application/json",
            "X-Selected-API": "fallback",
            "X-Fallback-Decision": "true",
          },
        });
      } else {
        const responseHeaders = new Headers(primaryResponse.headers);
        responseHeaders.set("X-Selected-API", "primary");
        responseHeaders.set("X-Fallback-Decision", "false");

        return new Response(primaryResponse.body, {
          status: primaryResponse.status,
          headers: responseHeaders,
        });
      }
    }

    // Streaming mode - start streaming IMMEDIATELY, don't wait for decision
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Track decision state
    let decisionResolved = false;
    let needsFallback = false;

    // Start decision check in background
    decisionPromise.then((result) => {
      const content = result.choices?.[0]?.message?.content?.toLowerCase().trim() ?? "";
      needsFallback = content === "true";
      decisionResolved = true;
    }).catch(() => {
      decisionResolved = true;
      needsFallback = false;
    });

    // Get primary response (just headers, body streams)
    const primaryResponse = await primaryFetchPromise;

    const stream = new ReadableStream({
      async start(controller) {
        const sendSSE = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        const primaryReader = primaryResponse.body?.getReader();
        if (!primaryReader) {
          controller.close();
          return;
        }

        // Buffer for incomplete SSE data from primary
        let sseBuffer = "";

        try {
          // Stream from primary while decision is pending OR if decision says no fallback
          while (true) {
            const { done, value } = await primaryReader.read();

            if (done) {
              // Primary finished - forward any remaining buffer
              if (sseBuffer.trim()) {
                controller.enqueue(encoder.encode(sseBuffer));
              }
              controller.close();
              return;
            }

            // Decode and buffer the chunk
            sseBuffer += decoder.decode(value, { stream: true });

            // Parse and forward only complete SSE events (ending with \n\n)
            const events = sseBuffer.split("\n\n");
            // Keep the last potentially incomplete event in buffer
            sseBuffer = events.pop() || "";

            // Forward complete events
            for (const event of events) {
              if (event.trim()) {
                controller.enqueue(encoder.encode(event + "\n\n"));
              }
            }

            // Check if decision resolved and needs fallback
            if (decisionResolved && needsFallback) {
              // Cancel primary and switch to fallback
              // Note: We discard sseBuffer (incomplete event) to ensure clean switch
              await primaryReader.cancel();
              break;
            }
          }

          // If we get here, we need to switch to fallback
          // Send switch statement as SSE chunk
          const switchChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: fallback.model,
            choices: [
              {
                index: 0,
                delta: { content: fallback.switchStatement },
                finish_reason: null,
              },
            ],
          };
          sendSSE(JSON.stringify(switchChunk));

          // Stream from fallback
          const fallbackStream = await fallbackStreamPromise;
          for await (const chunk of fallbackStream as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
            sendSSE(JSON.stringify(chunk));
          }

          sendSSE("[DONE]");
          controller.close();
        } catch (e) {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };
};
