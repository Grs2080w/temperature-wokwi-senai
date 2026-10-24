import { defineConfig } from 'vite';

export default defineConfig({
  // Caminhos relativos: funciona atras de proxy com prefixo (ex.: /code/proxy/5173/).
  base: './',
  server: {
    host: true,
    allowedHosts: true, // aceita qualquer host (equivale a "*")
  },
  preview: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
});
