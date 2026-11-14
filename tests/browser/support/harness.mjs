export const HARNESS_PATH = "/tests/browser/harness.html";
export const openHarness = page => page.goto(HARNESS_PATH);

export async function settleBrowserFrames(page, frameCount = 2) {
  await page.evaluate(async count => {
    for (let index = 0; index < count; index += 1) {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
  }, frameCount);
}
