// Presets are imported as text (`with { type: "text" }`); Bun inlines them at build time.
declare module "*.gitignore" {
  const text: string;
  export default text;
}
