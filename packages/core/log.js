// @ts-check
// One JSON line per event, readable in Docker and Render logs.

/** @param {string} scope */
export function logger(scope) {
  /** @param {'info'|'warn'|'error'} level @param {string} msg @param {Record<string, unknown>} [extra] */
  const emit = (level, msg, extra) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...extra });
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  };
  return {
    /** @param {string} m @param {Record<string, unknown>} [x] */ info: (m, x) => emit('info', m, x),
    /** @param {string} m @param {Record<string, unknown>} [x] */ warn: (m, x) => emit('warn', m, x),
    /** @param {string} m @param {Record<string, unknown>} [x] */ error: (m, x) => emit('error', m, x),
  };
}
