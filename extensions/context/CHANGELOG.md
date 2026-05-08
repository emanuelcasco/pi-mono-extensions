# pi-mono-context

## 0.1.1

### Patch Changes

### Maintenance

- Update pi core imports and peer dependencies to the new `@earendil-works` package scope.

## 0.1.0

### Patch Changes

### New Extension: context

- Add `/context` command for a Claude Code-style context usage report printed in the conversation.
- Filter generated context reports out of future LLM context while keeping them visible in the transcript.
- Render generated reports with the requested category palette: grey system prompts/tools/free space, light-blue custom agents, orange memory files, yellow skills, and purple messages.
- Show total context usage from Pi plus estimated category breakdowns, extension allocation by source/package, session stats, active tools, and command sections.
