# Chat Proxy Worker

A Cloudflare Worker that intelligently routes chat completion requests between OpenAI and Parallel AI based on whether the query requires web search or real-time information.

## Features

- **Dual API Support**: Simultaneously queries both OpenAI and Parallel AI
- **Intelligent Routing**: Uses GPT-4o-mini to determine if search is needed
- **Streaming Support**: Handles both streaming and non-streaming requests
- **Full Compatibility**: Preserves all OpenAI parameters while filtering supported ones for Parallel
- **Error Handling**: Comprehensive error handling with detailed responses

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set environment variables in Cloudflare Dashboard:

   - `OPENAI_API_KEY`: Your OpenAI API key
   - `PARALLEL_API_KEY`: Your Parallel AI API key

3. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Usage

Send POST requests to `https://your-worker.your-subdomain.workers.dev/chat/completions` with standard OpenAI chat completion format.

### Example Request

```javascript
const response = await fetch(
  "https://your-worker.your-subdomain.workers.dev/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer your-api-key", // Optional, if you want to add auth
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [
        { role: "user", content: "What is the current weather in New York?" },
      ],
      stream: true,
    }),
  }
);
```

## How It Works

1. **Parallel Execution**: The worker simultaneously sends requests to:

   - OpenAI with your specified model and all parameters
   - Parallel AI with the "speed" model and supported parameters only
   - OpenAI with GPT-4o-mini to determine if search is needed

2. **Decision Making**: The decision prompt asks if the query requires web search or real-time information

3. **Response Routing**:

   - If `true` (search needed): Streams the Parallel AI response
   - If `false` (no search needed): Streams the OpenAI response

4. **Response Headers**: Includes additional headers:
   - `X-Selected-API`: Which API was used (`openai` or `parallel`)
   - `X-Search-Decision`: The boolean decision (`true` or `false`)

## Supported Parameters

### For OpenAI (all preserved):

- All standard OpenAI chat completion parameters

### For Parallel AI (filtered):

- `model` (forced to "speed")
- `messages`
- `response_format`
- `stream`

## Error Handling

The worker provides detailed error responses for:

- Missing API keys
- Failed API requests
- Decision parsing errors
- Internal server errors

## Development

Run locally with:

```bash
npm run dev
```

This will start a local development server with hot reloading.
