RULES:
https://uithub.com/janwilmake/gists/tree/main/named-codeblocks.md

PROMPT:
https://docs.parallel.ai/chat-api/chat-quickstart.md
https://docs.parallel.ai/chat-api/sdk-compatibility.md

I want to make a proxy on a Cloudflare worker that takes any /chat/completions input and proxies it to the above as well as to any model specified for api.openai.com/v1. it submits to both apis at the same time, and also, does a request to openai that should return a boolean which is a prompt that contains the original prompt and a question as to whether or not search is needed. Both chat completions endpoints stream back and get held in memory until we either get true or false. if true, we stream the parallel chat completions, if false, the open ai one.

ANSWER: https://letmeprompt.com/httpsdocsparalle-u6dsxbjr3pc0t8?key=result

1. yes something like that
2. for the decision prompt, use gpt-5-mini-2025-08-07
3. it should not fail, but if it does, respond with error of that
4. yes preserve it all for openai but for parallel only send supported ones
