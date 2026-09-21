import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Etapa 1 del frontend React de HILO Store: solo autenticación.
// El proxy de /api hace que, en el browser, el front y el server de
// Express (lyon, http://localhost:4000) queden same-origin — así las
// cookies HttpOnly de sesión viajan sin fricción de CORS/SameSite.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
