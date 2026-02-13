// ═══════════════════════════════════════
// ATLAS — PM2 Configuration
// ═══════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'atlas',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      kill_timeout: 15000,
      shutdown_with_message: true,
      env: {
        NODE_ENV: 'production',
        CLI_ENABLED: 'false',
      },
      env_development: {
        NODE_ENV: 'development',
        CLI_ENABLED: 'true',
      },
      error_file: 'data/logs/pm2-error.log',
      out_file: 'data/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
