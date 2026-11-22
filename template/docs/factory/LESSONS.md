# Factory lessons

Maintainer-approved lessons from earlier factory runs. The implementation agent and the verifier
read the Active section on every run. The agent cannot edit this file, and `ufactory tune` only
proposes lessons (in its issue, or in a draft PR you merge).

How a lesson gets here:

1. `ufactory tune` (weekly in the monitor job) finds a problem that recurred in at least
   `learning.min_occurrences` runs, such as the same verifier objection, and proposes a lesson
   with a stable id (`L-1a2b3c`).
2. A maintainer accepts it: merge the tune PR, or copy the lesson below by hand. Edit the wording
   first if it is vague; a lesson the model cannot act on is noise.
3. When the verifier rejects a diff for breaking a lesson, it cites the id. If that keeps
   happening, `tune` proposes turning the lesson into a deterministic check.

Keep lessons short and concrete ("API handlers validate `req.body` with the schema in
`src/schemas/`"), and move a lesson to Retired when a gate or lint rule enforces it. Only the
Active section reaches the models, capped at `learning.max_lesson_chars`.

## Active

## Retired
