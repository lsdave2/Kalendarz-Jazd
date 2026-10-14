import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/ui',workers:1,fullyParallel:false,timeout:30000,
  use:{baseURL:'http://127.0.0.1:5175',viewport:{width:390,height:844},trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium',channel:process.platform==='win32'?'chrome':undefined}}],
  webServer:[
    {command:'node scripts/test-server.mjs',url:'http://127.0.0.1:4319/health',reuseExistingServer:false,timeout:30000},
    {command:'npm run dev -- --port 5175 --strictPort',url:'http://127.0.0.1:5175',env:{VITE_LOCAL_TEST_MODE:'true'},reuseExistingServer:false,timeout:30000},
  ],
});
