import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copiarOcr } from "./scripts/copiar-ocr.mjs";

export default defineConfig({
  plugins: [
    // OCR servido pelo próprio site (public/ocr/): copiado aqui, e não num prebuild do npm,
    // porque o Vercel roda `vite build` direto e o prebuild nunca rodava lá
    { name: "copiar-ocr", config() { copiarOcr(); } },
    react(), tailwindcss(),
  ],
});
