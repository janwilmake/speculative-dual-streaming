Several experimental strategies showcasing how to stream multiple models and choose one in the end

- [after-decision-prompt](after-decision-prompt/) starts both streams but only streams the first token after a decision-prompt clarifies which model is needed.
- [midstream-switch](midstream-switch/) streams back OpenAI first, but switches mid-stream if web-data is needed. It also cancels the unnecessary switch after the decision has been made. **NB: Not working as of now**

Why is this useful?

This technique ("speculative-dual-streaming") can be useful if TTFT (time to first token) is crucial (for example, for LLM user interfaces).

Why is this interesting for Parallel?

This could allow people building LLM User interfaces to enable Parallel search
