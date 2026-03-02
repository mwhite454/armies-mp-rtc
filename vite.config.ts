import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), fresh()],
  ssr: {
    // Phaser uses `window` at module-init time; keep it out of the SSR bundle.
    external: ["phaser"],
  },
});
