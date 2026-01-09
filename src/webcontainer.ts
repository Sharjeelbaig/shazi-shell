/**
 * This file previously contained StackBlitz WebContainer integration.
 *
 * Per project direction: do not depend on commercial/hosted runtimes.
 * Kept as a small placeholder so future open, self-hosted alternatives
 * can plug in behind the same kind of API without pulling in WebContainers.
 */

export function isWebContainerSupported(): boolean {
  return false;
}

export async function bootWebContainer(): Promise<never> {
  throw new Error('WebContainer integration is disabled in this project');
}
