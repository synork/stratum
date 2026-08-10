import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), solid()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8099",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});