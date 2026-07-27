---
name: Slides template sizing vs QA floor
description: How to resolve conflicts between a slide template's prescribed text sizes and the visual-QA vw floor.
---

# Slide template sizing vs the visual-QA text floor

**Rule:** When a deck uses a saved/skill template (e.g. Corporate Grid), the template file's prescribed sizes are ground truth for *furniture* — chrome (page numbers, corner labels), eyebrows, tracked uppercase labels, step numerals — even when they fall below the generic visual-QA 1.5vw floor. Actual reading copy (card bodies, quotes, bullets) still follows the QA floor (1.5vw absolute minimum, 2vw+ preferred).

**Why:** The Corporate Grid template itself specifies 0.8–0.9vw chrome and 1.1–1.5vw labels/body. Blindly enforcing the QA floor on furniture breaks template fidelity, which the user explicitly picked. The Linkweave Tool Guide deck (18 slides, 2026-07) shipped with 0.8–1.2vw furniture + 1.5–1.7vw card bodies and passed the slide-1 fidelity check cleanly.

**How to apply:** During visual QA on any templated deck, classify each sub-floor size: template-prescribed furniture → keep; reading copy → raise. Check the template `.md` (e.g. `.local/skills/slides/templates/corporate-grid.md`) for its fontSize values before "fixing" small text.
