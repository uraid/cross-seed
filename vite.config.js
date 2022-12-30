import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	root: "src/frontend",
	base: "/url_base_magic_slug/",
	plugins: [react()],
	build: { outDir: "../../dist/frontend", emptyOutDir: true },
});
