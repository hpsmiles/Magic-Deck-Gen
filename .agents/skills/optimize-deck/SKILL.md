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
   a. **Strategy-synergy audit**: Score each non-land card against the deck's stated strategy (from deck.json metadata.strategy). Flag cards as:
      - **Core**: Directly enables or benefits from the strategy (e.g., landfall payoffs in a landfall deck)
      - **Support**: Provides enabling infrastructure (ramp, removal, draw) that the strategy needs
      - **Off-strategy**: Does not meaningfully interact with the strategy (e.g., a token generator that makes the wrong creature type, a looting spell in a deck that doesn't care about the graveyard)
      - **Anti-synergy**: Actively works against the strategy (e.g., a card that punishes playing lands in a landfall deck)
   b. **Find upgrades for off-strategy cards**: Search the collection for cards in the same color identity that ARE core or support for the strategy. Prioritize:
      - Cards that directly trigger or benefit from the deck's mechanic (e.g., landfall triggers in a landfall deck, sacrifice outlets in a sacrifice deck)
      - Cards referenced by EDHREC as staples for the commander or archetype
      - Cards with lower CMC than the card being replaced (improves mana curve)
      - Cards that serve multiple roles (e.g., a creature that's both ramp and a landfall trigger)
   c. **Check structural needs**: After synergy swaps, verify:
      - Mana curve balance (too top-heavy? too many low-impact 1-drops?)
      - Missing key effects (enough ramp? enough removal? enough draw?)
      - Color balance (too many cards in one color?)
   d. Identify 1-3 specific changes (swaps, additions, removals)
   e. Log the iteration:
      ```bash
      cd .agents/skills/optimize-deck/scripts && npx tsx log-iteration.ts '<iteration-json>' <log-path>
      ```
   f. Update deck.json with the changes
   g. Re-validate (run `validate-deck` skill)
   h. If valid and no more improvements needed, stop

4. **Mark optimization complete**:
   ```bash
   cd .agents/skills/optimize-deck/scripts && npx tsx log-iteration.ts --complete <log-path>
   ```

5. **Present final deck** to the user with a summary of all changes made

## Improvement Priorities

1. **Fix validation errors** (must do)
2. **Replace off-strategy cards** (cards that don't support the deck's stated strategy — highest impact improvements)
3. **Add missing ramp** (if <8 ramp sources for Commander)
4. **Add missing card draw** (if <8 draw sources for Commander)
5. **Add missing removal** (if <6 removal spells for Commander)
6. **Improve mana curve** (aim for bell curve peaking at 2-3 CMC)
7. **Improve synergy** (replace support cards with ones that also advance the strategy)
8. **Improve land count** (Commander: 36-38 lands typically)

## Strategy-Synergy Examples

These illustrate how to identify off-strategy cards and find better replacements:

| Deck Strategy | Off-Strategy Card | Why It's Off-Strategy | Better Replacement |
|---------------|-------------------|----------------------|-------------------|
| Landfall (Omnath) | Dragonmaster Outcast | Makes dragons, not elementals; no landfall interaction | Green Sun's Zenith (tutors for landfall creatures) |
| Landfall (Omnath) | Bitter Reunion | Generic looting; doesn't interact with lands | Elvish Reclaimer (sacrifices a land to find another = landfall trigger) |
| Sacrifice (Ayli) | Random vanilla beater | No death trigger, no life gain, no sacrifice value | Creature with "when this dies" or "when you gain life" effect |
| Tokens (Ghired) | Non-token creature | Doesn't create or buff tokens | Token generator or populate spell |

The key question for each card: **"Does this card get better because of my strategy, or does my strategy get better because of this card?"** If neither, it's off-strategy.

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
