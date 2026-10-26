module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    baseUrl: process.env.WEB_BASE_PATH ?? '',
  },
});
