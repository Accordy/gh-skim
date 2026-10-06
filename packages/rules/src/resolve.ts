import { parseCodeownersDirective } from "./codeowners.ts";
import { parsePatterns, type PatternSource } from "./matcher.ts";
import {
  detectPresets,
  linguistGeneratedPatterns,
  parsePresetDirective,
  presetSources,
} from "./presets.ts";

export const REVIEW_IGNORE_PATH = ".github/review-ignore";

/** The raw inputs, as text. Reading them is the caller's job. */
export type RuleInputs = {
  /** Contents of `.github/review-ignore`, or null when the file does not exist. */
  reviewIgnore: string | null;
  /** Contents of `.gitattributes`, or null when the file does not exist. */
  gitattributes: string | null;
  /** `--preset a,b` on the command line. Beats the directive and detection. */
  presetOverride: string[] | null;
  /** Repository languages, largest first. Only read when presets are detected. */
  languages: string[];
};

export type ResolvedRules = {
  /** In precedence order, lowest priority first. */
  sources: PatternSource[];
  presets: string[];
  presetOrigin: "flag" | "directive" | "detected" | "none";
  hasReviewIgnore: boolean;
  linguistPatterns: string[];
  /** `# codeowners: on`: each reviewer is shown only the files they own. */
  ownersOnly: boolean;
};

/**
 * True when the presets come from the repository's languages, so the caller
 * has to look them up. Lets a caller skip that request when nothing needs it.
 */
export function needsLanguages(
  inputs: Pick<RuleInputs, "reviewIgnore" | "presetOverride">,
): boolean {
  if (inputs.presetOverride && inputs.presetOverride.length) return false;
  if (inputs.reviewIgnore === null) return true;
  return parsePresetDirective(inputs.reviewIgnore).kind === "absent";
}

/**
 * Build the pattern sources from the config files.
 *
 * Precedence, highest first: `.github/review-ignore`, then `linguist-generated`
 * entries in `.gitattributes`, then the presets.
 *
 * In gitignore evaluation the last matching line wins, so the highest-priority
 * source has to be appended LAST. Getting this backwards would make a `!`
 * escape hatch in review-ignore silently do nothing.
 */
export function resolveRules(inputs: RuleInputs): ResolvedRules {
  const { reviewIgnore, gitattributes, presetOverride, languages } = inputs;

  let presets: string[] = [];
  let presetOrigin: ResolvedRules["presetOrigin"] = "none";

  if (presetOverride && presetOverride.length) {
    presets = presetOverride;
    presetOrigin = "flag";
  } else {
    const directive = reviewIgnore === null ? null : parsePresetDirective(reviewIgnore);
    if (directive?.kind === "explicit") {
      presets = directive.names;
      presetOrigin = "directive";
    } else if (directive?.kind === "none") {
      presets = [];
      presetOrigin = "none";
    } else {
      presets = detectPresets(languages);
      presetOrigin = "detected";
    }
  }

  const sources: PatternSource[] = [...presetSources(presets)];

  const linguistPatterns = gitattributes ? linguistGeneratedPatterns(gitattributes) : [];
  if (linguistPatterns.length) {
    sources.push({ name: ".gitattributes linguist-generated", patterns: linguistPatterns });
  }

  if (reviewIgnore !== null) {
    sources.push({ name: REVIEW_IGNORE_PATH, patterns: parsePatterns(reviewIgnore) });
  }

  return {
    sources,
    presets,
    presetOrigin,
    hasReviewIgnore: reviewIgnore !== null,
    linguistPatterns,
    ownersOnly: parseCodeownersDirective(reviewIgnore),
  };
}
