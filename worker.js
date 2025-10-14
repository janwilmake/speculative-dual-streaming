// Cloudflare Worker for dual API proxy with intelligent routing

export default {
  async fetch(request, env, ctx) {
    // Only handle POST requests to /chat/completions
    if (
      request.method !== "POST" ||
      !request.url.endsWith("/chat/completions")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const requestBody = await request.json();

      // Extract API keys from environment variables
      const openaiApiKey = env.OPENAI_API_KEY;
      const parallelApiKey = env.PARALLEL_API_KEY;

      if (!openaiApiKey || !parallelApiKey) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Missing API keys in environment variables",
              type: "authentication_error",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Prepare OpenAI request (preserve all parameters)
      const openaiRequest = {
        ...requestBody,
        stream: true, // Force streaming for both
      };

      // Prepare Parallel request (only supported parameters)
      const parallelRequest = {
        model: "speed",
        messages: requestBody.messages,
        stream: true,
      };

      // Add supported Parallel parameters if present
      if (requestBody.response_format) {
        parallelRequest.response_format = requestBody.response_format;
      }

      // Prepare decision request
      const decisionMessages = [
        ...requestBody.messages,
        {
          role: "user",
          content:
            "Does this query require web search, real-time information, or current events? Answer only 'true' or 'false'.",
        },
      ];

      const decisionRequest = {
        model: "gpt-4o-mini-2024-07-18",
        messages: decisionMessages,
        stream: false,
        max_tokens: 10,
        temperature: 0,
      };

      // Start all three requests simultaneously
      const [openaiResponse, parallelResponse, decisionResponse] =
        await Promise.allSettled([
          fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openaiApiKey}`,
            },
            body: JSON.stringify(openaiRequest),
          }),
          fetch("https://api.parallel.ai/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${parallelApiKey}`,
            },
            body: JSON.stringify(parallelRequest),
          }),
          fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openaiApiKey}`,
            },
            body: JSON.stringify(decisionRequest),
          }),
        ]);

      // Handle decision response
      let needsSearch = false;
      if (
        decisionResponse.status === "fulfilled" &&
        decisionResponse.value.ok
      ) {
        try {
          const decisionData = await decisionResponse.value.json();
          const decisionContent = decisionData.choices?.[0]?.message?.content
            ?.toLowerCase()
            .trim();
          needsSearch = decisionContent === "true";
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Failed to parse decision response",
                type: "decision_error",
                details: error.message,
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      } else {
        return new Response(
          JSON.stringify({
            error: {
              message: "Decision request failed",
              type: "decision_error",
              details: decisionResponse.reason || "Unknown error",
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Determine which response to use
      let selectedResponse;
      let selectedName;

      if (needsSearch) {
        if (
          parallelResponse.status === "fulfilled" &&
          parallelResponse.value.ok
        ) {
          selectedResponse = parallelResponse.value;
          selectedName = "parallel";
        } else {
          return new Response(
            JSON.stringify({
              error: {
                message: "Parallel API request failed",
                type: "api_error",
                details: parallelResponse.reason || "Unknown error",
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      } else {
        if (openaiResponse.status === "fulfilled" && openaiResponse.value.ok) {
          selectedResponse = openaiResponse.value;
          selectedName = "openai";
        } else {
          return new Response(
            JSON.stringify({
              error: {
                message: "OpenAI API request failed",
                type: "api_error",
                details: openaiResponse.reason || "Unknown error",
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }

      // Stream the selected response
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "text/event-stream");
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      responseHeaders.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );
      responseHeaders.set("X-Selected-API", selectedName);
      responseHeaders.set("X-Search-Decision", needsSearch.toString());

      // Handle non-streaming requests
      if (!requestBody.stream) {
        // If original request wasn't streaming, collect all chunks and return complete response
        const reader = selectedResponse.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let lastChunk = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.choices?.[0]?.delta?.content) {
                    fullContent += data.choices[0].delta.content;
                  }
                  lastChunk = data;
                } catch (e) {
                  // Skip invalid JSON lines
                }
              }
            }
          }

          // Return complete response
          const completeResponse = {
            id: lastChunk?.id || "",
            object: "chat.completion",
            created: lastChunk?.created || Math.floor(Date.now() / 1000),
            model: lastChunk?.model || requestBody.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fullContent,
                },
                finish_reason: "stop",
              },
            ],
            usage: lastChunk?.usage || {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          };

          return new Response(JSON.stringify(completeResponse), {
            headers: {
              "Content-Type": "application/json",
              "X-Selected-API": selectedName,
              "X-Search-Decision": needsSearch.toString(),
            },
          });
        } finally {
          reader.releaseLock();
        }
      }

      // For streaming requests, return the stream directly
      return new Response(selectedResponse.body, {
        headers: responseHeaders,
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Internal server error",
            type: "server_error",
            details: error.message,
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
};
