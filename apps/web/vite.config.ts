import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
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
