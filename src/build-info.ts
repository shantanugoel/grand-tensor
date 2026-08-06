/** Surfaces the build stamp `build.ts` writes into index.html.
 *
 *  Read back out of the DOM rather than substituted in by the bundler so the
 *  value has a single home: the tag a `curl` of the domain returns is the same
 *  one the console reports, and the two can never drift apart. */

export const BUILD = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content ?? 'unknown'

declare global {
  interface Window {
    /** Here so the deployed build can be read off a live tab's console. */
    __BUILD__: string
  }
}

window.__BUILD__ = BUILD
console.info(`Grand Tensor build ${BUILD}`)
