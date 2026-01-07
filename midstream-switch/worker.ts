import OpenAI from "openai";
import { createSpeculativeDualStreamProxy } from "./speculative-proxy";

const PORT = 3000;

// Set your API keys here or via environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PARALLEL_API_KEY = process.env.PARALLEL_API_KEY || "";
const SECRET = process.env.SECRET || "test-secret";

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle /chat endpoint
    if (url.pathname === "/chat" && request.method === "POST") {
      // Auth check
      const authHeader = request.headers.get("Authorization");
      if (authHeader?.slice("Bearer ".length) !== SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = (await request.json()) as { message?: string };
        const userMessage = body.message;

        if (!userMessage) {
          return new Response("Missing 'message' in request body", {
            status: 400,
          });
        }

        // Create the speculative dual stream proxy
        const fetchProxy = createSpeculativeDualStreamProxy({
          decision: {
            model: "gpt-5-nano-2025-08-07",
            apiKey: OPENAI_API_KEY,
            baseURL: "https://api.openai.com/v1",
            prompt:
              "Does this query require web search, real-time information, or current events? Answer only 'true' or 'false'.",
          },
          fallback: {
            model: "speed",
            apiKey: PARALLEL_API_KEY,
            baseURL: "https://api.parallel.ai",
            switchStatement:
              "\n\n-------\nSWITCH TO PARALLEL FOR WEB DATA\n-------\n\n",
          },
        });

        // Create OpenAI client with custom fetch
        const client = new OpenAI({
          apiKey: OPENAI_API_KEY,
          fetch: fetchProxy,
        });

        const stream = await client.chat.completions.create({
          model: "gpt-5.2-2025-12-11",
          messages: [{ role: "user", content: userMessage }],
          stream: true,
        });

        // Stream only the deltas as plain text
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content ?? "";
                if (delta) {
                  controller.enqueue(encoder.encode(delta));
                }
              }
              controller.enqueue(encoder.encode("\n"));
              controller.close();
            } catch (e) {
              const errorMessage = e instanceof Error ? e.message : String(e);
              controller.enqueue(
                encoder.encode(`\n\n[ERROR]: ${errorMessage}\n`),
              );
              controller.close();
            }
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return new Response(`[ERROR]: ${errorMessage}\n`, {
          status: 500,
        });
      }
    }

    return new Response("POST /chat with { message: string }", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${PORT}`);
console.log(`\nTest with curl:`);
console.log(`  curl -N -X POST http://localhost:${PORT}/chat \\`);
console.log(`    -H "Authorization: Bearer ${SECRET}" \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"message": "What is the weather in Tokyo today?"}'`);
