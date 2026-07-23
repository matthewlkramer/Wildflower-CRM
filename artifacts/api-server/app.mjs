// Vercel entrypoint: points the Express framework preset at the prebuilt
// esbuild bundle (created by `pnpm run build`) instead of the TypeScript
// sources, so Vercel's builder doesn't re-typecheck src/ with its own
// (incompatible) compiler settings.
import "./dist/index.mjs";
