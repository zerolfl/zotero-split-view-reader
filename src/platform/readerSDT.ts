export function createGetSDTPack(
  itemID: number,
  targetWindow: Window,
): ((options?: any) => Promise<any>) | null {
  if (!itemID || typeof (Zotero as any).SDT?.getPack !== "function")
    return null;
  const target = targetWindow as any;
  const utils = Components.utils;
  return (options = {}) =>
    new target.Promise((resolve: any, reject: any) => {
      Promise.resolve()
        .then(() => {
          const contentOptions = utils.waiveXrays(options);
          const onProgress =
            typeof contentOptions.onProgress === "function"
              ? (progress: number) => {
                  if (!utils.isDeadWrapper(targetWindow))
                    contentOptions.onProgress(progress);
                }
              : null;
          return (Zotero as any).SDT.getPack(itemID, {
            isPriority: true,
            onProgress,
          });
        })
        .then((result) => {
          if (!utils.isDeadWrapper(targetWindow))
            resolve(utils.cloneInto(result, targetWindow));
        })
        .catch((error) => {
          if (!utils.isDeadWrapper(targetWindow))
            reject(new target.Error(String(error?.message || error)));
        });
    });
}
