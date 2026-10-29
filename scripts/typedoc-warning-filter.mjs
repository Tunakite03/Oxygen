const knownDependencyWarning = /^At most one @(remarks|returns) tag is expected in a comment, ignoring all but the first in comment at .*[/\\]node_modules[/\\]@types[/\\]three[/\\]src[/\\]extras[/\\]core[/\\]Curve\.d\.ts:11$/;

/** @param {import('typedoc').Application} application */
export function load(application) {
  const logger = application.logger;
  const warn = logger.warn.bind(logger);

  // TypeDoc's declaration-file warning suppression does not cover these post-processing warnings.
  logger.warn = (message, ...context) => {
    if (context.length === 0 && knownDependencyWarning.test(message)) {
      logger.info(`Known third-party documentation warning: ${message}`);
      return;
    }
    warn(message, ...context);
  };
}
