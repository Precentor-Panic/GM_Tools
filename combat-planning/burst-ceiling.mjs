/**
 * Burst ceiling — Phase 18 task 18.4. PURE function, zero I/O, zero LLM
 * calls (mutation-engine/propagate.mjs's convention). Design record §2: "a
 * separate worst-case number (max recharge-ability damage, a
 * synchronized-crit ceiling) -- answers 'what if the monsters roll well'
 * without simulating anything." A static max-plausible-damage sum over a
 * candidate list of burst components -- NOT a Monte Carlo roll of any kind.
 *
 * THE SETUP-STEP GUARD ("fantasy ceiling" guard against an unreachable
 * number DMs learn to ignore): a component needing 2+ setup steps (a
 * Sneak-Attack-style effect needing a prior ally hit, e.g.) is EXCLUDED from
 * the ceiling total entirely -- not counted at full value, not discounted by
 * a fudge factor either. setupSteps 0 (unconditional) or 1 (one free setup
 * step) both count at FULL value.
 */

/**
 * @param {Array<{name:string, damage:number, setupSteps:number}>} components
 * @returns {{ceiling:number, included:Array, excluded:Array}}
 */
export function computeBurstCeiling(components = []) {
  const included = [];
  const excluded = [];

  for (const component of components) {
    if ((component.setupSteps ?? 0) >= 2) {
      excluded.push(component);
    } else {
      included.push(component);
    }
  }

  const ceiling = included.reduce((sum, c) => sum + (c.damage ?? 0), 0);
  return { ceiling, included, excluded };
}
