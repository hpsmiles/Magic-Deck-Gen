---
name: optimize-deck
description: "Use when the user wants to improve or optimize an MTG deck. Triggers include requests to 'optimize my deck', 'improve this deck', 'make this deck better', or 'tune my deck'."
---

# Optimize Deck

Iteratively improve a deck based on validation results and strategic analysis. Maximum 10 iterations.

## Prerequisites

- `deck.json` must exist (run `build-deck` first)
- `collection.json` must exist (run `import-collection` first)
- `validation-report.json` recommended (run `validate-deck` first)

## Workflow

1. **Load context**: Read `deck.json`, `collection.json`, and `validation-report.json` (if available)

2. **Fix errors first**: If validation-report.json has errors, address those before strategic improvements:
   - Remove banned/not-legal cards → suggest in-color replacements from collection
   - Fix color identity violations → remove off-color cards, add in-color alternatives
   - Fix deck size → add or remove cards strategically
   - Fix quantity violations → reduce to legal count, suggest alternatives

3. **Strategic improvement loop** (max 10 iterations):
   For each iteration:
   a. Analyze the deck's strengths and weaknesses:
      - Mana curve balance (too top-heavy? too many low-impact 1-drops?)
      - Synergy gaps (cards that don't support the strategy)
      - Missing key effects (enough ramp? enough removal? enough draw?)
      - Color balance (too many cards in one color?)
   b. Identify 1-3 specific changes (swaps, additions, removals)
   c. Log the iteration:
      ```bash
      cd .agents/skills/optimize-deck/scripts && npx tsx log-iteration.ts '<iteration-json>' <log-path>
      ```
   d. Update deck.json with the changes
   e. Re-validate (run `validate-deck` skill)
   f. If valid and no more improvements needed, stop

4. **Mark optimization complete**:
   ```bash
   cd .agents/skills/optimize-deck/scripts && npx tsx log-iteration.ts --complete <log-path>
   ```

5. **Present final deck** to the user with a summary of all changes made

## Improvement Priorities

1. **Fix validation errors** (must do)
2. **Add missing ramp** (if <8 ramp sources for Commander)
3. **Add missing card draw** (if <8 draw sources for Commander)
4. **Add missing removal** (if <6 removal spells for Commander)
5. **Improve mana curve** (aim for bell curve peaking at 2-3 CMC)
6. **Improve synergy** (replace cards that don't support the strategy)
7. **Improve land count** (Commander: 36-38 lands typically)

## Key Constraints

- Maximum 10 iterations (stop even if not perfect)
- Only suggest cards available in the collection
- Respect format legality and quantity limits
- Each iteration should make targeted, explainable changes
- Don't change the commander without user approval
- Don't change the core strategy without user approval

## When to Stop

- Deck passes validation with no errors
- No more meaningful improvements can be made with available cards
- 10 iterations reached
- User is satisfied with the deck
