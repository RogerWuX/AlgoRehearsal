// Unit boundary for the library; Metro checks exercise the installed package.
module.exports = {
  logger: {
    createLogger(options) {
      return Object.fromEntries(Object.entries(options.levels).map(([level, severity]) => [level, (...rawMsg) => {
        if (severity < options.levels[options.severity ?? 'debug']) return;
        options.transport({ rawMsg, msg: options.stringifyFunc?.(rawMsg) ?? '', level: { text: level, severity } });
      }]));
    },
  },
};
