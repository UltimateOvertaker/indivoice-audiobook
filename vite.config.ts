import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Always replace this at build-time (even if API_KEY isn't set yet)
    "process.env.API_KEY": JSON.stringify(process.env.API_KEY ?? ""),
  },
});
