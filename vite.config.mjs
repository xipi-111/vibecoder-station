import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        player: `${projectRoot}index.html`,
        manager: `${projectRoot}manager.html`,
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx", "./src/manager-main.jsx"],
    },
  },
  plugins: [react()],
});
