// Resolve Expo's own transformer even when npm nests its Metro dependencies.
const expoTransformer = require(require.resolve('@expo/metro-config/babel-transformer', {
  paths: [require.resolve('expo/package.json')],
}));

module.exports = {
  ...expoTransformer,
  transform(args) {
    return expoTransformer.transform(args.filename.endsWith('.md')
      ? { ...args, src: `export default ${JSON.stringify(args.src)};` }
      : args);
  },
};
