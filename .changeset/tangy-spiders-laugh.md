---
"pi-mono-ask-user-question": patch
---

fix(ask-user-question): wrap text for tabs and options.

Previously long question labels in the tab bar would truncate with ellipsis,
and radio/checkbox option labels would overflow and become unreadable.

Changes:

- Tab bar now uses compact Q1/Q2/Q3 labels with ▸ active + ✓ answered indicators
- Tab bar stays on a single row with proper width budgeting
- Radio option labels now wrap across multiple lines with indented continuation
- Checkbox option labels now wrap across multiple lines with indented continuation
- Option descriptions now wrap instead of being cutoff
- Full question text is visible below the tab bar for the active question
