import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd());
  if (command === 'build' && env.VITE_LOCAL_TEST_MODE === 'true') {
    throw new Error('Local test database mode cannot be built for deployment.');
  }
  return { base: './', plugins: [react()], server: {
    proxy: { '/test-api': 'http://127.0.0.1:4319' },
  } };
});
