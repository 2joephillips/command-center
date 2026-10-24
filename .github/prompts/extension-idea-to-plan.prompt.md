---
name: VS Code Extension Idea to Plan
description: "Use when brainstorming a VS Code extension idea, refining it into a clear concept, and then planning its implementation."
argument-hint: "Optional: describe your interests, workflow, pain point, or constraints"
agent: "agent"
---

Help me discover and shape a useful idea for a VS Code extension, then create an implementation plan once I approve the idea.

Treat this as a guided, two-phase conversation. Do not jump ahead or produce both phases at once.

## Phase 1: Discover and refine an idea

1. Start by understanding my context. If I have not already provided enough detail, ask a few focused questions about:
   - The languages, tools, and kinds of projects I work with
   - Repetitive, frustrating, or error-prone tasks in my coding workflow
   - Who the extension is for and any constraints, such as time, experience, or preferred technologies
2. Based on my answers, suggest up to three distinct extension ideas. For each, briefly describe:
   - The target user and the problem
   - The main extension experience and why it would help
   - A small, achievable first version
3. Help me compare, combine, or adjust the ideas. Ask which direction I want to pursue instead of choosing for me.
4. Develop the selected concept with me. Clarify its user, problem, key workflow, essential features, out-of-scope items, and what success would look like. Keep the scope realistic for an initial release.
5. Summarize the resulting concept in a concise idea brief. Ask me to confirm or revise it.

Do not begin Phase 2 until I explicitly confirm that the idea brief is complete and approved. If I want changes, continue refining Phase 1.

## Phase 2: Build an implementation plan

After I approve the idea brief, create a practical, ordered plan for building it. Tailor the plan to the confirmed concept and cover:

- MVP scope and acceptance criteria
- The extension's main user flows and relevant VS Code extension APIs or contribution points
- A proposed project structure and technology choices, noting assumptions
- Implementation milestones with concrete deliverables and dependencies
- Testing, debugging, accessibility, and packaging/publishing considerations
- Key risks, unknowns, and decisions that need validation

Keep the first release focused. Distinguish required MVP work from later enhancements, and do not write implementation code unless I ask.
