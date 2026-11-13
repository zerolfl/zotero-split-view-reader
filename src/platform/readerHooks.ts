export function afterReaderMethod(
  browser: XULBrowserElement,
  target: any,
  key: string,
  after: () => void,
): () => void {
  const win = browser.contentWindow!;
  const content = (win as any).wrappedJSObject || win;
  const origin = target[key];
  if (typeof origin !== "function")
    throw new Error(`Reader method ${key} is unavailable`);
  const factory = new content.Function(
    "origin",
    "after",
    `
    let enabled = true;
    function wrapper(...args) {
      const result = origin.apply(this, args);
      if (enabled) after();
      return result;
    }
    return {
      wrapper,
      disable() { enabled = false; after = null; }
    };
  `,
  );
  const handle = Components.utils.waiveXrays(
    factory(origin, Components.utils.exportFunction(after, win)),
  );
  target[key] = handle.wrapper;
  return () => {
    handle.disable();
    if (target[key] === handle.wrapper) target[key] = origin;
  };
}
