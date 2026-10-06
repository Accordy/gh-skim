// What counts as noise. Pure: text and paths in, decisions out. No network,
// no file system, so anything can call it, including a test or a CI step.
export * from "./codeowners.ts";
export * from "./matcher.ts";
export * from "./presets.ts";
export * from "./resolve.ts";
