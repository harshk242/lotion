#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Building Lotion for Linux...');

// Run electron-forge make
const forgeProcess = spawn('bun', ['run', 'make:linux'], {
  stdio: 'inherit',
  cwd: process.cwd()
});

forgeProcess.on('close', (code) => {
  if (code === 0) {
    console.log('✅ Build completed successfully!');
    console.log('📦 Check the "out" directory for your Linux packages:');
    console.log('   - DEB package (for Debian/Ubuntu)');
    console.log('   - RPM package (for Red Hat/Fedora)');
    console.log('   - ZIP archive (universal)');
  } else {
    console.error('❌ Build failed with code:', code);
    process.exit(code);
  }
});

forgeProcess.on('error', (err) => {
  console.error('❌ Failed to start build process:', err);
  process.exit(1);
}); 